package transport

// tab.close — the renderer telling the backend that a tab closed (nocx-tsajw).
// The capture contract (internal/credential/capture.go) names tab closure as a
// destruction trigger, but the transport had no way to fire it: the pending
// captures were scoped to the connection, so a tab's offer sat in backend
// memory until the connection dropped, the vault sealed, or the app quit.
// This notification is the missing trigger: the renderer mints a per-tab
// identity, rides it on history.record so the captures are scoped to the tab,
// and announces the tab's death here so those captures are destroyed with it.
//
// The params shape is declared once in contracts/tab.close.schema.json (the
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

// tabCloseParams is the payload of the tab.close notification.
type tabCloseParams struct {
	TabID string `json:"tabId"`
}

// maxTabIDRunes bounds the renderer-minted tab identity that history.record
// and tab.close accept: a crypto.randomUUID() is 36 characters, and any real
// identity fits far under this. The bound is per-field wire-cost hygiene —
// the same shape as every other string bound in this package — so a hostile
// frame cannot make the server hold an unbounded string in a capture scope.
const maxTabIDRunes = 128

// validateTabCloseRaw checks the tab.close notification: the tabId must be
// present and within bounds. The connection half of the destruction key is
// never on this wire — it is the handler's own identity, added at destroy
// time so a tab id from one connection can never reach another's captures.
func validateTabCloseRaw(raw json.RawMessage) string {
	var p tabCloseParams
	if msg := decodeParams(raw, &p); msg != "" {
		return msg
	}
	if strings.TrimSpace(p.TabID) == "" {
		return "tabId is required"
	}
	if utf8.RuneCountInString(p.TabID) > maxTabIDRunes {
		return fmt.Sprintf("tabId exceeds %d characters", maxTabIDRunes)
	}
	return ""
}

// tabCloseHandlers answers tab.close: registry only, no capability — destroying
// a pending capture touches no store, exactly like secrets.captureDismiss.
// It holds the *wsConn as identity (reg, not regResponder) because the
// destruction key is (connection, tab), and the connection half is the
// handler's own fact.
type tabCloseHandlers struct {
	captures *credential.CaptureRegistry
	log      log.Logger
}

// handleTabClose destroys the closed tab's pending captures. The validator has
// already refused a missing or oversized tabId; the defensive re-parse and
// the silent return on failure mirror ackHandler — a notification has no
// response to carry an error, and nothing is left half-destroyed.
func (h tabCloseHandlers) handleTabClose(_ context.Context, wconn *wsConn, req jsonrpcRequest) {
	var p tabCloseParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		h.log.Warn("tab.close invalid params")
		return
	}
	if h.captures != nil {
		h.captures.DestroyTab(connectionID(wconn), p.TabID)
	}
}
