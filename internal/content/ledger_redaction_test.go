package content_test

// The ledger's half of the redaction receipt (nocx-rtg0.24), through the
// public seam: the receipt rides entries.payload, and RewriteRedaction turns
// one masked span on a LEDGER row into a vault reference — addressed by the
// entry's client-minted UUIDv7, not by command_history's autoincrement rowid.
//
// These assert the same five properties internal/content/redaction_test.go
// asserts for command_history, because they are the same property: the span
// is refused rather than corrupted when it no longer fits, and the row's
// CURRENT redactions are the idempotency authority, not the text.

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// theSecret is the plaintext no assertion in this file may ever find on
// disk, in an intent or in a payload. It is the whole reason the feature
// exists.
const theSecret = "sk-proj-abcdef1234567890" //nolint:gosec // a synthetic detector fixture

// maskedIntent is what the wire's masker leaves behind: the secret replaced
// by its head/tail mask. The span below is the byte offset of that mask.
const maskedIntent = `curl -H "Authorization: Bearer sk-p...7890" https://api.example.com`

// receiptSpan is the one redaction on maskedIntent.
var receiptSpan = content.Redaction{Kind: "openai", Start: 31, End: 42, Prefix: "sk-p", Suffix: "7890"}

// submitMasked records one closed-shaped entry carrying a masked intent and
// its redaction receipt, and returns the entry id.
func submitMasked(t *testing.T, led content.LedgerRepository, id, intent string, reds ...content.Redaction) string {
	t.Helper()
	ctx := context.Background()
	envReady(t, led, "local")
	kinds := make([]string, 0, len(reds))
	for _, r := range reds {
		kinds = append(kinds, r.Kind)
	}
	payload, err := content.WithEntryMasking("{}", content.EntryMasking{
		MaskedCount: len(reds), MaskedKinds: kinds, Redactions: reds,
	})
	if err != nil {
		t.Fatalf("WithEntryMasking: %v", err)
	}
	if _, err := led.Submit(ctx, content.SubmitEntry{
		ID: id, Client: "test-client", EnvironmentID: "local",
		Cwd: "/repo", Kind: content.EntryShell, Intent: intent, Payload: payload,
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	return id
}

// maskingOf reads the receipt back off the stored row.
func maskingOf(t *testing.T, led content.LedgerRepository, id string) (content.EntryMasking, *content.LedgerEntry) {
	t.Helper()
	row, err := led.Entry(context.Background(), id)
	if err != nil {
		t.Fatalf("Entry(%q): %v", id, err)
	}
	if row == nil {
		t.Fatalf("no ledger row carries id %q", id)
	}
	m, err := content.EntryMaskingOf(row.Payload)
	if err != nil {
		t.Fatalf("EntryMaskingOf(%q): %v", row.Payload, err)
	}
	return m, row
}

// ── the receipt survives the round trip ───────────────────────────────────

func TestEntryMaskingRoundTripsThroughThePayload(t *testing.T) {
	db, led := newLedger(t)
	defer func() { _ = db.Close() }()

	id := submitMasked(t, led, "00000000-0000-7000-8000-000000000001", maskedIntent, receiptSpan)
	got, row := maskingOf(t, led, id)

	if got.MaskedCount != 1 {
		t.Errorf("maskedCount = %d, want 1 — the count of what was actually masked", got.MaskedCount)
	}
	if len(got.MaskedKinds) != 1 || got.MaskedKinds[0] != "openai" {
		t.Errorf("maskedKinds = %v, want [openai]", got.MaskedKinds)
	}
	if len(got.Redactions) != 1 || got.Redactions[0] != receiptSpan {
		t.Errorf("redactions = %+v, want the one stored span %+v", got.Redactions, receiptSpan)
	}
	if strings.Contains(row.Payload, theSecret) || strings.Contains(row.Intent, theSecret) {
		t.Fatalf("the raw secret is in the row: intent=%q payload=%q", row.Intent, row.Payload)
	}
}

// An entry with nothing masked answers the empty receipt — never nil, so a
// reader that renders the three fields cannot tell "no secrets" apart from
// "the writer forgot" by looking at a null.
func TestEntryMaskingOfAnUnmaskedEntry(t *testing.T) {
	db, led := newLedger(t)
	defer func() { _ = db.Close() }()

	id := submitMasked(t, led, "00000000-0000-7000-8000-000000000002", "make test")
	got, _ := maskingOf(t, led, id)
	if got.MaskedCount != 0 {
		t.Errorf("maskedCount = %d, want 0", got.MaskedCount)
	}
	if got.MaskedKinds == nil || len(got.MaskedKinds) != 0 {
		t.Errorf("maskedKinds = %v, want the empty list, never null", got.MaskedKinds)
	}
	if got.Redactions == nil || len(got.Redactions) != 0 {
		t.Errorf("redactions = %v, want the empty list, never null", got.Redactions)
	}
}

// The kind arm and the receipt share one column and neither erases the
// other: a close merges its arm into the payload the open wrote.
func TestWithEntryMaskingKeepsTheKindArm(t *testing.T) {
	arm := content.ShellPayloadJSON(intPtr(2))
	merged, err := content.WithEntryMasking(arm, content.EntryMasking{
		MaskedCount: 1, MaskedKinds: []string{"openai"}, Redactions: []content.Redaction{receiptSpan},
	})
	if err != nil {
		t.Fatalf("WithEntryMasking: %v", err)
	}
	if !strings.Contains(merged, `"exitCode":2`) || !strings.Contains(merged, `"kind":"shell"`) {
		t.Fatalf("merged payload lost the shell arm: %s", merged)
	}
	back, err := content.EntryMaskingOf(merged)
	if err != nil {
		t.Fatalf("EntryMaskingOf: %v", err)
	}
	if back.MaskedCount != 1 || len(back.Redactions) != 1 {
		t.Fatalf("receipt did not survive the merge: %+v", back)
	}
}

// A payload that is not a JSON object is refused rather than silently
// replaced — a caller that hands over garbage must learn it did.
func TestWithEntryMaskingRefusesANonObjectPayload(t *testing.T) {
	if _, err := content.WithEntryMasking("[1,2,3]", content.EntryMasking{}); err == nil {
		t.Fatal("a JSON array was accepted as an entry payload")
	}
	if _, err := content.EntryMaskingOf("not json"); err == nil {
		t.Fatal("a non-JSON payload was read as a receipt")
	}
}

// ── the rewrite, on a ledger row ──────────────────────────────────────────

func TestLedgerRewriteRedactionReplacesSpanAndDropsSegment(t *testing.T) {
	db, led, path := newLedgerAt(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	id := submitMasked(t, led, "00000000-0000-7000-8000-000000000003", maskedIntent, receiptSpan)
	const ref = "{{secret:openrouter.ai}}"
	if err := led.RewriteRedaction(ctx, id, receiptSpan, ref); err != nil {
		t.Fatalf("RewriteRedaction: %v", err)
	}

	got, row := maskingOf(t, led, id)
	want := `curl -H "Authorization: Bearer {{secret:openrouter.ai}}" https://api.example.com`
	if row.Intent != want {
		t.Errorf("intent = %q, want %q", row.Intent, want)
	}
	if len(got.Redactions) != 0 {
		t.Errorf("redactions = %+v, want the saved segment gone", got.Redactions)
	}
	// maskedCount is what WAS masked from this command — a historical fact
	// the rewrite does not revise, exactly as command_history keeps it.
	if got.MaskedCount != 1 {
		t.Errorf("maskedCount = %d, want the unrevised 1", got.MaskedCount)
	}

	// The property the whole feature exists for: nowhere in the file.
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	blob, err := os.ReadFile(path) //nolint:gosec // the test owns the temp path it just wrote
	if err != nil {
		t.Fatalf("read the store file: %v", err)
	}
	if bytes.Contains(blob, []byte(theSecret)) {
		t.Fatal("the raw secret is on disk after the save flow")
	}
}

// A retried save re-sends the span it captured at record time. The first
// attempt consumed it; the retry must leave the same string, not replace
// text at stale offsets.
func TestLedgerRewriteRedactionIsIdempotent(t *testing.T) {
	db, led := newLedger(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	id := submitMasked(t, led, "00000000-0000-7000-8000-000000000004", maskedIntent, receiptSpan)
	const ref = "{{secret:openrouter.ai}}"
	if err := led.RewriteRedaction(ctx, id, receiptSpan, ref); err != nil {
		t.Fatalf("first rewrite: %v", err)
	}
	if err := led.RewriteRedaction(ctx, id, receiptSpan, ref); err != nil {
		t.Fatalf("retried rewrite must be a no-op, got %v", err)
	}
	got, row := maskingOf(t, led, id)
	want := `curl -H "Authorization: Bearer {{secret:openrouter.ai}}" https://api.example.com`
	if row.Intent != want {
		t.Errorf("intent after the retry = %q, want %q — one reference, not two", row.Intent, want)
	}
	if strings.Count(row.Intent, ref) != 1 {
		t.Errorf("intent holds %d references, want exactly 1", strings.Count(row.Intent, ref))
	}
	if len(got.Redactions) != 0 {
		t.Errorf("redactions = %+v, want empty", got.Redactions)
	}
}

// A span that is not one of the row's CURRENT redactions is a no-op even
// when the offsets still fit — the receipt is the idempotency authority,
// not the text.
func TestLedgerRewriteRedactionStaleSpanNoOps(t *testing.T) {
	db, led := newLedger(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	id := submitMasked(t, led, "00000000-0000-7000-8000-000000000005", maskedIntent, receiptSpan)
	stale := content.Redaction{Kind: "jwt", Start: 31, End: 42}
	if err := led.RewriteRedaction(ctx, id, stale, "{{secret:y}}"); err != nil {
		t.Fatalf("stale span must no-op, got %v", err)
	}
	got, row := maskingOf(t, led, id)
	if row.Intent != maskedIntent {
		t.Errorf("intent = %q, want unchanged", row.Intent)
	}
	if len(got.Redactions) != 1 || got.Redactions[0] != receiptSpan {
		t.Errorf("redactions = %+v, want the original segment intact", got.Redactions)
	}
}

// The span is byte offsets into the stored intent. One that no longer fits
// means the row changed shape underneath the caller: refuse rather than
// corrupt, and leave the row exactly as it was.
func TestLedgerRewriteRedactionRefusesASpanThatNoLongerFits(t *testing.T) {
	db, led := newLedger(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	oversized := content.Redaction{Kind: "openai", Start: 31, End: len(maskedIntent) + 40}
	id := submitMasked(t, led, "00000000-0000-7000-8000-000000000006", maskedIntent, oversized)
	err := led.RewriteRedaction(ctx, id, oversized, "{{secret:x}}")
	if err == nil {
		t.Fatal("a span past the end of the intent was accepted")
	}
	got, row := maskingOf(t, led, id)
	if row.Intent != maskedIntent {
		t.Errorf("intent = %q, want the refusal to have changed nothing", row.Intent)
	}
	if len(got.Redactions) != 1 {
		t.Errorf("redactions = %+v, want the refusal to have changed nothing", got.Redactions)
	}
}

func TestLedgerRewriteRedactionUnknownEntry(t *testing.T) {
	db, led := newLedger(t)
	defer func() { _ = db.Close() }()
	err := led.RewriteRedaction(context.Background(), "00000000-0000-7000-8000-999999999999", receiptSpan, "{{secret:x}}")
	if !errors.Is(err, content.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// The external call this path makes is the store itself. A closed store
// answers ErrClosed rather than panicking or reporting success.
func TestLedgerRewriteRedactionOnAClosedStore(t *testing.T) {
	db, led := newLedger(t)
	id := submitMasked(t, led, "00000000-0000-7000-8000-000000000007", maskedIntent, receiptSpan)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := led.RewriteRedaction(context.Background(), id, receiptSpan, "{{secret:x}}"); !errors.Is(err, content.ErrClosed) {
		t.Fatalf("err = %v, want ErrClosed", err)
	}
}

// A row whose payload was written by something that kept no receipt reads as
// the empty receipt and rewrites nothing — the absent receipt is not a
// crash, and it is not a licence to slice the intent at offsets nobody
// recorded.
func TestLedgerRewriteRedactionOnAnEntryWithNoReceipt(t *testing.T) {
	db, led := newLedger(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()
	envReady(t, led, "local")
	const id = "00000000-0000-7000-8000-000000000008"
	if _, err := led.Submit(ctx, content.SubmitEntry{
		ID: id, Client: "test-client", EnvironmentID: "local", Cwd: "/repo",
		Kind: content.EntryShell, Intent: maskedIntent, Payload: "{}",
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := led.RewriteRedaction(ctx, id, receiptSpan, "{{secret:x}}"); err != nil {
		t.Fatalf("RewriteRedaction: %v", err)
	}
	_, row := maskingOf(t, led, id)
	if row.Intent != maskedIntent {
		t.Errorf("intent = %q, want unchanged", row.Intent)
	}
}
