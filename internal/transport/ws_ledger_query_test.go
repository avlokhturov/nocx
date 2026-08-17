package transport

// ledger.query / ledger.get over the REAL socket into the REAL store
// (nocx-rtg0.20) — the read path, and the only ordering implementation
// (design §6.2).
//
// Written from the bead's acceptance criteria: every filter is proved by
// what it EXCLUDES, an empty answer is [] rather than null, an unknown id is
// an error rather than an empty success, and the detail read carries
// artifact METADATA without the bytes.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/ssh"
)

// ── decoding helpers ──────────────────────────────────────────────────────

// queriedEntry names the fields these tests assert on. It is deliberately
// NOT the handler's DTO: the exact key set is the contract test's job
// (additionalProperties:false plus required), and a test that reuses the
// implementation's struct cannot notice a field the handler never sends.
type queriedEntry struct {
	ID          string   `json:"id"`
	Seq         int64    `json:"seq"`
	EnvID       string   `json:"environmentId"`
	Host        *string  `json:"host"`
	Cwd         string   `json:"cwd"`
	Kind        string   `json:"kind"`
	Intent      string   `json:"intent"`
	Phase       string   `json:"phase"`
	Status      string   `json:"status"`
	SubmittedAt int64    `json:"submittedAt"`
	StartedAt   *int64   `json:"startedAt"`
	EndedAt     *int64   `json:"endedAt"`
	DurationMs  *int64   `json:"durationMs"`
	ExitCode    *int     `json:"exitCode"`
	MaskedCount int      `json:"maskedCount"`
	MaskedKinds []string `json:"maskedKinds"`
	Redactions  []struct {
		Kind   string `json:"kind"`
		Start  int    `json:"start"`
		End    int    `json:"end"`
		Prefix string `json:"prefix"`
		Suffix string `json:"suffix"`
	} `json:"redactions"`
}

type queriedPage struct {
	Entries   []queriedEntry `json:"entries"`
	Scope     string         `json:"scope"`
	Exhausted bool           `json:"exhausted"`
	HasRows   bool           `json:"hasRows"`
	Coverage  *int64         `json:"coverage"`
}

func queryCall(t *testing.T, conn *websocket.Conn, params map[string]any, id int) queriedPage {
	t.Helper()
	resp := vaultCall(t, conn, "ledger.query", params, id)
	if resp.Error != nil {
		t.Fatalf("ledger.query %+v: %+v", params, resp.Error)
	}
	var page queriedPage
	if err := json.Unmarshal(resp.Result, &page); err != nil {
		t.Fatalf("decode ledger.query result: %v\nraw: %s", err, resp.Result)
	}
	return page
}

func queriedIDs(page queriedPage) []string {
	out := make([]string, 0, len(page.Entries))
	for _, e := range page.Entries {
		out = append(out, e.ID)
	}
	return out
}

// wantQueried asserts the page holds exactly these ids in this order —
// naming the whole set is what makes a silently ignored filter fail.
func wantQueried(t *testing.T, page queriedPage, ids ...string) {
	t.Helper()
	got := queriedIDs(page)
	if strings.Join(got, ",") != strings.Join(ids, ",") {
		t.Fatalf("page = %v, want exactly %v", got, ids)
	}
}

// openEntry drives one ledger.open over the socket.
func openEntry(t *testing.T, conn *websocket.Conn, sid, id, intent string, rpcID int) {
	t.Helper()
	_, errObj := ledgerCall(t, conn, "ledger.open",
		map[string]any{"envelope": ledgerEnv(sid, id, intent, 1)}, rpcID)
	if errObj != nil {
		t.Fatalf("ledger.open %s: %+v", id, errObj)
	}
}

// openEntryIn drives a ledger.open whose envelope names a directory of its
// own — the coordinate the directory rung filters on.
func openEntryIn(t *testing.T, conn *websocket.Conn, sid, id, cwd, kind, intent string, rpcID int) {
	t.Helper()
	env := ledgerEnv(sid, id, intent, 1)
	env["cwd"] = cwd
	env["kind"] = kind
	_, errObj := ledgerCall(t, conn, "ledger.open", map[string]any{"envelope": env}, rpcID)
	if errObj != nil {
		t.Fatalf("ledger.open %s: %+v", id, errObj)
	}
}

// closeEntryOverWire ends an entry with a status and an exit code.
func closeEntryOverWire(t *testing.T, conn *websocket.Conn, sid, id, status string, exit int, rpcID int) {
	t.Helper()
	_, errObj := ledgerCall(t, conn, "ledger.close", map[string]any{
		"envelope": ledgerEnv(sid, id, "make test", 2),
		"status":   status,
		"facts":    map[string]any{"terminationReason": "completed", "exitCode": exit},
	}, rpcID)
	if errObj != nil {
		t.Fatalf("ledger.close %s: %+v", id, errObj)
	}
}

// ── the empty answer ─────────────────────────────────────────────────────

// An empty result is {"entries": []} and never null — off the real socket,
// read out of the raw JSON rather than through a Go decode, which turns null
// into an empty slice and hides exactly this. The renderer's first .map is
// what a null throws in (nocx-25k9.14).
func TestLedgerQuery_EmptyAnswerIsAnArrayNotNull(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)

	resp := vaultCall(t, conn, "ledger.query", map[string]any{"scope": "everywhere"}, 2)
	if resp.Error != nil {
		t.Fatalf("ledger.query on an empty store: %+v", resp.Error)
	}
	if !strings.Contains(string(resp.Result), `"entries":[]`) {
		t.Fatalf("empty result does not carry an empty array: %s", resp.Result)
	}
	var page queriedPage
	if err := json.Unmarshal(resp.Result, &page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if page.HasRows {
		t.Fatal("hasRows on a ledger that holds nothing")
	}
	if !page.Exhausted {
		t.Fatal("an empty page is not exhausted")
	}
	if page.Coverage != nil {
		t.Fatalf("coverage = %d with nothing recorded", *page.Coverage)
	}
	if page.Scope != "everywhere" {
		t.Fatalf("scope = %q, want the rung that was asked for", page.Scope)
	}
}

// The subtle one, off the socket: a rung that matches nothing in a ledger
// that holds rows answers hasRows=true with an empty page. history.query
// turns that into source=store; collapsing it into "no rows" ships a UI
// saying "no history" when it means "history is off".
func TestLedgerQuery_HasRowsSeparatesAnEmptyAnswerFromAnEmptyLedger(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	openEntry(t, conn, sid, "entry-1", "make test", 2)

	page := queryCall(t, conn, map[string]any{
		"scope": "directory", "environmentId": localEnvironmentID(), "cwd": "/nowhere",
	}, 3)
	if len(page.Entries) != 0 {
		t.Fatalf("the rung /nowhere answered %v", queriedIDs(page))
	}
	if !page.HasRows {
		t.Fatal("hasRows is false while the ledger holds a row the rung did not match")
	}
}

// localEnvironmentID is the id a local session's environment hashes to —
// the same derivation environmentForSession runs (EnvironmentIDFor), which
// is how a caller holding a host turns it into a rung coordinate.
func localEnvironmentID() string {
	return content.EnvironmentIDFor(content.EnvLocal, "")
}

// ── ordering ─────────────────────────────────────────────────────────────

// seq DESC, off the socket. Three opens in a row land inside the same
// millisecond often enough that this is the case wall-clock ordering gets
// wrong; the assertion is on the seq the acks carry, so it holds either way.
func TestLedgerQuery_OrdersBySeqDescOverTheWire(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	openEntry(t, conn, sid, "entry-1", "one", 2)
	openEntry(t, conn, sid, "entry-2", "two", 3)
	openEntry(t, conn, sid, "entry-3", "three", 4)

	page := queryCall(t, conn, map[string]any{"scope": "everywhere"}, 5)
	wantQueried(t, page, "entry-3", "entry-2", "entry-1")
	for i := 1; i < len(page.Entries); i++ {
		if page.Entries[i-1].Seq <= page.Entries[i].Seq {
			t.Fatalf("seq is not descending: %d then %d", page.Entries[i-1].Seq, page.Entries[i].Seq)
		}
	}
}

// ── the filters, each proved by what it excludes ─────────────────────────

func TestLedgerQuery_FiltersExcludeOverTheWire(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	openEntryIn(t, conn, sid, "here-shell", "/repo", "shell", "make test", 2)
	openEntryIn(t, conn, sid, "there-shell", "/other", "shell", "make lint", 3)
	openEntryIn(t, conn, sid, "here-agent", "/repo", "agent", "why did it fail", 4)
	closeEntryOverWire(t, conn, sid, "here-shell", "failure", 2, 5)

	t.Run("directory excludes another directory", func(t *testing.T) {
		page := queryCall(t, conn, map[string]any{
			"scope": "directory", "environmentId": localEnvironmentID(), "cwd": "/other",
		}, 10)
		wantQueried(t, page, "there-shell")
	})
	t.Run("kind excludes another kind", func(t *testing.T) {
		page := queryCall(t, conn, map[string]any{"scope": "everywhere", "kind": "agent"}, 11)
		wantQueried(t, page, "here-agent")
	})
	t.Run("status excludes another status", func(t *testing.T) {
		page := queryCall(t, conn, map[string]any{"scope": "everywhere", "status": "failure"}, 12)
		wantQueried(t, page, "here-shell")
	})
	t.Run("limit bounds the page and says it is not exhausted", func(t *testing.T) {
		page := queryCall(t, conn, map[string]any{"scope": "everywhere", "limit": 1}, 13)
		wantQueried(t, page, "here-agent")
		if page.Exhausted {
			t.Fatal("a page with two further entries behind it says it is exhausted")
		}
	})
	t.Run("before pages on seq and excludes what was already seen", func(t *testing.T) {
		all := queryCall(t, conn, map[string]any{"scope": "everywhere"}, 14)
		oldest := all.Entries[len(all.Entries)-1]
		page := queryCall(t, conn, map[string]any{"scope": "everywhere", "before": oldest.Seq}, 15)
		wantQueried(t, page)
		if !page.HasRows {
			t.Fatal("hasRows is false while the ledger holds every row the cursor skipped")
		}
	})
	t.Run("since excludes what came before it", func(t *testing.T) {
		all := queryCall(t, conn, map[string]any{"scope": "everywhere"}, 16)
		newest := all.Entries[0]
		page := queryCall(t, conn, map[string]any{
			"scope": "everywhere", "since": newest.SubmittedAt + 1,
		}, 17)
		wantQueried(t, page)
	})
}

// The environment rung, with a real remote session: the host rung answers
// from the environment it was asked for and excludes the other machine.
// The id is hashed forward with EnvironmentIDFor, which is how a host
// becomes a rung coordinate.
func TestLedgerQuery_HostRungExcludesTheOtherMachine(t *testing.T) {
	const sshHost = "build.example.com"
	logger := log.NewSlogAdapter(nil)
	db := newLedgerStore(t)
	reg := newRegWithStub(logger)
	reg.WithSSHFactory(&stubSSHFactory{
		connectFn: func(_ context.Context, _ string, _ ...ssh.ConnectOption) (ssh.Channel, error) {
			return ssh.NewStubChannel(logger), nil
		},
	})
	ws := NewWSServer(logger, reg,
		WithContentDB(db),
		WithProfileResolver(&fakeResolver{
			resolveFn: func(string) (string, *ssh.ConnectConfig, error) {
				return sshHost, &ssh.ConnectConfig{User: "alice", Port: 22}, nil
			},
		}),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)

	localSID := openLocalSession(t, conn)
	sshSID := openSSHSession(t, conn, 2)
	openEntry(t, conn, localSID, "local-entry", "make test", 3)
	openEntry(t, conn, sshSID, "ssh-entry", "make deploy", 4)

	remoteID := content.EnvironmentIDFor(content.EnvSSH, sshHost)
	page := queryCall(t, conn, map[string]any{"scope": "host", "environmentId": remoteID}, 5)
	wantQueried(t, page, "ssh-entry")
	if page.Entries[0].Host == nil || *page.Entries[0].Host != sshHost {
		t.Fatalf("the row does not say which host it ran on: %+v", page.Entries[0].Host)
	}

	local := queryCall(t, conn, map[string]any{"scope": "host", "environmentId": localEnvironmentID()}, 6)
	wantQueried(t, local, "local-entry")
	if local.Entries[0].Host == nil || *local.Entries[0].Host != "" {
		t.Fatalf("the local row's host = %v, want the empty string", local.Entries[0].Host)
	}
}

// ── the request is refused rather than answered wrongly ──────────────────

// A value the closed enums do not name is a rejected request, never an
// empty result set: an empty page for a misspelled status reads as "nothing
// ever failed here", which is the answer most likely to be believed.
func TestLedgerQuery_RefusesWhatItCannotAnswer(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	openEntry(t, conn, sid, "entry-1", "make test", 2)

	bad := map[string]map[string]any{
		"no scope":                 {},
		"unknown scope":            {"scope": "recent"},
		"unknown kind":             {"scope": "everywhere", "kind": "script"},
		"unknown status":           {"scope": "everywhere", "status": "ok"},
		"directory with no rung":   {"scope": "directory", "cwd": "/repo"},
		"directory with no cwd":    {"scope": "directory", "environmentId": localEnvironmentID()},
		"host with no environment": {"scope": "host"},
		"negative before":          {"scope": "everywhere", "before": -1},
		"negative since":           {"scope": "everywhere", "since": -1},
	}
	id := 10
	for name, params := range bad {
		t.Run(name, func(t *testing.T) {
			resp := vaultCall(t, conn, "ledger.query", params, id)
			id++
			if resp.Error == nil {
				t.Fatalf("ledger.query %+v answered %s rather than refusing", params, resp.Result)
			}
			if resp.Error.Code != -32602 {
				t.Fatalf("ledger.query %+v error code = %d, want -32602", params, resp.Error.Code)
			}
		})
	}
}

// A limit above the ceiling is CLAMPED rather than refused — the same
// product contract history.query's page limit carries, so one concept keeps
// one behaviour. What it must never be is unbounded.
func TestLedgerQuery_LimitAboveTheCeilingIsClamped(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	openEntry(t, conn, sid, "entry-1", "make test", 2)

	page := queryCall(t, conn, map[string]any{
		"scope": "everywhere", "limit": content.MaxLedgerPageLimit + 5000,
	}, 3)
	wantQueried(t, page, "entry-1")
}

// ── the redaction receipt rides the row ──────────────────────────────────

// The receipt is READ back out of the entry's payload (EntryMaskingOf,
// nocx-rtg0.24) rather than recomputed by re-running the detector over the
// stored text — which would be a second owner of one fact and would mask
// text that is already masked. The proof is that the recorded intent is the
// MASKED one and the counts still describe what was taken out of it.
func TestLedgerQuery_CarriesTheRedactionReceiptItWasWrittenWith(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	const secret = "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD" //nolint:gosec // a synthetic detector fixture
	openEntry(t, conn, sid, "entry-1", secret, 2)

	page := queryCall(t, conn, map[string]any{"scope": "everywhere"}, 3)
	wantQueried(t, page, "entry-1")
	row := page.Entries[0]
	if row.Intent == secret {
		t.Fatal("the recorded intent is the raw text — the durable command is always the masked one")
	}
	if row.MaskedCount != 1 {
		t.Fatalf("maskedCount = %d, want 1: %+v", row.MaskedCount, row)
	}
	if len(row.MaskedKinds) != 1 || row.MaskedKinds[0] != "openai" {
		t.Fatalf("maskedKinds = %v, want [openai]", row.MaskedKinds)
	}
	if len(row.Redactions) != 1 {
		t.Fatalf("redactions = %+v, want exactly the one segment the mask left", row.Redactions)
	}
	seg := row.Redactions[0]
	if seg.Start < 0 || seg.End > len([]rune(row.Intent))+len(row.Intent) || seg.Start >= seg.End {
		t.Fatalf("redaction span [%d:%d] does not address the stored intent %q", seg.Start, seg.End, row.Intent)
	}
	if row.Intent[seg.Start:seg.End] == "" {
		t.Fatalf("redaction span [%d:%d] selects nothing of %q", seg.Start, seg.End, row.Intent)
	}
}

// A clean command carries an empty receipt, never a null one: no mask is
// [] on both lists (contracts/history.query.schema.json).
func TestLedgerQuery_CleanCommandCarriesEmptyListsNotNull(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	openEntry(t, conn, sid, "entry-1", "make test", 2)

	resp := vaultCall(t, conn, "ledger.query", map[string]any{"scope": "everywhere"}, 3)
	if resp.Error != nil {
		t.Fatalf("ledger.query: %+v", resp.Error)
	}
	raw := string(resp.Result)
	if !strings.Contains(raw, `"maskedKinds":[]`) || !strings.Contains(raw, `"redactions":[]`) {
		t.Fatalf("a clean command's receipt is not empty arrays: %s", raw)
	}
}

// ── ledger.get ───────────────────────────────────────────────────────────

type gotEntry struct {
	Entry queriedEntry `json:"entry"`
	Edges []struct {
		From    string          `json:"from"`
		To      string          `json:"to"`
		Rel     string          `json:"rel"`
		Payload json.RawMessage `json:"payload"`
	} `json:"edges"`
	Artifacts []struct {
		ID            string  `json:"id"`
		ExecutionID   int64   `json:"executionId"`
		MediaType     string  `json:"mediaType"`
		State         string  `json:"state"`
		ByteLen       int64   `json:"byteLen"`
		ChunkCount    int     `json:"chunkCount"`
		CaptureMethod string  `json:"captureMethod"`
		Encoding      string  `json:"encoding"`
		Stream        *string `json:"stream"`
	} `json:"artifacts"`
}

// The detail read: the entry, its edges and its artifact METADATA. The
// bodies are absent because "the recall read must not haul bytes" — the raw
// result is searched for the chunk text, since a Go decode into a struct
// that names no such field could not see it.
func TestLedgerGet_ReturnsEdgesAndArtifactMetadataWithoutTheBytes(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	ctx := context.Background()

	openEntry(t, conn, sid, "entry-1", "make test", 2)
	openEntry(t, conn, sid, "entry-2", "make test again", 3)
	closeEntryOverWire(t, conn, sid, "entry-2", "success", 0, 4)

	led := db.Ledger()
	if err := led.AddEdge(ctx, content.Edge{
		From: "entry-2", To: "entry-1", Rel: content.RelRerunOf, Payload: `{}`,
	}); err != nil {
		t.Fatalf("AddEdge: %v", err)
	}
	row, err := led.Entry(ctx, "entry-2")
	if err != nil || row == nil || len(row.Executions) == 0 {
		t.Fatalf("Entry(entry-2) = %+v, %v — want a row with an execution", row, err)
	}
	const body = "the-output-bytes-nobody-asked-for"
	if _, err := led.AppendArtifact(ctx, content.AppendArtifact{
		ExecutionID: row.Executions[0].ID, ID: "artifact-1", MediaType: content.MediaText,
		CaptureMethod: content.CaptureRawOutput, CaptureVersion: 1, Encoding: "utf-8",
	}); err != nil {
		t.Fatalf("AppendArtifact: %v", err)
	}
	if err := led.AppendChunk(ctx, "artifact-1", []byte(body)); err != nil {
		t.Fatalf("AppendChunk: %v", err)
	}

	resp := vaultCall(t, conn, "ledger.get", map[string]any{"id": "entry-2"}, 5)
	if resp.Error != nil {
		t.Fatalf("ledger.get: %+v", resp.Error)
	}
	if strings.Contains(string(resp.Result), body) {
		t.Fatalf("ledger.get hauled the chunk bodies:\n%s", resp.Result)
	}
	var got gotEntry
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode ledger.get: %v\nraw: %s", err, resp.Result)
	}
	if got.Entry.ID != "entry-2" {
		t.Fatalf("entry = %q, want entry-2", got.Entry.ID)
	}
	if got.Entry.ExitCode == nil || *got.Entry.ExitCode != 0 {
		t.Fatalf("exitCode = %v, want 0 — null is not zero", got.Entry.ExitCode)
	}
	if len(got.Edges) != 1 || got.Edges[0].Rel != "rerun-of" ||
		got.Edges[0].From != "entry-2" || got.Edges[0].To != "entry-1" {
		t.Fatalf("edges = %+v, want the one rerun-of edge", got.Edges)
	}
	if len(got.Artifacts) != 1 {
		t.Fatalf("artifacts = %+v, want exactly one", got.Artifacts)
	}
	art := got.Artifacts[0]
	if art.ID != "artifact-1" || art.ExecutionID != row.Executions[0].ID {
		t.Fatalf("artifact = %+v, want the one appended to execution %d", art, row.Executions[0].ID)
	}
	if art.ByteLen != int64(len(body)) || art.ChunkCount != 1 {
		t.Fatalf("artifact metadata = %+v, want byteLen %d and one chunk", art, len(body))
	}
}

// An unknown id is an ERROR, never an empty success: an empty entry reads as
// "that command left no trace", which is a different fact from "no such id".
func TestLedgerGet_UnknownIDIsAnErrorNotAnEmptySuccess(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)

	resp := vaultCall(t, conn, "ledger.get", map[string]any{"id": "no-such-entry"}, 2)
	if resp.Error == nil {
		t.Fatalf("ledger.get on an unknown id answered %s", resp.Result)
	}
	if resp.Error.Code != -32602 {
		t.Fatalf("error code = %d, want -32602 (an id the caller sent that no row carries)", resp.Error.Code)
	}
	if missing := vaultCall(t, conn, "ledger.get", map[string]any{}, 3); missing.Error == nil {
		t.Fatalf("ledger.get with no id answered %s", missing.Result)
	}
}

// ── the store's failures reach the caller ────────────────────────────────

// Every external call this path makes has a test where it fails. The store
// is closed underneath the handler: both reads report the failure rather
// than answering with an empty page, which cannot be told from "no history".
func TestLedgerReadMethods_ReportAStoreFailure(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	openEntry(t, conn, sid, "entry-1", "make test", 2)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	for i, method := range []string{"ledger.query", "ledger.get"} {
		params := map[string]any{"scope": "everywhere"}
		if method == "ledger.get" {
			params = map[string]any{"id": "entry-1"}
		}
		resp := vaultCall(t, conn, method, params, 10+i)
		if resp.Error == nil {
			t.Fatalf("%s over a closed store answered %s", method, resp.Result)
		}
	}
}

// With no content store wired at all, the read methods say the method is not
// available rather than answering an empty page that reads as "no history".
func TestLedgerReadMethods_WithoutAContentStore(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	ws := NewWSServer(logger, newRegWithStub(logger))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)

	resp := vaultCall(t, conn, "ledger.query", map[string]any{"scope": "everywhere"}, 2)
	if resp.Error == nil {
		t.Fatalf("ledger.query with no store answered %s", resp.Result)
	}
	got := vaultCall(t, conn, "ledger.get", map[string]any{"id": "entry-1"}, 3)
	if got.Error == nil {
		t.Fatalf("ledger.get with no store answered %s", got.Result)
	}
}
