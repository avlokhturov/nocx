package transport

// ledger.query / ledger.get — the read path of the one authoritative ledger
// (nocx-rtg0.20, design §6.2 and §6.6).
//
// ledger.query IS THE ONLY ORDERING IMPLEMENTATION. The frontend cache
// renders what it holds and never answers a recall query with an ordering of
// its own, or the same keystroke returns different results depending on which
// pane it came from. The order is ingest_seq DESC — the backend-assigned
// total order (§6.3), so two windows submitting inside one millisecond still
// have an order, which a wall clock cannot give them and a UUIDv7 does not
// claim to.
//
// WHAT CROSSES. Ledger facts, on the control plane, as AD-1 permits since
// nocx-m64b — never a raw byte and never a chunk body. The detail read
// returns artifact METADATA precisely because "the recall read must not haul
// bytes" (ADR-0019 §6): the bodies are fetched one artifact at a time, by
// whoever actually wants them.
//
// WHAT THIS FILE DOES NOT DECIDE. Three facts have owners elsewhere and are
// READ here, never re-derived:
//
//   - the host a row ran on — the environment resolved by the page's own
//     join (nocx-rtg0.25, Environment.Host);
//   - the redaction receipt — content.EntryMaskingOf over the entry payload
//     the open wrote (nocx-rtg0.24). Re-running the detector over the stored
//     text would be a second owner of one fact, and would mask text that is
//     already masked;
//   - the exit code — content.ShellExitCodeOf over the shell arm of the same
//     payload.
//
// The result shapes are declared once in contracts/ledger.query.schema.json
// and contracts/ledger.get.schema.json.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/secrets"
)

// ── wire shapes ───────────────────────────────────────────────────────────

// ledgerEntryWire is one row of recall. It carries every per-entry column
// history.query's contract declares, plus the ledger's own identity (seq and
// the environment), so the cutover in nocx-rtg0.19 is a mapping rather than a
// second read.
//
// Nothing here is omitempty: the schema requires every key, and a field that
// disappears when it is empty is a field the renderer has to special-case.
type ledgerEntryWire struct {
	ID    string `json:"id"`
	Seq   int64  `json:"seq"`
	EnvID string `json:"environmentId"`
	// Host is the environment's endpoint, "" for the local machine — and
	// NULL when no environment row carries the entry's environment_id, which
	// is "unknown" and must not be rendered as "local".
	Host        *string `json:"host"`
	Cwd         string  `json:"cwd"`
	Kind        string  `json:"kind"`
	Intent      string  `json:"intent"`
	Phase       string  `json:"phase"`
	Status      string  `json:"status"`
	SubmittedAt int64   `json:"submittedAt"`
	StartedAt   *int64  `json:"startedAt"`
	EndedAt     *int64  `json:"endedAt"`
	DurationMs  *int64  `json:"durationMs"`
	// ExitCode is the shell arm's fact. Null is a real value — an
	// interrupted command has none — and is never rendered as zero.
	ExitCode    *int            `json:"exitCode"`
	MaskedCount int             `json:"maskedCount"`
	MaskedKinds []string        `json:"maskedKinds"`
	Redactions  []redactionWire `json:"redactions"`
}

// ledgerQueryResponse is the page plus the three facts that keep it honest.
//
// hasRows is the one that looks redundant and is not: it separates "the
// ledger answered and had nothing" from "the ledger has nothing to answer
// from". history.query turns it into source=store vs source=session, and a
// reader that cannot tell them apart renders "no history" for "history is
// off".
type ledgerQueryResponse struct {
	Entries   []ledgerEntryWire `json:"entries"`
	Scope     string            `json:"scope"`
	Exhausted bool              `json:"exhausted"`
	HasRows   bool              `json:"hasRows"`
	Coverage  *int64            `json:"coverage"`
}

// ledgerEdgeWire is one relation touching the entry, in either direction.
type ledgerEdgeWire struct {
	From    string          `json:"from"`
	To      string          `json:"to"`
	Rel     string          `json:"rel"`
	Payload json.RawMessage `json:"payload"`
}

// ledgerArtifactWire is one artifact's METADATA and its capture provenance
// (ADR-0019 §6: derived text must be able to say how it was taken). There is
// no field for the bodies, deliberately — the shape is what makes "the
// recall read must not haul bytes" true rather than merely intended.
type ledgerArtifactWire struct {
	ID             string          `json:"id"`
	ExecutionID    int64           `json:"executionId"`
	MediaType      string          `json:"mediaType"`
	DerivedFrom    *string         `json:"derivedFrom"`
	State          string          `json:"state"`
	ByteLen        int64           `json:"byteLen"`
	ChunkCount     int             `json:"chunkCount"`
	Pinned         bool            `json:"pinned"`
	Truncated      *string         `json:"truncated"`
	CaptureMethod  string          `json:"captureMethod"`
	CaptureVersion int             `json:"captureVersion"`
	TerminalCols   *int            `json:"terminalCols"`
	TerminalRows   *int            `json:"terminalRows"`
	Stream         *string         `json:"stream"`
	ByteOffset     *int64          `json:"byteOffset"`
	ByteEnd        *int64          `json:"byteEnd"`
	Encoding       string          `json:"encoding"`
	Gaps           []ledgerGapWire `json:"gaps"`
	Payload        json.RawMessage `json:"payload"`
}

// ledgerGapWire is one dropped byte range in a captured stream.
type ledgerGapWire struct {
	Start  int64  `json:"start"`
	End    int64  `json:"end"`
	Reason string `json:"reason"`
}

// ledgerGetResponse is the detail read (§6.2): the entry, its edges and its
// artifact metadata. The entry is the SAME shape a page row has, so one
// mapping serves both — two mappings of one shape disagree the first time
// either grows a field.
type ledgerGetResponse struct {
	Entry     ledgerEntryWire      `json:"entry"`
	Edges     []ledgerEdgeWire     `json:"edges"`
	Artifacts []ledgerArtifactWire `json:"artifacts"`
}

// ── params ────────────────────────────────────────────────────────────────

// ledgerQueryParams is the request. There is deliberately no params schema
// (contracts/README.md): the handler is the check and rejects what it cannot
// parse.
//
//	scope         — required; directory | host | everywhere
//	environmentId — required for scope=directory and scope=host
//	cwd           — required for scope=directory
//	kind, status  — optional; the closed enums, refused when unknown
//	text          — optional; the search box, a case-insensitive substring
//	                over the intent within the rung. history.query's filter
//	                (nocx-ms7v) over the ledger's column, so the overlay's
//	                box means the same thing after the cutover as before it
//	since         — optional; a wall-clock floor on submitted_at
//	before        — optional; the paging cursor, an ingest_seq
//	limit         — optional; <1 → 50, above the ceiling → the ceiling
type ledgerQueryParams struct {
	Scope         string  `json:"scope"`
	EnvironmentID *string `json:"environmentId"`
	Cwd           *string `json:"cwd"`
	Kind          *string `json:"kind"`
	Status        *string `json:"status"`
	Text          *string `json:"text"`
	Since         *int64  `json:"since"`
	Before        *int64  `json:"before"`
	Limit         *int    `json:"limit"`
}

type ledgerGetParams struct {
	ID string `json:"id"`
}

// defaultLedgerPageLimit is the page size when the caller sends none. It is
// deliberately history.query's: one product object — a page of recall — with
// two page sizes is how the two drift apart.
const defaultLedgerPageLimit = defaultHistoryPageLimit

// ── the handler ───────────────────────────────────────────────────────────

// ledgerReadHandlers answers ledger.query and ledger.get. It holds the
// LedgerOperation (nil → the content store is not wired) and the Responder;
// never the *WSServer, and never the connection — a read needs no session.
type ledgerReadHandlers struct {
	op capability.LedgerOperation // nil → content store not wired
	r  Responder
}

func (h ledgerReadHandlers) handleQuery(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "method not found: content store not wired"})
		return
	}
	var p ledgerQueryParams
	if msg := decodeParams(req.Params, &p); msg != "" {
		h.invalid(req, msg)
		return
	}
	q, msg := ledgerQueryOf(p)
	if msg != "" {
		h.invalid(req, msg)
		return
	}

	var out ledgerQueryResponse
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.LedgerService) error {
		page, err := svc.QueryEntries(ctx, q)
		if err != nil {
			return err
		}
		// Never nil: no matches is [] (the schema says so, and a null throws
		// the overlay's first .map — the nocx-25k9.14 defect class).
		entries := make([]ledgerEntryWire, 0, len(page.Entries))
		for _, row := range page.Entries {
			wire, err := ledgerEntryWireOf(row)
			if err != nil {
				return err
			}
			entries = append(entries, wire)
		}
		out = ledgerQueryResponse{
			Entries: entries, Scope: string(q.Scope),
			Exhausted: page.Exhausted, HasRows: page.HasRows, Coverage: page.Coverage,
		}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req, err)
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(out))
}

func (h ledgerReadHandlers) handleGet(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "method not found: content store not wired"})
		return
	}
	var p ledgerGetParams
	if msg := decodeParams(req.Params, &p); msg != "" {
		h.invalid(req, msg)
		return
	}
	if msg := validateLedgerGet(p); msg != "" {
		h.invalid(req, msg)
		return
	}

	var out ledgerGetResponse
	// An id no row carries is a fact about the REQUEST, so it is reported as
	// invalid params rather than as a server fault — and never as an empty
	// success, which reads as "that command left no trace".
	missing := false
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.LedgerService) error {
		row, err := svc.Entry(ctx, p.ID)
		if err != nil {
			return err
		}
		if row == nil {
			missing = true
			return nil
		}
		entry, err := ledgerEntryWireOf(row.Summary())
		if err != nil {
			return err
		}
		edges, err := svc.Edges(ctx, p.ID)
		if err != nil {
			return err
		}
		wireEdges := make([]ledgerEdgeWire, 0, len(edges))
		for _, e := range edges {
			payload, err := ledgerRawObject(e.Payload, "edge payload")
			if err != nil {
				return err
			}
			wireEdges = append(wireEdges, ledgerEdgeWire{
				From: e.From, To: e.To, Rel: string(e.Rel), Payload: payload,
			})
		}
		// The artifacts of every execution of this entry, flattened: they
		// attach to the run, and the run's id rides each one, so a caller
		// that cares which attempt produced what still can tell.
		artifacts := []ledgerArtifactWire{}
		for _, ex := range row.Executions {
			for _, a := range ex.Artifacts {
				wire, err := ledgerArtifactWireOf(a)
				if err != nil {
					return err
				}
				artifacts = append(artifacts, wire)
			}
		}
		out = ledgerGetResponse{Entry: entry, Edges: wireEdges, Artifacts: artifacts}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req, err)
		return
	}
	if missing {
		h.invalid(req, fmt.Sprintf("no ledger entry carries id %q", p.ID))
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(out))
}

func (h ledgerReadHandlers) invalid(req jsonrpcRequest, msg string) {
	_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: " + msg})
}

// ── mapping ───────────────────────────────────────────────────────────────

// ledgerEntryWireOf is the ONE mapping from a stored row to the wire, used by
// both the page and the detail read. The two sparse readers it calls are the
// owners of their keys; this function decides nothing about them.
func ledgerEntryWireOf(row content.LedgerEntrySummary) (ledgerEntryWire, error) {
	masking, err := content.EntryMaskingOf(row.Payload)
	if err != nil {
		return ledgerEntryWire{}, err
	}
	exit, err := content.ShellExitCodeOf(row.Payload)
	if err != nil {
		return ledgerEntryWire{}, err
	}
	// The store slices BYTES; the renderer decorates UTF-16 code units. The
	// conversion happens once, here at the wire, exactly as history.query
	// does it — one owner for "where does this segment sit on screen".
	reds := make([]redactionWire, 0, len(masking.Redactions))
	for _, red := range masking.Redactions {
		start, end := secrets.ToUTF16Span(row.Intent, red.Start, red.End)
		reds = append(reds, redactionWire{
			Kind: red.Kind, Start: start, End: end, Prefix: red.Prefix, Suffix: red.Suffix,
		})
	}
	kinds := masking.MaskedKinds
	if kinds == nil {
		kinds = []string{}
	}
	var host *string
	if row.Environment != nil {
		h := row.Environment.Host()
		host = &h
	}
	return ledgerEntryWire{
		ID: row.ID, Seq: row.IngestSeq, EnvID: row.EnvironmentID, Host: host,
		Cwd: row.Cwd, Kind: string(row.Kind), Intent: row.Intent,
		Phase: string(row.Phase), Status: string(row.Status),
		SubmittedAt: row.SubmittedAt, StartedAt: row.StartedAt, EndedAt: row.EndedAt,
		DurationMs: row.DurationMs, ExitCode: exit,
		MaskedCount: masking.MaskedCount, MaskedKinds: kinds, Redactions: reds,
	}, nil
}

func ledgerArtifactWireOf(a content.Artifact) (ledgerArtifactWire, error) {
	payload, err := ledgerRawObject(a.Payload, "artifact payload")
	if err != nil {
		return ledgerArtifactWire{}, err
	}
	gaps := make([]ledgerGapWire, 0, len(a.Gaps))
	for _, g := range a.Gaps {
		gaps = append(gaps, ledgerGapWire{Start: g.Start, End: g.End, Reason: g.Reason})
	}
	var truncated *string
	if a.Truncated != nil {
		v := string(*a.Truncated)
		truncated = &v
	}
	var stream *string
	if a.Stream != nil {
		v := string(*a.Stream)
		stream = &v
	}
	return ledgerArtifactWire{
		ID: a.ID, ExecutionID: a.ExecutionID, MediaType: string(a.MediaType),
		DerivedFrom: a.DerivedFrom, State: string(a.State), ByteLen: a.ByteLen,
		ChunkCount: a.ChunkCount, Pinned: a.Pinned, Truncated: truncated,
		CaptureMethod: string(a.CaptureMethod), CaptureVersion: a.CaptureVersion,
		TerminalCols: a.TerminalCols, TerminalRows: a.TerminalRows, Stream: stream,
		ByteOffset: a.ByteOffset, ByteEnd: a.ByteEnd, Encoding: a.Encoding,
		Gaps: gaps, Payload: payload,
	}, nil
}

// ledgerRawObject puts a stored sparse-extension column on the wire as the
// JSON object it is. An empty column is the empty object — the column's own
// default, and "this row carries no extension". Anything else that does not
// parse is refused rather than repaired: a payload the store cannot read is
// corruption, and answering with {} would hide it.
func ledgerRawObject(payload, what string) (json.RawMessage, error) {
	if strings.TrimSpace(payload) == "" {
		return json.RawMessage("{}"), nil
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &probe); err != nil {
		return nil, fmt.Errorf("%s is not a JSON object: %w", what, err)
	}
	return json.RawMessage(payload), nil
}

// ── validation ────────────────────────────────────────────────────────────

// ledgerQueryOf turns the request into the store's own query, or names what
// is wrong with it. Everything it refuses would otherwise come back as an
// empty page, and an empty page is the answer most likely to be believed:
// "nothing ever failed on this host" is indistinguishable from "you
// misspelled the status".
//
// The rung's coordinates are checked for PRESENCE, not for a non-empty
// value — "" is a legitimate cwd (a command whose directory was never known)
// — with one exception: an environment id is a hash and the empty string is
// not one, so a rung whose environment is "" would match nothing at all.
func ledgerQueryOf(p ledgerQueryParams) (content.LedgerQuery, string) {
	var q content.LedgerQuery
	switch p.Scope {
	case "directory":
		q.Scope = content.ScopeDirectory
	case "host":
		q.Scope = content.ScopeHost
	case "everywhere":
		q.Scope = content.ScopeEverywhere
	default:
		return q, "scope must be one of directory, host, everywhere"
	}
	if p.EnvironmentID != nil {
		q.EnvironmentID = *p.EnvironmentID
	}
	if p.Cwd != nil {
		q.Cwd = *p.Cwd
	}
	if q.Scope != content.ScopeEverywhere && q.EnvironmentID == "" {
		return q, "environmentId is required for scope=directory and scope=host"
	}
	if q.Scope == content.ScopeDirectory && p.Cwd == nil {
		return q, "cwd is required for scope=directory"
	}
	if p.Kind != nil {
		switch content.EntryKind(*p.Kind) {
		case content.EntryShell, content.EntryAgent, content.EntryAction:
			q.Kind = content.EntryKind(*p.Kind)
		default:
			return q, "kind must be one of shell, agent, action"
		}
	}
	if p.Status != nil {
		switch content.EntryStatus(*p.Status) {
		case content.EntryPending, content.EntryRunning, content.EntrySuccess,
			content.EntryFailure, content.EntryInterrupted, content.EntryUnknown:
			q.Status = content.EntryStatus(*p.Status)
		default:
			return q, "status must be one of pending, running, success, failure, interrupted, unknown"
		}
	}
	// Absent and empty are the same state on the wire — no filter — exactly
	// as history.query treats them: the client omits the field when the search
	// box is empty, and clearing the box sends "". The needle crosses
	// VERBATIM: it is bound as a parameter, never spliced into SQL, and it is
	// not trimmed or case-folded here, because the store owns the matching
	// rule and a second owner would be a second semantics.
	if p.Text != nil {
		q.Text = *p.Text
	}
	if p.Since != nil {
		if *p.Since < 0 {
			return q, "since must be epoch milliseconds"
		}
		q.Since = p.Since
	}
	if p.Before != nil {
		// The cursor is an ingest_seq, which starts at 1. It is deliberately
		// NOT the interim history path's row id: seq is this design's total
		// order and the two are never mixed.
		if *p.Before < 1 {
			return q, "before must be the seq of the entry the previous page ended at"
		}
		q.Before = p.Before
	}
	// The limit is CLAMPED rather than refused — the page size is a product
	// contract, not a rejection — but it is never unbounded: an unbounded
	// limit is a denial of service the renderer can trigger by accident.
	q.Limit = defaultLedgerPageLimit
	if p.Limit != nil {
		q.Limit = *p.Limit
		if q.Limit < 1 {
			q.Limit = defaultLedgerPageLimit
		} else if q.Limit > content.MaxLedgerPageLimit {
			q.Limit = content.MaxLedgerPageLimit
		}
	}
	return q, ""
}

func validateLedgerGet(p ledgerGetParams) string {
	if strings.TrimSpace(p.ID) == "" || utf8.RuneCountInString(p.ID) > maxIDRunes {
		return "id is required and bounded"
	}
	return ""
}

func validateLedgerQueryRaw(raw json.RawMessage) string {
	var p ledgerQueryParams
	if msg := decodeParams(raw, &p); msg != "" {
		return msg
	}
	_, msg := ledgerQueryOf(p)
	return msg
}

func validateLedgerGetRaw(raw json.RawMessage) string {
	var p ledgerGetParams
	if msg := decodeParams(raw, &p); msg != "" {
		return msg
	}
	return validateLedgerGet(p)
}
