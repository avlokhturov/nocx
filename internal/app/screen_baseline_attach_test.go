package app

// A window that attaches to an IDLE session is owed the screen the session
// already shows (nocx-zg3k3.2.15). Every frame the runtime published while no
// renderer was attached was dropped at the transport by design, so an attach
// that waited for "the next revision" to carry its baseline waited for a
// program to print something — and a pane at rest prints nothing. The window
// stayed blank until something was printed or it was resized.
//
// Over the real path, like screen_over_the_wire_test.go: the shipped helper
// daemon, a real shell on a real PTY, the frame read off a real websocket.
// Every wait is on an observable — the runtime's own screen read, the
// revision the coordinator has forwarded, a frame on the socket.

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/storage/storagetest"
	"github.com/shady2k/nocx/internal/transport"
)

// forwardedScreens records the highest revision the coordinator has handed to
// the transport's screen plane, and wakes a waiter on every one. It is what
// makes "the session is idle" an observed state rather than a pause: once the
// revision the runtime's screen read reports has been forwarded, nothing the
// runtime drew is still in flight toward the transport.
type forwardedScreens struct {
	mu   sync.Mutex
	cond *sync.Cond
	last uint64
}

func recordForwardedScreens(a *App) *forwardedScreens {
	r := &forwardedScreens{}
	r.cond = sync.NewCond(&r.mu)
	publish := a.localHelper.publishScreen
	a.localHelper.publishScreen = func(sid session.ID, revision uint64, doc []byte) bool {
		r.mu.Lock()
		if revision > r.last {
			r.last = revision
		}
		r.cond.Broadcast()
		r.mu.Unlock()
		return publish(sid, revision, doc)
	}
	return r
}

func (r *forwardedScreens) awaitRevision(t *testing.T, rev uint64) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	timer := time.AfterFunc(time.Until(deadline), func() {
		r.mu.Lock()
		r.cond.Broadcast()
		r.mu.Unlock()
	})
	defer timer.Stop()
	r.mu.Lock()
	defer r.mu.Unlock()
	for r.last < rev {
		if !time.Now().Before(deadline) {
			t.Fatalf("the coordinator forwarded revision %d at most, never the %d the screen read reported", r.last, rev)
		}
		r.cond.Wait()
	}
}

// frameRevision reads the revision a published session.frame document
// carries — the runtime's clock at publication.
func frameRevision(t *testing.T, payload []byte) uint64 {
	t.Helper()
	var doc struct {
		Revision uint64 `json:"revision"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatalf("payload is not a frame document: %v", err)
	}
	return doc.Revision
}

// awaitIdleMarker waits, through the product's own screen read, until the
// marker is OUTPUT on a row, and answers the revision that read was taken at.
func awaitIdleMarker(t *testing.T, a *App, sid string, marker string) uint64 {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		f, err := a.paneViews.Frame(sid)
		if err == nil {
			for row := range f.Lines {
				if strings.Contains(f.Text(row), marker) {
					return uint64(f.Revision)
				}
			}
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the marker %q never reached the screen read (last error: %v)", marker, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestAnAttachToAnIdleSessionWithNoSizeReceivesTheScreenItShows is the
// defect: draw, go idle, attach with no size and draw nothing — the window is
// owed exactly one frame, and it is the screen as it stands.
func TestAnAttachToAnIdleSessionWithNoSizeReceivesTheScreenItShows(t *testing.T) {
	src := realHelperArtifacts(t)
	home := storagetest.IsolateWithHome(t)
	t.Cleanup(func() { endTheDaemon(t, filepath.Join(helperRoot(home, src.hash()), "nocx-helper")) })

	a := bootLocalAppOn(t, src)
	forwarded := recordForwardedScreens(a)
	opened, err := a.Transport.OpenSession(context.Background(), transport.OpenSpec{Cols: 100, Rows: 30})
	if err != nil {
		t.Fatalf("opening a local pane through the shipped opener: %v", err)
	}
	sid := string(opened.Session.ID())
	if err := a.paneViews.Enrol(sid); err != nil {
		t.Fatalf("watching the pane: %v", err)
	}

	// The marker is assembled by printf, so the echoed command line never
	// contains it — only the program's output does. The `read` then holds
	// the shell: no prompt follows, and the pane is at rest.
	const marker = "IDLE-MARK"
	if _, err := opened.Session.Write([]byte("printf '%s-%s\\n' IDLE MARK; read -r _\n")); err != nil {
		t.Fatalf("write to the pane: %v", err)
	}
	rev := awaitIdleMarker(t, a, sid, marker)
	// Idle, observed: the revision the screen read was taken at has already
	// reached the transport, and with no renderer attached it was dropped.
	forwarded.awaitRevision(t, rev)

	conn := dialRenderer(t, a)
	attachRenderer(t, conn, sid) // no cols, no rows: no resize to lean on

	first := nextScreenFrame(t, conn)
	if got := screenText(t, first.Payload); !strings.Contains(got, marker) {
		t.Fatalf("the frame an idle session's attacher received shows %q, want the marker already on screen", got)
	}
	firstRev := frameRevision(t, first.Payload)

	// Exactly one: end the `read`, and the next frame on the socket must be
	// the shell's new output at a later revision — never a second copy of
	// the baseline.
	if _, err := opened.Session.Write([]byte("\n")); err != nil {
		t.Fatalf("write to the pane: %v", err)
	}
	next := nextScreenFrame(t, conn)
	if nextRev := frameRevision(t, next.Payload); nextRev <= firstRev {
		t.Fatalf("after the baseline at revision %d the attacher was sent revision %d: the baseline arrived more than once", firstRev, nextRev)
	}
}
