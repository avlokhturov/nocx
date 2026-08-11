package transport

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/ssh"
)

// TestWSServer_OpenPasswordAsk_DoesNotBlockTheReadLoop pins the deadlock
// the connection-password ask would otherwise cause. The open RPC raises
// the ask and blocks until the renderer answers — and the answer arrives
// over the SAME websocket, which the read loop is what consumes. Before
// handleOpen was dispatched on its own goroutine, the read loop sat inside
// the dial, the resolution went unread, and the open waited forever (the
// e2e caught it: the prompt appeared, the password was submitted, the
// connection never came up).
//
// The test proves both halves: while the open is pending the loop still
// serves a second RPC, and the answer actually reaches the asker — the
// open completes with the submitted password.
func TestWSServer_OpenPasswordAsk_DoesNotBlockTheReadLoop(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	reg := newRegWithStub(logger)

	var ws *WSServer
	var answerUsed string
	reg.WithSSHFactory(&stubSSHFactory{
		connectFn: func(ctx context.Context, _ string, opts ...ssh.ConnectOption) (ssh.Channel, error) {
			// Rebuild the config the way session.Open does (the seam that
			// previously dropped the requester), then raise the ask exactly
			// as the prompt rung of the auth ladder does.
			cfg := &ssh.ConnectConfig{}
			for _, o := range opts {
				o(cfg)
			}
			if cfg.PasswordRequester == nil {
				return nil, errors.New("dial saw no password requester")
			}
			ans, err := cfg.PasswordRequester.RequestConnectionPassword(ctx, ssh.PasswordRequest{
				Connection: cfg.ConnectionName,
				User:       cfg.User,
				Host:       "host.example.com",
				Reason:     "no password is stored for this connection",
			})
			if err != nil {
				return nil, err
			}
			answerUsed = ans.Password
			return ssh.NewStubChannel(logger), nil
		},
	})

	ws = NewWSServer(logger, reg,
		WithProfileResolver(&fakeResolver{
			resolveFn: func(_ string) (string, *ssh.ConnectConfig, error) {
				return "host.example.com", &ssh.ConnectConfig{
					User:              "test",
					Port:              22,
					AuthMode:          "password",
					ConnectionName:    "prod-web",
					PasswordRequester: wirePasswordAsker{ws: ws},
				}, nil
			},
		}),
	)

	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })

	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	// The open request goes out first; its response comes later.
	req, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      100,
		"method":  "open",
		"params": map[string]any{
			"cols":      80,
			"rows":      24,
			"xpixel":    0,
			"ypixel":    0,
			"kind":      "ssh",
			"profileId": "ssh:test:1",
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if writeErr := conn.WriteMessage(websocket.TextMessage, req); writeErr != nil {
		t.Fatalf("write open: %v", writeErr)
	}

	// The renderer receives the connections.passwordRequest notification.
	_ = conn.SetReadDeadline(time.Now().Add(wantWithin))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read password request notification: %v", err)
	}
	var notif struct {
		Method string `json:"method"`
		Params struct {
			RequestID string `json:"requestId"`
		} `json:"params"`
	}
	if unmarshalErr := json.Unmarshal(data, &notif); unmarshalErr != nil {
		t.Fatalf("unmarshal notification: %v", unmarshalErr)
	}
	if notif.Method != "connections.passwordRequest" {
		t.Fatalf("expected connections.passwordRequest, got %q", notif.Method)
	}

	// While the open is STILL pending, the same connection must serve
	// another RPC — the read loop is alive, not parked inside the dial.
	_ = conn.SetReadDeadline(time.Now().Add(wantWithin))
	vaultResp := jsonrpcCall(t, conn, "vault.status", nil)
	if string(vaultResp) == "" {
		t.Fatal("read loop did not answer vault.status while the open was pending")
	}

	// Now answer the ask over the same socket. Before the fix this message
	// sat unread and the open never completed.
	_ = conn.SetReadDeadline(time.Now().Add(wantWithin))
	resp := vaultCall(t, conn, "connections.passwordResolved", map[string]any{
		"requestId": notif.Params.RequestID,
		"outcome":   "submitted",
		"password":  "hunter2",
		"remember":  false,
	}, 2)
	if resp.Error != nil {
		t.Fatalf("passwordResolved error: %s", resp.Error.Message)
	}

	// The open completes with the answer the ask returned.
	_ = conn.SetReadDeadline(time.Now().Add(wantWithin))
	_, openData, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read open response: %v", err)
	}
	var openResp struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(openData, &openResp); err != nil {
		t.Fatalf("unmarshal open response: %v", err)
	}
	if openResp.Error != nil {
		t.Fatalf("open failed: %s", openResp.Error.Message)
	}
	if answerUsed != "hunter2" {
		t.Errorf("dial used %q, want the submitted password", answerUsed)
	}
}

// wirePasswordAsker adapts the transport's RequestConnectionPassword into
// ssh.ConnectionPasswordRequester for the test's resolver.
type wirePasswordAsker struct {
	ws *WSServer
}

func (w wirePasswordAsker) RequestConnectionPassword(ctx context.Context, req ssh.PasswordRequest) (ssh.PasswordAnswer, error) {
	return w.ws.RequestConnectionPassword(ctx, req)
}
