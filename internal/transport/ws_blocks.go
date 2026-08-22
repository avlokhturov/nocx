package transport

// The block source (nocx-5u3oz.6): the transport half of blocks.list and
// blocks.read. It answers the agent's two block tools from the LEDGER — the
// authoritative record of what has been run (ADR-0019 decision 1: one
// authoritative ledger, disposable projections) — rather than from the
// renderer, and internal/assistant/blocks.go carries the whole argument for
// that choice. There is no wire method here and no renderer round trip: the
// renderer already wrote every one of these rows (history.record for the
// entry, ledger.capture for the body), and this reads them back.
//
// WHAT IS SCOPED, AND WHERE. The run's grant names a SESSION, and a block is
// anchored to a PANE — entries.session_id is deliberately NULL for a command
// and pane_id is the durable anchor (ws_ledger.go says why). So the scope of
// a granted session is derived here, from the one owner of that fact: the
// session says which pane it is the pipe of, and when it was opened. Blocks
// of another tab are another pane; blocks recorded before this session
// existed — the same pane, an earlier run of the app — are before its floor.
// Neither is ever in the answer to be filtered: the query carries both
// bounds, and the read applies the same predicate to the row it resolves, so
// an id guessed from another pane answers exactly as an id that never
// existed (assistant.ErrBlockNotFound).
//
// The ledger handle is the raw repository, the same one the tool pipeline's
// attempt writes use (ws_agent.go's attemptLedger) and for the same reason:
// a tool runs on the ask stream, outside the content queue, and taking the
// content gate here would put a tool call behind the queue that is waiting
// for it. The wire methods keep the gate; this is not one.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/shady2k/nocx/internal/assistant"
	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/session"
)

// blockScope is what a granted session narrows to in the ledger's own
// vocabulary: the pane its blocks are anchored to, and the wall-clock floor
// below which a row belongs to an earlier session of the same pane.
type blockScope struct {
	paneID string
	since  int64
}

// blockScopeFor resolves the granted session to its ledger scope. A session
// this backend does not hold, or one attached to no recorded pane, is an
// ERROR and never an empty list: "this session has no blocks" and "there is
// no such session" must not look alike, or a model reads the second as the
// first and tells the person they have run nothing.
func (s *WSServer) blockScopeFor(sessionID string) (blockScope, error) {
	if s.registry == nil {
		return blockScope{}, errors.New("no session registry is wired")
	}
	sess, err := s.registry.Get(session.ID(sessionID))
	if err != nil {
		return blockScope{}, fmt.Errorf("no such session: %s", sessionID)
	}
	pane := sess.PaneID()
	if pane == "" {
		return blockScope{}, errors.New("this session is attached to no recorded pane, so none of its blocks are in the record")
	}
	// The floor INCLUDES the millisecond the session opened in: a row
	// stamped in that same tick cannot be attributed either way, and
	// counting it in errs toward showing the person's own pane rather than
	// hiding a block they are looking at.
	return blockScope{paneID: pane, since: sess.OpenedAt().UnixMilli()}, nil
}

// ledgerForBlocks is the repository the two reads run against, or nil when
// the content store is not wired in this build.
func (s *WSServer) ledgerForBlocks() content.LedgerRepository {
	if s.contentDB == nil {
		return nil
	}
	return s.contentDB.Ledger()
}

// ListBlocks implements assistant.BlockSource: the newest blocks of the
// granted session's pane, newest first (the ledger's own ingest_seq order),
// each with the total the model aims a window with.
//
// The line count costs a read per row — the recall page carries an entry's
// metadata and never its bytes (LedgerRepository.Entry), so a total can only
// come from the body. That is why the page is small by default: the tool's
// limit is ten unless the model asks for more, and fifty at most.
func (s *WSServer) ListBlocks(ctx context.Context, sessionID string, limit int) (assistant.BlockList, error) {
	ledger := s.ledgerForBlocks()
	if ledger == nil {
		return assistant.BlockList{}, errors.New("no content store is wired, so nothing has been recorded to read")
	}
	scope, err := s.blockScopeFor(sessionID)
	if err != nil {
		return assistant.BlockList{}, err
	}
	since := scope.since
	page, err := ledger.QueryEntries(ctx, content.LedgerQuery{
		Scope:  content.ScopeEverywhere,
		PaneID: scope.paneID,
		Since:  &since,
		Limit:  limit,
	})
	if err != nil {
		return assistant.BlockList{}, err
	}
	out := assistant.BlockList{
		Blocks: make([]assistant.BlockSummary, 0, len(page.Entries)),
		More:   !page.Exhausted,
	}
	for _, row := range page.Entries {
		summary := assistant.BlockSummary{
			ID:      row.ID,
			Command: row.Intent,
			Status:  string(row.Status),
			EndedAt: row.EndedAt,
		}
		if code, codeErr := content.ShellExitCodeOf(row.Payload); codeErr == nil {
			summary.ExitCode = code
		}
		body, bodyErr := s.blockBody(ctx, ledger, row.ID)
		if bodyErr != nil {
			return assistant.BlockList{}, bodyErr
		}
		summary.BodyKept = body.kept
		if body.kept {
			summary.Lines = len(splitBlockLines(body.text))
		}
		out.Blocks = append(out.Blocks, summary)
	}
	return out, nil
}

// ReadBlock implements assistant.BlockSource: one window of one block's
// output. The window is clamped to what the block holds and the span that
// comes back is the one that was actually read — a window past the end is
// the empty span at the total, never an error (design §4.4).
func (s *WSServer) ReadBlock(ctx context.Context, sessionID, blockID string, start, count int) (assistant.BlockWindow, error) {
	ledger := s.ledgerForBlocks()
	if ledger == nil {
		return assistant.BlockWindow{}, errors.New("no content store is wired, so nothing has been recorded to read")
	}
	scope, err := s.blockScopeFor(sessionID)
	if err != nil {
		return assistant.BlockWindow{}, err
	}
	entry, err := ledger.Entry(ctx, blockID)
	if err != nil {
		return assistant.BlockWindow{}, err
	}
	// The SAME predicate the list query carries, applied to the row an id
	// resolved to. A block of another pane, or of an earlier session of this
	// pane, answers exactly as an id that names nothing: the model learns
	// nothing about a block it may not read, not even that it exists.
	if entry == nil || entry.PaneID == nil || *entry.PaneID != scope.paneID || entry.SubmittedAt < scope.since {
		return assistant.BlockWindow{}, assistant.ErrBlockNotFound
	}

	win := assistant.BlockWindow{
		Command: entry.Intent,
		Status:  string(entry.Status),
	}
	if code, codeErr := content.ShellExitCodeOf(entry.Payload); codeErr == nil {
		win.ExitCode = code
	}
	body, err := s.blockBody(ctx, ledger, blockID)
	if err != nil {
		return assistant.BlockWindow{}, err
	}
	win.BodyKept = body.kept
	win.Truncated = body.truncated
	if !body.kept {
		return win, nil
	}
	lines := splitBlockLines(body.text)
	win.Total = len(lines)
	begin := start
	if begin > win.Total {
		begin = win.Total
	}
	end := begin + count
	if end > win.Total {
		end = win.Total
	}
	win.Start, win.End = begin, end
	win.Text = strings.Join(lines[begin:end], "\n")
	return win, nil
}

// blockBodyResult is what the store kept for one block: the text, whether it
// kept anything at all, and whether what it kept lost its middle to the
// capture cap.
type blockBodyResult struct {
	text      string
	kept      bool
	truncated string
}

// blockBody reads one block's plain body. Two artifacts hang on a frozen
// block — the SGR body a restore draws, and the plain body derived from it,
// which is what search, copy and this read use (capture-client.ts) — so this
// takes the derived one and never re-derives text from the escape sequences.
// No such artifact is not a failure: history off, output retention off or a
// sensitive command all end here, and the tools state it as an absence
// rather than as an empty output.
//
// The shape of the read — entry, then its execution's artifacts, then the
// artifact's chunks — is the one capability.agentService.FrameText already
// uses: the recall read never hauls bytes, so the body is a second,
// deliberate fetch.
func (s *WSServer) blockBody(ctx context.Context, ledger content.LedgerRepository, entryID string) (blockBodyResult, error) {
	entry, err := ledger.Entry(ctx, entryID)
	if err != nil {
		return blockBodyResult{}, err
	}
	if entry == nil {
		return blockBodyResult{}, nil
	}
	for _, ex := range entry.Executions {
		for _, a := range ex.Artifacts {
			if a.MediaType != content.MediaText {
				continue
			}
			art, artErr := ledger.Artifact(ctx, a.ID)
			if artErr != nil {
				return blockBodyResult{}, artErr
			}
			if art == nil {
				// The metadata is there and the body is not: retention
				// evicted it. A hole, and it is reported as one (ADR-0019
				// §7) rather than as an empty output.
				continue
			}
			var sb strings.Builder
			for _, c := range art.Chunks {
				sb.Write(c)
			}
			out := blockBodyResult{text: sb.String(), kept: true}
			if a.Truncated != nil {
				out.truncated = string(*a.Truncated)
			}
			return out, nil
		}
	}
	return blockBodyResult{}, nil
}

// splitBlockLines is the ONE derivation of a block's lines. The captured
// body is the block's rows joined by '\n' by the serializer, and a row never
// contains one, so the split is exact. An empty body is ZERO lines and not
// one empty line: a command that printed nothing has no output to window.
func splitBlockLines(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}
