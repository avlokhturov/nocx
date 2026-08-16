package assistant

import (
	"context"
	"encoding/json"
)

// FrameRegion is an absolute buffer row span [Start, End) of a session's
// screen. The renderer interprets it against ITS grid; the backend never
// re-derives terminal geometry (AD-6). Nil means "the visible screen".
type FrameRegion struct {
	Start int
	End   int
}

// RendererRequester is the seam a renderer-executed tool (design §2.2,
// §6.6 — Executes: InRenderer) asks the renderer through. The transport
// adapts its request broker to this interface at the run: the broker mints
// the request id, correlates the resolution over the same socket, and
// returns the frame body as it crossed the wire, validated (bounded,
// shape-checked) before the executor ever decodes it.
//
// The frame body is deliberately opaque here: the frame wire vocabulary
// (cells, attributes, capture identity) is owned by the transport's
// captureFrame validation, and this seam consumes it rather than recreating
// it — the executor decodes only the fields its return contract needs
// (design §4.4's window), never the full frame type.
type RendererRequester interface {
	// RequestScreen asks the renderer to capture sessionID's screen — the
	// same frame shape the renderer pushes for agent.captureFrame, pulled —
	// and returns the validated frame body (rows, cursor, capture identity).
	// A session the run cannot read must be refused HERE or before: the
	// capability check happens before this call, and a failed capture is a
	// returned error, never a hang.
	RequestScreen(ctx context.Context, sessionID string, region *FrameRegion) (json.RawMessage, error)
}
