package transport

// pane.close — the renderer telling the backend that a pane closed (nocx-tsajw).
// The capture contract (internal/credential/capture.go) names pane closure as a
// destruction trigger, but the transport had no way to fire it: the pending
// captures were scoped to the connection, so a pane's offer sat in backend
// memory until the connection dropped, the vault sealed, or the app quit.
// This notification is the missing trigger: the renderer mints a per-pane
// identity, rides it on history.record so the captures are scoped to the pane,
// and announces the pane's death here so those captures are destroyed with it.
//
// The params shape is declared once in contracts/pane.close.schema.json (the
// renderer's type is generated from it); this handler is the Go side's check.
// It is a notification with no response — the renderer is fire-and-forget, and
// a lost frame is covered by the transport-disconnect trigger
// (DestroyConnection), which is the same destruction the tab's death would
// have caused anyway.
import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
)

// paneCloseParams is the payload of the pane.close notification.
type paneCloseParams struct {
	PaneID string `json:"paneId"`
}

// maxPaneIDRunes bounds the renderer-minted pane identity that history.record
// and pane.close accept: a crypto.randomUUID() is 36 characters, and any real
// identity fits far under this. The bound is per-field wire-cost hygiene —
// the same shape as every other string bound in this package — so a hostile
// frame cannot make the server hold an unbounded string in a capture scope.
const maxPaneIDRunes = 128

// validatePaneCloseRaw checks the pane.close notification: the paneId must be
// present and within bounds. The connection half of the destruction key is
// never on this wire — it is the handler's own identity, added at destroy
// time so a pane id from one connection can never reach another's captures.
func validatePaneCloseRaw(raw json.RawMessage) string {
	var p paneCloseParams
	if msg := decodeParams(raw, &p); msg != "" {
		return msg
	}
	if strings.TrimSpace(p.PaneID) == "" {
		return "paneId is required"
	}
	if utf8.RuneCountInString(p.PaneID) > maxPaneIDRunes {
		return fmt.Sprintf("paneId exceeds %d characters", maxPaneIDRunes)
	}
	return ""
}

// paneCloseHandlers answers pane.close: registry only, no capability — destroying
// a pending capture touches no store, exactly like secrets.captureDismiss.
// It holds the *wsConn as identity (reg, not regResponder) because the
// destruction key is (connection, pane), and the connection half is the
// handler's own fact.
type paneCloseHandlers struct {
	captures *credential.CaptureRegistry
	log      log.Logger
}

// handlePaneClose destroys the closed pane's pending captures. The validator has
// already refused a missing or oversized paneId; the defensive re-parse and
// the silent return on failure mirror ackHandler — a notification has no
// response to carry an error, and nothing is left half-destroyed.
func (h paneCloseHandlers) handlePaneClose(_ context.Context, wconn *wsConn, req jsonrpcRequest) {
	var p paneCloseParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		h.log.Warn("pane.close invalid params")
		return
	}
	if h.captures != nil {
		h.captures.DestroyPane(connectionID(wconn), p.PaneID)
	}
}
