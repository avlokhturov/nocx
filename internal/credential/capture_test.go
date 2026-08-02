package credential

// The pending-capture registry, exercised against the contract pasted in
// capture.go: single-use, 30-second expiry, destruction on every named
// trigger, one save repairing every linked row, and suppression by value
// equality without keeping the value.

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/content"
)

func newTestRegistry(t *testing.T, start time.Time) (*CaptureRegistry, *time.Time) {
	t.Helper()
	clock := start
	r, err := NewCaptureRegistry(func() time.Time { return clock }, DefaultCaptureExpiry)
	if err != nil {
		t.Fatalf("NewCaptureRegistry: %v", err)
	}
	return r, &clock
}

func scope(tab string, gen uint64) CaptureScope {
	return CaptureScope{Tab: tab, Generation: gen}
}

func cred(value, name string) PendingCredential {
	return PendingCredential{
		Value:         []byte(value),
		SuggestedName: name,
		Redaction:     content.Redaction{Kind: "openai", Start: 0, End: 11, Prefix: "sk-p", Suffix: "7890"},
	}
}

func TestSubmitMintsAndLinks(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	// First submission: a capture.
	res := r.Submit(scope("tab1", 1), []PendingCredential{cred("sk-proj-key-one-1234567890", "openrouter.ai")})
	if len(res) != 1 || res[0].Outcome != OutcomeCaptured || res[0].CaptureID == "" {
		t.Fatalf("first submit = %+v, want one captured", res)
	}
	id := res[0].CaptureID

	// Same value again, next command: linked to the SAME capture, no second
	// offer.
	res = r.Submit(scope("tab1", 2), []PendingCredential{cred("sk-proj-key-one-1234567890", "openrouter.ai")})
	if len(res) != 1 || res[0].Outcome != OutcomeLinked || res[0].CaptureID != id {
		t.Fatalf("second submit = %+v, want linked to %s", res, id)
	}
}

func TestSubmitSuppression(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	// Save a value, then re-submit it: the row stores the reference
	// automatically, nothing is offered.
	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-saved-value-1234567890", "saved.ai")})
	id := res[0].CaptureID
	if _, err := r.Reserve(id); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	r.Complete(id, "saved.ai", "sec:v1:system:x", false, nil)

	res = r.Submit(scope("t", 2), []PendingCredential{cred("sk-proj-saved-value-1234567890", "saved.ai")})
	if len(res) != 1 || res[0].Outcome != OutcomeSaved || res[0].SavedName != "saved.ai" {
		t.Fatalf("re-submit after save = %+v, want OutcomeSaved with the existing name", res)
	}
	if res[0].CaptureID != "" {
		t.Fatalf("a saved value must not mint a capture, got %s", res[0].CaptureID)
	}

	// Dismiss a value, then re-submit it in the same session: suppressed.
	res = r.Submit(scope("t", 3), []PendingCredential{cred("sk-proj-dismissed-value-123456", "dismissed.ai")})
	id2 := res[0].CaptureID
	if err := r.Dismiss(id2); err != nil {
		t.Fatalf("Dismiss: %v", err)
	}
	res = r.Submit(scope("t", 4), []PendingCredential{cred("sk-proj-dismissed-value-123456", "dismissed.ai")})
	if len(res) != 1 || res[0].Outcome != OutcomeSuppressed {
		t.Fatalf("re-submit after dismiss = %+v, want OutcomeSuppressed", res)
	}
}

func TestExpiryDestroysAndNextCommandReOffers(t *testing.T) {
	r, clock := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-expiring-value-1234567890", "exp.ai")})
	id := res[0].CaptureID

	// Inside the window: still pending.
	if _, err := r.Reserve(id); err != nil {
		t.Fatalf("reserve before expiry: %v", err)
	}

	// A fresh capture, then expire it.
	res = r.Submit(scope("t", 2), []PendingCredential{cred("sk-proj-expiring-value-1234567890", "exp.ai")})
	id2 := res[0].CaptureID
	if res[0].Outcome != OutcomeCaptured {
		t.Fatalf("after a consumed capture, re-submit = %+v, want a fresh capture", res)
	}
	*clock = clock.Add(DefaultCaptureExpiry + time.Second)
	r.PurgeExpired()
	if _, err := r.Reserve(id2); !errors.Is(err, ErrCaptureUnknown) {
		t.Fatalf("reserve after expiry = %v, want ErrCaptureUnknown", err)
	}
	// The next command re-offers: a fresh capture, not a suppression.
	res = r.Submit(scope("t", 3), []PendingCredential{cred("sk-proj-expiring-value-1234567890", "exp.ai")})
	if len(res) != 1 || res[0].Outcome != OutcomeCaptured {
		t.Fatalf("re-submit after expiry = %+v, want a fresh capture (expiry re-offers)", res)
	}
}

func TestReserveIsSingleUseAndIdempotent(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-single-use-value-123456", "once.ai")})
	id := res[0].CaptureID

	h, err := r.Reserve(id)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if h.Completed || h.Value.IsEmpty() {
		t.Fatalf("first reserve = %+v, want a live handle", h)
	}
	if uerr := h.Value.Use(func(b []byte) error {
		if string(b) != "sk-proj-single-use-value-123456" {
			t.Errorf("handle value = %q", b)
		}
		return nil
	}); uerr != nil {
		t.Fatalf("Use: %v", uerr)
	}
	if len(h.Links) != 1 || h.Links[0].EntryID != "" {
		t.Fatalf("links = %+v", h.Links)
	}

	r.Complete(id, "once.ai", "sec:v1:system:y", false, nil)

	// Retry (a lost response): the same outcome, no second mint.
	h2, err := r.Reserve(id)
	if err != nil {
		t.Fatalf("retry reserve: %v", err)
	}
	if !h2.Completed || h2.Name != "once.ai" || h2.RewritePending {
		t.Fatalf("retry handle = %+v, want the recorded outcome", h2)
	}
	// The value is released: a completed handle must not carry plaintext.
	if !h2.Value.IsEmpty() {
		t.Fatal("completed handle still holds the value")
	}
}

func TestSaveFailureIsRecordedNotRetried(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-failing-value-1234567890", "fail.ai")})
	id := res[0].CaptureID

	if _, err := r.Reserve(id); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	r.Complete(id, "", "", false, errors.New("vault sealed"))

	// A retry must report the failure, never run the vault again.
	_, err := r.Reserve(id)
	if !errors.Is(err, ErrCaptureSaveFailed) {
		t.Fatalf("retry after failed save = %v, want ErrCaptureSaveFailed", err)
	}
	if !strings.Contains(err.Error(), "vault sealed") {
		t.Fatalf("error = %v, want the recorded cause", err)
	}
}

func TestRewritePendingIsRedoable(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-partial-value-123456789", "partial.ai")})
	id := res[0].CaptureID

	if _, err := r.Reserve(id); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	// Vault create succeeded, the row rewrite is still owed.
	r.Complete(id, "partial.ai", "sec:v1:system:z", true, nil)

	h, err := r.Reserve(id)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !h.Completed || !h.RewritePending || h.Name != "partial.ai" {
		t.Fatalf("handle = %+v, want completed with the rewrite still owed", h)
	}
	// The retry re-runs the rewrites (not the vault) and settles.
	r.Complete(id, h.Name, h.SecretID, false, nil)
	h2, err := r.Reserve(id)
	if err != nil {
		t.Fatalf("second retry: %v", err)
	}
	if !h2.Completed || h2.RewritePending {
		t.Fatalf("handle = %+v, want fully settled", h2)
	}
}

func TestDismissConsumesTheToken(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-dismiss-token-1234567890", "d.ai")})
	id := res[0].CaptureID
	if err := r.Dismiss(id); err != nil {
		t.Fatalf("Dismiss: %v", err)
	}
	if err := r.Dismiss(id); err != nil {
		t.Fatalf("second Dismiss must be idempotent, got %v", err)
	}
	if _, err := r.Reserve(id); !errors.Is(err, ErrCaptureConsumed) {
		t.Fatalf("reserve after dismiss = %v, want ErrCaptureConsumed", err)
	}
	if err := r.Dismiss("cap_does-not-exist"); !errors.Is(err, ErrCaptureUnknown) {
		t.Fatalf("dismiss of an unknown id = %v, want ErrCaptureUnknown", err)
	}
}

func TestSupersedingSubmissionDestroysOlderPending(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	// Two pending captures from tab1, then a third submission supersedes
	// both older ones.
	resA := r.Submit(scope("tab1", 1), []PendingCredential{cred("sk-proj-super-a-1234567890123", "a.ai")})
	resB := r.Submit(scope("tab1", 2), []PendingCredential{cred("sk-proj-super-b-1234567890123", "b.ai")})
	idA, idB := resA[0].CaptureID, resB[0].CaptureID
	r.Submit(scope("tab1", 3), []PendingCredential{cred("sk-proj-super-c-1234567890123", "c.ai")})
	if _, err := r.Reserve(idA); !errors.Is(err, ErrCaptureUnknown) {
		t.Fatalf("older capture A after supersede = %v, want unknown", err)
	}
	if _, err := r.Reserve(idB); !errors.Is(err, ErrCaptureUnknown) {
		t.Fatalf("older capture B after supersede = %v, want unknown", err)
	}
}

func TestSupersedeIsScopedToTheTab(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	// tab2's pending capture survives a superseding submission from tab1.
	resD := r.Submit(scope("tab2", 1), []PendingCredential{cred("sk-proj-super-d-1234567890123", "d.ai")})
	idD := resD[0].CaptureID
	r.Submit(scope("tab1", 1), []PendingCredential{cred("sk-proj-super-e-1234567890123", "e.ai")})
	if _, err := r.Reserve(idD); err != nil {
		t.Fatalf("another tab's capture after an unrelated supersede = %v, want live", err)
	}

	// tab2's own next submission supersedes ITS older pending capture (a
	// fresh one — the previous was consumed by the alive-check above).
	resF := r.Submit(scope("tab2", 2), []PendingCredential{cred("sk-proj-super-f-1234567890123", "f.ai")})
	idF := resF[0].CaptureID
	r.Submit(scope("tab2", 3), []PendingCredential{cred("sk-proj-super-g-1234567890123", "g.ai")})
	if _, err := r.Reserve(idF); !errors.Is(err, ErrCaptureUnknown) {
		t.Fatalf("tab2's older capture after its own supersede = %v, want unknown", err)
	}
}

func TestTypingNextCommandDoesNotDestroy(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-typing-keeps-1234567890", "keep.ai")})
	id := res[0].CaptureID

	// The deliberate exception: no submission happened, so nothing is
	// destroyed. The transport destroys captures only on a NEW submission
	// (Submit), not on document changes.
	if _, err := r.Reserve(id); err != nil {
		t.Fatalf("capture must survive typing: %v", err)
	}
}

func TestDestroyTabAndDestroyAll(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))

	res1 := r.Submit(scope("tab1", 1), []PendingCredential{cred("sk-proj-dt-a-1234567890123456", "a.ai")})
	res2 := r.Submit(scope("tab2", 1), []PendingCredential{cred("sk-proj-dt-b-1234567890123456", "b.ai")})
	id1, id2 := res1[0].CaptureID, res2[0].CaptureID

	// Tab closure / disconnect destroys only that tab's pending captures.
	r.DestroyTab("tab1")
	if _, err := r.Reserve(id1); !errors.Is(err, ErrCaptureUnknown) {
		t.Fatalf("tab1 capture after DestroyTab = %v, want unknown", err)
	}
	if _, err := r.Reserve(id2); err != nil {
		t.Fatalf("tab2 capture after DestroyTab(tab1) = %v, want live", err)
	}

	// Vault seal / app lock / shutdown destroys everything still pending
	// (id2 was consumed by the alive-check above, so a fresh capture is
	// used for the DestroyAll assertion).
	res3 := r.Submit(scope("tab3", 1), []PendingCredential{cred("sk-proj-dt-c-1234567890123456", "c.ai")})
	id3 := res3[0].CaptureID
	r.DestroyAll()
	if _, err := r.Reserve(id3); !errors.Is(err, ErrCaptureUnknown) {
		t.Fatalf("capture after DestroyAll = %v, want unknown", err)
	}
}

func TestFingerprintsAreKeyedAndDistinct(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))
	a := r.Fingerprint([]byte("password123"))
	b := r.Fingerprint([]byte("password123"))
	c := r.Fingerprint([]byte("password124"))
	if a != b {
		t.Fatalf("same value, different fingerprints")
	}
	if a == c {
		t.Fatalf("different values, same fingerprint")
	}
}

func TestCaptureNeverSerializes(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))
	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-non-serial-1234567890", "n.ai")})
	h, err := r.Reserve(res[0].CaptureID)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	// The pending plaintext must refuse every serialization path — a JSON
	// response that accidentally carried the handle must fail loudly, not
	// ship the value.
	if _, err := json.Marshal(h.Value); err == nil {
		t.Fatal("json.Marshal of a pending value must fail, got nil")
	}
	if got := h.Value.String(); got != "[REDACTED]" {
		t.Fatalf("String() = %q, want [REDACTED]", got)
	}
}

func TestConcurrentReservesSettleToOneCreate(t *testing.T) {
	r, _ := newTestRegistry(t, time.Unix(1_750_000_000, 0))
	res := r.Submit(scope("t", 1), []PendingCredential{cred("sk-proj-concurrent-12345678901", "c.ai")})
	id := res[0].CaptureID

	if _, err := r.Reserve(id); err != nil {
		t.Fatalf("first reserve: %v", err)
	}
	// The second reserve must block until the first settles, then see the
	// same outcome — never run the vault a second time.
	got := make(chan error, 1)
	go func() {
		h, err := r.Reserve(id)
		if err != nil {
			got <- err
			return
		}
		if !h.Completed || h.Name != "c.ai" {
			got <- errors.New("second reserve did not see the settled outcome")
			return
		}
		got <- nil
	}()

	// Settle while the waiter is blocked.
	time.Sleep(10 * time.Millisecond)
	r.Complete(id, "c.ai", "sec:v1:system:w", false, nil)
	if err := <-got; err != nil {
		t.Fatalf("concurrent reserve: %v", err)
	}
}
