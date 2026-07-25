package ssh

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

// dialer encapsulates SSH connection logic.
type dialer struct {
	client *RealClient
}

// dial connects to the target host, optionally through a jump host.
func (d *dialer) dial(ctx context.Context, host string, resolved *resolvedConfig, cfg *ConnectConfig) (*gossh.Client, error) {
	hostKeyCB, err := d.client.hostKeyCallback()
	if err != nil {
		return nil, fmt.Errorf("host key callback: %w", err)
	}

	chain, err := d.client.buildAuthChain(resolved, cfg)
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

	if cfg.JumpHost != "" {
		return d.dialViaJumpHost(ctx, cfg, resolved, gcfg, addr)
	}

	return d.dialDirect(ctx, addr, gcfg, host, resolved.user)
}

// dialDirect establishes a direct SSH connection with context support.
func (d *dialer) dialDirect(ctx context.Context, addr string, cfg *gossh.ClientConfig, host, user string) (*gossh.Client, error) {
	d.client.log.Info("Dialing directly", "addr", addr, "user", cfg.User)

	netConn, err := d.dialWithCtx(ctx, "tcp", addr, cfg.Timeout)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}

	conn, chans, reqs, err := gossh.NewClientConn(netConn, addr, cfg)
	if err != nil {
		_ = netConn.Close()
		if isAuthError(err) {
			return nil, &ErrAuthFailed{User: user, Host: host, Err: err}
		}
		return nil, err
	}

	return gossh.NewClient(conn, chans, reqs), nil
}

// dialWithCtx dials a network address with context cancellation support.
func (d *dialer) dialWithCtx(ctx context.Context, network, addr string, timeout time.Duration) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: timeout}
	return dialer.DialContext(ctx, network, addr)
}

// dialViaJumpHost connects to the target host through a jump server.
func (d *dialer) dialViaJumpHost(ctx context.Context, cfg *ConnectConfig, resolved *resolvedConfig, targetCfg *gossh.ClientConfig, targetAddr string) (*gossh.Client, error) {
	d.client.log.Info("Connecting via jump host", "jump", cfg.JumpHost, "target", targetAddr)

	jumpClient, err := d.connectToJumpHost(ctx, cfg)
	if err != nil {
		return nil, err
	}

	conn, err := jumpClient.Dial("tcp", targetAddr)
	if err != nil {
		_ = jumpClient.Close()
		return nil, fmt.Errorf("dial target %s through jump: %w", targetAddr, err)
	}

	clientConn, chans, reqs, err := gossh.NewClientConn(conn, targetAddr, targetCfg)
	if err != nil {
		_ = conn.Close()
		_ = jumpClient.Close()
		return nil, fmt.Errorf("ssh client conn through jump: %w", err)
	}

	client := gossh.NewClient(clientConn, chans, reqs)

	d.client.mu.Lock()
	d.client.clients = append(d.client.clients, jumpClient)
	d.client.mu.Unlock()

	return client, nil
}

// connectToJumpHost establishes a connection to the jump server with context support.
func (d *dialer) connectToJumpHost(ctx context.Context, cfg *ConnectConfig) (*gossh.Client, error) {
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
		return nil, fmt.Errorf("resolve jump host config: %w", err)
	}
	// Enforce the jump credential's binding against the jump host's resolved
	// name/effective port, independently of the target. JumpCredentials is
	// the newer, easier-to-miss path (nocx-mon/PR11-T5): a jump credential
	// bound to one bastion must not be submittable to another.
	if jumpCfg.Credentials != nil {
		if bindErr := checkBinding(cfg.JumpBoundHost, cfg.JumpBoundPort, jumpResolved, jumpCfg.CredIdentity.User, true); bindErr != nil {
			return nil, bindErr
		}
	}

	jumpChain, err := d.client.buildAuthChain(jumpResolved, jumpCfg)
	if err != nil {
		return nil, fmt.Errorf("build jump host auth: %w", err)
	}

	jumpAuths := authMethodsFromChain(jumpChain)

	jumpHostCB, err := d.client.hostKeyCallback()
	if err != nil {
		return nil, fmt.Errorf("jump host key callback: %w", err)
	}

	jumpClientCfg := &gossh.ClientConfig{
		User:            jumpResolved.user,
		Auth:            jumpAuths,
		HostKeyCallback: jumpHostCB,
		Timeout:         30 * time.Second,
	}

	jumpAddr := net.JoinHostPort(jumpResolved.hostName, strconv.Itoa(jumpResolved.port))
	d.client.log.Info("Dialing jump server", "addr", jumpAddr, "user", jumpResolved.user)

	netConn, err := d.dialWithCtx(ctx, "tcp", jumpAddr, jumpClientCfg.Timeout)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("dial jump server %s: %w", jumpAddr, err)
	}

	conn, chans, reqs, err := gossh.NewClientConn(netConn, jumpAddr, jumpClientCfg)
	if err != nil {
		_ = netConn.Close()
		return nil, fmt.Errorf("jump server handshake %s: %w", jumpAddr, err)
	}

	return gossh.NewClient(conn, chans, reqs), nil
}
