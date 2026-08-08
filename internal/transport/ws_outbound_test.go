package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/transport/outbound"
)

// waitForPendingAsk polls the ask broker until one ask is registered and
// returns its request id.
func waitForPendingAsk(t *testing.T, ws *WSServer) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ws.asks.mu.Lock()
		var rid string
		for k := range ws.asks.pending {
			rid = k
			break
		}
		ws.asks.mu.Unlock()
		if rid != "" {
			return rid
		}
		if time.Now().After(deadline) {
			t.Fatal("ask never registered")
		}
		time.Sleep(time.Millisecond)
	}
}

// TestUnlockResolved_ReleasesWaiterWhileOutboundBlocked is the point of the
// whole task, end to end: the resolver's critical interval must end when
// the waiter is signalled, not when the acknowledgement is written. The
// connection's outbound pump is wedged mid-write (the deterministic
// stand-in for a renderer that stopped reading), so the ack cannot be
// delivered; vault.unlockResolved must still release RequestUnlock.
func TestUnlockResolved_ReleasesWaiterWhileOutboundBlocked(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	ws := NewWSServer(logger, newRegWithStub(logger))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })

	wedge := newWedgedSocket()
	wconn := &wsConn{out: outbound.New(wedge, outbound.Config{}), id: 1}
	t.Cleanup(func() { _ = wedge.Close() })
	ws.registerConn(wconn)
	released := make(chan error, 1)
	go func() { released <- ws.RequestUnlock(ctx, "acceptance") }()

	// Wait until the ask is registered AND the pump is mid-write on the
	// broadcast notification: from here the ack cannot be delivered until
	// the wedge releases.
	rid := waitForPendingAsk(t, ws)
	select {
	case <-wedge.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the outbound pump never started its write: the wedge is not holding anything")
	}

	// Resolve the ask the way the read loop would, on a connection whose
	// acknowledgement cannot be written (the pump is blocked and the wedge
	// is still held).
	// Resolve the ask the way the read loop would, on a connection whose
	// acknowledgement cannot be written (the pump is blocked and the wedge
	// is still held). The resolver is a constructed handler holding the ask
	// broker and the connection's Responder.
	askResolverHandlers{asks: &ws.asks, r: wconn}.handleUnlockResolved(jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  "vault.unlockResolved",
		Params:  mustMarshal(map[string]string{"requestId": rid, "outcome": "unsealed"}),
	})

	select {
	case err := <-released:
		if err != nil {
			t.Fatalf("RequestUnlock: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("vault.unlockResolved did not release the waiter while the outbound writer was blocked: the critical interval still ends at the acknowledgement")
	}
	// The wedge is still held: the ack was never delivered. The waiter
	// was released before the write, which is the whole point.
	if n := wedge.writes.Load(); n != 0 {
		t.Fatalf("the ack was delivered (%d writes) before the waiter was released", n)
	}
}

// TestAskBroadcastToNConnectionsIsFast: an ask broadcast to N connections
// is N non-blocking enqueues, never N × the write deadline. Every
// connection here has a wedged pump; the old serial broadcast would spend
// N × 10 s inside RequestUnlock.
func TestAskBroadcastToNConnectionsIsFast(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	ws := NewWSServer(logger, newRegWithStub(logger))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })

	const n = 8
	for i := uint64(0); i < n; i++ {
		wedge := newWedgedSocket()
		wconn := &wsConn{out: outbound.New(wedge, outbound.Config{}), id: i + 1}
		t.Cleanup(func() { _ = wedge.Close() })
		ws.registerConn(wconn)
		t.Cleanup(func() { ws.unregisterConn(wconn) })
	}

	start := time.Now()
	if err := ws.broadcastAsk("test.ask", map[string]any{"n": n}, ErrNoClientConnected); err != nil {
		t.Fatalf("broadcastAsk: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("ask broadcast to %d wedged connections took %v: a serial write path is still alive", n, elapsed)
	}
}

// TestSlowRendererOnOneConnectionDoesNotDelayAnother: over the real socket,
// a connection whose renderer stops reading (its pump wedges, its queue
// saturates and the stall policy fires) must not delay responses on a
// second, healthy connection.
func TestSlowRendererOnOneConnectionDoesNotDelayAnother(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	ws := NewWSServer(logger, newRegWithStub(logger))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })

	slow := connectWS(t, ws)
	t.Cleanup(func() { _ = slow.Close() })
	fast := connectWS(t, ws)
	t.Cleanup(func() { _ = fast.Close() })

	// The slow renderer stops reading and floods the server: its kernel
	// buffer fills, the pump blocks, the queue saturates, the stall notice
	// fires and the connection eventually closes — all while the healthy
	// connection beside it keeps answering.
	go func() {
		id := 100
		for i := 0; i < 4000; i++ {
			id++
			req, err := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": id, "method": "profiles.list",
			})
			if err != nil {
				return
			}
			if err := slow.WriteMessage(websocket.TextMessage, req); err != nil {
				return
			}
		}
	}()

	// The healthy connection must keep getting responses throughout the
	// flood. profiles.list without a resolver answers an error, but any
	// response proves the round trip completed.
	deadline := time.Now().Add(5 * time.Second)
	for i := 0; i < 20; i++ {
		_ = jsonrpcCallWithID(t, fast, "profiles.list", nil, 1000+i)
		if time.Now().After(deadline) {
			break
		}
	}
}

// TestSessionInputFlowsWhileOutboundSaturated: over the real socket, input
// to a live session keeps flowing while a connection's outbound queue is
// saturated. One connection stops reading and floods the control plane
// without bound: its TCP window fills, the pump blocks, the queue
// saturates, the stall notice is reserved, and the connection is closed
// when even that cannot be delivered — the terminal policy, end to end.
// The session is connection-independent (AD-9): a second connection
// attaches and types, and the input must reach the session's channel while
// the first connection is wedged.
func TestSessionInputFlowsWhileOutboundSaturated(t *testing.T) {
	live := newLiveChannel()
	ws := stallServer(t, live)
	connA := connectWS(t, ws)
	t.Cleanup(func() { _ = connA.Close() })
	sid := openSSHOverSocket(t, connA, 1)

	// A fresh connection attaches to the same session and types into it —
	// BEFORE the flood starts. The session and its input path must survive
	// the saturated connection (AD-9); the read loop must never wait behind
	// outbound. The attach is itself an admitted control method now, so it
	// must land while the lane is free: under the wired executor a
	// saturated ordinary lane refuses control work with the retryable
	// -32004 (the saturation contract), and what this test watches is the
	// DATA path.
	connB := connectWS(t, ws)
	t.Cleanup(func() { _ = connB.Close() })
	attachResp := jsonrpcCallWithID(t, connB, "attach", map[string]any{"sessionId": sid, "offset": 0}, 2)
	var attachEnv struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(attachResp, &attachEnv); err != nil {
		t.Fatalf("attach unmarshal: %v", err)
	}
	if attachEnv.Error != nil {
		t.Fatalf("attach before the flood failed: %+v", attachEnv.Error)
	}

	// connA's renderer stops reading and floods the control plane without
	// bound. The flood can only end when the server closes the connection
	// (its writes start failing), which is exactly the close we wait for:
	// the flood's end IS the stall policy's close.
	floodDone := make(chan struct{})
	go func() {
		defer close(floodDone)
		id := 100
		for {
			id++
			req, err := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": id, "method": "profiles.list",
			})
			if err != nil {
				return
			}
			if err := connA.WriteMessage(websocket.TextMessage, req); err != nil {
				return
			}
		}
	}()

	// Type into the live session while connA is wedged: the DATA path must
	// never wait behind outbound.
	sendData(t, connB, sid, "hostname\n")

	deadline := time.After(15 * time.Second)
	for {
		if live.received() == "hostname\n" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("the live session never received the input while another connection's outbound was saturated (got %q)",
				live.received())
		case <-time.After(5 * time.Millisecond):
		}
	}

	// The saturated connection must be closed by the stall policy: the
	// flood ends only when its writes fail, which happens when the server
	// closes the socket.
	select {
	case <-floodDone:
	case <-time.After(30 * time.Second):
		t.Fatal("the saturated connection was never closed by the stall policy: no stall, or the close path is dead")
	}
	// Drain whatever was delivered before the close: the close itself must
	// surface as a connection error, not a timeout.
	_ = connA.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		if _, _, err := connA.ReadMessage(); err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				t.Fatal("the saturated connection closed server-side but the close never surfaced")
			}
			return // genuine close
		}
	}
}
