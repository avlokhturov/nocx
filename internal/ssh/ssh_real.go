package ssh

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
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
// via golang.org/x/crypto/ssh.
type RealClient struct {
	log            log.Logger
	knownHostsFile string
	sshConfigPath  string

	mu      sync.Mutex
	clients []*gossh.Client
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
	// credential (Credentials != nil) carries a binding to check; inline
	// auth has no stored secret to redirect. The check sees the resolved
	// hostname/effective port, so an alias remapped via HostName cannot
	// slip a bound credential past its target (nocx-mon/PR11-T5).
	if cfg.Credentials != nil {
		if bindErr := checkBinding(cfg.BoundHost, cfg.BoundPort, resolved, cfg.CredIdentity.User, false); bindErr != nil {
			return nil, bindErr
		}
	}

	d := &dialer{client: rc}
	gclient, err := d.dial(ctx, host, resolved, cfg)
	if err != nil {
		return nil, err
	}

	rc.mu.Lock()
	rc.clients = append(rc.clients, gclient)
	rc.mu.Unlock()

	ch, err := rc.openShell(ctx, gclient, resolved, cfg)
	if err != nil {
		_ = gclient.Close()
		return nil, err
	}

	return ch, nil
}

// Close implements SSH.Close.
func (rc *RealClient) Close() error {
	rc.mu.Lock()
	clients := rc.clients
	rc.clients = nil
	rc.mu.Unlock()

	var lastErr error
	for _, cl := range clients {
		if err := cl.Close(); err != nil {
			lastErr = err
		}
	}
	return lastErr
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

// openShell opens a session, requests a PTY, and starts a shell.
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
		ch.closeOnce.Do(func() {
			close(ch.done)
		})
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
