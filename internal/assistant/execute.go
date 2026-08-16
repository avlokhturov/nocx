package assistant

// The execution layer: one function per executable tool, each running the
// tool against ITS narrowed capability (design §6.6 — the only step that
// differs, and it differs by exactly the declaration row). The middleware
// sequences and enforces; this layer performs. An executor never re-checks
// the grant — it cannot: it holds only the capability, which is already
// scoped to the grant (ADR-0028 decision 4).
//
// The window contract (design §4.4): every tool that returns text returns a
// window — total, an explicit window, and a statement of which window was
// actually returned — so one files.read on a large log cannot consume the
// context the run needs. The window is the tool's own return contract
// (contracts/tools/files.read.schema.json states it), not a parameter.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/shady2k/nocx/internal/agenttools"
	"github.com/shady2k/nocx/internal/filesystem"
)

// filesReadWindowBytes is the window the files.read tool returns: the first
// this-many bytes of the file. It is a context budget, not a file limit —
// the window statement tells the model how much more the file holds.
const filesReadWindowBytes = 64 << 10

// executors maps tool name to the function that runs it against its narrowed
// capability. One entry per executable tool. The middleware consults it only
// after the declaration's Narrow produced a capability; a tool that executes
// InGo must have an entry here, enforced by TestExecutorsCoverTheRegistry
// (a new row with a Narrow but no executor is a registration that cannot
// run).
var executors = map[string]func(ctx context.Context, cap agenttools.Capability, args json.RawMessage) (string, error){
	"files.read": executeFilesRead,
}

// filesReadResult is the tool's return: total (the file's size), the window
// that was ACTUALLY returned (which clamps to the file — a window past the
// end is answered honestly, never as an error), and the text. Binary content
// is reported as data, not pasted: Binary=true and no text.
type filesReadResult struct {
	Path     string          `json:"path"`
	Total    int64           `json:"total"`
	Window   filesReadWindow `json:"window"`
	Returned int64           `json:"returned"`
	Binary   bool            `json:"binary,omitempty"`
	Text     string          `json:"text,omitempty"`
}

type filesReadWindow struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

// executeFilesRead runs the files.read tool: read the named path through the
// scoped capability (the grant's paths), return the window. The capability
// refuses an out-of-scope path structurally; the policy already refused or
// escalated it at the gate, and this refusal is the backstop that holds even
// if the policy is bypassed.
func executeFilesRead(ctx context.Context, cap agenttools.Capability, args json.RawMessage) (string, error) {
	scoped, ok := cap.(*filesystem.ScopedReader)
	if !ok {
		return "", fmt.Errorf("files.read: capability is %T, not *filesystem.ScopedReader", cap)
	}
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		// Unreachable through the middleware (validation precedes policy,
		// let alone execution); the direct-call seam still answers honestly.
		return "", fmt.Errorf("files.read: args: %w", err)
	}
	c, err := scoped.Read(ctx, p.Path, filesReadWindowBytes)
	if err != nil {
		return "", err
	}
	out := filesReadResult{
		Path:  c.Path,
		Total: c.Total,
		Window: filesReadWindow{
			Start: 0,
			End:   c.Size,
		},
		Returned: c.Size,
		Binary:   c.Binary,
		Text:     c.Text,
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("files.read: marshal result: %w", err)
	}
	return string(b), nil
}

// ── readScreen (design §4.1: the agent reads the screen through the
//    renderer, because the renderer owns the grid — AD-6) ──────────────────

// readScreenResult is the readScreen tool's return contract (design §4.4 —
// every tool that returns text returns a window): total (the screen's
// height), the window that was asked for, the window that was actually
// returned (the frame's row span — a region past the end clamps rather than
// erroring), the text of the returned rows, and the capture facts (cursor +
// identity) so the model can reason about what it read.
type readScreenResult struct {
	SessionID string            `json:"sessionId"`
	Total     int               `json:"total"`
	Window    readScreenWindow  `json:"window"`
	Returned  readScreenWindow  `json:"returned"`
	Text      string            `json:"text"`
	Cursor    *readScreenCursor `json:"cursor,omitempty"`
	Identity  *readScreenIdent  `json:"identity,omitempty"`
}

type readScreenWindow struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type readScreenCursor struct {
	Line int `json:"line"`
	Col  int `json:"col"`
}

// readScreenIdent is the capture identity the frame carried (buffer
// instance, geometry, generation) — the same facts the push path records,
// consumed here in the minimal shape this tool's return needs.
type readScreenIdent struct {
	Buffer struct {
		Kind string `json:"kind"`
	} `json:"buffer"`
	Cols       int `json:"cols"`
	Rows       int `json:"rows"`
	Generation int `json:"generation"`
}

// frameBodyWire is this tool's consumer view of the validated frame body the
// requester returned (rows, cursor, identity). The frame wire vocabulary is
// owned by the transport's captureFrame validation; this decode reads the
// fields the window contract needs and never re-validates them.
type frameBodyWire struct {
	Rows []struct {
		Kind  string `json:"kind"`
		Cells []struct {
			Char string `json:"char"`
		} `json:"cells"`
		Text string `json:"text"`
	} `json:"rows"`
	Cursor *struct {
		Line int `json:"line"`
		Col  int `json:"col"`
	} `json:"cursor"`
	Identity *struct {
		Buffer struct {
			Kind string `json:"kind"`
		} `json:"buffer"`
		Cols       int `json:"cols"`
		Rows       int `json:"rows"`
		Generation int `json:"generation"`
	} `json:"identity"`
	Range *struct {
		Start int `json:"start"`
		End   int `json:"end"`
	} `json:"range"`
}

// executeReadScreen runs the readScreen tool: the narrowed session
// capability (the grant's sessions) gates the call, and the renderer
// produces the frame through the run's requester seam. The capability check
// happens BEFORE the request — naming a session outside the grant is
// refused here and no broker request ever leaves (criterion 2, asserted by
// trying).
func executeReadScreen(ctx context.Context, reader *agenttools.ScreenReader, requester RendererRequester, args json.RawMessage) (string, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		Region    *struct {
			Start int `json:"start"`
			End   int `json:"end"`
		} `json:"region"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		// Unreachable through the middleware (validation precedes policy,
		// let alone execution); the direct-call seam still answers honestly.
		return "", fmt.Errorf("readScreen: args: %w", err)
	}
	if p.Region != nil && (p.Region.Start < 0 || p.Region.End <= p.Region.Start) {
		return "", fmt.Errorf("readScreen: a region must be a non-negative span with end greater than start")
	}
	if !reader.Allows(p.SessionID) {
		return "", fmt.Errorf("readScreen: session %q is outside the run's grant — the request never reached the renderer", p.SessionID)
	}
	var region *FrameRegion
	if p.Region != nil {
		region = &FrameRegion{Start: p.Region.Start, End: p.Region.End}
	}
	body, err := requester.RequestScreen(ctx, p.SessionID, region)
	if err != nil {
		return "", err
	}
	var frame frameBodyWire
	if decodeErr := json.Unmarshal(body, &frame); decodeErr != nil {
		return "", fmt.Errorf("readScreen: frame body: %w", decodeErr)
	}
	if frame.Identity == nil {
		return "", errors.New("readScreen: the renderer's frame carried no capture identity")
	}

	// The window: what was asked for (the region, or the whole screen) and
	// what the frame actually returned (its row span — the renderer clamps
	// a region past the end rather than erroring, and the window states it).
	total := frame.Identity.Rows
	asked := readScreenWindow{Start: 0, End: total}
	if p.Region != nil {
		asked = readScreenWindow{Start: p.Region.Start, End: p.Region.End}
	}
	returned := asked
	if frame.Range != nil {
		returned = readScreenWindow{Start: frame.Range.Start, End: frame.Range.End}
	}

	var lines []string
	for _, row := range frame.Rows {
		if row.Kind == "text" {
			lines = append(lines, row.Text)
			continue
		}
		var b strings.Builder
		for _, c := range row.Cells {
			b.WriteString(c.Char)
		}
		lines = append(lines, b.String())
	}
	out := readScreenResult{
		SessionID: p.SessionID,
		Total:     total,
		Window:    asked,
		Returned:  returned,
		Text:      strings.Join(lines, "\n"),
	}
	if frame.Cursor != nil {
		out.Cursor = &readScreenCursor{Line: frame.Cursor.Line, Col: frame.Cursor.Col}
	}
	out.Identity = &readScreenIdent{
		Buffer: struct {
			Kind string `json:"kind"`
		}{Kind: frame.Identity.Buffer.Kind},
		Cols:       frame.Identity.Cols,
		Rows:       frame.Identity.Rows,
		Generation: frame.Identity.Generation,
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("readScreen: marshal result: %w", err)
	}
	return string(b), nil
}
