package ssh

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
	agent "golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// RealClientOption configures the RealClient constructor.
type RealClientOption func(*RealClient)

// WithKnownHostsFile sets an explicit known_hosts path.
func WithKnownHostsFile(path string) RealClientOption {
	return func(rc *RealClient) { rc.knownHostsFile = path }
}

// WithSSHConfigPath sets an explicit SSH config path.
func WithSSHConfigPath(path string) RealClientOption {
	return func(rc *RealClient) { rc.sshConfigPath = path }
}

// RealClient is a production SSH client that connects to remote hosts
// via golang.org/x/crypto/ssh. Connections are pooled and ref-counted
// (AD-4): tabs targeting the same host+identity+route share one
// authenticated ssh.Client, and the connection (including any jump
// transport) closes when the last referencing tab closes.
type RealClient struct {
	log            log.Logger
	knownHostsFile string
	sshConfigPath  string

	pool *ConnPool
}

// NewReal creates a RealClient with the given options.
func NewReal(logger log.Logger, opts ...RealClientOption) (*RealClient, error) {
	rc := &RealClient{
		log: logger.With("module", "ssh"),
	}
	home, _ := os.UserHomeDir()
	rc.knownHostsFile = filepath.Join(home, ".ssh", "known_hosts")
	rc.sshConfigPath = filepath.Join(home, ".ssh", "config")

	for _, o := range opts {
		o(rc)
	}

	rc.pool = NewConnPool(logger)
	// The pool's default dial factory is the placeholder (it returns an
	// error). Production Connects pass a per-call factory to AcquireDial so
	// the dial sees the caller's credential store and key material — the key
	// identifies the principal, the factory provides the credentials. Keeping
	// p.dial as the placeholder means a bare Acquire (no factory) fails loud
	// rather than silently dialing with the wrong identity.
	return rc, nil
}

// Connect implements SSH.Connect.
func (rc *RealClient) Connect(ctx context.Context, host string, opts ...ConnectOption) (Channel, error) {
	cfg := &ConnectConfig{}
	for _, o := range opts {
		o(cfg)
	}

	resolved, err := rc.resolveConfig(host, cfg)
	if err != nil {
		return nil, fmt.Errorf("resolve config for %s: %w", host, err)
	}

	// Enforce the credential binding BEFORE any dial. Only a linked
	// credential (Secrets != nil) carries a binding to check; inline
	// auth has no stored secret to redirect. The check sees the resolved
	// hostname/effective port, so an alias remapped via HostName cannot
	// slip a bound credential past its target (nocx-mon/PR11-T5).
	if cfg.Secrets != nil {
		if bindErr := checkBinding(cfg.BoundHost, cfg.BoundPort, resolved, string(cfg.SecretID), false); bindErr != nil {
			return nil, bindErr
		}
	}
	key := rc.poolKeyFor(resolved, cfg)
	handle, err := rc.pool.AcquireDial(ctx, key, rc.dialForConnect(ctx, host, resolved, cfg))
	if err != nil {
		return nil, err
	}

	pconn, ok := handle.conn.(*pooledSSHConn)
	if !ok {
		// dialForConnect always returns a *pooledSSHConn; a different type
		// means the pool's dial factory was overridden (tests). Release and bail.
		rc.pool.Release(handle)
		return nil, fmt.Errorf("internal: pooled connection is not a *pooledSSHConn (%T)", handle.conn)
	}
	gclient, ok := pconn.client.(*gossh.Client)
	if !ok {
		rc.pool.Release(handle)
		return nil, fmt.Errorf("internal: pooled client is not *gossh.Client (%T)", pconn.client)
	}

	// Agent forwarding: register the per-connection channel handler once
	// (initAgentForward is guarded by agentForwardOnce), then request it
	// per-session inside openShell. Fail early if the user asked for
	// forwarding but no agent is reachable.
	if cfg.AgentForward {
		if !rc.agentAvailable() {
			rc.pool.Release(handle)
			return nil, fmt.Errorf("agent forwarding requested but no SSH agent available (SSH_AUTH_SOCK not set)")
		}
		if fwdErr := pconn.initAgentForward(gclient, os.Getenv("SSH_AUTH_SOCK")); fwdErr != nil {
			rc.pool.Release(handle)
			return nil, fmt.Errorf("agent-forward setup: %w", fwdErr)
		}
	}

	ch, err := rc.openShell(ctx, gclient, resolved, cfg)
	if err != nil {
		// Failed to open the shell — release our reference so the
		// connection can close if we were the only tab. Without this the
		// failed Connect path leaks a pooled ref (and a jump transport)
		// for the process life.
		rc.pool.Release(handle)
		return nil, err
	}

	// Wire the channel's close to release our pool reference. RealChannel.Close
	// runs closeCb exactly once (sync.Once), so the handle is released exactly
	// once even if the session errors and the tab then closes. Releasing the
	// handle drops the target refcount; when it hits zero the pooledSSHConn
	// closes the gossh.Client AND releases the jump handle, which closes the
	// bastion when its own refcount hits zero. One Close per channel, one
	// Release per handle, no leak.
	ch.releasePoolRef = func() { rc.pool.Release(handle) }
	return ch, nil
}

// Close implements SSH.Close. It closes every pooled connection regardless
// of refcount — used during shutdown. Ordinary tab closure releases a
// single handle via the channel's closeCb and never reaches here.
func (rc *RealClient) Close() error {
	rc.pool.CloseAll()
	return nil
}

// hostKeyCallback builds a HostKeyCallback from known_hosts.
func (rc *RealClient) hostKeyCallback() (gossh.HostKeyCallback, error) {
	cb, err := knownhosts.New(rc.knownHostsFile)
	if err != nil {
		return func(addr string, remote net.Addr, key gossh.PublicKey) error {
			return &ErrUnknownHostKey{
				Addr:        addr,
				KeyAlgo:     key.Type(),
				Fingerprint: gossh.FingerprintSHA256(key),
			}
		}, nil
	}

	return func(addr string, remote net.Addr, key gossh.PublicKey) error {
		err := cb(addr, remote, key)
		if err == nil {
			return nil
		}

		var keyErr *knownhosts.KeyError
		if errors.As(err, &keyErr) {
			if len(keyErr.Want) == 0 {
				return &ErrUnknownHostKey{
					Addr:        addr,
					KeyAlgo:     key.Type(),
					Fingerprint: gossh.FingerprintSHA256(key),
				}
			}
			var expected []string
			for _, k := range keyErr.Want {
				expected = append(expected, gossh.FingerprintSHA256(k.Key))
			}
			return &ErrHostKeyMismatch{
				Addr:        addr,
				Fingerprint: gossh.FingerprintSHA256(key),
				Expected:    strings.Join(expected, ","),
			}
		}
		return err
	}, nil
}

// openShell opens a session, requests a PTY, optionally requests agent
// forwarding, and starts a shell.
func (rc *RealClient) openShell(ctx context.Context, gclient *gossh.Client, resolved *resolvedConfig, cfg *ConnectConfig) (*RealChannel, error) {
	if cfg.RemoteInstaller != nil {
		remoteHome, err := cfg.RemoteInstaller.GetRemoteHome(gclient)
		if err != nil {
			rc.log.Warn("ssh: could not determine remote home for shell integration",
				"host", resolved.hostName, "error", err)
		} else if err := cfg.RemoteInstaller.EnsureInstalledRemote(ctx, gclient, remoteHome); err != nil {
			rc.log.Warn("ssh: shell integration install failed",
				"host", resolved.hostName, "error", err)
		}
	}

	session, err := gclient.NewSession()
	if err != nil {
		return nil, fmt.Errorf("new session: %w", err)
	}

	ptyReq := ptyReqMsg{
		Term:     "xterm-256color",
		Columns:  uint32(resolved.cols),
		Rows:     uint32(resolved.rows),
		Width:    uint32(resolved.xpixel),
		Height:   uint32(resolved.ypixel),
		Modelist: buildTerminalModes(),
	}
	_, err = session.SendRequest("pty-req", true, gossh.Marshal(&ptyReq))
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("pty-req: %w", err)
	}

	if cfg.AgentForward {
		// Per-connection handler already registered in Connect (initAgentForward).
		// Per-session: request agent forwarding on this session so the remote
		// side can open auth-agent@openssh.com channels. agent.RequestAgentForwarding
		// uses wantReply=true, so a server refusal surfaces as an error.
		if reqErr := agent.RequestAgentForwarding(session); reqErr != nil {
			_ = session.Close()
			return nil, fmt.Errorf("agent-forward request: %w", reqErr)
		}
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if cfg.RemoteInstaller != nil {
		if err := session.Start(cfg.RemoteInstaller.RemoteStartCommand()); err != nil {
			_ = session.Close()
			return nil, fmt.Errorf("shell start: %w", err)
		}
	} else {
		if err := session.Shell(); err != nil {
			_ = session.Close()
			return nil, fmt.Errorf("shell: %w", err)
		}
	}

	ch := &RealChannel{
		log:     rc.log.With("remote", resolved.hostName),
		session: session,
		stdin:   stdin,
		stdout:  stdout,
		done:    make(chan struct{}),
		closeCb: func() {
			_ = session.Close()
		},
	}

	go func() {
		_ = session.Wait()
		// Remote session ended — release the pool reference. Close is
		// idempotent (closeOnce), so if the tab already called Close this
		// is a no-op; if not, it closes the session, drops the ref, and
		// (for a jump-backed conn) releases the bastion handle.
		_ = ch.Close()
	}()

	return ch, nil
}

// isAuthError returns true if the error likely comes from a failed SSH authentication.
func isAuthError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "unable to authenticate") ||
		strings.Contains(msg, "no supported methods remain") ||
		strings.Contains(msg, "ssh: handshake failed") ||
		strings.Contains(msg, "no common algorithms")
}
