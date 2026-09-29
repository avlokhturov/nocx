package transport

// Round 8 (nocx-zg3k3.5.3): the re-adopting stream re-binds the block's
// floor with its cursor, a resend delivery reaching below the floor is
// prepended BEFORE anything is confirmed, and the acknowledgement never
// claims a span the artifact does not hold.

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/emulator"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/session"
)

func TestAResentHeadBelowTheBlockFloorPrependsBeforeItConfirms(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	db, err := content.Open(ctx, content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    key,
		Budget: content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8},
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("content.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	led := db.Ledger()
	if envErr := led.EnsureEnvironment(ctx, content.Environment{ID: "local", Kind: content.EnvLocal}); envErr != nil {
		t.Fatalf("EnsureEnvironment: %v", envErr)
	}
	if _, obsErr := led.RecordObservation(ctx, content.Observation{
		EnvironmentID: "local", Confidence: "{}",
		Criticality: content.CriticalityRoutine, Payload: "{}",
	}); obsErr != nil {
		t.Fatalf("RecordObservation: %v", obsErr)
	}
	sid := "sess-floor-1"
	const attempt = "att-floor-1"
	colour := "#000000"
	if _, wsErr := db.Layout().CreateWorkspace(ctx, content.Workspace{ID: "ws-floor", Name: "floor", Colour: &colour, Position: 0},
		content.Tab{ID: "tab-floor", WorkspaceID: "ws-floor", Position: 0, Layout: "column"},
		content.Pane{ID: "pane-floor", TabID: "tab-floor", Kind: "local", SizeShare: 1, Cwd: "/repo"}); wsErr != nil {
		t.Fatalf("CreateWorkspace: %v", wsErr)
	}
	if sessErr := led.CreateSession(ctx, content.Session{ID: sid, WorkspaceID: "ws-floor"}); sessErr != nil {
		t.Fatalf("CreateSession: %v", sessErr)
	}
	if _, submitErr := led.Submit(ctx, content.SubmitEntry{
		ID: attempt, Client: "c1", EnvironmentID: "local", Kind: content.EntryShell,
		SessionID: &sid, Cwd: "/repo", Intent: "head loses the race",
	}); submitErr != nil {
		t.Fatalf("Submit: %v", submitErr)
	}
	if _, startErr := led.StartExecution(ctx, content.StartExecution{EntryID: attempt}); startErr != nil {
		t.Fatalf("StartExecution: %v", startErr)
	}
	artifact := "00000000-0000-7000-8000-0000000000aa"
	if _, openErr := led.OpenBlockOutput(ctx, content.OpenBlockOutput{
		EntryID: attempt, ArtifactID: artifact,
	}); openErr != nil {
		t.Fatalf("OpenBlockOutput: %v", openErr)
	}
	// The block's first delivery began at absolute 6: [6..10) held, the
	// command's R1..R6 departed before the block opened.
	rows := []emulator.Row{aStreamRow("R7"), aStreamRow("R8"), aStreamRow("R9"), aStreamRow("R10")}
	if appendErr := led.AppendBlockRows(ctx, content.AppendBlockRows{
		EntryID: attempt, ArtifactID: artifact, FromRow: 6, Rows: rows,
	}); appendErr != nil {
		t.Fatalf("the first delivery: %v", appendErr)
	}

	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)), WithContentDB(db))
	ws.AttachBlockRows(session.ID(sid))

	// The resend's head: [0..9) — [0..6) below the floor, [6..9) held.
	var resent []emulator.Row
	for i := 1; i <= 9; i++ {
		resent = append(resent, aStreamRow("R"+strings.Repeat("x", 0)+string(rune('0'+i))))
	}
	written, confirm := ws.BlockRowsArrived(session.ID(sid), 0, 0, resent, "")
	if !confirm {
		t.Fatalf("the head delivery was not confirmed: the mark would never cover it")
	}
	if written != 10 {
		t.Fatalf("the ack reports %d, want the artifact's cursor 10 — the whole span it now holds", written)
	}

	// The artifact holds [0..10): the prepended head first.
	art, err := led.Artifact(ctx, artifact)
	if err != nil {
		t.Fatalf("Artifact: %v", err)
	}
	var lines []struct {
		From uint64 `json:"from"`
		Row  struct {
			Text string `json:"text"`
		} `json:"row"`
	}
	var body []byte
	for _, c := range art.Chunks {
		body = append(body, c...)
	}
	for _, line := range strings.Split(strings.TrimSuffix(string(body), "\n"), "\n") {
		var l struct {
			From uint64 `json:"from"`
			Row  struct {
				Text string `json:"text"`
			} `json:"row"`
		}
		if err := json.Unmarshal([]byte(line), &l); err != nil {
			t.Fatalf("decode a stored line %q: %v", line, err)
		}
		lines = append(lines, l)
	}
	if len(lines) != 10 {
		t.Fatalf("the artifact holds %d rows, want the head and the first delivery's 10", len(lines))
	}
	if lines[0].From != 0 || !strings.Contains(lines[0].Row.Text, "R1") {
		t.Fatalf("the artifact's first row is from=%d %q, want the prepended head's R1 at 0", lines[0].From, lines[0].Row.Text)
	}
	if lines[6].From != 6 || !strings.Contains(lines[6].Row.Text, "R7") {
		t.Fatalf("row 6 is from=%d %q, want the first delivery's R7", lines[6].From, lines[6].Row.Text)
	}
}

func TestAResentHeadHeldUntilItReachesTheFloor(t *testing.T) {
	// Round 9 (nocx-zg3k3.5.3): the loaded R33 run — the resend's batches
	// landed INSIDE the gap: [0,32) refused against a floor of 57, [32,57)
	// prepended, and the second batch's ack leapt over the refused [0,32).
	// The chain holds the parts until they reach the floor; nothing held
	// is ever confirmed.
	ctx := context.Background()
	dir := t.TempDir()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	db, err := content.Open(ctx, content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    key,
		Budget: content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8},
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("content.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	led := db.Ledger()
	if envErr := led.EnsureEnvironment(ctx, content.Environment{ID: "local", Kind: content.EnvLocal}); envErr != nil {
		t.Fatalf("EnsureEnvironment: %v", envErr)
	}
	if _, obsErr := led.RecordObservation(ctx, content.Observation{
		EnvironmentID: "local", Confidence: "{}",
		Criticality: content.CriticalityRoutine, Payload: "{}",
	}); obsErr != nil {
		t.Fatalf("RecordObservation: %v", obsErr)
	}
	sid := "sess-floor-2"
	colour := "#000000"
	if _, wsErr := db.Layout().CreateWorkspace(ctx, content.Workspace{ID: "ws-floor2", Name: "floor2", Colour: &colour, Position: 0},
		content.Tab{ID: "tab-floor2", WorkspaceID: "ws-floor2", Position: 0, Layout: "column"},
		content.Pane{ID: "pane-floor2", TabID: "tab-floor2", Kind: "local", SizeShare: 1, Cwd: "/repo"}); wsErr != nil {
		t.Fatalf("CreateWorkspace: %v", wsErr)
	}
	if sessErr := led.CreateSession(ctx, content.Session{ID: sid, WorkspaceID: "ws-floor2"}); sessErr != nil {
		t.Fatalf("CreateSession: %v", sessErr)
	}
	const attempt = "att-floor-2"
	if _, submitErr := led.Submit(ctx, content.SubmitEntry{
		ID: attempt, Client: "c1", EnvironmentID: "local", Kind: content.EntryShell,
		SessionID: &sid, Cwd: "/repo", Intent: "batches inside the gap",
	}); submitErr != nil {
		t.Fatalf("Submit: %v", submitErr)
	}
	if _, startErr := led.StartExecution(ctx, content.StartExecution{EntryID: attempt}); startErr != nil {
		t.Fatalf("StartExecution: %v", startErr)
	}
	artifact := "00000000-0000-7000-8000-0000000000bb"
	if _, openErr := led.OpenBlockOutput(ctx, content.OpenBlockOutput{
		EntryID: attempt, ArtifactID: artifact,
	}); openErr != nil {
		t.Fatalf("OpenBlockOutput: %v", openErr)
	}
	// The block's first delivery began at absolute 6: [6..10) held.
	rows := []emulator.Row{aStreamRow("R7"), aStreamRow("R8"), aStreamRow("R9"), aStreamRow("R10")}
	if appendErr := led.AppendBlockRows(ctx, content.AppendBlockRows{
		EntryID: attempt, ArtifactID: artifact, FromRow: 6, Rows: rows,
	}); appendErr != nil {
		t.Fatalf("the first delivery: %v", appendErr)
	}

	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)), WithContentDB(db))
	ws.AttachBlockRows(session.ID(sid))

	// Batch 1: [0..3) — inside the gap, short of the floor. Held, never
	// confirmed: the ack must not leap over rows the artifact lacks.
	if written, confirm := ws.BlockRowsArrived(session.ID(sid), 0, 0,
		[]emulator.Row{aStreamRow("R1"), aStreamRow("R2"), aStreamRow("R3")}, ""); confirm {
		t.Fatalf("batch 1 confirmed while the chain is short of the floor (written %d) — the leap again", written)
	}
	// Batch 2: [3..6) — the chain now reaches the floor: it all joins in
	// one prepend, and the ack covers the artifact's whole held span.
	if written, confirm := ws.BlockRowsArrived(session.ID(sid), 3, 0,
		[]emulator.Row{aStreamRow("R4"), aStreamRow("R5"), aStreamRow("R6")}, ""); !confirm || written != 10 {
		t.Fatalf("batch 2 = (%d, %v), want the chain joined and the artifact's cursor 10", written, confirm)
	}

	// The artifact holds [0..10), head first.
	art, artErr := led.Artifact(ctx, artifact)
	if artErr != nil {
		t.Fatalf("Artifact: %v", artErr)
	}
	var body []byte
	for _, c := range art.Chunks {
		body = append(body, c...)
	}
	got := strings.Split(strings.TrimSuffix(string(body), "\n"), "\n")
	if len(got) != 10 {
		t.Fatalf("the artifact holds %d rows, want the chain and the first delivery's 10", len(got))
	}
	if !strings.Contains(got[0], "R1") {
		t.Fatalf("the artifact's first row is %q, want the held head's R1", got[0])
	}
}
