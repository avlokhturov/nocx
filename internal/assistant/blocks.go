package assistant

// The block tools (nocx-5u3oz.6): list the finished blocks this run was
// granted, and read a WINDOW of one.
//
// WHY THEY EXIST. In nocx a finished command's rows LEAVE the xterm grid at
// the block freeze and the DOM owns them — the renderer's clearViewport says
// it in as many words: "the grid only ever holds the running command's rows,
// and the DOM owns the scrollback". So readScreen, which reads the grid,
// answers a screenful of empty lines for everything that has already
// finished, which is everything the person is looking at. A run asked "what
// command did I run?" over a screen full of `df` output read 33 empty rows
// and went guessing at ~/.bash_history.
//
// WHERE THE TEXT COMES FROM, and this is the decision the bead asked to be
// made explicitly: the LEDGER, not the renderer. ADR-0019 decision 1 is one
// authoritative ledger with disposable projections, and the DOM scrollback
// is a projection of it — the renderer already writes every frozen block
// there (history.record for the row, ledger.capture for the two bodies), so
// reading the record is reading what the renderer put there rather than
// asking it to re-derive it. It needs no renderer round trip, so it has no
// timeout and no "the tab is gone" hang; it survives a closed tab; and it
// reuses the query, the paging and the artifact read that already exist
// instead of growing a second enumeration of blocks beside them.
//
// What that costs is named on the return rather than hidden: a block whose
// body the store never kept (history off, output retention off, a sensitive
// command) is listed with bodyKept false and reads as a stated absence, and
// a body the capture truncated says so (truncated: "cap" — the middle went,
// the head and tail are what the store has).
//
// The SEAM is BlockSource below. Authority is not on it: the capability
// (agenttools.BlockReader) holds the grant's sessions and the executor
// refuses an out-of-grant session BEFORE the source is asked, exactly as
// readScreen and run do — the request never leaves the process.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/agenttools"
)

// defaultBlockListLimit is how many blocks one blocks.list answers with when
// the model names no limit: enough to cover "what have I been doing" without
// spending the run's context on a page nobody reads. The reply says whether
// older blocks remain.
const defaultBlockListLimit = 10

// maxBlockListLimit is the ceiling on one page, matching the params schema.
const maxBlockListLimit = 50

// defaultBlockLines and maxBlockLines bound one blocks.read window in LINES
// (the unit the model aims with, because the total it was given is a line
// count). The byte bound below is the second, independent one.
const (
	defaultBlockLines = 200
	maxBlockLines     = 2000
)

// maxBlockWindowBytes is the context budget of one window: a block may hold
// a quarter of a megabyte, and the run must not spend it on one call. A
// window the bound cuts short says so in the window it returns — never a
// silent truncation (design §4.4).
const maxBlockWindowBytes = 64 << 10

// ErrBlockNotFound is the one answer to "no block of this session carries
// that id". It is deliberately the SAME answer for an id that does not exist
// and for an id that exists in another pane or another session: the model
// learns nothing about a block it may not read, not even that it is there.
var ErrBlockNotFound = errors.New("no such block in this session")

// BlockSource is the seam the block tools read the granted session's
// finished blocks through. The transport implements it over the ledger — it
// is the side that can resolve which pane a session is the pipe of, which is
// what a block is anchored to (ws_ledger.go: entries.session_id is
// deliberately NULL and pane_id is the durable anchor) — and it applies that
// scope itself, so a row outside the granted session's pane is never in the
// answer to be filtered.
//
// It is infrastructure, not authority: the capability decides WHICH sessions
// this run may name, and this decides how a block of a named session is
// read. Nil for a run the transport did not wire it into, which the tools
// report honestly rather than answering with an empty list.
type BlockSource interface {
	// ListBlocks returns the newest limit blocks of sessionID's pane, newest
	// first, and whether older ones remain. A session the process does not
	// hold is an error, never an empty list — "no blocks" and "no such
	// session" must not look alike.
	ListBlocks(ctx context.Context, sessionID string, limit int) (BlockList, error)
	// ReadBlock returns the window [start, start+count) of one block's
	// output, clamped to what the block holds, together with the total. A
	// block sessionID's pane does not carry — including one that exists
	// elsewhere — is ErrBlockNotFound.
	ReadBlock(ctx context.Context, sessionID, blockID string, start, count int) (BlockWindow, error)
}

// BlockSummary is one row of the list: what the model needs to choose a
// block, and the total it needs to aim a window at.
type BlockSummary struct {
	// ID is the ledger entry id — exactly what blocks.read takes.
	ID string
	// Command is the command as it was recorded, which is the MASKED text:
	// the durable command is always the masked one (ws_ledger.go), so a
	// secret the person typed is not handed to the model by this tool.
	Command string
	// Status is the block's frozen outcome (success | failure | interrupted
	// | unknown), and ExitCode the shell's code when the row carries one.
	Status   string
	ExitCode *int
	// Lines is how many lines of output the store kept for this block —
	// the total blocks.read's window is aimed with. Zero with BodyKept
	// false means no body was kept at all.
	Lines int
	// BodyKept says whether the store holds this block's output. False is a
	// FACT, not a failure: history off, output retention off, or a command
	// marked sensitive.
	BodyKept bool
	// EndedAt is when the command finished, Unix milliseconds, when the row
	// carries it.
	EndedAt *int64
}

// BlockList is one page of the session's blocks, newest first.
type BlockList struct {
	Blocks []BlockSummary
	// More reports that older blocks exist beyond this page.
	More bool
}

// BlockWindow is one block's facts plus the window of its output that was
// actually read. Start/End are the span the source returned — clamped to the
// block, so a window past the end is the empty span at Total rather than an
// error.
type BlockWindow struct {
	Command   string
	Status    string
	ExitCode  *int
	Total     int
	Start     int
	End       int
	Text      string
	BodyKept  bool
	Truncated string // "cap" when the stored body dropped its middle at capture
}

// ── the returns the model reads ──────────────────────────────────────────

type blocksListResult struct {
	SessionID string          `json:"sessionId"`
	Returned  int             `json:"returned"`
	More      bool            `json:"more"`
	Blocks    []blocksListRow `json:"blocks"`
	Note      string          `json:"note,omitempty"`
	_         struct{}        `json:"-"`
}

type blocksListRow struct {
	BlockID  string `json:"blockId"`
	Command  string `json:"command"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exitCode"`
	Lines    int    `json:"lines"`
	BodyKept bool   `json:"bodyKept"`
	EndedAt  *int64 `json:"endedAt,omitempty"`
}

type blocksReadResult struct {
	SessionID string    `json:"sessionId"`
	BlockID   string    `json:"blockId"`
	Command   string    `json:"command"`
	Status    string    `json:"status"`
	ExitCode  *int      `json:"exitCode"`
	Total     int       `json:"total"`
	Window    blockSpan `json:"window"`
	Returned  blockSpan `json:"returned"`
	Text      string    `json:"text"`
	BodyKept  bool      `json:"bodyKept"`
	Truncated string    `json:"truncated,omitempty"`
	Note      string    `json:"note,omitempty"`
}

type blockSpan struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// ── the executors ────────────────────────────────────────────────────────

// executeBlocksList runs blocks.list: the narrowed capability gates the
// session, then the source answers from the pane's record. The capability
// check happens BEFORE the read — naming a session outside the grant is
// refused here and nothing is ever queried (the bead's first and third
// criteria, asserted by trying).
func executeBlocksList(ctx context.Context, reader *agenttools.BlockReader, source BlockSource, args json.RawMessage) (string, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		Limit     int    `json:"limit"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		// Unreachable through the middleware (validation precedes policy,
		// let alone execution); the direct-call seam still answers honestly.
		return "", fmt.Errorf("blocks.list: args: %w", err)
	}
	if !reader.Allows(p.SessionID) {
		return "", fmt.Errorf("blocks.list: session %q is outside the run's grant — nothing was read", p.SessionID)
	}
	if source == nil {
		return "", errors.New("blocks.list: no block source is wired for this run")
	}
	limit := p.Limit
	if limit <= 0 {
		limit = defaultBlockListLimit
	}
	if limit > maxBlockListLimit {
		limit = maxBlockListLimit
	}
	list, err := source.ListBlocks(ctx, p.SessionID, limit)
	if err != nil {
		return "", fmt.Errorf("blocks.list: %w", err)
	}
	out := blocksListResult{
		SessionID: p.SessionID,
		Returned:  len(list.Blocks),
		More:      list.More,
		Blocks:    make([]blocksListRow, 0, len(list.Blocks)),
	}
	for _, b := range list.Blocks {
		out.Blocks = append(out.Blocks, blocksListRow{
			BlockID: b.ID, Command: b.Command, Status: b.Status, ExitCode: b.ExitCode,
			Lines: b.Lines, BodyKept: b.BodyKept, EndedAt: b.EndedAt,
		})
	}
	if len(out.Blocks) == 0 {
		// An empty page and an unanswerable question must not look alike:
		// the model is told this is what the record holds for this session,
		// so it asks the person rather than inventing a history.
		out.Note = "this session has recorded no finished blocks yet"
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("blocks.list: marshal result: %w", err)
	}
	return string(b), nil
}

// executeBlocksRead runs blocks.read: the same narrowing, then one window of
// one block. A window past the end of the output is answered honestly — the
// window asked for is echoed, the window returned is what the block could
// give, and the total says where it stops (design §4.4).
func executeBlocksRead(ctx context.Context, reader *agenttools.BlockReader, source BlockSource, args json.RawMessage) (string, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		BlockID   string `json:"blockId"`
		Start     int    `json:"start"`
		Count     int    `json:"count"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", fmt.Errorf("blocks.read: args: %w", err)
	}
	if p.Start < 0 {
		return "", errors.New("blocks.read: a window starts at line 0 or later")
	}
	if !reader.Allows(p.SessionID) {
		return "", fmt.Errorf("blocks.read: session %q is outside the run's grant — nothing was read", p.SessionID)
	}
	if p.BlockID == "" {
		return "", errors.New("blocks.read: a blockId is required — blocks.list spells them")
	}
	if source == nil {
		return "", errors.New("blocks.read: no block source is wired for this run")
	}
	count := p.Count
	if count <= 0 {
		count = defaultBlockLines
	}
	if count > maxBlockLines {
		count = maxBlockLines
	}
	win, err := source.ReadBlock(ctx, p.SessionID, p.BlockID, p.Start, count)
	if err != nil {
		return "", fmt.Errorf("blocks.read: %w", err)
	}
	text, end := boundBlockText(win.Text, win.Start, win.End)
	out := blocksReadResult{
		SessionID: p.SessionID,
		BlockID:   p.BlockID,
		Command:   win.Command,
		Status:    win.Status,
		ExitCode:  win.ExitCode,
		Total:     win.Total,
		Window:    blockSpan{Start: p.Start, End: p.Start + count},
		Returned:  blockSpan{Start: win.Start, End: end},
		Text:      text,
		BodyKept:  win.BodyKept,
		Truncated: win.Truncated,
	}
	switch {
	case !win.BodyKept:
		out.Note = "this block's output was not kept: history or output retention is off, or the command was marked sensitive"
	case win.Truncated == "cap":
		out.Note = "the stored body was capped when it was captured: the middle of the output is gone, the head and the tail are what the store has"
	case p.Start >= win.Total && win.Total > 0:
		out.Note = "the window starts past the end of the output; total is where it stops"
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("blocks.read: marshal result: %w", err)
	}
	return string(b), nil
}

// boundBlockText applies the window's BYTE bound — the line count is what
// the model aims with, and this is the budget it cannot overrun with 2000
// very long lines. It cuts on a line boundary and returns the end the
// returned window must state, so the reply never claims lines it did not
// carry.
func boundBlockText(text string, start, end int) (string, int) {
	if len(text) <= maxBlockWindowBytes {
		return text, end
	}
	kept := 0
	lines := 0
	for kept < len(text) {
		nl := indexNewline(text[kept:])
		width := nl + 1
		if nl < 0 {
			width = len(text) - kept
		}
		if kept+width > maxBlockWindowBytes {
			break
		}
		kept += width
		lines++
	}
	out := text[:kept]
	// A single line longer than the whole budget would keep nothing at all;
	// answer with the head of it rather than with an empty window that reads
	// as "the block printed nothing".
	if lines == 0 {
		return text[:maxBlockWindowBytes], start + 1
	}
	if len(out) > 0 && out[len(out)-1] == '\n' {
		out = out[:len(out)-1]
	}
	return out, start + lines
}

func indexNewline(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return i
		}
	}
	return -1
}
