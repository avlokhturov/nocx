package transport

// ledger.open / ledger.bind / ledger.close over the REAL socket into the REAL
// store (nocx-rtg0.3). These are the bead's acceptance assertions, written
// from the brief rather than from the implementation: the phases walk
// forwards and only forwards, a close for an id nobody opened creates exactly
// one row from its envelope, every event is idempotent by (id, phase), and
// every store call this path makes has a test where that call fails.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/log"
)

// ── harness ───────────────────────────────────────────────────────────────

// newLedgerWSServer wires a WSServer over a REAL content store with a caller
// supplied logger — the ledger's drop rule is "dropped AND LOGGED", so the
// log is part of the contract and the test has to be able to read it. Same
// shape as newAgentWSServer, which cannot take a logger.
func newLedgerWSServer(t *testing.T, logger log.Logger, db content.ContentDB) (*WSServer, func()) {
	t.Helper()
	ctx := context.Background()
	ws := NewWSServer(logger, newRegWithStub(logger), WithContentDB(db))
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return ws, func() { _ = ws.Stop(ctx) }
}

// newLedgerStore opens a real, keyed content store in a temp dir.
func newLedgerStore(t *testing.T) content.ContentDB {
	t.Helper()
	dir := t.TempDir()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	db, err := content.Open(context.Background(), content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    key,
		Budget: content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8},
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("content.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// ledgerEnv builds the immutable envelope every ledger event repeats.
func ledgerEnv(sid, id, intent string, clientSeq int) map[string]any {
	return map[string]any{
		"id":          id,
		"sessionId":   sid,
		"cwd":         "/repo",
		"kind":        "shell",
		"intent":      intent,
		"sensitivity": "normal",
		"clientSeq":   clientSeq,
	}
}

type ledgerAck struct {
	ID          string `json:"id"`
	ClientSeq   int64  `json:"clientSeq"`
	Seq         int64  `json:"seq"`
	SubmittedAt int64  `json:"submittedAt"`
	Phase       string `json:"phase"`
	Outcome     string `json:"outcome"`
}

// ledgerCall sends one ledger.* request and decodes the ack.
func ledgerCall(t *testing.T, conn *websocket.Conn, method string, params map[string]any, id int) (ledgerAck, *jsonrpcErrorObj) {
	t.Helper()
	raw := jsonrpcCallWithID(t, conn, method, params, id)
	var env struct {
		Result ledgerAck        `json:"result"`
		Error  *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("decode %s response: %v\nraw: %s", method, err, raw)
	}
	return env.Result, env.Error
}

func mustEntry(t *testing.T, db content.ContentDB, id string) *content.LedgerEntry {
	t.Helper()
	e, err := db.Ledger().Entry(context.Background(), id)
	if err != nil {
		t.Fatalf("Entry(%q): %v", id, err)
	}
	if e == nil {
		t.Fatalf("no ledger row carries id %q", id)
	}
	return e
}

func entryCount(t *testing.T, db content.ContentDB) int {
	t.Helper()
	rows, err := db.Ledger().ListEntries(context.Background(), 1000)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	return len(rows)
}

// ── the happy path: the phases walk forwards ──────────────────────────────

// A user runs a command: the renderer opens the entry at submit, binds it at
// OSC 133 C and closes it at D. Off the real socket, into the real store, the
// row walks open → bound → closed and takes its final status.
func TestLedgerOpenBindClose_WalksThePhasesOverTheWire(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	env := ledgerEnv(sid, "entry-1", "make test", 1)

	ack, errObj := ledgerCall(t, conn, "ledger.open", map[string]any{"envelope": env}, 2)
	if errObj != nil {
		t.Fatalf("ledger.open error: %+v", errObj)
	}
	if ack.Outcome != "applied" || ack.Phase != "open" {
		t.Fatalf("open ack = %+v, want applied/open", ack)
	}
	if ack.Seq <= 0 {
		t.Fatalf("open ack seq = %d, want the backend-assigned ingest_seq", ack.Seq)
	}
	if ack.SubmittedAt <= 0 {
		t.Fatalf("open ack submittedAt = %d, want the store's wall clock", ack.SubmittedAt)
	}
	if ack.ClientSeq != 1 {
		t.Fatalf("open ack clientSeq = %d, want the envelope's 1 echoed back", ack.ClientSeq)
	}
	if row := mustEntry(t, db, "entry-1"); row.Phase != content.PhaseOpen || row.Status != content.EntryPending {
		t.Fatalf("after open: phase=%q status=%q, want open/pending", row.Phase, row.Status)
	}

	env2 := ledgerEnv(sid, "entry-1", "make test", 2)
	ack, errObj = ledgerCall(t, conn, "ledger.bind", map[string]any{"envelope": env2}, 3)
	if errObj != nil {
		t.Fatalf("ledger.bind error: %+v", errObj)
	}
	if ack.Outcome != "applied" || ack.Phase != "bound" {
		t.Fatalf("bind ack = %+v, want applied/bound", ack)
	}
	row := mustEntry(t, db, "entry-1")
	if row.Phase != content.PhaseBound {
		t.Fatalf("after bind: phase=%q, want bound", row.Phase)
	}
	if len(row.Executions) != 1 {
		t.Fatalf("after bind: %d executions, want exactly 1", len(row.Executions))
	}

	env3 := ledgerEnv(sid, "entry-1", "make test", 3)
	ack, errObj = ledgerCall(t, conn, "ledger.close", map[string]any{
		"envelope":   env3,
		"status":     "failure",
		"facts":      map[string]any{"terminationReason": "failed"},
		"durationMs": 2300,
	}, 4)
	if errObj != nil {
		t.Fatalf("ledger.close error: %+v", errObj)
	}
	if ack.Outcome != "applied" || ack.Phase != "closed" {
		t.Fatalf("close ack = %+v, want applied/closed", ack)
	}
	row = mustEntry(t, db, "entry-1")
	if row.Phase != content.PhaseClosed || row.Status != content.EntryFailure {
		t.Fatalf("after close: phase=%q status=%q, want closed/failure", row.Phase, row.Status)
	}
	if len(row.Executions) != 1 {
		t.Fatalf("after close: %d executions, want exactly 1", len(row.Executions))
	}
	ex := row.Executions[0]
	if ex.EndedAt == nil {
		t.Fatal("after close: the execution has no ended_at")
	}
	if ex.TerminationReason == nil || *ex.TerminationReason != content.TermFailed {
		t.Fatalf("after close: termination reason = %v, want failed", ex.TerminationReason)
	}
	if entryCount(t, db) != 1 {
		t.Fatalf("the whole cycle wrote %d rows, want exactly 1", entryCount(t, db))
	}
}

// ── §6.3 rule 3: a close for an unknown id creates its row ────────────────

// The open was lost (a socket that dropped between submit and ledger.open).
// The close carries the whole immutable envelope, so the row is created
// closed from it — environment, cwd, kind and intent all come from the
// envelope, and exactly ONE row appears.
func TestLedgerClose_ForAnIdNeverOpened_CreatesExactlyOneClosedRow(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	ack, errObj := ledgerCall(t, conn, "ledger.close", map[string]any{
		"envelope":   ledgerEnv(sid, "orphan-1", "git push", 7),
		"status":     "success",
		"facts":      map[string]any{"terminationReason": "completed"},
		"durationMs": 120,
	}, 2)
	if errObj != nil {
		t.Fatalf("ledger.close error: %+v", errObj)
	}
	if ack.Outcome != "applied" || ack.Phase != "closed" {
		t.Fatalf("close ack = %+v, want applied/closed", ack)
	}

	if n := entryCount(t, db); n != 1 {
		t.Fatalf("a close for an unknown id created %d rows, want exactly 1", n)
	}
	row := mustEntry(t, db, "orphan-1")
	if row.Phase != content.PhaseClosed || row.Status != content.EntrySuccess {
		t.Fatalf("phase=%q status=%q, want closed/success", row.Phase, row.Status)
	}
	if row.Cwd != "/repo" {
		t.Fatalf("cwd = %q, want the envelope's /repo", row.Cwd)
	}
	if row.Kind != content.EntryShell {
		t.Fatalf("kind = %q, want the envelope's shell", row.Kind)
	}
	if row.Intent != "git push" {
		t.Fatalf("intent = %q, want the envelope's text", row.Intent)
	}
	// The environment is derived by the BACKEND from the session, never
	// minted by the renderer (AD-7, environmentForSession): a local session
	// is the local environment's derived id.
	wantEnv := content.EnvironmentIDFor(content.EnvLocal, "")
	if row.EnvironmentID != wantEnv {
		t.Fatalf("environmentId = %q, want the backend-derived %q", row.EnvironmentID, wantEnv)
	}
	if len(row.Executions) != 1 {
		t.Fatalf("%d executions, want exactly 1 — a closed entry has a run", len(row.Executions))
	}
}

// ── §6.3 rule 2: phase is monotonic ───────────────────────────────────────

// A bind that arrives after the close (the outbox replayed out of order)
// leaves the row closed, answers `dropped`, and says so in the log. Never
// applied, and never silent.
func TestLedgerBindAfterClose_IsDroppedAndLogged(t *testing.T) {
	db := newLedgerStore(t)
	var buf syncBuffer
	logger := log.NewSlogAdapter(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	ws, stop := newLedgerWSServer(t, logger, db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	if _, errObj := ledgerCall(t, conn, "ledger.close", map[string]any{
		"envelope": ledgerEnv(sid, "late-1", "ls", 3),
		"status":   "success",
		"facts":    map[string]any{"terminationReason": "completed"},
	}, 2); errObj != nil {
		t.Fatalf("ledger.close error: %+v", errObj)
	}

	ack, errObj := ledgerCall(t, conn, "ledger.bind",
		map[string]any{"envelope": ledgerEnv(sid, "late-1", "ls", 2)}, 3)
	if errObj != nil {
		t.Fatalf("ledger.bind error: %+v", errObj)
	}
	if ack.Outcome != "dropped" {
		t.Fatalf("late bind outcome = %q, want dropped", ack.Outcome)
	}
	if ack.Phase != "closed" {
		t.Fatalf("late bind reported phase %q, want the unchanged closed", ack.Phase)
	}
	if row := mustEntry(t, db, "late-1"); row.Phase != content.PhaseClosed {
		t.Fatalf("after the late bind: phase=%q, want closed", row.Phase)
	}
	if logged := buf.String(); !strings.Contains(logged, "late-1") ||
		!strings.Contains(strings.ToLower(logged), "phase") {
		t.Fatalf("the dropped event was not logged:\n%s", logged)
	}
}

// An open that arrives after the bind is the same rule one rung lower.
func TestLedgerOpenAfterBind_IsDropped(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	if _, errObj := ledgerCall(t, conn, "ledger.bind",
		map[string]any{"envelope": ledgerEnv(sid, "back-1", "ls", 1)}, 2); errObj != nil {
		t.Fatalf("ledger.bind error: %+v", errObj)
	}
	ack, errObj := ledgerCall(t, conn, "ledger.open",
		map[string]any{"envelope": ledgerEnv(sid, "back-1", "ls", 0)}, 3)
	if errObj != nil {
		t.Fatalf("ledger.open error: %+v", errObj)
	}
	if ack.Outcome != "dropped" || ack.Phase != "bound" {
		t.Fatalf("late open ack = %+v, want dropped/bound", ack)
	}
}

// ── §6.3 rule 4: re-delivery in the same phase is a no-op ─────────────────

// Every event sent twice. Asserted by COUNTING rows and executions, never by
// the absence of an error: a second Submit that quietly aliased a second
// intent would raise no error at all.
func TestLedgerEventsSentTwice_ProduceOneRowAndOneExecution(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	open := map[string]any{"envelope": ledgerEnv(sid, "dup-1", "echo hi", 1)}
	bind := map[string]any{"envelope": ledgerEnv(sid, "dup-1", "echo hi", 2)}
	closeP := map[string]any{
		"envelope": ledgerEnv(sid, "dup-1", "echo hi", 3),
		"status":   "success",
		"facts":    map[string]any{"terminationReason": "completed"},
	}

	id := 2
	send := func(method string, p map[string]any, wantOutcome string) {
		t.Helper()
		ack, errObj := ledgerCall(t, conn, method, p, id)
		id++
		if errObj != nil {
			t.Fatalf("%s error: %+v", method, errObj)
		}
		if ack.Outcome != wantOutcome {
			t.Fatalf("%s outcome = %q, want %q", method, ack.Outcome, wantOutcome)
		}
	}

	send("ledger.open", open, "applied")
	send("ledger.open", open, "replay")
	send("ledger.bind", bind, "applied")
	send("ledger.bind", bind, "replay")
	send("ledger.close", closeP, "applied")
	send("ledger.close", closeP, "replay")

	if n := entryCount(t, db); n != 1 {
		t.Fatalf("six events produced %d rows, want exactly 1", n)
	}
	row := mustEntry(t, db, "dup-1")
	if len(row.Executions) != 1 {
		t.Fatalf("six events produced %d executions, want exactly 1", len(row.Executions))
	}
	if row.Phase != content.PhaseClosed {
		t.Fatalf("phase = %q, want closed", row.Phase)
	}
}

// ── the interval, with both ends ──────────────────────────────────────────

// "A row exists from the moment its open is accepted until it is closed or
// deleted." Both ends are asserted: the row is present and NOT closed for the
// whole open span, closed by the close, and gone only when the entry is
// deleted — there is no fourth exit (design §4.3).
func TestLedgerEntry_ExistsFromOpenUntilClosedOrDeleted(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)
	ctx := context.Background()

	if _, errObj := ledgerCall(t, conn, "ledger.open",
		map[string]any{"envelope": ledgerEnv(sid, "span-1", "sleep 1", 1)}, 2); errObj != nil {
		t.Fatalf("ledger.open error: %+v", errObj)
	}
	// The start of the interval, and every point inside it: present, not closed.
	for _, when := range []string{"after open", "after bind"} {
		if when == "after bind" {
			if _, errObj := ledgerCall(t, conn, "ledger.bind",
				map[string]any{"envelope": ledgerEnv(sid, "span-1", "sleep 1", 2)}, 3); errObj != nil {
				t.Fatalf("ledger.bind error: %+v", errObj)
			}
		}
		row := mustEntry(t, db, "span-1")
		if row.Phase == content.PhaseClosed {
			t.Fatalf("%s: the row is already closed", when)
		}
	}
	// The closing event.
	if _, errObj := ledgerCall(t, conn, "ledger.close", map[string]any{
		"envelope": ledgerEnv(sid, "span-1", "sleep 1", 3),
		"status":   "interrupted",
		"facts":    map[string]any{"terminationReason": "user-killed"},
	}, 4); errObj != nil {
		t.Fatalf("ledger.close error: %+v", errObj)
	}
	if row := mustEntry(t, db, "span-1"); row.Phase != content.PhaseClosed {
		t.Fatalf("after close: phase = %q, want closed", row.Phase)
	}
	// The other end: deletion, the only thing that removes the row.
	if err := db.Ledger().DeleteEntry(ctx, "span-1"); err != nil {
		t.Fatalf("DeleteEntry: %v", err)
	}
	got, err := db.Ledger().Entry(ctx, "span-1")
	if err != nil {
		t.Fatalf("Entry after delete: %v", err)
	}
	if got != nil {
		t.Fatal("the row survived its deletion")
	}
}

// ── secrets: the ledger is a durable writer of command text ───────────────

// history.record masks at the wire because the durable row must never carry a
// credential. ledger.open writes the same text to the same database, so it
// masks through the SAME owner — a second durable writer that did not would
// be the whole reason that rule exists.
func TestLedgerOpen_MasksTheIntentBeforeItIsDurable(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" //nolint:gosec // a synthetic detector fixture
	if _, errObj := ledgerCall(t, conn, "ledger.open",
		map[string]any{"envelope": ledgerEnv(sid, "sec-1", "export OPENAI_API_KEY="+secret, 1)}, 2); errObj != nil {
		t.Fatalf("ledger.open error: %+v", errObj)
	}
	row := mustEntry(t, db, "sec-1")
	if strings.Contains(row.Intent, secret) {
		t.Fatalf("the raw credential reached the durable intent: %q", row.Intent)
	}
}

// ── params: every reachable field is refused, never repaired ──────────────

func TestLedgerEvents_RefuseUnusableParams(t *testing.T) {
	db := newLedgerStore(t)
	ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
	defer stop()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	cases := []struct {
		name   string
		method string
		params map[string]any
	}{
		{"no envelope", "ledger.open", map[string]any{}},
		{"empty id", "ledger.open", map[string]any{"envelope": ledgerEnv(sid, "", "ls", 1)}},
		{"unknown kind", "ledger.open", map[string]any{"envelope": func() map[string]any {
			e := ledgerEnv(sid, "k-1", "ls", 1)
			e["kind"] = "sorcery"
			return e
		}()}},
		{"unknown sensitivity", "ledger.open", map[string]any{"envelope": func() map[string]any {
			e := ledgerEnv(sid, "k-2", "ls", 1)
			e["sensitivity"] = "secretish"
			return e
		}()}},
		{"negative clientSeq", "ledger.open", map[string]any{"envelope": ledgerEnv(sid, "k-3", "ls", -1)}},
		{"empty cwd", "ledger.open", map[string]any{"envelope": func() map[string]any {
			e := ledgerEnv(sid, "k-4", "ls", 1)
			e["cwd"] = "  "
			return e
		}()}},
		{"oversized intent", "ledger.open", map[string]any{"envelope": ledgerEnv(sid, "k-5", strings.Repeat("x", maxRecordCommandRunes+1), 1)}},
		{"unknown sessionId", "ledger.open", map[string]any{"envelope": ledgerEnv("deadbeefdeadbeefdeadbeefdeadbeef", "k-6", "ls", 1)}},
		{"unknown status", "ledger.close", map[string]any{
			"envelope": ledgerEnv(sid, "k-7", "ls", 1),
			"status":   "cromulent",
			"facts":    map[string]any{"terminationReason": "completed"},
		}},
		{"unknown termination reason", "ledger.close", map[string]any{
			"envelope": ledgerEnv(sid, "k-8", "ls", 1),
			"status":   "success",
			"facts":    map[string]any{"terminationReason": "vanished"},
		}},
		{"missing termination reason", "ledger.close", map[string]any{
			"envelope": ledgerEnv(sid, "k-9", "ls", 1),
			"status":   "success",
		}},
		{"unknown interactivity", "ledger.bind", map[string]any{
			"envelope": ledgerEnv(sid, "k-10", "ls", 1),
			"facts":    map[string]any{"interactivity": "telepathy"},
		}},
		{"negative durationMs", "ledger.close", map[string]any{
			"envelope":   ledgerEnv(sid, "k-11", "ls", 1),
			"status":     "success",
			"facts":      map[string]any{"terminationReason": "completed"},
			"durationMs": -5,
		}},
	}

	id := 2
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, errObj := ledgerCall(t, conn, tc.method, tc.params, id)
			id++
			if errObj == nil {
				t.Fatalf("%s accepted %s", tc.method, tc.name)
			}
			if errObj.Code != -32602 {
				t.Fatalf("%s answered code %d, want -32602 (%s)", tc.method, errObj.Code, errObj.Message)
			}
		})
	}
	if n := entryCount(t, db); n != 0 {
		t.Fatalf("refused requests wrote %d rows, want 0", n)
	}
}

// The method must not exist at all when no content store is wired: the
// caller's next move is to stop calling it, not to fix its arguments.
func TestLedgerEvents_WithoutAContentStore_AreMethodNotFound(t *testing.T) {
	ctx := context.Background()
	logger := log.NewSlogAdapter(nil)
	ws := NewWSServer(logger, newRegWithStub(logger))
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	sid := openLocalSession(t, conn)

	_, errObj := ledgerCall(t, conn, "ledger.open",
		map[string]any{"envelope": ledgerEnv(sid, "nostore-1", "ls", 1)}, 2)
	if errObj == nil {
		t.Fatal("ledger.open answered without a content store")
	}
	if errObj.Code != -32601 {
		t.Fatalf("code = %d, want -32601 (%s)", errObj.Code, errObj.Message)
	}
}

// ── the failure paths: one per store call this handler makes ──────────────

// failingLedgerDB is a real store with ONE ledger method replaced by a
// failure. Everything else is the real path, so the assertion after the
// failure is about the state the real store was actually left in.
type failingLedgerDB struct {
	content.ContentDB
	failOn string
	err    error
}

func (f *failingLedgerDB) Ledger() content.LedgerRepository {
	return &failingLedger{LedgerRepository: f.ContentDB.Ledger(), failOn: f.failOn, err: f.err}
}

type failingLedger struct {
	content.LedgerRepository
	failOn string
	err    error
}

func (l *failingLedger) Entry(ctx context.Context, id string) (*content.LedgerEntry, error) {
	if l.failOn == "Entry" {
		return nil, l.err
	}
	return l.LedgerRepository.Entry(ctx, id)
}

func (l *failingLedger) EnsureEnvironment(ctx context.Context, env content.Environment) error {
	if l.failOn == "EnsureEnvironment" {
		return l.err
	}
	return l.LedgerRepository.EnsureEnvironment(ctx, env)
}

func (l *failingLedger) RecordObservation(ctx context.Context, obs content.Observation) (int64, error) {
	if l.failOn == "RecordObservation" {
		return 0, l.err
	}
	return l.LedgerRepository.RecordObservation(ctx, obs)
}

func (l *failingLedger) Submit(ctx context.Context, in content.SubmitEntry) (content.SubmitResult, error) {
	if l.failOn == "Submit" {
		return content.SubmitResult{}, l.err
	}
	return l.LedgerRepository.Submit(ctx, in)
}

func (l *failingLedger) StartExecution(ctx context.Context, in content.StartExecution) (int64, error) {
	if l.failOn == "StartExecution" {
		return 0, l.err
	}
	return l.LedgerRepository.StartExecution(ctx, in)
}

func (l *failingLedger) FinishExecution(ctx context.Context, execID int64, end content.FinishExecution) error {
	if l.failOn == "FinishExecution" {
		return l.err
	}
	return l.LedgerRepository.FinishExecution(ctx, execID, end)
}

// Every external call this handler makes has a test where that call fails.
// The event is refused — never half-acknowledged — and the assertion names
// what is true on disk afterwards, because a partial write is what the next
// start has to recover from.
func TestLedgerEvents_EveryStoreCallFails(t *testing.T) {
	boom := errors.New("store is on fire")

	cases := []struct {
		failOn string
		// afterOpen is what the entry looks like once ledger.open has been
		// refused with this call failing.
		wantRowAfterOpen bool
	}{
		{failOn: "Entry", wantRowAfterOpen: false},
		{failOn: "EnsureEnvironment", wantRowAfterOpen: false},
		{failOn: "RecordObservation", wantRowAfterOpen: false},
		{failOn: "Submit", wantRowAfterOpen: false},
	}

	for _, tc := range cases {
		t.Run("open/"+tc.failOn, func(t *testing.T) {
			real := newLedgerStore(t)
			db := &failingLedgerDB{ContentDB: real, failOn: tc.failOn, err: boom}
			ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
			defer stop()
			conn := connectWS(t, ws)
			sid := openLocalSession(t, conn)

			_, errObj := ledgerCall(t, conn, "ledger.open",
				map[string]any{"envelope": ledgerEnv(sid, "fail-1", "ls", 1)}, 2)
			if errObj == nil {
				t.Fatalf("ledger.open succeeded with %s failing", tc.failOn)
			}
			if errObj.Code != -32603 {
				t.Fatalf("code = %d, want -32603 (%s)", errObj.Code, errObj.Message)
			}
			row, err := real.Ledger().Entry(context.Background(), "fail-1")
			if err != nil {
				t.Fatalf("Entry: %v", err)
			}
			if (row != nil) != tc.wantRowAfterOpen {
				t.Fatalf("row present = %v, want %v", row != nil, tc.wantRowAfterOpen)
			}
		})
	}

	// StartExecution fails on the bind. The entry keeps its row and stays
	// OPEN: the intent is not lost, and the startup sweep closes it unknown
	// at the next start (design §4.3) — that is the recovery, and it needs
	// the row to still be there.
	t.Run("bind/StartExecution", func(t *testing.T) {
		real := newLedgerStore(t)
		db := &failingLedgerDB{ContentDB: real, failOn: "StartExecution", err: boom}
		ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
		defer stop()
		conn := connectWS(t, ws)
		sid := openLocalSession(t, conn)

		if _, errObj := ledgerCall(t, conn, "ledger.open",
			map[string]any{"envelope": ledgerEnv(sid, "fail-2", "ls", 1)}, 2); errObj != nil {
			t.Fatalf("ledger.open error: %+v", errObj)
		}
		_, errObj := ledgerCall(t, conn, "ledger.bind",
			map[string]any{"envelope": ledgerEnv(sid, "fail-2", "ls", 2)}, 3)
		if errObj == nil {
			t.Fatal("ledger.bind succeeded with StartExecution failing")
		}
		row := mustEntry(t, real, "fail-2")
		if row.Phase != content.PhaseOpen {
			t.Fatalf("phase = %q, want the unchanged open", row.Phase)
		}
		if len(row.Executions) != 0 {
			t.Fatalf("%d executions, want 0 — StartExecution is one transaction", len(row.Executions))
		}
	})

	// FinishExecution fails on the close. The run stays live and the entry
	// stays bound; nothing is reported closed that is not.
	t.Run("close/FinishExecution", func(t *testing.T) {
		real := newLedgerStore(t)
		db := &failingLedgerDB{ContentDB: real, failOn: "FinishExecution", err: boom}
		ws, stop := newLedgerWSServer(t, log.NewSlogAdapter(nil), db)
		defer stop()
		conn := connectWS(t, ws)
		sid := openLocalSession(t, conn)

		for _, m := range []struct {
			method string
			params map[string]any
		}{
			{"ledger.open", map[string]any{"envelope": ledgerEnv(sid, "fail-3", "ls", 1)}},
			{"ledger.bind", map[string]any{"envelope": ledgerEnv(sid, "fail-3", "ls", 2)}},
		} {
			if _, errObj := ledgerCall(t, conn, m.method, m.params, 2); errObj != nil {
				t.Fatalf("%s error: %+v", m.method, errObj)
			}
		}
		_, errObj := ledgerCall(t, conn, "ledger.close", map[string]any{
			"envelope": ledgerEnv(sid, "fail-3", "ls", 3),
			"status":   "success",
			"facts":    map[string]any{"terminationReason": "completed"},
		}, 4)
		if errObj == nil {
			t.Fatal("ledger.close succeeded with FinishExecution failing")
		}
		row := mustEntry(t, real, "fail-3")
		if row.Phase != content.PhaseBound {
			t.Fatalf("phase = %q, want the unchanged bound", row.Phase)
		}
		if row.Status == content.EntrySuccess {
			t.Fatal("the entry took the close's status while the close failed")
		}
	})
}
