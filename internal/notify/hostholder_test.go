package notify_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/notify"
)

// recordingHost counts what reached it, so a test can tell "the holder
// delegated" from "the holder swallowed".
type recordingHost struct {
	mu      sync.Mutex
	banners int
	badges  []int
	bounces int
	err     error
}

func (h *recordingHost) Banner(context.Context, notify.Event) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.banners++
	return h.err
}

func (h *recordingHost) Badge(_ context.Context, n int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.badges = append(h.badges, n)
	return h.err
}

func (h *recordingHost) Bounce(context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.bounces++
	return h.err
}

func (h *recordingHost) counts() (int, int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.banners, len(h.badges), h.bounces
}

// TestHostHolder_UnboundReportsUnavailable: the zero holder is the state
// every host that never binds one lives in — cmd/devharness, the dev-web
// harness, an e2e run. It must report unavailable on all three surfaces, so
// a raise there is a visible failed delivery and never a silent drop.
func TestHostHolder_UnboundReportsUnavailable(t *testing.T) {
	var h notify.HostHolder
	ctx := context.Background()

	if err := h.Banner(ctx, notify.Event{}); !errors.Is(err, notify.ErrUnavailable) {
		t.Errorf("Banner on unbound holder = %v, want ErrUnavailable", err)
	}
	if err := h.Badge(ctx, 3); !errors.Is(err, notify.ErrUnavailable) {
		t.Errorf("Badge on unbound holder = %v, want ErrUnavailable", err)
	}
	if err := h.Bounce(ctx); !errors.Is(err, notify.ErrUnavailable) {
		t.Errorf("Bounce on unbound holder = %v, want ErrUnavailable", err)
	}
}

// TestHostHolder_BoundDelegatesEverySurface is the paired positive of the
// test above: on an ordinary desktop host the holder is transparent, and all
// three surfaces reach the bound implementation with their arguments intact.
func TestHostHolder_BoundDelegatesEverySurface(t *testing.T) {
	var h notify.HostHolder
	host := &recordingHost{}
	h.Set(host)
	ctx := context.Background()

	if err := h.Banner(ctx, notify.Event{Title: "done"}); err != nil {
		t.Errorf("Banner: %v", err)
	}
	if err := h.Badge(ctx, 7); err != nil {
		t.Errorf("Badge: %v", err)
	}
	if err := h.Bounce(ctx); err != nil {
		t.Errorf("Bounce: %v", err)
	}

	banners, badges, bounces := host.counts()
	if banners != 1 || badges != 1 || bounces != 1 {
		t.Fatalf("delegated banners=%d badges=%d bounces=%d, want 1 each", banners, badges, bounces)
	}
	if host.badges[0] != 7 {
		t.Errorf("Badge count reached host as %d, want 7", host.badges[0])
	}
}

// TestHostHolder_PropagatesHostFailure: the holder must not convert a bound
// host's failure into success. A denied or unavailable desktop surface is a
// visible failed delivery, and the holder is not allowed to hide it.
func TestHostHolder_PropagatesHostFailure(t *testing.T) {
	var h notify.HostHolder
	want := errors.New("denied by the user")
	h.Set(&recordingHost{err: want})

	if err := h.Banner(context.Background(), notify.Event{}); !errors.Is(err, want) {
		t.Errorf("Banner = %v, want the host's own error", err)
	}
}

// TestHostHolder_SetReplacesPreviousHost: Set is wired once at startup, but
// it is not one-shot, and a second bind must not leave the first host
// receiving events.
func TestHostHolder_SetReplacesPreviousHost(t *testing.T) {
	var h notify.HostHolder
	first, second := &recordingHost{}, &recordingHost{}
	h.Set(first)
	h.Set(second)

	if err := h.Banner(context.Background(), notify.Event{}); err != nil {
		t.Fatalf("Banner: %v", err)
	}
	if b, _, _ := first.counts(); b != 0 {
		t.Errorf("replaced host received %d banners, want 0", b)
	}
	if b, _, _ := second.counts(); b != 1 {
		t.Errorf("current host received %d banners, want 1", b)
	}
}

// TestHostHolder_ConcurrentSetAndBanner is why the holder has a mutex: Set
// runs during startup while raises can already be arriving from a session
// that reattached, so the bind and the read genuinely overlap. Run under
// -race; the assertion is that nothing tears and every call is answered.
func TestHostHolder_ConcurrentSetAndBanner(t *testing.T) {
	var h notify.HostHolder
	host := &recordingHost{}
	ctx := context.Background()

	const n = 50
	var wg sync.WaitGroup
	wg.Add(2 * n)
	for i := 0; i < n; i++ {
		go func() { defer wg.Done(); h.Set(host) }()
		go func() {
			defer wg.Done()
			// Either error is correct: unbound before the race resolves,
			// nil once a host is bound. Neither may panic.
			if err := h.Banner(ctx, notify.Event{}); err != nil && !errors.Is(err, notify.ErrUnavailable) {
				t.Errorf("Banner = %v, want nil or ErrUnavailable", err)
			}
		}()
	}
	wg.Wait()
}
