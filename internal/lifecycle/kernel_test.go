package lifecycle

import (
	"errors"
	"testing"
	"time"
)

// --- sequence and replay (decision 7) ---------------------------------------

func TestSequenceDuplicateAndDecreasingRejected(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	// seq 2 accepted, then the same seq 2 replayed, then a decreasing 1.
	mustIngest(t, k, "T", env("L", h, 2, startEvt(nil, "ls")))
	att, _ := k.OpenAttempt(h.Domain)
	if err := k.Ingest("T", env("L", h, 2, startEvt(nil, "ls"))); !errors.Is(err, ErrSequenceReplay) {
		t.Fatalf("duplicate seq must be rejected, got %v", err)
	}
	if err := k.Ingest("T", env("L", h, 1, promptReadyEvt())); !errors.Is(err, ErrSequenceReplay) {
		t.Fatalf("decreasing seq must be rejected, got %v", err)
	}
	// The attempt is still open: the rejected frames mutated nothing.
	if _, ok := k.Attempt(att.ID); !ok {
		t.Fatal("attempt must survive rejected frames")
	}
}

func TestSequenceStateMutatesOnlyAfterAuthentication(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	// A wrong-capability frame with a high sequence is rejected and must
	// not advance the counter: the same sequence is then accepted with the
	// right capability.
	wrong := h.Capability
	wrong[0] ^= 0xFF
	if err := k.Ingest("T", envRaw("L", h.Domain, h.Epoch, wrong, 999, startEvt(nil, "evil"))); !errors.Is(err, ErrBadCapability) {
		t.Fatalf("wrong capability must be rejected, got %v", err)
	}
	mustIngest(t, k, "T", env("L", h, 2, startEvt(nil, "ok")))
	att, ok := k.OpenAttempt(h.Domain)
	if !ok || att.Command != "ok" {
		t.Fatalf("counter must not have advanced past the rejected frame, got %+v", att)
	}
}

func TestReconnectNeverResetsCounterWithinEpoch(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	mustIngest(t, k, "T", env("L", h, 2, startEvt(nil, "a")))
	att, _ := k.OpenAttempt(h.Domain)

	// The shell's connection drops and reconnects: a hello with the same
	// epoch and capability is a reconnect, answered with accept, and the
	// counter continues from 3 — a replayed 2 is still rejected.
	p.reset()
	mustIngest(t, k, "T", env("L", h, 3, helloEvt("bash")))
	mustAccept(t, p)
	if err := k.Ingest("T", env("L", h, 2, promptReadyEvt())); !errors.Is(err, ErrSequenceReplay) {
		t.Fatalf("reconnect must not reset the counter, got %v", err)
	}
	mustIngest(t, k, "T", env("L", h, 4, completeEvt(att.ID, 0, fence(0xAA))))
	if got, _ := k.Attempt(att.ID); got.State != AttemptCompleted {
		t.Fatalf("attempt must complete after reconnect, got %v", got.State)
	}
}

// --- loss and abandonment (decisions 8, 5) -----------------------------------

func TestAttemptUnknownOnTransportLossNeverSuccessful(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "long job", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "long job")))

	if err := k.TransportLost("T"); err != nil {
		t.Fatal(err)
	}
	got, ok := k.Attempt(att.ID)
	if !ok || got.State != AttemptUnknown {
		t.Fatalf("open attempt must become unknown on loss, got %+v", got)
	}
	if got.ExitCode != nil {
		t.Fatalf("loss must never assign an exit code, got %d", *got.ExitCode)
	}
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleLost {
		t.Fatalf("lane must be Lost, got %v", st.Lifecycle)
	}
}

func TestDomainClosedUnknownsOpenAttempts(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "sudo ls", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "sudo ls")))
	mustIngest(t, k, "T", env("L", h, 3, closeEvt()))
	if got, _ := k.Attempt(att.ID); got.State != AttemptUnknown {
		t.Fatalf("closing a domain must unknown its open attempt, got %v", got.State)
	}
}

func TestAbandonAttempt(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "thing", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "thing")))
	if err := k.AbandonAttempt(att.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := k.Attempt(att.ID); got.State != AttemptUnknown || got.ExitCode != nil {
		t.Fatalf("abandoned attempt must be unknown with no exit code, got %+v", got)
	}
	// A completion for an abandoned attempt is rejected.
	if err := k.Ingest("T", env("L", h, 3, completeEvt(att.ID, 0, fence(0xBB)))); !errors.Is(err, ErrAttemptNotOpen) {
		t.Fatalf("completion of an abandoned attempt must be rejected, got %v", err)
	}
}

// --- desynchronization and the snapshot (decision 7) -------------------------

func TestGapDesynchronizesAndOnlySnapshotRestores(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "make", "/work", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "make")))

	p.reset()
	if err := k.NotifyGap("T", h.Domain, 512, 3); err != nil {
		t.Fatal(err)
	}
	// The kernel demanded a snapshot.
	kinds := p.kinds()
	if len(kinds) != 1 || kinds[0] != KindRefreshRequest {
		t.Fatalf("desync must emit exactly one refresh_request, got %v", kinds)
	}
	rid := p.envelopes()[0].Event.RefreshRequest.RequestID
	st := mustState(t, k, "L")
	if st.Lifecycle != LifecycleDesynchronized || st.Domain != h.Domain {
		t.Fatalf("lane must be Desynchronized, got %+v", st)
	}

	// Ordinary lifecycle events are quarantined: rejected, nothing mutated.
	if err := k.Ingest("T", env("L", h, 3, promptReadyEvt())); !errors.Is(err, ErrDomainDesynchronized) {
		t.Fatalf("events while desynced must be quarantined, got %v", err)
	}
	// A snapshot answering the wrong request is rejected.
	if err := k.Ingest("T", env("L", h, 4, snapshotEvt("req-other", ShellRunning, &att.ID, nil, 5))); !errors.Is(err, ErrSnapshotMismatch) {
		t.Fatalf("snapshot answering another request must be rejected, got %v", err)
	}
	// The real answer restores authority and keeps the open attempt running.
	mustIngest(t, k, "T", env("L", h, 5, snapshotEvt(rid, ShellRunning, &att.ID, nil, 6)))
	st = mustState(t, k, "L")
	assertState(t, st, LifecycleRunning, h.Domain, att.ID, []DomainID{h.Domain})
	if got, _ := k.Attempt(att.ID); got.State != AttemptOpen {
		t.Fatalf("snapshot-named active attempt must stay open, got %v", got.State)
	}
	mustIngest(t, k, "T", env("L", h, 6, completeEvt(att.ID, 1, fence(0xCC))))
	if got, _ := k.Attempt(att.ID); got.State != AttemptCompleted || *got.ExitCode != 1 {
		t.Fatalf("attempt must complete after resync, got %+v", got)
	}
}

func TestSnapshotReconcilesOpenAttemptAsUnknown(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "lost in gap", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "lost in gap")))

	p.reset()
	if err := k.NotifyGap("T", h.Domain, 64, 1); err != nil {
		t.Fatal(err)
	}
	rid := p.envelopes()[0].Event.RefreshRequest.RequestID
	// The shell is at a prompt with no active attempt and no completion for
	// ours: the open attempt must become unknown, never successful.
	last := &CompletedRef{AttemptID: "att-other", ExitCode: intPtr(0)}
	mustIngest(t, k, "T", env("L", h, 3, snapshotEvt(rid, ShellAtPrompt, nil, last, 4)))
	if got, _ := k.Attempt(att.ID); got.State != AttemptUnknown || got.ExitCode != nil {
		t.Fatalf("unrecoverable attempt must be unknown with no exit code, got %+v", got)
	}
	st := mustState(t, k, "L")
	assertState(t, st, LifecyclePromptReady, h.Domain, "", []DomainID{h.Domain})
}

func TestSnapshotCreatesShellOriginatedActiveAttempt(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	p.reset()
	if err := k.NotifyGap("T", h.Domain, 64, 1); err != nil {
		t.Fatal(err)
	}
	rid := p.envelopes()[0].Event.RefreshRequest.RequestID
	// The gap swallowed the Start; the snapshot names the running attempt.
	sid := AttemptID("att-shell-1")
	mustIngest(t, k, "T", env("L", h, 2, snapshotEvt(rid, ShellRunning, &sid, nil, 3)))
	st := mustState(t, k, "L")
	assertState(t, st, LifecycleRunning, h.Domain, sid, []DomainID{h.Domain})
	if got, ok := k.Attempt(sid); !ok || got.Origin != OriginShell || got.State != AttemptOpen {
		t.Fatalf("snapshot-declared attempt must exist shell-originated and open, got %+v", got)
	}
}

func TestSnapshotContradictionsRejected(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "x", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "x")))

	p.reset()
	if err := k.NotifyGap("T", h.Domain, 64, 1); err != nil {
		t.Fatal(err)
	}
	rid := p.envelopes()[0].Event.RefreshRequest.RequestID
	// Active and last-completed naming the same attempt: contradiction.
	if err := k.Ingest("T", env("L", h, 3, snapshotEvt(rid, ShellRunning, &att.ID, &CompletedRef{AttemptID: att.ID, ExitCode: intPtr(0)}, 4))); !errors.Is(err, ErrSnapshotConflict) {
		t.Fatalf("contradictory snapshot must be rejected, got %v", err)
	}
	// A snapshot with a next sequence that does not advance is rejected.
	if err := k.Ingest("T", env("L", h, 4, snapshotEvt(rid, ShellRunning, &att.ID, nil, 3))); !errors.Is(err, ErrSnapshotSequence) {
		t.Fatalf("non-advancing snapshot must be rejected, got %v", err)
	}
	// A snapshot answering a different request id is rejected.
	if err := k.Ingest("T", env("L", h, 5, snapshotEvt("req-none", ShellRunning, &att.ID, nil, 6))); !errors.Is(err, ErrSnapshotMismatch) {
		t.Fatalf("snapshot answering another request must be rejected, got %v", err)
	}
	// The domain is still desynchronized after all the rejections.
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleDesynchronized {
		t.Fatalf("rejections must not restore authority, got %v", st.Lifecycle)
	}
}

func TestSnapshotValidationPrecedesMutation(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	// A foreign-domain attempt on a second lane.
	hO := establish(t, k, "T", p, "L2", nil)
	foreign, err := k.SubmitAttempt(hO.Domain, "other", "/", "other")
	if err != nil {
		t.Fatal(err)
	}
	mustIngest(t, k, "T", env("L2", hO, 2, startEvt(&foreign.ID, "other")))

	p.reset()
	if err := k.NotifyGap("T", h.Domain, 64, 1); err != nil {
		t.Fatal(err)
	}
	rid := p.envelopes()[0].Event.RefreshRequest.RequestID

	// The snapshot names an unknown active attempt (which the apply phase
	// would create) and a last-completed attempt from a foreign domain:
	// the whole envelope must be rejected before anything mutates.
	ghost := AttemptID("att-ghost")
	last := &CompletedRef{AttemptID: foreign.ID, ExitCode: intPtr(0)}
	if err := k.Ingest("T", env("L", h, 3, snapshotEvt(rid, ShellRunning, &ghost, last, 4))); !errors.Is(err, ErrSnapshotConflict) {
		t.Fatalf("foreign last-completed must be rejected, got %v", err)
	}
	if _, exists := k.Attempt(ghost); exists {
		t.Fatal("rejected snapshot must not have created the unknown active attempt")
	}
	if got, _ := k.Attempt(foreign.ID); got.State != AttemptOpen {
		t.Fatalf("rejected snapshot must not have completed the foreign attempt, got %v", got.State)
	}
	// The domain stays desynchronized: the rejection restored nothing.
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleDesynchronized {
		t.Fatalf("rejection must not restore authority, got %v", st.Lifecycle)
	}
}

func TestDesyncBudgetExhaustionRevokesDomain(t *testing.T) {
	// Episode budget of one: the second gap revokes the domain outright.
	k, _, _ := newTestKernel(Options{Budgets: Budgets{MaxDesyncEpisodes: 1}})
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "x", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "x")))

	p.reset()
	if err := k.NotifyGap("T", h.Domain, 16, 1); err != nil {
		t.Fatal(err)
	}
	rid := p.envelopes()[0].Event.RefreshRequest.RequestID
	mustIngest(t, k, "T", env("L", h, 3, snapshotEvt(rid, ShellRunning, &att.ID, nil, 4)))
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleRunning {
		t.Fatalf("first episode must be recoverable, got %v", st.Lifecycle)
	}
	// The second episode exceeds the budget of one: the gap itself revokes
	// (it is accepted, then the domain is gone), and later gaps are rejected.
	if err := k.NotifyGap("T", h.Domain, 16, 1); err != nil {
		t.Fatalf("the revoking gap must not error, got %v", err)
	}
	if err := k.NotifyGap("T", h.Domain, 16, 1); !errors.Is(err, ErrDomainNotLive) {
		t.Fatalf("gap on a revoked domain must be rejected, got %v", err)
	}
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleNative || len(st.Stack) != 0 {
		t.Fatalf("revoked domain must leave a native lane, got %+v", st)
	}
	if got, _ := k.Attempt(att.ID); got.State != AttemptUnknown {
		t.Fatalf("revocation must unknown the open attempt, got %v", got.State)
	}
}

func TestDesyncScanBudgetExhaustionRevokesDomain(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	if err := k.NotifyGap("T", h.Domain, 0, 0); err != nil {
		t.Fatal(err)
	}
	// 200 garbage frames exceeds the 128-frame budget.
	if err := k.NotifyGap("T", h.Domain, 0, 200); err != nil {
		t.Fatal(err)
	}
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleNative {
		t.Fatalf("scan-budget exhaustion must revoke, got %v", st.Lifecycle)
	}
	if d, _ := k.Domain(h.Domain); d.State != DomainClosed {
		t.Fatalf("domain must be closed, got %v", d.State)
	}
}

func TestDesyncDurationBudgetExhaustionRevokesDomain(t *testing.T) {
	k, clock, _ := newTestKernel(Options{Budgets: Budgets{ScanDuration: 5 * time.Second}})
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	if err := k.NotifyGap("T", h.Domain, 0, 0); err != nil {
		t.Fatal(err)
	}
	clock.advance(6 * time.Second)
	if err := k.NotifyGap("T", h.Domain, 0, 0); err != nil {
		t.Fatal(err)
	}
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleNative {
		t.Fatalf("duration-budget exhaustion must revoke, got %v", st.Lifecycle)
	}
}

// --- handshake (decision 3) ---------------------------------------------------

func TestNothingBeforeAccept(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h, err := k.RequestDomain("L", nil, "T")
	if err != nil {
		t.Fatal(err)
	}
	// Lifecycle events for a Pending domain are rejected before any accept.
	if err := k.Ingest("T", env("L", h, 1, startEvt(nil, "ls"))); !errors.Is(err, ErrDomainPending) {
		t.Fatalf("start before accept must be rejected, got %v", err)
	}
	if err := k.Ingest("T", env("L", h, 1, promptReadyEvt())); !errors.Is(err, ErrDomainPending) {
		t.Fatalf("prompt_ready before accept must be rejected, got %v", err)
	}
	if len(p.envelopes()) != 0 {
		t.Fatalf("nothing may be sent before accept, got %v", p.kinds())
	}
}

func TestHandshakeRateLimit(t *testing.T) {
	k, clock, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	// Eight failed handshakes fill the budget…
	for i := 0; i < 8; i++ {
		wrong := h.Capability
		wrong[0] ^= byte(i + 1)
		if err := k.Ingest("T", envRaw("L", h.Domain, h.Epoch, wrong, 100, helloEvt("bash"))); !errors.Is(err, ErrBadCapability) {
			t.Fatalf("failed handshake %d must be rejected, got %v", i, err)
		}
	}
	// …and new establishment on the lane is refused.
	if _, err := k.RequestDomain("L", nil, "T"); !errors.Is(err, ErrHandshakeRateLimited) {
		t.Fatalf("establishment must be rate limited, got %v", err)
	}
	// The window drains; the limiter clears (the lane is still busy with its
	// established domain, so ErrLaneBusy is the expected non-rate-limit
	// outcome — it proves the limiter no longer refuses).
	clock.advance(31 * time.Second)
	if _, err := k.RequestDomain("L", nil, "T"); errors.Is(err, ErrHandshakeRateLimited) {
		t.Fatalf("establishment must recover after the window")
	}
}

// --- attempts (decision 5) ----------------------------------------------------

func TestStartAttachRules(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	// A start naming a mismatched attempt over a pending app attempt is
	// rejected; the anonymous start attaches.
	att, _ := k.SubmitAttempt(h.Domain, "app cmd", "/", "local")
	other := AttemptID("att-other")
	if err := k.Ingest("T", env("L", h, 2, startEvt(&other, "evil"))); !errors.Is(err, ErrAttemptMismatch) {
		t.Fatalf("mismatched explicit start must be rejected, got %v", err)
	}
	mustIngest(t, k, "T", env("L", h, 3, startEvt(nil, "evil")))
	if got, _ := k.Attempt(att.ID); !got.Started || got.Command != "app cmd" {
		t.Fatalf("anonymous start must attach to the app attempt, got %+v", got)
	}
	if _, exists := k.Attempt(other); exists {
		t.Fatal("the mismatched id must never become an attempt")
	}

	// A second start while the attempt runs is a violation — with an
	// explicit id and without.
	if err := k.Ingest("T", env("L", h, 4, startEvt(&att.ID, "again"))); !errors.Is(err, ErrAttemptOpen) {
		t.Fatalf("start while running must be rejected, got %v", err)
	}
	if err := k.Ingest("T", env("L", h, 5, startEvt(nil, "again"))); !errors.Is(err, ErrAttemptOpen) {
		t.Fatalf("anonymous start while running must be rejected, got %v", err)
	}
}

func TestStartRequiresPromptReady(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "x", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "x")))
	mustIngest(t, k, "T", env("L", h, 3, completeEvt(att.ID, 0, fence(0x01))))
	// The lane is Running with a closed attempt, awaiting prompt_ready: a
	// fresh start here would open a second attempt — rejected.
	if err := k.Ingest("T", env("L", h, 4, startEvt(nil, "too early"))); !errors.Is(err, ErrNotPromptReady) {
		t.Fatalf("start before prompt_ready must be rejected, got %v", err)
	}
}

func TestPromptReadyOverOpenAttemptRejected(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "x", "/", "local")
	mustIngest(t, k, "T", env("L", h, 2, startEvt(&att.ID, "x")))
	if err := k.Ingest("T", env("L", h, 3, promptReadyEvt())); !errors.Is(err, ErrPromptOverAttempt) {
		t.Fatalf("prompt_ready over an open attempt must be rejected, got %v", err)
	}
}

func TestCompleteValidation(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(h.Domain, "x", "/", "local")

	// Complete before start: rejected.
	if err := k.Ingest("T", env("L", h, 2, completeEvt(att.ID, 0, fence(0x02)))); !errors.Is(err, ErrAttemptNotStarted) {
		t.Fatalf("completion of an unstarted attempt must be rejected, got %v", err)
	}
	mustIngest(t, k, "T", env("L", h, 3, startEvt(&att.ID, "x")))
	// Missing fence: rejected.
	if err := k.Ingest("T", env("L", h, 4, completeEvtNoFence(att.ID))); !errors.Is(err, ErrFenceMissing) {
		t.Fatalf("fence-less completion must be rejected, got %v", err)
	}
	mustIngest(t, k, "T", env("L", h, 5, completeEvt(att.ID, 7, fence(0x03))))
	// Exit status is set exactly once.
	if err := k.Ingest("T", env("L", h, 6, completeEvt(att.ID, 0, fence(0x04)))); !errors.Is(err, ErrAttemptNotOpen) {
		t.Fatalf("second completion must be rejected, got %v", err)
	}
	if got, _ := k.Attempt(att.ID); got.ExitCode == nil || *got.ExitCode != 7 {
		t.Fatalf("first status must persist, got %+v", got)
	}
}

func TestCompleteCannotCrossDomains(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	hA := establish(t, k, "T", p, "L", nil)
	att, _ := k.SubmitAttempt(hA.Domain, "sudo", "/", "local")
	mustIngest(t, k, "T", env("L", hA, 2, startEvt(&att.ID, "sudo")))
	mustIngest(t, k, "T", env("L", hA, 3, suspendEvt()))
	hB := establish(t, k, "T", p, "L", &hA.Domain)
	// A completion for A's attempt arriving with B's domain on the envelope:
	// wrong domain. With A's own domain: A is inactive. Both rejected.
	if err := k.Ingest("T", env("L", hB, 2, completeEvt(att.ID, 0, fence(0x05)))); !errors.Is(err, ErrAttemptDomainMismatch) {
		t.Fatalf("cross-domain completion must be rejected, got %v", err)
	}
	if err := k.Ingest("T", env("L", hA, 4, completeEvt(att.ID, 0, fence(0x06)))); !errors.Is(err, ErrDomainInactive) {
		t.Fatalf("completion for an inactive domain must be rejected, got %v", err)
	}
}

// --- domain stack (decisions 2, 6) ---------------------------------------------

func TestChildCannotEstablishOverActiveParent(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	hA := establish(t, k, "T", p, "L", nil)
	// The child's hello arrives while the parent is still active: rejected.
	hB, err := k.RequestDomain("L", &hA.Domain, "T")
	if err != nil {
		t.Fatal(err)
	}
	if err := k.Ingest("T", env("L", hB, 1, helloEvt("bash"))); !errors.Is(err, ErrParentActive) {
		t.Fatalf("child over an active parent must be rejected, got %v", err)
	}
	if _, ok := k.Domain(hB.Domain); !ok {
		t.Fatal("the pending domain must still exist (rejected, not destroyed)")
	}
	// After the parent suspends, the same hello establishes the child.
	mustIngest(t, k, "T", env("L", hA, 2, suspendEvt()))
	mustIngest(t, k, "T", env("L", hB, 1, helloEvt("bash")))
	if st := mustState(t, k, "L"); st.Lifecycle != LifecyclePromptReady || st.Domain != hB.Domain {
		t.Fatalf("child must be active after parent suspends, got %+v", st)
	}
}

func TestSecondRootRejectedWhileLaneLive(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	establish(t, k, "T", p, "L", nil)
	if _, err := k.RequestDomain("L", nil, "T"); !errors.Is(err, ErrLaneBusy) {
		t.Fatalf("a second top-level domain on a live lane must be rejected, got %v", err)
	}
}

func TestActivateAndCloseOrdering(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	hA := establish(t, k, "T", p, "L", nil)
	// Activating an established (active) domain is not a thing.
	if err := k.Ingest("T", env("L", hA, 2, activateEvt())); !errors.Is(err, ErrNotSuspended) {
		t.Fatalf("activating an established domain must be rejected, got %v", err)
	}
	mustIngest(t, k, "T", env("L", hA, 3, suspendEvt()))
	hB := establish(t, k, "T", p, "L", &hA.Domain)

	// The parent cannot be activated while the child is on top.
	if err := k.Ingest("T", env("L", hA, 4, activateEvt())); !errors.Is(err, ErrDomainNotTop) {
		t.Fatalf("activation under a live child must be rejected, got %v", err)
	}
	// The child closes; closing it again is rejected.
	mustIngest(t, k, "T", env("L", hB, 2, closeEvt()))
	if err := k.Ingest("T", env("L", hB, 3, closeEvt())); !errors.Is(err, ErrDomainNotLive) {
		t.Fatalf("closing a closed domain must be rejected, got %v", err)
	}
}

func TestSuspendedDomainEventsRejected(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	hA := establish(t, k, "T", p, "L", nil)
	mustIngest(t, k, "T", env("L", hA, 2, suspendEvt()))
	for _, evt := range []Event{
		startEvt(nil, "x"),
		promptReadyEvt(),
		suspendEvt(),
	} {
		if err := k.Ingest("T", env("L", hA, 3, evt)); !errors.Is(err, ErrDomainInactive) {
			t.Fatalf("suspended-domain event %s must be rejected, got %v", evt.Kind, err)
		}
	}
	if _, err := k.SubmitAttempt(hA.Domain, "x", "/", "local"); !errors.Is(err, ErrDomainInactive) {
		t.Fatalf("submit into a suspended domain must be rejected, got %v", err)
	}
}

// --- transports (decision 8) --------------------------------------------------

func TestTransportLossCascadesToDescendants(t *testing.T) {
	k, _, _ := newTestKernel()
	p1, p2 := &fakePort{}, &fakePort{}
	_ = k.BindTransport("T1", p1)
	_ = k.BindTransport("T2", p2)
	// Local shell on T1; its ssh child on T2 (real nested topology).
	hA := establish(t, k, "T1", p1, "L", nil)
	mustIngest(t, k, "T1", env("L", hA, 2, suspendEvt()))
	hB := establish(t, k, "T2", p2, "L", &hA.Domain)

	// Losing the parent's transport takes the child down with it, even
	// though the child's own transport is untouched.
	if err := k.TransportLost("T1"); err != nil {
		t.Fatal(err)
	}
	if dA, _ := k.Domain(hA.Domain); dA.State != DomainLost {
		t.Fatalf("parent must be lost, got %v", dA.State)
	}
	if dB, _ := k.Domain(hB.Domain); dB.State != DomainLost {
		t.Fatalf("child must be lost with its parent chain, got %v", dB.State)
	}
	if st := mustState(t, k, "L"); st.Lifecycle != LifecycleLost {
		t.Fatalf("lane must be lost, got %v", st.Lifecycle)
	}
}

// --- addressing and envelope validation ---------------------------------------

func TestEnvelopeAddressingRejected(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)

	badVersion := env("L", h, 2, startEvt(nil, "x"))
	badVersion.Version = 99
	badLane := envRaw("L2", h.Domain, h.Epoch, h.Capability, 2, startEvt(nil, "x"))
	badDomain := envRaw("L", "dom-nope", h.Epoch, h.Capability, 2, startEvt(nil, "x"))
	unknownTransport := env("L", h, 2, startEvt(nil, "x"))

	if err := k.Ingest("T2", unknownTransport); !errors.Is(err, ErrUnknownTransport) {
		t.Fatalf("unknown transport must be rejected, got %v", err)
	}
	if err := k.Ingest("T", badDomain); !errors.Is(err, ErrUnknownDomain) {
		t.Fatalf("unknown domain must be rejected, got %v", err)
	}
	if err := k.Ingest("T", badVersion); !errors.Is(err, ErrBadVersion) {
		t.Fatalf("bad version must be rejected, got %v", err)
	}
	if err := k.Ingest("T", badLane); !errors.Is(err, ErrWrongLane) {
		t.Fatalf("wrong lane must be rejected, got %v", err)
	}
}

func TestKernelOriginatedKindsRejectedInbound(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	for _, evt := range []Event{
		{Kind: KindAccept, Accept: &Accept{}},
		{Kind: KindRefreshRequest, RefreshRequest: &RefreshRequest{RequestID: "r"}},
		{Kind: KindDomainEstablished, DomainEstablished: &DomainEstablishedEvent{}},
	} {
		if err := k.Ingest("T", env("L", h, 2, evt)); !errors.Is(err, ErrIllegalEvent) {
			t.Fatalf("kernel-originated kind %s must be rejected inbound, got %v", evt.Kind, err)
		}
	}
}

func TestRegistrySupportsSeveralDomainsOnOneTransport(t *testing.T) {
	r := NewDomainRegistry()
	d1 := &Domain{ID: "d1", Transport: "T", State: DomainPending}
	d2 := &Domain{ID: "d2", Transport: "T", State: DomainPending}
	d3 := &Domain{ID: "d3", Transport: "T2", State: DomainPending}
	r.Register(d1)
	r.Register(d2)
	r.Register(d3)
	if got := r.DomainsOnTransport("T"); len(got) != 2 {
		t.Fatalf("want 2 domains on T, got %d", len(got))
	}
	if got := r.DomainsOnTransport("T2"); len(got) != 1 {
		t.Fatalf("want 1 domain on T2, got %d", len(got))
	}
	if d, ok := r.Lookup("d2"); !ok || d.ID != "d2" {
		t.Fatalf("lookup failed: %v %v", d, ok)
	}
}

func TestStateUnknownLane(t *testing.T) {
	k, _, _ := newTestKernel()
	if _, err := k.State("nowhere"); !errors.Is(err, ErrUnknownLane) {
		t.Fatalf("unknown lane must error, got %v", err)
	}
}

func TestOversizeCommandRejected(t *testing.T) {
	k, _, _ := newTestKernel(Options{Budgets: Budgets{MaxCommandBytes: 16}})
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	big := make([]byte, 64)
	for i := range big {
		big[i] = 'x'
	}
	if _, err := k.SubmitAttempt(h.Domain, string(big), "/", "local"); !errors.Is(err, ErrOversizeCommand) {
		t.Fatalf("oversize submit must be rejected, got %v", err)
	}
	if err := k.Ingest("T", env("L", h, 2, startEvt(nil, string(big)))); !errors.Is(err, ErrOversizeCommand) {
		t.Fatalf("oversize start must be rejected, got %v", err)
	}
}

func intPtr(i int) *int { return &i }

// A shell that attached to an app-submitted attempt never learns the app-minted
// id, so it completes without naming one and the kernel resolves the domain's
// single open attempt. A required id here made completion unreachable from the
// shell on the primary path (found by the shell adapter, nocx-u7uh.3).
func TestCompleteWithoutAttemptIDResolvesByContext(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	att, err := k.SubmitAttempt(h.Domain, "echo hi", "/home/dev", "local")
	if err != nil {
		t.Fatalf("SubmitAttempt: %v", err)
	}
	if err := k.Ingest("T", env("L", h, 2, startEvt(nil, "echo hi"))); err != nil {
		t.Fatalf("start: %v", err)
	}
	ev := Event{Kind: KindComplete, Complete: &Complete{ExitCode: intPtr(0), Fence: fence(0x31)}}
	if err := k.Ingest("T", env("L", h, 3, ev)); err != nil {
		t.Fatalf("unnamed completion must resolve the open attempt: %v", err)
	}
	got, ok := k.Attempt(att.ID)
	if !ok || got.State != AttemptCompleted || got.ExitCode == nil || *got.ExitCode != 0 {
		t.Fatalf("attempt not completed by context: %+v", got)
	}
}

// A named id that is not the domain's open attempt is still refused, so making
// the field optional did not loosen the cross-attempt rule.
func TestCompleteWithForeignAttemptIDRejected(t *testing.T) {
	k, _, _ := newTestKernel()
	p := &fakePort{}
	_ = k.BindTransport("T", p)
	h := establish(t, k, "T", p, "L", nil)
	if _, err := k.SubmitAttempt(h.Domain, "echo hi", "/home/dev", "local"); err != nil {
		t.Fatalf("SubmitAttempt: %v", err)
	}
	if err := k.Ingest("T", env("L", h, 2, startEvt(nil, "echo hi"))); err != nil {
		t.Fatalf("start: %v", err)
	}
	bogus := AttemptID("does-not-exist")
	ev := Event{Kind: KindComplete, Complete: &Complete{AttemptID: &bogus, ExitCode: intPtr(0), Fence: fence(0x32)}}
	if err := k.Ingest("T", env("L", h, 3, ev)); !errors.Is(err, ErrAttemptNotOpen) {
		t.Fatalf("foreign attempt id must be rejected, got %v", err)
	}
}
