package app

// The composition-root acceptance for nocx-rtg0.15, in the bead's words:
//
//	Start on a machine where the content key cannot be read. Open Settings →
//	History. Everything is there and none of it does anything.
//
// This drives that machine — the salt the derived key needs is replaced by a
// directory, so contentkey.LoadOrCreate fails the way a real unreadable
// keystore fails — and then asks, over the real socket, the two questions a
// user's screen asks: does the History section have anything to say, and
// does recall know the difference between a store that answered with nothing
// and no store at all.
//
// It asserts the answers on the wire, never the internal flag: a test that
// reads historyStatus.available proves the field was set, which is what the
// slog.Warn already proved. What was missing was the sentence.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/storage"
	"github.com/shady2k/nocx/internal/storage/storagetest"
)

// historyStatusWire is the decoded history.status result.
type historyStatusWire struct {
	Available bool    `json:"available"`
	Reason    *string `json:"reason"`
	Detail    *string `json:"detail"`
}

func TestHistory_KeyUnreadable_AppSaysSoOnTheWire(t *testing.T) {
	storagetest.Isolate(t)

	paths, err := storage.NewAppPaths()
	if err != nil {
		t.Fatalf("NewAppPaths: %v", err)
	}
	// A directory where the salt file goes: every read and every write of
	// contentkey.salt now fails, so the derived-key branch cannot produce a
	// key and neither can the keystore branch (there is no OS keystore in a
	// test app — newTestApp declares it out of reach).
	saltPath := filepath.Join(paths.ConfigDir(), "contentkey.salt")
	if mkErr := os.MkdirAll(saltPath, 0o755); mkErr != nil {
		t.Fatalf("plant the unreadable salt: %v", mkErr)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	a, err := newTestApp(t)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// The terminal STARTS. That is the half of the design that was already
	// right and must stay right: failing soft beats refusing to run.
	if startErr := a.Start(ctx); startErr != nil {
		t.Fatalf("Start: %v", startErr)
	}
	defer a.Shutdown(ctx)

	conn := dialAppWS(t, a)
	defer func() { _ = conn.Close() }()

	// 1. The History settings have something to say.
	resp := callAppWS(t, conn, "history.status", map[string]any{}, 1)
	if resp.Error != nil {
		t.Fatalf("history.status: %+v", resp.Error)
	}
	var status historyStatusWire
	if decodeErr := json.Unmarshal(resp.Result, &status); decodeErr != nil {
		t.Fatalf("decode history.status: %v (raw %s)", decodeErr, resp.Result)
	}
	if status.Available {
		t.Fatal("history.status says durable history is running; the key could not be read")
	}
	if status.Reason == nil || *status.Reason != "noKey" {
		t.Fatalf("reason = %v, want noKey", status.Reason)
	}
	if status.Detail == nil || *status.Detail == "" {
		t.Fatal("detail is empty; the notice's second line would be blank")
	}

	// 2. Recall does not present an unanswerable question as an empty
	//    answer. Before this bead the shipped app answered -32603 here,
	//    because the composition root injects a stub ContentDB on its
	//    degrade paths and the stub's Query returns ErrNotImplemented — the
	//    "honest source=session fallback" the comment promised was
	//    unreachable in the product.
	resp = callAppWS(t, conn, "history.query", map[string]any{"scope": "everywhere"}, 2)
	if resp.Error != nil {
		t.Fatalf("history.query answered an error, not an honest page: %+v", resp.Error)
	}
	var page struct {
		Source  string            `json:"source"`
		Entries []json.RawMessage `json:"entries"`
	}
	if decodeErr := json.Unmarshal(resp.Result, &page); decodeErr != nil {
		t.Fatalf("decode history.query: %v (raw %s)", decodeErr, resp.Result)
	}
	if page.Source != "unavailable" {
		t.Fatalf("source = %q, want unavailable", page.Source)
	}
	if page.Entries == nil {
		t.Fatal("entries = null, want []")
	}
}

// The other end of the interval: on an ordinary machine the same two
// questions answer the other way. Without this, every assertion above is
// satisfied by a build that reports history broken always — the paired
// "and on a normal machine it succeeds" AGENTS.md asks for.
func TestHistory_OrdinaryMachine_SaysHistoryIsRunning(t *testing.T) {
	storagetest.Isolate(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	a, err := newTestApp(t)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if startErr := a.Start(ctx); startErr != nil {
		t.Fatalf("Start: %v", startErr)
	}
	defer a.Shutdown(ctx)

	conn := dialAppWS(t, a)
	defer func() { _ = conn.Close() }()

	resp := callAppWS(t, conn, "history.status", map[string]any{}, 1)
	if resp.Error != nil {
		t.Fatalf("history.status: %+v", resp.Error)
	}
	var status historyStatusWire
	if decodeErr := json.Unmarshal(resp.Result, &status); decodeErr != nil {
		t.Fatalf("decode history.status: %v (raw %s)", decodeErr, resp.Result)
	}
	if !status.Available {
		t.Fatalf("history.status says durable history is not running on a normal machine: reason %v detail %v",
			status.Reason, status.Detail)
	}
	if status.Reason != nil {
		t.Fatalf("reason = %q while available", *status.Reason)
	}
}
