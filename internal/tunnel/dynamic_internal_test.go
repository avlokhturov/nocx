package tunnel

import (
	"bytes"
	"errors"
	"io"
	"net"
	"syscall"
	"testing"
	"time"
)

// tcpPair returns a connected TCP socket pair. Real socket semantics are
// required here, not net.Pipe: a Write returns once the kernel buffers the
// bytes, so the server may reply before the client has finished sending a
// request — the BIND path answers after the 4-byte header without draining
// the address, which net.Pipe cannot model (its Write blocks until every
// byte is consumed, deadlocking the two).
func tcpPair(t *testing.T) (server, client net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	clientCh := make(chan net.Conn, 1)
	errCh := make(chan error, 1)
	go func() {
		c, aerr := ln.Accept()
		if aerr != nil {
			errCh <- aerr
			return
		}
		clientCh <- c
	}()
	server, err = net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	select {
	case client = <-clientCh:
	case aerr := <-errCh:
		_ = server.Close()
		t.Fatalf("accept: %v", aerr)
	}
	t.Cleanup(func() { _ = server.Close() })
	t.Cleanup(func() { _ = client.Close() })
	return server, client
}

// TestNegotiateSocks walks every protocol branch of the SOCKS5 greeting and
// request, asserting both the CONNECT target returned and the exact reply
// bytes the server must send — the replies are the contract: a client that
// gets 0xFF, 0x07 or 0x08 knows the truth instead of an EOF that reads as
// "the proxy is broken".
func TestNegotiateSocks(t *testing.T) {
	tests := []struct {
		name      string
		greet     []byte
		req       []byte
		want      string
		methodRep []byte // method-selection reply when the negotiation ends at the method step
		wantRep   []byte // request-reply envelope the server must write (nil = none)
		wantErr   bool
	}{
		{
			name:  "ipv4 connect",
			greet: []byte{5, 1, 0},
			req:   []byte{5, 1, 0, 1, 127, 0, 0, 1, 0x1f, 0x90},
			want:  "127.0.0.1:8080",
		},
		{
			name:  "domain connect",
			greet: []byte{5, 1, 0},
			req:   []byte{5, 1, 0, 3, 7, 'e', 'x', 'a', 'm', 'p', 'l', 'e', 0, 80},
			want:  "example:80",
		},
		{
			name:  "ipv6 connect",
			greet: []byte{5, 1, 0},
			req:   []byte{5, 1, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x01, 0xbb},
			want:  "[::1]:443",
		},
		{
			// No request follows: the negotiation fails at the method step
			// and the method reply IS the assertion.
			name:      "no acceptable method",
			greet:     []byte{5, 1, 2},
			methodRep: []byte{0x05, 0xFF},
			wantErr:   true,
		},
		{
			name:    "bind",
			greet:   []byte{5, 1, 0},
			req:     []byte{5, 2, 0, 1, 127, 0, 0, 1, 0, 80},
			wantRep: []byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0},
			wantErr: true,
		},
		{
			name:    "udp associate",
			greet:   []byte{5, 1, 0},
			req:     []byte{5, 3, 0, 1, 127, 0, 0, 1, 0, 80},
			wantRep: []byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0},
			wantErr: true,
		},
		{
			name:    "unknown command",
			greet:   []byte{5, 1, 0},
			req:     []byte{5, 9, 0, 1, 127, 0, 0, 1, 0, 80},
			wantRep: []byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0},
			wantErr: true,
		},
		{
			name:    "bad address type",
			greet:   []byte{5, 1, 0},
			req:     []byte{5, 1, 0, 2, 1, 2, 3, 4, 0, 80},
			wantRep: []byte{5, 8, 0, 1, 0, 0, 0, 0, 0, 0},
			wantErr: true,
		},
		{
			name:    "empty domain",
			greet:   []byte{5, 1, 0},
			req:     []byte{5, 1, 0, 3, 0, 0, 80},
			wantRep: []byte{5, 1, 0, 1, 0, 0, 0, 0, 0, 0},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server, client := tcpPair(t)

			type result struct {
				target string
				err    error
			}
			resCh := make(chan result, 1)
			go func() {
				target, err := negotiateSocks(server)
				resCh <- result{target, err}
			}()

			if _, err := client.Write(tt.greet); err != nil {
				t.Fatalf("write greeting: %v", err)
			}
			methodRep := make([]byte, 2)
			if _, err := io.ReadFull(client, methodRep); err != nil {
				t.Fatalf("read method reply: %v", err)
			}

			if tt.req == nil {
				// The negotiation ends at the method step: the method reply
				// is the whole assertion.
				if !bytes.Equal(methodRep, tt.methodRep) {
					t.Fatalf("method reply = %v, want %v", methodRep, tt.methodRep)
				}
			} else {
				if methodRep[0] != 0x05 || methodRep[1] != 0x00 {
					t.Fatalf("method reply = %v, want [5 0]", methodRep)
				}
				if _, err := client.Write(tt.req); err != nil {
					t.Fatalf("write request: %v", err)
				}
				if tt.wantRep != nil {
					rep := make([]byte, len(tt.wantRep))
					if _, err := io.ReadFull(client, rep); err != nil {
						t.Fatalf("read reply: %v", err)
					}
					if !bytes.Equal(rep, tt.wantRep) {
						t.Fatalf("reply = %v, want %v", rep, tt.wantRep)
					}
				}
			}

			res := <-resCh
			if (res.err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", res.err, tt.wantErr)
			}
			if res.target != tt.want {
				t.Fatalf("target = %q, want %q", res.target, tt.want)
			}
		})
	}
}

// TestNegotiateSocks_MethodReplyIsTwoBytes pins the exact wire shape of the
// method-selection reply: VER plus the chosen method, nothing else — a 0xFF
// refusal must not carry BND fields. The negotiation is over after the
// refusal, so negotiateSocks must return without waiting for anything more.
func TestNegotiateSocks_MethodReplyIsTwoBytes(t *testing.T) {
	server, client := tcpPair(t)

	resCh := make(chan error, 1)
	go func() {
		_, err := negotiateSocks(server)
		resCh <- err
	}()
	if _, err := client.Write([]byte{5, 1, 2}); err != nil {
		t.Fatalf("write greeting: %v", err)
	}
	rep := make([]byte, 2)
	if _, err := io.ReadFull(client, rep); err != nil {
		t.Fatalf("read method reply: %v", err)
	}
	if rep[0] != 0x05 || rep[1] != 0xFF {
		t.Fatalf("method reply = %v, want [5 255]", rep)
	}
	select {
	case <-resCh:
	case <-time.After(5 * time.Second):
		t.Fatal("negotiateSocks did not return after the 0xFF refusal")
	}
}

// TestSocksReplyCode maps every dial-failure shape to the reply code a SOCKS
// client can act on: refused is 0x05, unreachable is 0x03, generic 0x01.
func TestSocksReplyCode(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want byte
	}{
		{"refused errno", syscall.ECONNREFUSED, 0x05},
		{"network unreachable", syscall.ENETUNREACH, 0x03},
		{"host unreachable", syscall.EHOSTUNREACH, 0x03},
		// The OpenSSH server rejects the direct-tcpip channel open with a
		// text message ("connect failed: Connection refused"), which is not
		// a syscall error.
		{"refused text", errors.New("ssh: rejected: connection failed (connect failed: Connection refused)"), 0x05},
		{"unreachable text", errors.New("ssh: rejected: connection failed (connect failed: Network is unreachable)"), 0x03},
		{"generic", errors.New("boom"), 0x01},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := socksReplyCode(tt.err); got != tt.want {
				t.Fatalf("socksReplyCode(%v) = %d, want %d", tt.err, got, tt.want)
			}
		})
	}
}
