// Command e2e-sshd runs an in-process SSH server for the nocx e2e suite
// (e2e/shell-mode.spec.ts) that executes REAL commands on a REAL PTY with
// the REAL shell. The nocx integration path needs the far side to actually
// run `exec bash --rcfile <(...) -i` (or a plain `bash -i` shell) and emit
// OSC 133 markers — an echo server cannot. Hermetic and deterministic: keys
// are minted at startup, the address is ephemeral, and everything the spec
// needs is printed machine-readable.
//
// Dev-only; never shipped. Usage:
//
//	go run ./cmd/e2e-sshd
//
// Output:
//
//	ADDR=127.0.0.1:<port>
//	USERKEY=<path to the user private key PEM>
//	KNOWNHOSTS=<one known_hosts line for the host key>
//	READY
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
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
	hostSigner, _, _, err := signer()
	if err != nil {
		return err
	}
	userSigner, userKey, _, err := signer()
	if err != nil {
		return err
	}

	config := &gossh.ServerConfig{
		PublicKeyCallback: func(_ gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
			// Compare the wire blob (algorithm + key), not the raw key: the
			// client sends key.Marshal(), which for ed25519 carries the
			// algorithm string ahead of the 32-byte key.
			if string(key.Marshal()) == string(userSigner.PublicKey().Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("e2e-sshd: unknown public key")
		},
	}
	config.AddHostKey(hostSigner)

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
		go serveConn(conn, config)
	}
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
		_ = master.Close()
	}()
	go func() {
		_, _ = io.Copy(master, ch)
		_ = master.Close()
	}()
}
