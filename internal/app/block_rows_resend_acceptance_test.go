package app

// THE ACCEPTANCE (nocx-zg3k3.5.3), over the real helper daemon: the
// coordinator goes away, a command then prints its WHOLE output for nobody
// and finishes, and the coordinator comes back — the block in history ends
// up with the command's whole output. See the test's own doc for the
// deterministic shape.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/storage/storagetest"
	"github.com/shady2k/nocx/internal/transport"
)

// THE ACCEPTANCE (nocx-zg3k3.5.3), over the real helper daemon: the
// coordinator goes away, a command then prints its whole output for nobody
// and finishes, and the coordinator comes back — the block in history ends
// up with the command's whole output. The first composition root shuts
// down before a row is printed; the command polls a release file (the
// deterministic hold, never a duration) and writes a done file when its
// whole output has departed; the second root re-adopts the surviving
// session and the pump resends everything the scrollback still holds. The
// paired half — a short absence loses nothing — reads the block's own
// metadata the way the renderer does: sealed, no truncation, no lost and
// no unavailable rows.
func TestABlockEndsWithTheWholeOutputAfterACoordinatorRestart(t *testing.T) {
	src := realHelperArtifacts(t)
	home := storagetest.IsolateWithHome(t)
	binary := filepath.Join(helperRoot(home, src.hash()), "nocx-helper")
	t.Cleanup(func() { endTheDaemon(t, binary) })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := newTestApp(t, withLocalHelperArtifacts(src))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if startErr := a.Start(ctx); startErr != nil {
		t.Fatalf("Start: %v", startErr)
	}

	release := filepath.Join(t.TempDir(), "resend-release")
	done := filepath.Join(t.TempDir(), "resend-done")
	// The pane id is the client's own: the real renderer mints one per
	// pane, creates it in the workspace, and opens with it -- and the
	// record's pane anchor, everything the restored block is listed and
	// read through, hangs off it. The same two steps, over the same wire.
	conn := dialAppWS(t, a)
	// The workspace the app seeded at first run: the tab goes there, the
	// way the real client's own first pane does.
	state := callAppWS(t, conn, "layout.read", map[string]any{}, 1)
	if state.Error != nil {
		t.Fatalf("layout.read: %+v", state.Error)
	}
	var layout struct {
		DefaultWorkspaceID string `json:"defaultWorkspaceId"`
	}
	if unmarshalErr := json.Unmarshal(state.Result, &layout); unmarshalErr != nil || layout.DefaultWorkspaceID == "" {
		t.Fatalf("layout.read = %s (err %v): no default workspace", state.Result, unmarshalErr)
	}
	paneID := uuid.Must(uuid.NewV7()).String()
	tabCreated := callAppWS(t, conn, "tabs.create", map[string]any{
		"id":          uuid.Must(uuid.NewV7()).String(),
		"workspaceId": layout.DefaultWorkspaceID,
		"position":    0,
		"layout":      "column",
		"firstPane": map[string]any{
			"id": paneID, "cwd": "/", "kind": "local", "sizeShare": 1,
		},
	}, 2)
	if tabCreated.Error != nil {
		t.Fatalf("tabs.create: %+v", tabCreated.Error)
	}
	opened, err := a.Transport.OpenSession(ctx, transport.OpenSpec{
		Cols: 80, Rows: 24, PaneID: paneID,
	})
	if err != nil {
		t.Fatalf("opening a local pane through the shipped opener: %v", err)
	}
	p := &pane{sess: opened.Session}
	watchCtx, cancelWatch := context.WithCancel(context.Background())
	watchDone := make(chan error, 1)
	go func() {
		watchDone <- a.Transport.WatchSessionOutput(watchCtx, opened.Session.ID(), func(data []byte) {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.out.Write(data)
		})
	}()
	t.Cleanup(func() {
		cancelWatch()
		if werr := <-watchDone; werr != nil && !errors.Is(werr, context.Canceled) {
			t.Errorf("reading the pane's output from its ring: %v", werr)
		}
		_ = opened.Session.Close()
	})

	// The command prints its first two hundred rows at once, then holds
	// on the release file: the restart happens while it is mid-command.
	cmd := "r=" + release + "; i=1; while [ $i -le 200 ]; do echo R$i; i=$((i+1)); done; " +
		"while [ ! -f $r ]; do sleep 0.1; done; " +
		"while [ $i -le 300 ]; do echo R$i; i=$((i+1)); done; echo done > " + done
	if _, writeErr := p.sess.Write([]byte(cmd + "\n")); writeErr != nil {
		t.Fatalf("writing the command into the pane: %v", writeErr)
	}
	// The ring seeing R150 means every rows frame up to it was already
	// processed by the same read loop: the store holds a real prefix when
	// the restart comes.
	p.await(t, regexp.MustCompile("R150"))

	// THE RESTART: the process equivalent of quitting and relaunching. The
	// daemon survives; the session and its PTY are its own; the command
	// never noticed.
	a.Shutdown(ctx)

	// THE TAIL DEPARTS FOR NOBODY: with no coordinator anywhere, the
	// release lets the command print its last hundred rows and finish.
	// The done file is the state that says the whole tail has departed;
	// only then does the replacement root come up, so the rows can reach
	// the block only through the helper's resend from scrollback.
	if werr := os.WriteFile(release, []byte("go"), 0o600); werr != nil {
		t.Fatalf("releasing the command: %v", werr)
	}
	for {
		if _, statErr := os.Stat(done); statErr == nil {
			break
		} else if !os.IsNotExist(statErr) {
			t.Fatalf("stat the done file: %v", statErr)
		}
		time.Sleep(20 * time.Millisecond)
	}

	a2, err := newTestApp(t, withLocalHelperArtifacts(src))
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}
	if startErr := a2.Start(ctx); startErr != nil {
		t.Fatalf("Start after restart: %v", startErr)
	}
	defer a2.Shutdown(ctx)
	// Every post-restart question is asked of the SECOND root: the first
	// one is shut down, and a connection it once served answers nothing
	// worth asserting about this incarnation.
	conn2 := dialAppWS(t, a2)
	defer func() { _ = conn2.Close() }()

	// The block closes on the command's completion and reads back whole:
	// every row, in order, however many restarts it crossed. The entry is
	// found by its command through history.query (scope everywhere: the
	// command ran before this incarnation was even built) and read through
	// the item read, which takes the entry directly.
	deadline := time.Now().Add(30 * time.Second)
	var itemID string
	var settledStatus string
	for {
		resp := callAppWS(t, conn2, "history.query", map[string]any{
			"scope": "everywhere", "text": "resend-release", "limit": 50,
		}, 7)
		if resp.Error != nil {
			t.Fatalf("history.query: %+v", resp.Error)
		}
		var q struct {
			Entries []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"entries"`
		}
		if unmarshalErr := json.Unmarshal(resp.Result, &q); unmarshalErr != nil {
			t.Fatalf("decode history.query: %v (raw %s)", unmarshalErr, resp.Result)
		}
		if len(q.Entries) == 1 && q.Entries[0].Status != "running" {
			itemID = q.Entries[0].ID
			settledStatus = q.Entries[0].Status
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the command's block never closed: entries = %+v", q.Entries)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if settledStatus != "success" {
		t.Fatalf("the command settled %q, want success: the completion is carried across the restart", settledStatus)
	}
	// The entry closes the instant the completion lands; the tail rows'
	// appends are still in flight behind the same single-writer store. The
	// observable that says no more rows are coming is the artifact's seal
	// — the resent end marker, wire-ordered after every row — or the count
	// reaching the command's whole output. Count only after one of them.
	deadline = time.Now().Add(30 * time.Second)
	for {
		read, readErr := a2.Transport.ReadSessionItem(ctx, string(p.sess.ID()), itemID, 0, 400)
		if readErr != nil {
			t.Fatalf("ReadSessionItem after the restart: %v", readErr)
		}
		if read.Total >= 300 {
			break
		}
		got := callAppWS(t, conn2, "ledger.get", map[string]any{"id": itemID}, 8)
		if got.Error != nil {
			t.Fatalf("ledger.get: %+v", got.Error)
		}
		var probe struct {
			Artifacts []struct {
				MediaType string `json:"mediaType"`
				State     string `json:"state"`
			} `json:"artifacts"`
		}
		if unmarshalErr := json.Unmarshal(got.Result, &probe); unmarshalErr != nil {
			t.Fatalf("decode ledger.get: %v (raw %s)", unmarshalErr, got.Result)
		}
		sealed := false
		for _, art := range probe.Artifacts {
			if art.MediaType == string(content.MediaBlockRows) && art.State == "sealed" {
				sealed = true
			}
		}
		if sealed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the block never finished draining: %d rows, artifact unsealed", read.Total)
		}
		time.Sleep(20 * time.Millisecond)
	}
	read, err := a2.Transport.ReadSessionItem(ctx, string(p.sess.ID()), itemID, 0, 400)
	if err != nil {
		t.Fatalf("ReadSessionItem after the restart: %v", err)
	}
	lines := strings.Split(strings.TrimSuffix(read.Text, "\n"), "\n")
	// THE BLOCK HOLDS THE COMMAND'S WHOLE OUTPUT: three hundred rows, in
	// order. The coordinator went away mid-command and changed nothing —
	// the first root's rows stayed stored, the second root's attach
	// re-bound the open block from the store (ADR-0076 decision 3), the
	// resend and the live stream appended behind its cursor, and the
	// helper's own end report settled it.
	if len(lines) != 300 {
		t.Fatalf("the block holds %d rows (status %q) spanning %q..%q, want the command's whole output of 300", len(lines), settledStatus, lines[0], lines[len(lines)-1])
	}
	for i, line := range lines {
		if want := fmt.Sprintf("R%d", i+1); line != want {
			t.Fatalf("row %d reads %q, want %q — the output crossed the restart out of order or lossy", i, line, want)
		}
	}
	// THE PAIRED HALF — the short absence, nothing pruned: the store
	// marks nothing missing. The block's own metadata, read the way the
	// renderer reads it, is sealed, names no truncation, and carries no
	// lost and no unavailable rows.
	got := callAppWS(t, conn2, "ledger.get", map[string]any{"id": itemID}, 8)
	if got.Error != nil {
		t.Fatalf("ledger.get: %+v", got.Error)
	}
	var entry struct {
		Artifacts []struct {
			MediaType string          `json:"mediaType"`
			State     string          `json:"state"`
			Truncated *string         `json:"truncated"`
			Payload   json.RawMessage `json:"payload"`
		} `json:"artifacts"`
	}
	if unmarshalErr := json.Unmarshal(got.Result, &entry); unmarshalErr != nil {
		t.Fatalf("decode ledger.get: %v (raw %s)", unmarshalErr, got.Result)
	}
	var rowsArt *struct {
		MediaType string          `json:"mediaType"`
		State     string          `json:"state"`
		Truncated *string         `json:"truncated"`
		Payload   json.RawMessage `json:"payload"`
	}
	for i := range entry.Artifacts {
		if entry.Artifacts[i].MediaType == string(content.MediaBlockRows) {
			rowsArt = &entry.Artifacts[i]
		}
	}
	if rowsArt == nil {
		t.Fatalf("ledger.get holds no rows artifact: %+v", entry.Artifacts)
	}
	if rowsArt.State != "sealed" {
		t.Fatalf("rows artifact state = %q, want sealed", rowsArt.State)
	}
	if rowsArt.Truncated != nil {
		t.Fatalf("rows artifact truncated = %q, want nothing marked missing", *rowsArt.Truncated)
	}
	var payload struct {
		LostRows        uint64 `json:"lostRows"`
		UnavailableRows uint64 `json:"unavailableRows"`
	}
	if unmarshalErr := json.Unmarshal(rowsArt.Payload, &payload); unmarshalErr != nil {
		t.Fatalf("decode the rows payload: %v (raw %s)", unmarshalErr, rowsArt.Payload)
	}
	if payload.LostRows != 0 || payload.UnavailableRows != 0 {
		t.Fatalf("the payload marks %d lost / %d unavailable rows, want the short absence that lost nothing", payload.LostRows, payload.UnavailableRows)
	}
}

// THE PAIRED HALF, end to end over the real helper: the shell EXITS while
// the coordinator is away. On return the block is settled — by the
// helper's own session-end report (ADR-0074 decision 3, ADR-0076) — not
// left running: the entry is terminal and the block's artifact is sealed.
func TestAShellThatExitsWhileTheCoordinatorIsAwaySettlesItsBlockOnReturn(t *testing.T) {
	src := realHelperArtifacts(t)
	home := storagetest.IsolateWithHome(t)
	binary := filepath.Join(helperRoot(home, src.hash()), "nocx-helper")
	t.Cleanup(func() { endTheDaemon(t, binary) })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := newTestApp(t, withLocalHelperArtifacts(src))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if startErr := a.Start(ctx); startErr != nil {
		t.Fatalf("Start: %v", startErr)
	}

	release := filepath.Join(t.TempDir(), "exit-release")
	done := filepath.Join(t.TempDir(), "exit-done")
	conn := dialAppWS(t, a)
	state := callAppWS(t, conn, "layout.read", map[string]any{}, 1)
	if state.Error != nil {
		t.Fatalf("layout.read: %+v", state.Error)
	}
	var layout struct {
		DefaultWorkspaceID string `json:"defaultWorkspaceId"`
	}
	if unmarshalErr := json.Unmarshal(state.Result, &layout); unmarshalErr != nil || layout.DefaultWorkspaceID == "" {
		t.Fatalf("layout.read = %s (err %v): no default workspace", state.Result, unmarshalErr)
	}
	paneID := uuid.Must(uuid.NewV7()).String()
	tabCreated := callAppWS(t, conn, "tabs.create", map[string]any{
		"id":          uuid.Must(uuid.NewV7()).String(),
		"workspaceId": layout.DefaultWorkspaceID,
		"position":    0,
		"layout":      "column",
		"firstPane": map[string]any{
			"id": paneID, "cwd": "/", "kind": "local", "sizeShare": 1,
		},
	}, 2)
	if tabCreated.Error != nil {
		t.Fatalf("tabs.create: %+v", tabCreated.Error)
	}
	opened, err := a.Transport.OpenSession(ctx, transport.OpenSpec{
		Cols: 80, Rows: 24, PaneID: paneID,
	})
	if err != nil {
		t.Fatalf("opening a local pane through the shipped opener: %v", err)
	}
	p := &pane{sess: opened.Session}
	watchCtx, cancelWatch := context.WithCancel(context.Background())
	watchDone := make(chan error, 1)
	go func() {
		watchDone <- a.Transport.WatchSessionOutput(watchCtx, opened.Session.ID(), func(data []byte) {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.out.Write(data)
		})
	}()
	t.Cleanup(func() {
		cancelWatch()
		if werr := <-watchDone; werr != nil && !errors.Is(werr, context.Canceled) {
			t.Errorf("reading the pane's output from its ring: %v", werr)
		}
		_ = opened.Session.Close()
	})

	// The command opens its block, prints its first row, and holds on the
	// release file; releasing it makes the shell finish the command and
	// EXIT — while the coordinator is away, in the second half below.
	cmd := "echo started; while [ ! -f " + release + " ]; do sleep 0.1; done; " +
		"echo bye > " + done + "; exit"
	if _, writeErr := p.sess.Write([]byte(cmd + "\n")); writeErr != nil {
		t.Fatalf("writing the command into the pane: %v", writeErr)
	}
	p.await(t, regexp.MustCompile("started"))
	deadline := time.Now().Add(30 * time.Second)
	// The block exists before the restart: the shell's DEBUG trap records
	// the first simple command ("echo started") as the entry's command.
	for {
		resp := callAppWS(t, conn, "history.query", map[string]any{
			"scope": "everywhere", "text": "echo started", "limit": 50,
		}, 7)
		if resp.Error != nil {
			t.Fatalf("history.query: %+v", resp.Error)
		}
		var q struct {
			Entries []struct {
				ID string `json:"id"`
			} `json:"entries"`
		}
		if unmarshalErr := json.Unmarshal(resp.Result, &q); unmarshalErr != nil {
			t.Fatalf("decode history.query: %v (raw %s)", unmarshalErr, resp.Result)
		}
		if len(q.Entries) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the command's entry never appeared: %+v", q.Entries)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// THE COORDINATOR GOES AWAY. The shell holds; nothing about its block
	// changes (the detach is no-seal, ADR-0076).
	a.Shutdown(ctx)

	// THE SHELL EXITS WHILE THE COORDINATOR IS AWAY: with no coordinator
	// anywhere, the release lets the command finish and the `exit` end
	// the shell. The done file says the command ran; the pane's own end —
	// the session's Done, the same edge the teardown owner waits on —
	// says the shell has actually exited, so the replacement root cannot
	// arrive before the exit it must settle on return.
	if werr := os.WriteFile(release, []byte("go"), 0o600); werr != nil {
		t.Fatalf("releasing the command: %v", werr)
	}
	for {
		if _, statErr := os.Stat(done); statErr == nil {
			break
		} else if !os.IsNotExist(statErr) {
			t.Fatalf("stat the done file: %v", statErr)
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case <-p.sess.Done():
	case <-time.After(60 * time.Second):
		t.Fatal("the pane never ended after its shell exited")
	}

	a2, err := newTestApp(t, withLocalHelperArtifacts(src))
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}
	if startErr := a2.Start(ctx); startErr != nil {
		t.Fatalf("Start after restart: %v", startErr)
	}
	defer a2.Shutdown(ctx)
	conn2 := dialAppWS(t, a2)
	defer func() { _ = conn2.Close() }()

	// On return the block is settled, not left running: the entry is
	// terminal — the shell exited with no completion fact, so the honest
	// end is the helper's own session-end report — and the block's
	// artifact is sealed rather than open.
	deadline = time.Now().Add(30 * time.Second)
	var itemID, itemStatus string
	for {
		resp := callAppWS(t, conn2, "history.query", map[string]any{
			"scope": "everywhere", "text": "echo started", "limit": 50,
		}, 7)
		if resp.Error != nil {
			t.Fatalf("history.query: %+v", resp.Error)
		}
		var q struct {
			Entries []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"entries"`
		}
		if unmarshalErr := json.Unmarshal(resp.Result, &q); unmarshalErr != nil {
			t.Fatalf("decode history.query: %v (raw %s)", unmarshalErr, resp.Result)
		}
		if len(q.Entries) == 1 && q.Entries[0].Status != "running" {
			itemID = q.Entries[0].ID
			itemStatus = q.Entries[0].Status
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the block was left running after the shell's exit: entries = %+v", q.Entries)
		}
		time.Sleep(20 * time.Millisecond)
	}
	got := callAppWS(t, conn2, "ledger.get", map[string]any{"id": itemID}, 8)
	if got.Error != nil {
		t.Fatalf("ledger.get: %+v", got.Error)
	}
	var entry struct {
		Artifacts []struct {
			MediaType string `json:"mediaType"`
			State     string `json:"state"`
		} `json:"artifacts"`
	}
	if unmarshalErr := json.Unmarshal(got.Result, &entry); unmarshalErr != nil {
		t.Fatalf("decode ledger.get: %v (raw %s)", unmarshalErr, got.Result)
	}
	sealed := false
	for _, art := range entry.Artifacts {
		if art.MediaType == string(content.MediaBlockRows) && art.State == "sealed" {
			sealed = true
		}
	}
	if !sealed {
		t.Fatalf("the block is settled (%q) but its rows artifact is not sealed: %+v", itemStatus, entry.Artifacts)
	}
}
