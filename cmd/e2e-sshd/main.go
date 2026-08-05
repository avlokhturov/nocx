// Command e2e-sshd runs an in-process SSH server for the nocx e2e suite
// (e2e/shell-mode.spec.ts, e2e/nocxify-journey.spec.ts) that executes REAL
// commands on a REAL PTY with the REAL shell. The nocx integration path needs
// the far side to actually run `exec bash --rcfile <(...) -i` (or a plain
// `bash -i` shell) and emit OSC 133 markers — an echo server cannot. Hermetic
// and deterministic: keys are minted at startup, the address is ephemeral,
// and everything the spec needs is printed machine-readable.
//
// Dev-only; never shipped. Usage:
//
//	go run ./cmd/e2e-sshd [-banner <text>] [-password <pass>]
//
// Flags:
//
//	-banner <text>     send an sshd banner before authentication (the
//	                   journey's frozen local block must contain it)
//	-password <pass>   require password auth: the fixture's own key is
//	                   REFUSED, and the callback accepts only <pass>. This is
//	                   what makes a hand-typed `ssh` prompt for a password;
//	                   without it the server is public-key-only. A wrong
//	                   password (or a mismatched <pass> on a second fixture)
//	                   is the journey's authentication-failure host.
//
// Output:
//
//	ADDR=127.0.0.1:<port>
//	USERKEY=<path to the user private key PEM>
//	KNOWNHOSTS=<one known_hosts line for the host key>
//	CONN=<client address>   printed once per client, when its first userauth
//	                        attempt (the publickey offer) reaches the server:
//	                        key exchange is done and the client is one
//	                        response from rendering the password prompt. The
//	                        journey waits for this line before typing the
//	                        password, so the run is deterministic, not timed.
//	READY
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "e2e-sshd:", err)
		os.Exit(1)
	}
}

func run() error {
	banner := flag.String("banner", "", "sshd banner sent before authentication")
	password := flag.String("password", "", "require password auth; accepts exactly this password and refuses every key")
	flag.Parse()

	hostSigner, _, _, err := signer()
	if err != nil {
		return err
	}
	userSigner, userKey, _, err := signer()
	if err != nil {
		return err
	}

	userKeyPath, err := writeUserKey(userKey)
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer func() { _ = ln.Close() }()

	fmt.Printf("ADDR=%s\n", ln.Addr().String())
	fmt.Printf("USERKEY=%s\n", userKeyPath)
	fmt.Printf("KNOWNHOSTS=%s\n", knownhosts.Line([]string{ln.Addr().String()}, hostSigner.PublicKey()))
	fmt.Println("READY")
	_ = os.Stdout.Sync()

	for {
		conn, err := ln.Accept()
		if err != nil {
			return nil // listener closed
		}
		// CONN= is per connection: printed when the client's first userauth
		// attempt reaches the server — key exchange done, one response before
		// the client renders the password prompt. The journey waits for it
		// before typing the password; without it the run is timed, not
		// deterministic.
		var once sync.Once
		config := buildConfig(userSigner, hostSigner, *banner, *password, func() {
			once.Do(func() {
				fmt.Printf("CONN=%s\n", conn.RemoteAddr().String())
				_ = os.Stdout.Sync()
			})
		})
		go serveConn(conn, config)
	}
}

// buildConfig assembles the ServerConfig for one connection. onAuthAttempt
// fires on the client's publickey offer — the first userauth message that
// engages a callback (gossh answers "none" itself), after key exchange and
// before the password prompt.
func buildConfig(userSigner, hostSigner gossh.Signer, banner, password string, onAuthAttempt func()) *gossh.ServerConfig {
	config := &gossh.ServerConfig{}
	if password != "" {
		// Password-auth fixture (the journey's hand-typed `ssh` must be
		// prompted): the fixture's own key is REFUSED so the client has no
		// publickey path, and the callback accepts exactly the one password.
		// A wrong password is an auth failure with the client's own exit
		// status — the journey's fail-open assertion.
		config.PasswordCallback = func(_ gossh.ConnMetadata, pass []byte) (*gossh.Permissions, error) {
			if string(pass) == password {
				return nil, nil
			}
			return nil, fmt.Errorf("e2e-sshd: wrong password")
		}
		config.PublicKeyCallback = func(_ gossh.ConnMetadata, _ gossh.PublicKey) (*gossh.Permissions, error) {
			onAuthAttempt()
			return nil, fmt.Errorf("e2e-sshd: public key auth disabled")
		}
	} else {
		config.PublicKeyCallback = func(_ gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
			onAuthAttempt()
			// Compare the wire blob (algorithm + key), not the raw key: the
			// client sends key.Marshal(), which for ed25519 carries the
			// algorithm string ahead of the 32-byte key.
			if string(key.Marshal()) == string(userSigner.PublicKey().Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("e2e-sshd: unknown public key")
		}
	}
	if banner != "" {
		b := banner
		config.BannerCallback = func(_ gossh.ConnMetadata) string { return b }
	}
	config.AddHostKey(hostSigner)
	return config
}

func signer() (gossh.Signer, ed25519.PrivateKey, ed25519.PublicKey, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("generate key: %w", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("signer: %w", err)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, nil, nil, fmt.Errorf("signer: unexpected public key type")
	}
	return signer, priv, pub, nil
}

func writeUserKey(priv ed25519.PrivateKey) (string, error) {
	dir, err := os.MkdirTemp("", "nocx-e2e-sshd-*")
	if err != nil {
		return "", fmt.Errorf("temp dir: %w", err)
	}
	path := dir + "/id_e2e"
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", fmt.Errorf("marshal key: %w", err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return "", fmt.Errorf("write key: %w", err)
	}
	return path, nil
}

func serveConn(conn net.Conn, config *gossh.ServerConfig) {
	defer func() { _ = conn.Close() }()
	sshConn, chans, reqs, err := gossh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	defer func() { _ = sshConn.Close() }()
	go gossh.DiscardRequests(reqs)

	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			_ = newChan.Reject(gossh.UnknownChannelType, "unknown channel type")
			continue
		}
		ch, reqs, err := newChan.Accept()
		if err != nil {
			return
		}
		go handleSession(ch, reqs)
	}
}

type sessionState struct {
	mu      sync.Mutex
	cols    uint16
	rows    uint16
	slave   *os.File
	started bool
}

// clampU16 bounds a window-size field before the narrowing conversion
// (gosec G115 wants the check, not a raw cast).
func clampU16(v uint32) uint16 {
	if v > 65535 {
		return 65535
	}
	return uint16(v)
}

func handleSession(ch gossh.Channel, reqs <-chan *gossh.Request) {
	st := &sessionState{cols: 80, rows: 24}
	done := make(chan struct{})

	go func() {
		defer close(done)
		for req := range reqs {
			switch req.Type {
			case "pty-req":
				// RFC 4254 §6.2: term, cols, rows, width, height, modes.
				var p struct {
					Term  string
					Cols  uint32
					Rows  uint32
					W     uint32
					H     uint32
					Modes string
				}
				if gossh.Unmarshal(req.Payload, &p) == nil {
					st.mu.Lock()
					st.cols = clampU16(p.Cols)
					st.rows = clampU16(p.Rows)
					st.mu.Unlock()
				}
				_ = req.Reply(true, nil)
			case "window-change":
				var w struct {
					Cols uint32
					Rows uint32
					W    uint32
					H    uint32
				}
				if gossh.Unmarshal(req.Payload, &w) == nil {
					st.mu.Lock()
					st.cols = clampU16(w.Cols)
					st.rows = clampU16(w.Rows)
					slave := st.slave
					st.mu.Unlock()
					if slave != nil {
						rows := clampU16(w.Rows)
						cols := clampU16(w.Cols)
						_ = pty.Setsize(slave, &pty.Winsize{Rows: rows, Cols: cols})
					}
				}
				_ = req.Reply(true, nil)
			case "shell":
				_ = req.Reply(true, nil)
				startCommand(ch, st, "exec bash -i")
			case "exec":
				var e struct{ Command string }
				if gossh.Unmarshal(req.Payload, &e) != nil {
					_ = req.Reply(false, nil)
					continue
				}
				_ = req.Reply(true, nil)
				startCommand(ch, st, e.Command)
			default:
				_ = req.Reply(false, nil)
			}
		}
	}()
	<-done
	_ = ch.Close()
}

// startCommand runs the given command on a fresh PTY with the real bash and
// wires it to the channel. The command is wrapped in `bash -c` so launcher
// strings (`exec bash --rcfile <(...) -i`) execute as shell constructs. The
// parent's copy of the slave is closed after Start, mirroring pty.Start: the
// child alone holds the slave, so its exit propagates EOF to the master and
// the channel closes. stderr of the child is echoed to the fixture's stderr
// so a spawn failure is observable instead of a silent dead session.
func startCommand(ch gossh.Channel, st *sessionState, command string) {
	st.mu.Lock()
	if st.started {
		st.mu.Unlock()
		return
	}
	st.started = true
	st.mu.Unlock()

	master, slave, err := pty.Open()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e-sshd: pty open:", err)
		return
	}
	st.mu.Lock()
	st.slave = slave
	cols, rows := st.cols, st.rows
	st.mu.Unlock()
	_ = pty.Setsize(slave, &pty.Winsize{Rows: rows, Cols: cols})

	bash, err := exec.LookPath("bash")
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e-sshd: bash not found:", err)
		_ = slave.Close()
		_ = master.Close()
		return
	}
	//nolint:gosec // dev-only fixture: the command string is this binary's own contract.
	cmd := exec.Command(bash, "-c", command)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = ptySetctty()
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "e2e-sshd: spawn:", err)
		_ = slave.Close()
		_ = master.Close()
		return
	}
	// The child holds the slave through its stdio fds; the parent's copy is
	// closed so the child's exit produces EOF on the master.
	_ = slave.Close()

	go func() {
		_, _ = io.Copy(ch, master)
		_ = cmd.Wait()
		// A real ssh client terminates only on an explicit exit-status
		// followed by channel EOF (the journey's `exit` must end the remote
		// session cleanly and hand the real code to the local shell). The
		// shell's own `exit N` is the child's exit status; without this the
		// server waits for the client to close the channel while the client
		// waits for the server — a deadlock that looks like a hung ssh.
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		// A negative code means the process was signalled; the wire field is
		// unsigned, and the fixture only has to be faithful about ordinary
		// exits, so a signal reports as 255 the way a shell would.
		if code < 0 {
			code = 255
		}
		_, _ = ch.SendRequest(
			"exit-status",
			false,
			gossh.Marshal(struct{ Status uint32 }{Status: uint32(code)}), // #nosec G115 — clamped non-negative just above.
		)
		_ = master.Close()
		_ = ch.Close()
	}()
	go func() {
		_, _ = io.Copy(master, ch)
		_ = master.Close()
	}()
}
