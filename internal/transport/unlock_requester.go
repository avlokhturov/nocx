package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

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

// pendingUnlock tracks one in-flight unlock request.
type pendingUnlock struct {
	ch     chan error // receives nil on unsealed, ErrUnlockCancelled on dismiss
	reason string
}

// ── WSServer unlock-request implementation ─────────────────────────────

func (s *WSServer) initUnlockRequester() {
	s.unlockMu.Lock()
	defer s.unlockMu.Unlock()
	if s.pendingUnlocks == nil {
		s.pendingUnlocks = make(map[string]*pendingUnlock)
	}
}

// RequestUnlock sends a vault.unlockRequest notification to every connected
// client and blocks until one responds via vault.unlockResolved, or the
// context is done.
func (s *WSServer) RequestUnlock(ctx context.Context, reason string) error {
	s.initUnlockRequester()

	// Assign a request id so the response can be correlated.
	ridBytes := make([]byte, 8)
	if _, err := rand.Read(ridBytes); err != nil {
		return fmt.Errorf("generate request id: %w", err)
	}
	rid := hex.EncodeToString(ridBytes)

	ch := make(chan error, 1)
	pu := &pendingUnlock{ch: ch, reason: reason}

	s.unlockMu.Lock()
	s.pendingUnlocks[rid] = pu
	s.unlockMu.Unlock()

	// Send to every connected client; best-effort (one write failure does
	// not prevent writes to others).
	s.connsMu.Lock()
	conns := make([]*wsConn, 0, len(s.conns))
	for wc := range s.conns {
		conns = append(conns, wc)
	}
	s.connsMu.Unlock()

	if len(conns) == 0 {
		s.unlockMu.Lock()
		delete(s.pendingUnlocks, rid)
		s.unlockMu.Unlock()
		return ErrNoClientConnected
	}

	notif := map[string]any{
		"jsonrpc": "2.0",
		"method":  "vault.unlockRequest",
		"params": map[string]any{
			"requestId": rid,
			"reason":    reason,
		},
	}
	for _, wc := range conns {
		_ = wc.writeJSON(notif)
	}

	// Wait for a response or context done.
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		s.unlockMu.Lock()
		delete(s.pendingUnlocks, rid)
		s.unlockMu.Unlock()
		return ctx.Err()
	}
}

// handleUnlockResolved handles the vault.unlockResolved RPC from the
// renderer: it looks up the pending request and signals its channel.
func (s *WSServer) handleUnlockResolved(wconn *wsConn, req jsonrpcRequest) {
	var params struct {
		RequestID string `json:"requestId"`
		Outcome   string `json:"outcome"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}

	s.unlockMu.Lock()
	pu, ok := s.pendingUnlocks[params.RequestID]
	if ok {
		delete(s.pendingUnlocks, params.RequestID)
	}
	s.unlockMu.Unlock()

	if !ok {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Unknown request id"))
		return
	}

	switch params.Outcome {
	case "unsealed":
		pu.ch <- nil
	case "cancelled":
		pu.ch <- ErrUnlockCancelled
	default:
		pu.ch <- fmt.Errorf("unlock resolved with unknown outcome: %q", params.Outcome)
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, json.RawMessage("{}")))
}
