package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

// askBroker is the shared backend→renderer ask machinery: a pending
// registry keyed by server-assigned request id, a broadcast to every
// connected client, and a blocking wait for the resolution RPC. The vault
// unlock ask (UnlockRequester) and the connection-password ask
// (RequestConnectionPassword) are both thin specializations over it — one
// correlation mechanism, two meanings. A connection password is not the
// vault passphrase, so the two asks keep their own methods, params and
// error types; only the plumbing is shared.
type askBroker struct {
	mu      sync.Mutex
	pending map[string]*pendingAsk
}

// pendingAsk tracks one in-flight ask.
type pendingAsk struct {
	ch chan askResolution
}

// askResolution is one answer to a pending ask: either a result payload
// (the resolved answer) or an error (cancelled, no client, timeout,
// unknown outcome).
type askResolution struct {
	result json.RawMessage // nil when err != nil
	err    error
}

func (b *askBroker) init() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending == nil {
		b.pending = make(map[string]*pendingAsk)
	}
}

// register mints a request id and records the pending ask. The returned
// channel receives exactly one askResolution (buffered, so the resolver
// never blocks on the waiter).
func (b *askBroker) register() (string, chan askResolution, error) {
	b.init()
	ridBytes := make([]byte, 8)
	if _, err := rand.Read(ridBytes); err != nil {
		return "", nil, fmt.Errorf("generate request id: %w", err)
	}
	rid := hex.EncodeToString(ridBytes)
	ch := make(chan askResolution, 1)
	b.mu.Lock()
	b.pending[rid] = &pendingAsk{ch: ch}
	b.mu.Unlock()
	return rid, ch, nil
}

// consume removes and returns the pending ask for rid. Returns ok=false
// for an unknown id — the renderer resolved something that was never
// asked, or asked twice (the second resolution is the error).
func (b *askBroker) consume(rid string) (*pendingAsk, bool) {
	b.init()
	b.mu.Lock()
	defer b.mu.Unlock()
	pa, ok := b.pending[rid]
	if ok {
		delete(b.pending, rid)
	}
	return pa, ok
}

// drop abandons the pending ask for rid (no client connected, context
// done) so a late resolution cannot wake a waiter nobody is listening to.
func (b *askBroker) drop(rid string) {
	b.init()
	b.mu.Lock()
	delete(b.pending, rid)
	b.mu.Unlock()
}

// broadcastAsk sends a notification to every connected client. noClientErr
// is the error to return when no renderer is attached — each ask names its
// own outcome ("unlock prompt" vs "connection password"), because the three
// outcomes of an ask must be distinguishable by their message.
func (s *WSServer) broadcastAsk(method string, params map[string]any, noClientErr error) error {
	s.connsMu.Lock()
	conns := make([]*wsConn, 0, len(s.conns))
	for wc := range s.conns {
		conns = append(conns, wc)
	}
	s.connsMu.Unlock()

	if len(conns) == 0 {
		return noClientErr
	}

	// One enqueue per connection, never a blocking write: an ask to N
	// renderers costs N channel sends, not N write deadlines.
	for _, wc := range conns {
		_ = wc.TryNotify(method, mustMarshal(params))
	}
	return nil
}

// UnlockRequester lets backend code request a vault unlock from the user.
// A single method, behind an interface (AD-8), wired at the one composition
// root. Implemented by *WSServer: RequestUnlock sends a vault.unlockRequest
// notification to connected clients and blocks until one responds or the
// context is done.
type UnlockRequester interface {
	// RequestUnlock asks any connected renderer to show the vault unlock
	// dialog. The reason names why (e.g. "history needs the content key")
	// so the dialog can say what needs the unlock, not only that it is
	// locked. Blocks until a client responds via vault.unlockResolved, or
	// the context is done. Returns nil on success, or an error describing
	// why the unlock could not complete (no client connected, user
	// cancelled, timeout, etc.).
	RequestUnlock(ctx context.Context, reason string) error
}

// ErrNoClientConnected is returned by RequestUnlock when no renderer is
// attached to receive the notification.
var ErrNoClientConnected = errors.New("no client connected to show unlock prompt")

// ErrUnlockCancelled is returned by RequestUnlock when the user dismissed
// the unlock dialog without unlocking.
var ErrUnlockCancelled = errors.New("unlock cancelled by user")

// RequestUnlock sends a vault.unlockRequest notification to every connected
// client and blocks until one responds via vault.unlockResolved, or the
// context is done.
func (s *WSServer) RequestUnlock(ctx context.Context, reason string) error {
	rid, ch, err := s.asks.register()
	if err != nil {
		return err
	}

	if err := s.broadcastAsk("vault.unlockRequest", map[string]any{
		"requestId": rid,
		"reason":    reason,
	}, ErrNoClientConnected); err != nil {
		s.asks.drop(rid)
		return err
	}

	// Wait for a response or context done.
	select {
	case res := <-ch:
		return res.err
	case <-ctx.Done():
		s.asks.drop(rid)
		return ctx.Err()
	}
}

// handleUnlockResolved handles the vault.unlockResolved RPC from the
// renderer: it looks up the pending request and signals its channel.
func (s *WSServer) handleUnlockResolved(wconn Responder, req jsonrpcRequest) {
	var params struct {
		RequestID string `json:"requestId"`
		Outcome   string `json:"outcome"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	pa, ok := s.asks.consume(params.RequestID)
	if !ok {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Unknown request id"})
		return
	}

	switch params.Outcome {
	case "unsealed":
		pa.ch <- askResolution{}
	case "cancelled":
		pa.ch <- askResolution{err: ErrUnlockCancelled}
	default:
		pa.ch <- askResolution{err: fmt.Errorf("unlock resolved with unknown outcome: %q", params.Outcome)}
	}

	_ = wconn.TryResult(req.ID, json.RawMessage("{}"))
}
