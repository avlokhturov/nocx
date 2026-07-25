package transport

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
)

// The local WebSocket is the whole attack surface: behind it, `open` creates a
// PTY. Listening on a random loopback port is friction for an attacker, not
// authorization — any page that scans loopback finds it. These tests pin the
// capability check, and they all assert the same thing in different ways: the
// rejection happens BEFORE the upgrade, so `open` is never reachable.

// dialWith opens a raw WebSocket with the given subprotocols, origin and host.
// It returns the HTTP response so a test can assert on the pre-upgrade status
// rather than on a JSON-RPC error — the difference matters, because a rejection
// after upgrade would mean the socket existed at all.
func dialWith(ws *WSServer, protocols []string, origin, host string) (*websocket.Conn, *http.Response, error) {
	u, err := url.Parse(wsURL(ws))
	if err != nil {
		return nil, nil, err
	}
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	if host != "" {
		// Override the Host header so the request reaches the listener
		// but carries a different Host than the dial address.
		hdr.Set("Host", host)
	}
	d := websocket.Dialer{Subprotocols: protocols}
	return d.Dial(u.String(), hdr)
}

func startAuthServer(t *testing.T) (*WSServer, func()) {
	t.Helper()
	logger := log.NewSlogAdapter(nil)
	ws := NewWSServer(logger, newRegWithStub(logger))
	ctx, cancel := context.WithCancel(context.Background())
	if err := ws.Start(ctx); err != nil {
		cancel()
		t.Fatalf("start: %v", err)
	}
	return ws, func() {
		_ = ws.Stop(ctx)
		cancel()
	}
}

func TestUpgradeRejectedWithoutToken(t *testing.T) {
	ws, stop := startAuthServer(t)
	defer stop()

	conn, resp, err := dialWith(ws, nil, "", "")
	if err == nil {
		_ = conn.Close()
		t.Fatal("dial succeeded without a token; open would be reachable")
	}
	if resp == nil {
		t.Fatalf("no HTTP response: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d (rejection must precede the upgrade)",
			resp.StatusCode, http.StatusUnauthorized)
	}
}

func TestUpgradeRejectedWithWrongToken(t *testing.T) {
	ws, stop := startAuthServer(t)
	defer stop()

	// Same shape as a real token, different value — this must fail on the
	// comparison, not on parsing, or the test would pass for the wrong reason.
	conn, resp, err := dialWith(ws, []string{tokenProtocol("Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8")}, "", "")
	if err == nil {
		_ = conn.Close()
		t.Fatal("dial succeeded with a wrong token")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}
}

func TestUpgradeSucceedsWithCorrectToken(t *testing.T) {
	ws, stop := startAuthServer(t)
	defer stop()

	conn, resp, err := dialWith(ws, []string{tokenProtocol(ws.Token())}, "", "")
	if err != nil {
		t.Fatalf("dial with the correct token failed: %v", err)
	}
	defer func() { _ = conn.Close() }()

	// RFC 6455: if the client offered subprotocols, the server must echo the
	// one it selected. A browser client aborts the connection otherwise.
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != tokenProtocol(ws.Token()) {
		t.Errorf("selected subprotocol = %q, want it echoed back", got)
	}
	if got := conn.Subprotocol(); got == "" {
		t.Error("negotiated subprotocol is empty")
	}
}

func TestTokenIsFreshPerLaunch(t *testing.T) {
	a, stopA := startAuthServer(t)
	defer stopA()
	b, stopB := startAuthServer(t)
	defer stopB()

	if a.Token() == b.Token() {
		t.Fatal("two servers share a token; it must be minted per launch")
	}
	if len(a.Token()) < 40 {
		t.Errorf("token length = %d, want >= 40 chars (32 raw bytes, base64url)", len(a.Token()))
	}
	// Unpadded base64url: '=' and '/' are not valid HTTP token characters and
	// would corrupt the Sec-WebSocket-Protocol header.
	if strings.ContainsAny(a.Token(), "=/+") {
		t.Errorf("token %q contains characters invalid in a subprotocol name", a.Token())
	}
}

func TestStartFailsClosedOnEntropyFailure(t *testing.T) {
	logger := log.NewSlogAdapter(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ws := NewWSServer(logger, newRegWithStub(logger), WithTokenSource(failingReader{}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := ws.Start(ctx); err == nil {
		_ = ws.Stop(ctx)
		t.Fatal("Start succeeded without entropy; it must fail closed rather than serve an empty token")
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("no entropy") }

func TestUpgradeRejectedForHostileOrigin(t *testing.T) {
	ws, stop := startAuthServer(t)
	defer stop()

	// A token is not enough on its own: a page that somehow learns the token
	// still must not be able to drive the socket from a foreign origin.
	conn, resp, err := dialWith(ws, []string{tokenProtocol(ws.Token())}, "https://evil.example", "")
	if err == nil {
		_ = conn.Close()
		t.Fatal("dial succeeded from a hostile origin")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}

func TestUpgradeRejectedForWrongHost(t *testing.T) {
	ws, stop := startAuthServer(t)
	defer stop()

	// DNS rebinding: the request reaches our loopback listener but carries an
	// attacker-controlled Host, so an Origin check alone would not see it.
	_, port, ok := strings.Cut(ws.listener.Addr().String(), ":")
	if !ok {
		t.Fatal("listener address has no port")
	}
	conn, resp, err := dialWith(ws, []string{tokenProtocol(ws.Token())}, "", "attacker.example:"+port)
	if err == nil {
		_ = conn.Close()
		t.Fatal("dial succeeded with a foreign Host header")
	}
	if resp == nil {
		t.Fatalf("no HTTP response: %v — request did not reach handler", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}
