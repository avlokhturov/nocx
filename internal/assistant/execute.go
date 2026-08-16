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
	"fmt"

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
