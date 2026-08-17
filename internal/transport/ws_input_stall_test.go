package transport

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/ssh"
)

// deadChannel is the reported failure: a jump host behind a NAT that drops
// packets without an RST. Write never returns and never errors, because
// there is nothing to return.
type deadChannel struct {
	done      chan struct{}
	closeOnce sync.Once
}

func newDeadChannel() *deadChannel { return &deadChannel{done: make(chan struct{})} }

func (c *deadChannel) Read(p []byte) (int, error) { return 0, io.EOF }
func (c *deadChannel) Write(p []byte) (int, error) {
	<-c.done
	return 0, io.ErrClosedPipe
}

func (c *deadChannel) Close() error {
	c.closeOnce.Do(func() { close(c.done) })
	return nil
}
func (c *deadChannel) Done() <-chan struct{}                             { return c.done }
func (c *deadChannel) Resize(_ context.Context, _, _, _, _ uint16) error { return nil }
func (c *deadChannel) ShellIntegrationReason() ssh.RefusalReason         { return ssh.ReasonNone }

// liveChannel accepts everything and records it, standing in for the healthy
// tab that must keep working while another one is dead.
type liveChannel struct {
	mu   sync.Mutex
	got  []byte
	done chan struct{}
}

func newLiveChannel() *liveChannel { return &liveChannel{done: make(chan struct{})} }

func (c *liveChannel) Read(p []byte) (int, error) { return 0, io.EOF }
func (c *liveChannel) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.got = append(c.got, p...)
	return len(p), nil
}

func (c *liveChannel) received() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.got)
}
func (c *liveChannel) Close() error                                      { return nil }
func (c *liveChannel) Done() <-chan struct{}                             { return c.done }
func (c *liveChannel) Resize(_ context.Context, _, _, _, _ uint16) error { return nil }
func (c *liveChannel) ShellIntegrationReason() ssh.RefusalReason         { return ssh.ReasonNone }

// openSSHOverSocket opens an SSH session through the real control plane and
// returns its id.
func openSSHOverSocket(t *testing.T, conn *websocket.Conn, id int) string {
	t.Helper()
	resp := jsonrpcCallWithID(t, conn, "open", map[string]any{
		"cols": 80, "rows": 24, "xpixel": 0, "ypixel": 0,
		"kind": "ssh", "profileId": "ssh:test:1",
	}, id)
	var r struct {
		Result struct {
			SessionID string `json:"sessionId"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &r); err != nil {
		t.Fatalf("decode open response: %v", err)
	}
	if r.Error != nil {
		t.Fatalf("open failed: %s", r.Error.Message)
	}
	if r.Result.SessionID == "" {
		t.Fatal("open returned no session id")
	}
	return r.Result.SessionID
}

func sendData(t *testing.T, conn *websocket.Conn, sid, payload string) {
	t.Helper()
	sidBytes, err := session.IDToBytes(session.ID(sid))
	if err != nil {
		t.Fatalf("IDToBytes: %v", err)
	}
	f := Frame{Version: FrameVersion, MsgType: MsgTypeData, SessionID: sidBytes, Payload: []byte(payload)}
	if err := conn.WriteMessage(websocket.BinaryMessage, f.Encode()); err != nil {
		t.Fatalf("write data frame: %v", err)
	}
}

// stallServer wires a WSServer whose SSH factory hands out the given channels
// in order, one per open.
func stallServer(t *testing.T, channels ...ssh.Channel) *WSServer {
	t.Helper()
	logger := log.NewSlogAdapter(nil)
	reg := newRegWithStub(logger)
	var mu sync.Mutex
	next := 0
	reg.WithSSHFactory(&stubSSHFactory{
		connectFn: func(_ context.Context, _ string, _ ...ssh.ConnectOption) (ssh.Channel, error) {
			mu.Lock()
			defer mu.Unlock()
			ch := channels[next]
			next++
			return ch, nil
		},
	})
	ws := NewWSServer(logger, reg, WithProfileResolver(&fakeResolver{
		resolveFn: func(string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test", Port: 22}, nil
		},
	}))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	return ws
}

// TestDeadSession_DoesNotFreezeAnotherPane is the reported bug, end to end and
// over the real socket: one SSH channel goes dead, and the tab NEXT to it must
// still take input. Before the write queue both sessions shared the readLoop,
// so the dead one's blocked Write starved every other tab on the connection —
// including local ones with nothing wrong with them.
func TestDeadSession_DoesNotFreezeAnotherPane(t *testing.T) {
	dead := newDeadChannel()
	live := newLiveChannel()
	t.Cleanup(func() { _ = dead.Close() })

	ws := stallServer(t, dead, live)
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	deadSID := openSSHOverSocket(t, conn, 1)
	liveSID := openSSHOverSocket(t, conn, 2)

	// Bury the dead session under more frames than its queue can hold, so
	// its write path is thoroughly stuck before the healthy tab types.
	for i := 0; i < 200; i++ {
		sendData(t, conn, deadSID, "x")
	}
	sendData(t, conn, liveSID, "hostname\n")

	deadline := time.After(15 * time.Second)
	for {
		if live.received() == "hostname\n" {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("the healthy tab's input never arrived (got %q): a dead session is still freezing the readLoop",
				live.received())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// TestDeadSession_TellsThePaneItsInputIsBeingDropped pins the visible half.
// Dropping frames is the right call — a stalled channel must not be allowed
// to consume memory or stall its neighbours — but a terminal that silently
// swallows keystrokes is indistinguishable from one that ignores the person
// at it. The backend says so on the wire, once per stall.
func TestDeadSession_TellsThePaneItsInputIsBeingDropped(t *testing.T) {
	dead := newDeadChannel()
	t.Cleanup(func() { _ = dead.Close() })

	ws := stallServer(t, dead)
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	sid := openSSHOverSocket(t, conn, 1)

	notifs := make(chan string, 64)
	go func() {
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				close(notifs)
				return
			}
			if mt != websocket.TextMessage {
				continue
			}
			var n struct {
				Method string `json:"method"`
				Params struct {
					SessionID string `json:"sessionId"`
				} `json:"params"`
			}
			if json.Unmarshal(data, &n) == nil && n.Method == "inputStalled" {
				notifs <- n.Params.SessionID
			}
		}
	}()

	for i := 0; i < 300; i++ {
		sendData(t, conn, sid, "k")
	}

	select {
	case got, ok := <-notifs:
		if !ok {
			t.Fatal("connection closed before the stall was reported")
		}
		if got != sid {
			t.Fatalf("inputStalled named session %q, want %q", got, sid)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("input was dropped and the tab was never told: the degrade is invisible in the product")
	}
}
