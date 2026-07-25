package ssh

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

// dialer encapsulates SSH connection logic. It builds the per-target
// gossh.ClientConfig and performs the real network dial (direct or via a
// jump host). The pool owns the resulting connection; dialer only produces it.
type dialer struct {
	client *RealClient
}

// poolKeyFor builds the pool key for a Connect. The key carries the resolved
// host/port/user, the credential identity, and the resolved jump route (see
// poolKey). Two Connects that resolve to the same key share one connection.
//
// identity: a stored credential is the principal (its ID isolates it); an
// inline private key is the principal (its path isolates it); agent-only or
// prompt-password auth has no credential principal, so identity is empty and
// such connections share — there is no second principal to isolate. The
// identity string is what the binding check already keys on, so widening or
// narrowing it here is exactly widening/narrowing the authorization boundary.
func (rc *RealClient) poolKeyFor(resolved *resolvedConfig, cfg *ConnectConfig) poolKey {
	// identity: a stored credential is the principal (its ID isolates it);
	// an inline private key is the principal (its path isolates it). The key
	// file may come from cfg.KeyFile OR from ~/.ssh/config IdentityFile for
	// the host — both are the same principal boundary, so prefer the resolved
	// identityFile (it reflects what actually authenticates). Agent-only or
	// prompt-password auth has no credential principal, so identity is empty
	// and such connections share — there is no second principal to isolate.
	identity := cfg.CredIdentity.User
	if identity == "" {
		if cfg.KeyFile != "" {
			identity = cfg.KeyFile
		} else if resolved.identityFile != "" {
			identity = resolved.identityFile
		}
	}

	jumpRoute := ""
	if cfg.JumpHost != "" {
		jumpRoute = rc.jumpRouteKey(cfg)
	}

	return poolKey{
		host:      resolved.hostName,
		port:      resolved.port,
		user:      resolved.user,
		identity:  identity,
		jumpRoute: jumpRoute,
	}
}

// jumpRouteKey renders the jump host's resolved identity into the route
// component of the target's pool key. The bastion is pooled under its own
// poolKey (see dialPool's jump path); this string keeps a target-via-bastion-A
// entry separate from the same target via bastion-B, and from the same target
// dialed directly.
func (rc *RealClient) jumpRouteKey(cfg *ConnectConfig) string {
	jumpCfg := &ConnectConfig{
		User:         cfg.JumpUser,
		Port:         cfg.JumpPort,
		KeyFile:      cfg.JumpKeyFile,
		AuthMode:     cfg.JumpAuthMode,
		Credentials:  cfg.JumpCredentials,
		CredIdentity: cfg.JumpCredIdentity,
	}
	jumpResolved, err := rc.resolveConfig(cfg.JumpHost, jumpCfg)
	if err != nil {
		// Resolution failure here is reported again by dialPool's jump path;
		// fall back to the raw alias so the key is still distinct per jump.
		return "unresolved:" + cfg.JumpHost
	}
	jumpKey := poolKey{
		host:     jumpResolved.hostName,
		port:     jumpResolved.port,
		user:     jumpResolved.user,
		identity: cfg.JumpCredIdentity.User,
	}
	if jumpKey.identity == "" {
		if cfg.JumpKeyFile != "" {
			jumpKey.identity = cfg.JumpKeyFile
		} else if jumpResolved.identityFile != "" {
			jumpKey.identity = jumpResolved.identityFile
		}
	}
	return jumpKey.jumpRouteKey()
}

// dialForConnect is the per-Connect dial factory passed to the pool. It
// builds the gossh.ClientConfig from the caller's resolved config and auth
// chain (so stored-credential late-bind and inline key paths resolve
// exactly as a non-pooled Connect would), dials the target — directly or
// via a jump host acquired from this same pool — and returns a
// *pooledSSHConn wrapping the gossh.Client. The pool stores it under the
// key Connect computed; later Connects with the same key reuse it without
// re-dialing. The factory is invoked only on a cache miss.
func (rc *RealClient) dialForConnect(ctx context.Context, host string, resolved *resolvedConfig, cfg *ConnectConfig) func(poolKey) (sshClientConn, error) {
	return func(_ poolKey) (sshClientConn, error) {
		hostKeyCB, err := rc.hostKeyCallback()
		if err != nil {
			return nil, fmt.Errorf("host key callback: %w", err)
		}

		chain, err := rc.buildAuthChain(resolved, cfg)
		if err != nil {
			return nil, err
		}
		auths := authMethodsFromChain(chain)

		addr := net.JoinHostPort(resolved.hostName, strconv.Itoa(resolved.port))
		gcfg := &gossh.ClientConfig{
			User:            resolved.user,
			Auth:            auths,
			HostKeyCallback: hostKeyCB,
			Timeout:         30 * time.Second,
		}

		d := &dialer{client: rc}
		if cfg.JumpHost != "" {
			return d.dialViaJumpHost(ctx, cfg, resolved, gcfg, addr)
		}
		gclient, err := d.dialDirect(ctx, addr, gcfg, host, resolved.user)
		if err != nil {
			return nil, err
		}
		return &pooledSSHConn{client: gclient}, nil
	}
}

// dialJumpForConnect is the per-Connect dial factory for the bastion hop,
// passed to the pool when acquiring the jump connection. It dials the
// bastion directly (a bastion is not itself jumped) and returns a bare
// *pooledSSHConn (no further release hook — the bastion's lifetime is
// governed by its own pool entry's refcount).
func (rc *RealClient) dialJumpForConnect(ctx context.Context, host string, resolved *resolvedConfig, cfg *ConnectConfig) func(poolKey) (sshClientConn, error) {
	return func(_ poolKey) (sshClientConn, error) {
		hostKeyCB, err := rc.hostKeyCallback()
		if err != nil {
			return nil, fmt.Errorf("jump host key callback: %w", err)
		}
		chain, err := rc.buildAuthChain(resolved, cfg)
		if err != nil {
			return nil, fmt.Errorf("build jump host auth: %w", err)
		}
		jumpAuths := authMethodsFromChain(chain)
		jumpClientCfg := &gossh.ClientConfig{
			User:            resolved.user,
			Auth:            jumpAuths,
			HostKeyCallback: hostKeyCB,
			Timeout:         30 * time.Second,
		}
		d := &dialer{client: rc}
		jumpAddr := net.JoinHostPort(resolved.hostName, strconv.Itoa(resolved.port))
		gclient, err := d.dialDirect(ctx, jumpAddr, jumpClientCfg, host, resolved.user)
		if err != nil {
			return nil, err
		}
		return &pooledSSHConn{client: gclient}, nil
	}
}

// dialDirect establishes a direct SSH connection with context support.
//
// The TCP dial uses net.Dialer.DialContext, which respects ctx cancellation.
// gossh.NewClientConn has no context-aware form (v0.54.0), so it runs in a
// goroutine with a watchdog on ctx.Done(): closing the underlying net.Conn
// unblocks the handshake. The goroutine is drain-safe because the buffered
// channel (size 1) ensures the send always succeeds. The caller sees
// ctx.Err(), not an incidental "use of closed network connection" error.
func (d *dialer) dialDirect(ctx context.Context, addr string, cfg *gossh.ClientConfig, host, user string) (*gossh.Client, error) {
	d.client.log.Info("Dialing directly", "addr", addr, "user", cfg.User)

	netConn, err := d.dialWithCtx(ctx, "tcp", addr, cfg.Timeout)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}

	type hsResult struct {
		conn  gossh.Conn
		chans <-chan gossh.NewChannel
		reqs  <-chan *gossh.Request
		err   error
	}
	ch := make(chan hsResult, 1)
	go func() {
		conn, chans, reqs, err := gossh.NewClientConn(netConn, addr, cfg)
		ch <- hsResult{conn, chans, reqs, err}
	}()

	select {
	case <-ctx.Done():
		_ = netConn.Close() // unblocks NewClientConn
		<-ch                // drain goroutine
		return nil, ctx.Err()
	case r := <-ch:
		if r.err != nil {
			_ = netConn.Close()
			if isAuthError(r.err) {
				return nil, &ErrAuthFailed{User: user, Host: host, Err: r.err}
			}
			return nil, r.err
		}
		return gossh.NewClient(r.conn, r.chans, r.reqs), nil
	}
}

// dialWithCtx dials a network address with context cancellation support.
func (d *dialer) dialWithCtx(ctx context.Context, network, addr string, timeout time.Duration) (net.Conn, error) {
	netDialer := &net.Dialer{Timeout: timeout}
	return netDialer.DialContext(ctx, network, addr)
}

// dialViaJumpHost connects to the target host through a jump server. The
// jump client is ACQUIRED FROM THE SAME POOL as the target (AD-4): the bastion
// is itself a ref-counted connection, so two tabs jumping through one bastion
// share its transport, and the bastion closes when the last target through it
// closes. The returned *pooledSSHConn's Close releases the bastion handle.
//
// Jump-target dialing uses gossh.Client.DialContext (available since
// golang.org/x/crypto v0.54.0), which respects ctx cancellation. The
// subsequent gossh.NewClientConn handshake has no context-aware form;
// a watchdog goroutine closes the dialed connection on ctx.Done() so
// the handshake fails promptly.
func (d *dialer) dialViaJumpHost(ctx context.Context, cfg *ConnectConfig, resolved *resolvedConfig, targetCfg *gossh.ClientConfig, targetAddr string) (sshClientConn, error) {
	d.client.log.Info("Connecting via jump host", "jump", cfg.JumpHost, "target", targetAddr)

	jumpHandle, jumpClient, err := d.acquireJumpHost(ctx, cfg)
	if err != nil {
		return nil, err
	}

	// DialContext respects ctx cancellation — no watchdog needed for this step.
	conn, err := jumpClient.DialContext(ctx, "tcp", targetAddr)
	if err != nil {
		d.client.pool.Release(jumpHandle)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("dial target %s through jump: %w", targetAddr, err)
	}

	// gossh.NewClientConn has no context-aware form. Same watchdog pattern
	// as dialDirect: close conn on ctx.Done() to unblock the handshake.
	type hsResult struct {
		clientConn gossh.Conn
		chans      <-chan gossh.NewChannel
		reqs       <-chan *gossh.Request
		err        error
	}
	ch := make(chan hsResult, 1)
	go func() {
		cc, chans, reqs, err := gossh.NewClientConn(conn, targetAddr, targetCfg)
		ch <- hsResult{cc, chans, reqs, err}
	}()

	select {
	case <-ctx.Done():
		_ = conn.Close() // unblocks NewClientConn
		<-ch             // drain goroutine
		d.client.pool.Release(jumpHandle)
		return nil, ctx.Err()
	case r := <-ch:
		if r.err != nil {
			_ = conn.Close()
			d.client.pool.Release(jumpHandle)
			return nil, fmt.Errorf("ssh client conn through jump: %w", r.err)
		}
		target := gossh.NewClient(r.clientConn, r.chans, r.reqs)
		// The target's Close closes the gossh.Client AND releases the bastion
		// handle. When the last target through this bastion closes, the bastion's
		// refcount drops to zero and the bastion connection closes. The bastion
		// handle is released exactly once because pooledSSHConn.Close is guarded
		// by its own sync.Once.
		return &pooledSSHConn{
			client:  target,
			release: func() { d.client.pool.Release(jumpHandle) },
		}, nil
	}
}

// acquireJumpHost resolves the jump host's config, enforces the jump
// credential's binding, and Acquires the bastion from the pool — so the
// bastion is shared across tabs and released with the last target. Returns
// the pool handle (to release when the target closes) and the gossh.Client
// (to dial the target through).
func (d *dialer) acquireJumpHost(ctx context.Context, cfg *ConnectConfig) (*poolHandle, *gossh.Client, error) {
	jumpCfg := &ConnectConfig{
		User:         cfg.JumpUser,
		Port:         cfg.JumpPort,
		KeyFile:      cfg.JumpKeyFile,
		AuthMode:     cfg.JumpAuthMode,
		JumpHost:     "",
		Credentials:  cfg.JumpCredentials,
		CredIdentity: cfg.JumpCredIdentity,
	}

	jumpResolved, err := d.client.resolveConfig(cfg.JumpHost, jumpCfg)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve jump host config: %w", err)
	}
	// Enforce the jump credential's binding against the jump host's resolved
	// name/effective port, independently of the target. JumpCredentials is
	// the newer, easier-to-miss path (nocx-mon/PR11-T5): a jump credential
	// bound to one bastion must not be submittable to another.
	if jumpCfg.Credentials != nil {
		if bindErr := checkBinding(cfg.JumpBoundHost, cfg.JumpBoundPort, jumpResolved, jumpCfg.CredIdentity.User, true); bindErr != nil {
			return nil, nil, bindErr
		}
	}

	jumpKey := d.client.poolKeyFor(jumpResolved, jumpCfg)
	handle, err := d.client.pool.AcquireDial(ctx, jumpKey, d.client.dialJumpForConnect(ctx, cfg.JumpHost, jumpResolved, jumpCfg))
	if err != nil {
		return nil, nil, err
	}
	pconn, ok := handle.conn.(*pooledSSHConn)
	if !ok {
		d.client.pool.Release(handle)
		return nil, nil, fmt.Errorf("internal: jump pool entry is not *pooledSSHConn (%T)", handle.conn)
	}
	jumpClient, ok := pconn.client.(*gossh.Client)
	if !ok {
		d.client.pool.Release(handle)
		return nil, nil, fmt.Errorf("internal: jump client is not *gossh.Client (%T)", pconn.client)
	}
	return handle, jumpClient, nil
}
