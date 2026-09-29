package app

// THE RE-ADOPT'S LIFECYCLE WINDOW RESUME (ADR-0076 decision 4): a command
// whose end the helper saw while no coordinator was attached must close when
// the coordinator returns, and the only carrier for that end is the helper's
// retained lifecycle window. The re-adopt's attach therefore has to resume
// that window FROM ITS BASE — the frames no coordinator ever read replay into
// the replacing kernel — and not from the window's head, where the whole
// retained record is skipped and every frame spoken while nobody was
// attached is lost for good.

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/helper/client"
	"github.com/shady2k/nocx/internal/helper/proto"
	helpersession "github.com/shady2k/nocx/internal/helper/session"
	"github.com/shady2k/nocx/internal/session"
)

// lifecycleIdleProcess is the scripted idle process with a lifecycle carrier:
// the shell's side of the authenticated channel as a test double. Frames the
// test writes are the shell speaking; frames the helper writes to it (its own
// demands) are discarded — no shell answers them here.
type lifecycleIdleProcess struct {
	idleProcess
	speak   *io.PipeWriter
	carrier *testLifecycleCarrier
}

func (p *lifecycleIdleProcess) Lifecycle() io.ReadWriteCloser { return p.carrier }

type testLifecycleCarrier struct {
	in *io.PipeReader // the helper reads the shell's frames here
}

func (c *testLifecycleCarrier) Read(p []byte) (int, error)  { return c.in.Read(p) }
func (c *testLifecycleCarrier) Write(p []byte) (int, error) { return len(p), nil }
func (c *testLifecycleCarrier) Close() error                { return c.in.Close() }

// lifecycleWindowSpawner is the spawner whose every process carries the
// lifecycle carrier, so the helper builds a retained window for its sessions.
type lifecycleWindowSpawner struct {
	mu    sync.Mutex
	procs []*lifecycleIdleProcess
	next  int
}

func (s *lifecycleWindowSpawner) Spawn(req helpersession.SpawnRequest) (helpersession.Process, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	r, w := io.Pipe()
	p := &lifecycleIdleProcess{
		idleProcess: idleProcess{done: make(chan struct{}), pid: 5000 + s.next, id: req.SessionID},
		speak:       w,
		carrier:     &testLifecycleCarrier{in: r},
	}
	s.procs = append(s.procs, p)
	return p, nil
}

// theProcess answers the one process this test's session has.
func (s *lifecycleWindowSpawner) theProcess(t *testing.T) *lifecycleIdleProcess {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.procs) != 1 {
		t.Fatalf("%d processes were spawned, want exactly 1", len(s.procs))
	}
	return s.procs[0]
}

// recordingLocalRoute is the local route as a recording delegate: the real
// client answers, and the attach params the coordinator meant to send are
// captured on the way through.
type recordingLocalRoute struct {
	*client.Client
	mu     sync.Mutex
	attach []proto.AttachParams
}

func (r *recordingLocalRoute) Attach(ctx context.Context, params proto.AttachParams) (*client.AttachedSession, error) {
	r.mu.Lock()
	r.attach = append(r.attach, params)
	r.mu.Unlock()
	return r.Client.Attach(ctx, params)
}

func (r *recordingLocalRoute) LocalSessions(ctx context.Context, _ string) ([]client.SessionEntry, error) {
	return r.Client.Sessions(ctx)
}

func (r *recordingLocalRoute) Release(string)        {}
func (r *recordingLocalRoute) noteHeld(session.ID)   {}
func (r *recordingLocalRoute) forgetHeld(session.ID) {}

func (r *recordingLocalRoute) lastAttach() (proto.AttachParams, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.attach) == 0 {
		return proto.AttachParams{}, false
	}
	return r.attach[len(r.attach)-1], true
}

func TestAReadoptResumesTheHelpersRetainedLifecycleWindowFromItsBase(t *testing.T) {
	spawner := &lifecycleWindowSpawner{}
	svc := helpersession.New(helpersession.Options{
		Generation: proto.GenerationID(syntheticArtifactHash),
		Spawner:    spawner,
		Log:        discardLogger(t),
	})
	provider := &fakeLaneProvider{peer: sharedHelperPeer(t, svc)}
	first := newCoordinator(t, provider)
	binding := openHostedFixture(t, first, "pane-lifecycle-window")
	first.quit()
	// A real local open leaves Host, Account and HelperCommand empty — the
	// binding this test hands the local route keeps that shape (the routes
	// fixture's binding names a host, and this readopt is the local one).
	binding.Host, binding.Account, binding.HelperCommand = "", "", ""
	proc := spawner.theProcess(t)
	t.Cleanup(func() { _ = proc.speak.Close() })

	// A client of this test's own, over the same service, so the route can
	// answer the real daemon while recording what the readopt asks of it.
	route := &recordingLocalRoute{}
	{
		conn := newFakeLaneConn(sharedHelperPeer(t, svc))
		t.Cleanup(func() { _ = conn.Close() })
		c, err := client.Dial(context.Background(), client.Config{
			Exec:       conn,
			Command:    "/scripted/helper",
			ExpectHash: syntheticArtifactHash,
			Log:        discardLogger(t),
		})
		if err != nil {
			t.Fatalf("the test's own helper client: %v", err)
		}
		t.Cleanup(func() { _ = c.Close() })
		route.Client = c
	}

	// THE FRAMES NOBODY READ: the shell speaks while no coordinator is
	// attached. The window has provably retained them before anything asks
	// for the session back — that precondition is what makes the attach's
	// offset choice mean one thing and not the other.
	const spoken = `{"kind":"complete","exit":0}`
	if _, err := proc.speak.Write([]byte(spoken)); err != nil {
		t.Fatalf("the shell spoke: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	retained := false
	for !retained {
		entries, err := route.Client.Sessions(ctx)
		if err != nil {
			t.Fatalf("ask the helper what it holds: %v", err)
		}
		for _, e := range entries {
			if e.HostSessionID.Session == binding.SessionID &&
				e.LifecycleWindow.Written >= uint64(len(spoken)) {
				retained = true
			}
		}
		if !retained {
			if err := ctx.Err(); err != nil {
				t.Fatalf("the helper's window never retained the shell's frames: %v", err)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	// THE REPLACING COORDINATOR takes the session back over the recording
	// route.
	second := newCoordinator(t, provider)
	adopter := &stubAdopter{}
	t.Cleanup(adopter.endAdopted)
	pass := &readoptPass{registry: second.reg, adopter: adopter, local: route}
	if _, err := pass.readoptLocal(ctx, binding); err != nil {
		t.Fatalf("readopt: %v", err)
	}

	// THE ATTACH MUST ASK FOR THE WINDOW FROM ITS BASE. The offset the
	// readopt sends is the whole of the decision: from the base, the frames
	// nobody read replay into the replacing kernel; from the head — where
	// the stream stands now — they are skipped and gone.
	attach, ok := route.lastAttach()
	if !ok {
		t.Fatal("the readopt never attached")
	}
	if attach.LifecycleOffset != 0 {
		t.Fatalf("the re-adopt's attach resumed the lifecycle window at offset %d, want 0 (the window's base): the helper holds %d retained bytes no coordinator has read, and asking for the head skips them for good",
			attach.LifecycleOffset, uint64(len(spoken)))
	}
}
