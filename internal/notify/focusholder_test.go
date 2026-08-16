package notify_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/notify"
)

// TestFocusHolder_UnboundSuppressesNothing is the state every build starts in
// and, until something reports focus, stays in. It must report no window and
// no session focused, because the policy's suppression rule reads both and a
// wrong answer here silently swallows notifications.
func TestFocusHolder_UnboundSuppressesNothing(t *testing.T) {
	var f notify.FocusHolder
	if f.WindowFocused() {
		t.Error("unbound holder reports the window focused, want false")
	}
	if s := f.FocusedSession(); s != "" {
		t.Errorf("unbound holder reports focused session %q, want empty", s)
	}
}

func TestFocusHolder_SetIsReadBack(t *testing.T) {
	var f notify.FocusHolder
	f.Set(true, "s-7")
	if !f.WindowFocused() || f.FocusedSession() != "s-7" {
		t.Fatalf("after Set(true, s-7): windowed=%v session=%q", f.WindowFocused(), f.FocusedSession())
	}
	// Losing focus must clear both halves: a stale session with the window
	// unfocused would be read by nothing today, but the pair is the state.
	f.Set(false, "")
	if f.WindowFocused() || f.FocusedSession() != "" {
		t.Fatalf("after Set(false, \"\"): windowed=%v session=%q", f.WindowFocused(), f.FocusedSession())
	}
}

func TestFocusHolder_ConcurrentSetAndRead(t *testing.T) {
	var f notify.FocusHolder
	var wg sync.WaitGroup
	wg.Add(100)
	for i := 0; i < 50; i++ {
		go func() { defer wg.Done(); f.Set(true, "s-1") }()
		go func() { defer wg.Done(); _, _ = f.WindowFocused(), f.FocusedSession() }()
	}
	wg.Wait()
}

// TestFocusHolder_DrivesPolicySuppression is the paired positive: the holder
// is not decoration, it is what the policy reads. Bound to the session being
// raised, an event is suppressed; unbound, the same event is not.
func TestFocusHolder_DrivesPolicySuppression(t *testing.T) {
	focus := &notify.FocusHolder{}
	router, err := notify.NewRouter(notify.Table{}, notify.Limits{
		MaxInFlight: 1, DeliveryTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	p, err := notify.NewPolicy(context.Background(), router, time.Minute, focus, notify.NewManualClock())
	if err != nil {
		t.Fatal(err)
	}

	ev := notify.Event{SessionID: "s-1", Kind: notify.KindProgramNotify, Trust: notify.TrustProgramRequest}

	if got := p.Submit(ev); got == notify.DispositionSuppressed {
		t.Fatalf("unbound focus suppressed %v; nothing may be suppressed before focus is reported", got)
	}

	focus.Set(true, "s-1")
	if got := p.Submit(ev); got != notify.DispositionSuppressed {
		t.Errorf("focused session: disposition %v, want suppressed", got)
	}

	// A different tab is not the one being watched.
	focus.Set(true, "s-2")
	if got := p.Submit(ev); got == notify.DispositionSuppressed {
		t.Error("an unfocused session was suppressed; suppression must be per session")
	}

	// The window itself being away means the user is not watching anything.
	focus.Set(false, "s-1")
	if got := p.Submit(ev); got == notify.DispositionSuppressed {
		t.Error("suppressed while the window was not focused")
	}
}

// TestPolicyRaise_AcceptsWithoutWaitingForDelivery pins the contract the
// transport depends on: Raise answers as soon as the event is accepted, and
// its nil Err means accepted, never delivered. A program must not block until
// a debounce window closes.
func TestPolicyRaise_AcceptsWithoutWaitingForDelivery(t *testing.T) {
	clock := notify.NewManualClock()
	router, err := notify.NewRouter(notify.Table{}, notify.Limits{
		MaxInFlight: 1, DeliveryTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	p, err := notify.NewPolicy(context.Background(), router, time.Minute, &notify.FocusHolder{}, clock)
	if err != nil {
		t.Fatal(err)
	}

	out := p.Raise(context.Background(), notify.Event{
		SessionID: "s-1", Kind: notify.KindProgramNotify, Trust: notify.TrustProgramRequest,
	})
	if out.Err != nil {
		t.Errorf("Raise returned %v, want a nil Err meaning accepted", out.Err)
	}
	if len(out.Results) != 0 {
		t.Errorf("Raise returned %d results; delivery is asynchronous and carries none", len(out.Results))
	}
}

// TestPolicyRaise_RefusesCancelledCaller: a caller that has already given up
// is told so rather than having its event enter a window nobody asked for.
func TestPolicyRaise_RefusesCancelledCaller(t *testing.T) {
	router, err := notify.NewRouter(notify.Table{}, notify.Limits{
		MaxInFlight: 1, DeliveryTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	p, err := notify.NewPolicy(context.Background(), router, time.Minute, &notify.FocusHolder{}, notify.NewManualClock())
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if out := p.Raise(ctx, notify.Event{SessionID: "s-1"}); out.Err == nil {
		t.Error("Raise accepted an event from a cancelled caller")
	}
}
