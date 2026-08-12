//go:build darwin

package procwatch

import (
	"bytes"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sys/unix"

	"github.com/shady2k/nocx/internal/log"
)

// wakeIdent is the identifier of the EVFILT_USER event Close triggers to
// wake the reader out of its blocking Kevent. Waking it is what lets the
// reader own the queue's descriptor: closing an fd underneath a blocked
// syscall is the race this avoids.
const wakeIdent = 1

// New returns the darwin watcher: one kqueue for the whole process, one
// goroutine reading it, one registration per watched pid.
//
// A kqueue is not inherited across fork (kqueue(2) says so in as many words),
// so the shells this backend spawns never carry the queue's descriptor —
// which matters here, because the descriptor the shell DOES inherit is the
// lifecycle channel and nothing else should join it.
func New(logger log.Logger) Watcher {
	kq, err := unix.Kqueue()
	if err != nil {
		// Nothing observes, and the caller is told so per watch. The
		// handshake bound stays the detector it was.
		logger.Warn("process observation unavailable: kqueue", "error", err)
		return unsupported{err: fmt.Errorf("procwatch: kqueue: %w", err)}
	}
	w := &kqueueWatcher{log: logger, kq: kq, watched: make(map[int]*watch)}
	if _, err := unix.Kevent(kq, []unix.Kevent_t{{
		Ident:  wakeIdent,
		Filter: unix.EVFILT_USER,
		Flags:  unix.EV_ADD | unix.EV_CLEAR,
	}}, nil, nil); err != nil {
		_ = unix.Close(kq)
		logger.Warn("process observation unavailable: kqueue wakeup", "error", err)
		return unsupported{err: fmt.Errorf("procwatch: kqueue wakeup: %w", err)}
	}
	go w.read()
	return w
}

// watch is one registered process: what it was launched as, and who to tell.
type watch struct {
	expected string
	sink     Sink
}

type kqueueWatcher struct {
	log log.Logger
	kq  int

	mu      sync.Mutex
	watched map[int]*watch
	closed  bool

	closeOnce sync.Once
}

func (w *kqueueWatcher) Started(pid int, expectedExecutable string, sink Sink) (func(), error) {
	if pid <= 0 || sink == nil {
		return func() {}, errors.New("procwatch: a watch needs a live pid and a sink")
	}
	expected := commName(expectedExecutable)
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return func() {}, ErrClosed
	}
	w.watched[pid] = &watch{expected: expected, sink: sink}
	w.mu.Unlock()

	// Register BEFORE sampling, deliberately. The takeover this exists to
	// catch happens in the milliseconds after the fork, so the interval that
	// must be covered starts before we can look: registering first means an
	// exec from here on is delivered by the kernel, and the sample below
	// then catches one that already happened. An exec landing exactly
	// between the two is reported once, not twice — deliver() takes the
	// watch out of the map under the lock, and only the winner calls the
	// sink.
	if err := w.register(pid); err != nil {
		w.mu.Lock()
		delete(w.watched, pid)
		w.mu.Unlock()
		return func() {}, fmt.Errorf("procwatch: watch pid %d: %w", pid, err)
	}
	stop := func() { w.stop(pid) }
	if name := processName(pid); replaced(expected, name) {
		w.deliver(pid, name)
	}
	return stop, nil
}

func (w *kqueueWatcher) Close() error {
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closed = true
		w.watched = make(map[int]*watch)
		w.mu.Unlock()
		// Wake the reader; it owns the descriptor and closes it on its way
		// out. A trigger that fails leaves the goroutine blocked and is
		// worth a line, but there is nothing further to do about it.
		if _, err := unix.Kevent(w.kq, []unix.Kevent_t{{
			Ident:  wakeIdent,
			Filter: unix.EVFILT_USER,
			Fflags: unix.NOTE_TRIGGER,
		}}, nil, nil); err != nil {
			w.log.Debug("process observation: wakeup failed on close", "error", err)
		}
	})
	return nil
}

// register asks the kernel to report this process replacing its image.
// NOTE_EXIT is requested alongside NOTE_EXEC only so the registration can be
// dropped when the process goes away: "the shell ended" already has an owner
// (the pty's own Wait), and a second answer to it here would be the duplicate
// AD-8 forbids.
func (w *kqueueWatcher) register(pid int) error {
	_, err := unix.Kevent(w.kq, []unix.Kevent_t{{
		Ident:  uint64(pid), //nolint:gosec // a pid is non-negative; checked by the caller
		Filter: unix.EVFILT_PROC,
		Flags:  unix.EV_ADD,
		Fflags: unix.NOTE_EXEC | unix.NOTE_EXIT,
	}}, nil, nil)
	return err
}

// stop ends one watch. The kernel drops the registration itself when the
// process exits, so EV_DELETE failing with ESRCH is the ordinary case and
// not an error.
func (w *kqueueWatcher) stop(pid int) {
	w.mu.Lock()
	_, ok := w.watched[pid]
	delete(w.watched, pid)
	closed := w.closed
	w.mu.Unlock()
	if !ok || closed {
		return
	}
	w.unregister(pid)
}

func (w *kqueueWatcher) unregister(pid int) {
	if _, err := unix.Kevent(w.kq, []unix.Kevent_t{{
		Ident:  uint64(pid), //nolint:gosec // a pid is non-negative
		Filter: unix.EVFILT_PROC,
		Flags:  unix.EV_DELETE,
	}}, nil, nil); err != nil && !errors.Is(err, unix.ESRCH) && !errors.Is(err, unix.ENOENT) {
		w.log.Debug("process observation: could not drop a watch", "pid", pid, "error", err)
	}
}

// read is the sole reader of the queue and the sole closer of its
// descriptor.
func (w *kqueueWatcher) read() {
	defer func() { _ = unix.Close(w.kq) }()
	events := make([]unix.Kevent_t, 16)
	for {
		n, err := unix.Kevent(w.kq, nil, events, nil)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			w.log.Debug("process observation: queue read ended", "error", err)
			return
		}
		for i := 0; i < n; i++ {
			if w.dispatch(events[i]) {
				return
			}
		}
	}
}

// dispatch handles one event and reports whether the reader should stop.
func (w *kqueueWatcher) dispatch(ev unix.Kevent_t) (done bool) {
	if ev.Filter == unix.EVFILT_USER {
		return w.isClosed()
	}
	if ev.Filter != unix.EVFILT_PROC {
		return false
	}
	pid := int(ev.Ident) //nolint:gosec // the ident is the pid we registered
	// Exec first: a process that exec'd and then exited before we read the
	// queue reports both flags in one event, and the exec is the half that
	// answers the user's question.
	if ev.Fflags&unix.NOTE_EXEC != 0 {
		w.execObserved(pid)
	}
	if ev.Fflags&unix.NOTE_EXIT != 0 {
		w.stop(pid)
	}
	return false
}

// execObserved answers, for one kernel notification, whether the process is
// now running something else — and says so if it is.
func (w *kqueueWatcher) execObserved(pid int) {
	w.mu.Lock()
	wt, ok := w.watched[pid]
	w.mu.Unlock()
	if !ok {
		return
	}
	if name := processName(pid); replaced(wt.expected, name) {
		w.deliver(pid, name)
	}
}

// deliver reports an observation exactly once per watch. Taking the watch out
// of the map under the lock IS the once: the sampling in Started and the
// kernel's own notification can both reach here for one exec, and a user must
// not be told twice about one takeover.
func (w *kqueueWatcher) deliver(pid int, name string) {
	w.mu.Lock()
	wt, ok := w.watched[pid]
	delete(w.watched, pid)
	closed := w.closed
	w.mu.Unlock()
	if !ok || closed {
		return
	}
	w.unregister(pid)
	wt.sink(Observation{PID: pid, Name: name})
}

func (w *kqueueWatcher) isClosed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed
}

// processName is the kernel's own name for the image running under pid:
// kinfo_proc.kp_proc.p_comm, the basename truncated to MAXCOMLEN. It is what
// `ps` prints, it is readable for any process, and it structurally cannot
// carry a path, an argument or a command line — which is exactly the
// restriction the contract puts on the value.
func processName(pid int) string {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || kp == nil {
		return ""
	}
	comm := kp.Proc.P_comm[:]
	if i := bytes.IndexByte(comm, 0); i >= 0 {
		comm = comm[:i]
	}
	return commName(string(comm))
}

// The two helpers below live here rather than beside the interface, because
// darwin is the only platform that has anything to compare: on a platform that
// cannot observe an exec they would be functions nobody reaches, which is the
// dead half a reachability gate exists to catch. They move up if a second
// platform ever answers.

// commLen is how many characters of an executable name the kernel keeps
// (darwin's MAXCOMLEN). Names are compared truncated to it so a long wrapper
// name is not mistaken for a replacement of a long shell name, and vice
// versa.
const commLen = 16

// commName reduces an executable to the name the kernel would record for it:
// the basename, truncated the way the process table truncates it. Both sides
// of every comparison go through here, so "is this still the shell we
// started" is answered on one representation and not on two.
func commName(executable string) string {
	name := filepath.Base(strings.TrimSpace(executable))
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	if len(name) > commLen {
		name = name[:commLen]
	}
	return name
}

// replaced answers the package's whole question, in one place: the process is
// reported only when the kernel names something ELSE running there.
//
// An unnameable image is deliberately not a replacement. The observation's
// only value is the name it carries — the contract requires one and the
// details dialog renders one — so "something changed and I cannot say what"
// buys the user nothing and would flip a tab to conventional on no evidence
// they can act on.
func replaced(expected, observed string) bool {
	return observed != "" && observed != expected
}
