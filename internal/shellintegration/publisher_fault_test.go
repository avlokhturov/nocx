package shellintegration

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// errInjected is the fault the table injects at each boundary.
var errInjected = errors.New("injected fault")

// faultFS wraps an FS and can fail or record calls by kind. Every publish
// boundary is a kind: mkdir, create (each file write), sync (each file
// fsync), syncdir (each directory fsync), rename, remove (lock release and
// cleanup) and lock acquire (mkdir of the lock dir).
type faultFS struct {
	FS
	mu      sync.Mutex
	failOn  map[string]int // kind -> 1-based call number to fail
	failErr error
	counts  map[string]int
	ops     []string // ordered op log, "kind:path"
}

func newFaultFS(inner FS) *faultFS {
	return &faultFS{
		FS:     inner,
		failOn: map[string]int{},
		counts: map[string]int{},
	}
}

// setFault makes the n-th call of kind return err (1-based). n <= 0 clears.
func (f *faultFS) setFault(kind string, n int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if n <= 0 {
		delete(f.failOn, kind)
		return
	}
	f.failOn[kind] = n
	f.failErr = err
}

// resetCounts zeroes the per-kind counters and the op log so a subsequent
// publish can be faulted and counted in isolation from the baseline publish
// that precedes it.
func (f *faultFS) resetCounts() {
	f.mu.Lock()
	f.counts = map[string]int{}
	f.ops = nil
	f.mu.Unlock()
}

func (f *faultFS) hit(kind, path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counts[kind]++
	f.ops = append(f.ops, kind+":"+path)
	if n, ok := f.failOn[kind]; ok && f.counts[kind] == n {
		return f.failErr
	}
	return nil
}

func (f *faultFS) Lstat(path string) (fs.FileInfo, error) {
	if err := f.hit("lstat", path); err != nil {
		return nil, err
	}
	return f.FS.Lstat(path)
}

func (f *faultFS) Mkdir(path string, mode os.FileMode) error {
	if err := f.hit("mkdir", path); err != nil {
		return err
	}
	return f.FS.Mkdir(path, mode)
}

func (f *faultFS) Create(path string, mode os.FileMode) (File, error) {
	if err := f.hit("create", path); err != nil {
		return nil, err
	}
	file, err := f.FS.Create(path, mode)
	if err != nil {
		return nil, err
	}
	return &faultFile{File: file, fs: f, path: path}, nil
}

func (f *faultFS) SyncDir(path string) error {
	if err := f.hit("syncdir", path); err != nil {
		return err
	}
	return f.FS.SyncDir(path)
}

func (f *faultFS) Rename(src, dst string) error {
	if err := f.hit("rename", src+" -> "+dst); err != nil {
		return err
	}
	return f.FS.Rename(src, dst)
}

func (f *faultFS) Remove(path string) error {
	if err := f.hit("remove", path); err != nil {
		return err
	}
	return f.FS.Remove(path)
}

func (f *faultFS) ReadDir(path string) ([]fs.FileInfo, error) {
	if err := f.hit("readdir", path); err != nil {
		return nil, err
	}
	return f.FS.ReadDir(path)
}

func (f *faultFS) ReadFile(path string) ([]byte, error) {
	if err := f.hit("readfile", path); err != nil {
		return nil, err
	}
	return f.FS.ReadFile(path)
}

// faultFile makes File.Sync its own fault-injectable boundary.
type faultFile struct {
	File
	fs   *faultFS
	path string
}

func (w *faultFile) Sync() error {
	w.fs.mu.Lock()
	w.fs.counts["sync"]++
	w.fs.ops = append(w.fs.ops, "sync:"+w.path)
	n := w.fs.counts["sync"]
	var err error
	if want, ok := w.fs.failOn["sync"]; ok && n == want {
		err = w.fs.failErr
	}
	w.fs.mu.Unlock()
	if err != nil {
		return err
	}
	return w.File.Sync()
}

// recordingFS logs every operation in order (used by the rename-last test).
type recordingFS struct {
	FS
	mu  sync.Mutex
	ops []string
}

func (r *recordingFS) hit(kind, path string) {
	r.mu.Lock()
	r.ops = append(r.ops, kind+":"+path)
	r.mu.Unlock()
}

func (r *recordingFS) Lstat(path string) (fs.FileInfo, error) {
	r.hit("lstat", path)
	return r.FS.Lstat(path)
}

func (r *recordingFS) Mkdir(path string, mode os.FileMode) error {
	r.hit("mkdir", path)
	return r.FS.Mkdir(path, mode)
}

func (r *recordingFS) Create(path string, mode os.FileMode) (File, error) {
	r.hit("create", path)
	return r.FS.Create(path, mode)
}

func (r *recordingFS) SyncDir(path string) error {
	r.hit("syncdir", path)
	return r.FS.SyncDir(path)
}

func (r *recordingFS) Rename(src, dst string) error {
	r.hit("rename", src+" -> "+dst)
	return r.FS.Rename(src, dst)
}

func (r *recordingFS) Remove(path string) error {
	r.hit("remove", path)
	return r.FS.Remove(path)
}

func (r *recordingFS) ReadDir(path string) ([]fs.FileInfo, error) {
	r.hit("readdir", path)
	return r.FS.ReadDir(path)
}

func (r *recordingFS) ReadFile(path string) ([]byte, error) {
	r.hit("readfile", path)
	return r.FS.ReadFile(path)
}

// TestFaultAtEveryBoundaryConverges is the enumerable fault-injection test
// the seam exists for (design §4: failure at each boundary is injectable
// rather than argued about). For every publish boundary of a version bump —
// each mkdir, each file write, each file fsync, each directory fsync, each
// rename, lock acquire (mkdir of the lock dir) and lock release (removes) —
// inject a failure, assert the previous activation is untouched, then
// assert the next attempt converges with no manual cleanup.
func TestFaultAtEveryBoundaryConverges(t *testing.T) {
	origBound, origPoll := lockWaitBound, lockPollInterval
	lockWaitBound, lockPollInterval = 200*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { lockWaitBound, lockPollInterval = origBound, origPoll })

	// Enumerate every boundary position from a clean version-bump publish:
	// v1 installed, then v2 published, on a fault-free recording FS.
	enumHome := t.TempDir()
	enumFS := newFaultFS(NewOSFS())
	enumPub := NewPublisher(testLogger(), enumFS, filepath.Join(enumHome, dirName))
	if _, err := enumPub.Publish(testBundle("1")); err != nil {
		t.Fatalf("baseline publish v1: %v", err)
	}
	enumFS.resetCounts() // count only the version-bump publish, not the baseline
	if _, err := enumPub.Publish(testBundle("2")); err != nil {
		t.Fatalf("baseline publish v2: %v", err)
	}
	enumFS.mu.Lock()
	max := map[string]int{}
	for _, op := range enumFS.ops {
		kind := strings.SplitN(op, ":", 2)[0]
		max[kind]++
	}
	enumFS.mu.Unlock()

	type position struct {
		kind           string
		n              int
		postActivation bool
	}
	var positions []position
	for _, kind := range []string{"mkdir", "create", "sync", "syncdir", "rename", "remove"} {
		for n := 1; n <= max[kind]; n++ {
			// The final SyncDir is the root fsync after the manifest rename
			// (design §4: "the manifest's directory after it"). A fault
			// there fires after the activation pointer has moved.
			postActivation := kind == "syncdir" && n == max["syncdir"]
			positions = append(positions, position{kind, n, postActivation})
		}
	}

	for _, pos := range positions {
		t.Run(fmt.Sprintf("%s#%d", pos.kind, pos.n), func(t *testing.T) {
			home := t.TempDir()
			fsys := newFaultFS(NewOSFS())
			pub := NewPublisher(testLogger(), fsys, filepath.Join(home, dirName))
			root := filepath.Join(home, dirName)

			if _, err := pub.Publish(testBundle("1")); err != nil {
				t.Fatalf("baseline publish v1: %v", err)
			}
			before := readFileT(t, filepath.Join(root, manifestName))
			fsys.resetCounts() // fault positions are relative to the v2 publish alone
			fsys.setFault(pos.kind, pos.n, errInjected)
			_, err := pub.Publish(testBundle("2"))

			switch {
			case pos.kind == "remove":
				// The removes in a publish are the lock release, which fires
				// after the manifest committed: the publish itself succeeds
				// and the activation moves. The stale rule on the next
				// attempt absorbs any lock left behind.
				if err != nil {
					t.Fatalf("release-fault publish should succeed, got %v", err)
				}
			case pos.postActivation:
				// The root fsync after the manifest rename is fatal (the
				// durability contract is stated, not assumed) but fires
				// after the activation moved: the manifest now names v2,
				// and the retry converges by skipping.
				if err == nil {
					t.Fatalf("fault at %s#%d did not fail the publish", pos.kind, pos.n)
				}
				m := readManifestT(t, root)
				if m.Generation != "v2" {
					t.Fatalf("post-activation fault must leave the new manifest, got %s", m.Generation)
				}
			default:
				if err == nil {
					t.Fatalf("fault at %s#%d did not fail the publish", pos.kind, pos.n)
				}
				// Previous activation untouched: byte-identical manifest and
				// the v1 generation still verifies.
				if got := readFileT(t, filepath.Join(root, manifestName)); string(got) != string(before) {
					t.Fatalf("manifest changed after fault at %s#%d", pos.kind, pos.n)
				}
				vr, verr := pub.Verify()
				if verr != nil {
					t.Fatalf("Verify after fault: %v", verr)
				}
				if !vr.Installed || vr.Generation != "v1" {
					t.Fatalf("previous activation not intact after fault: %+v", vr)
				}
			}

			// The next attempt converges with no manual cleanup.
			fsys.setFault(pos.kind, 0, nil)
			res, err := pub.Publish(testBundle("2"))
			if err != nil {
				t.Fatalf("retry after fault at %s#%d: %v", pos.kind, pos.n, err)
			}
			if pos.kind == "remove" || pos.postActivation {
				if res.Published {
					t.Fatalf("retry after a post-activation fault should skip, got %+v", res)
				}
			} else if !res.Published {
				t.Fatalf("retry did not publish: %+v", res)
			}
			vr, err := pub.Verify()
			if err != nil {
				t.Fatalf("Verify after retry: %v", err)
			}
			if !vr.Installed || vr.Generation != "v2" {
				t.Fatalf("retry did not converge: %+v", vr)
			}
			assertBoundedFootprint(t, root, "v2")
		})
	}
}

// TestFirstPublishFaultLeavesNothingActive: a fault during the very first
// publish leaves no activation pointer and no committed generation reachable
// from one — torn publication is unrepresentable, and the retry converges.
func TestFirstPublishFaultLeavesNothingActive(t *testing.T) {
	origBound, origPoll := lockWaitBound, lockPollInterval
	lockWaitBound, lockPollInterval = 100*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { lockWaitBound, lockPollInterval = origBound, origPoll })

	for _, pos := range []struct {
		kind string
		n    int
	}{
		{"mkdir", 2},  // tmp mkdir
		{"create", 2}, // first generation file write
		{"sync", 3},   // a generation file fsync
		{"rename", 1}, // generation rename
		{"rename", 2}, // manifest rename
	} {
		t.Run(fmt.Sprintf("%s#%d", pos.kind, pos.n), func(t *testing.T) {
			home := t.TempDir()
			fsys := newFaultFS(NewOSFS())
			pub := NewPublisher(testLogger(), fsys, filepath.Join(home, dirName))
			root := filepath.Join(home, dirName)

			fsys.setFault(pos.kind, pos.n, errInjected)
			if _, err := pub.Publish(testBundle("1")); err == nil {
				t.Fatalf("fault at %s#%d did not fail the first publish", pos.kind, pos.n)
			}
			// Never an activation pointer: whatever fault fired, the
			// manifest must not exist.
			if _, err := os.Stat(filepath.Join(root, manifestName)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("a manifest exists after a failed first publish: %v", err)
			}
			// A fault after the generation rename (rename#2, the manifest
			// rename) legitimately leaves the uncommitted generation on
			// disk; it is unreachable without the manifest and the retry
			// converges. Earlier faults must leave nothing committed.
			if pos.kind == "rename" && pos.n == 2 {
				if _, err := os.Stat(filepath.Join(root, integrationDir, "v1")); err != nil {
					t.Fatalf("generation missing after manifest-rename fault: %v", err)
				}
			} else if _, err := os.Stat(filepath.Join(root, integrationDir, "v1")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("a committed generation exists after a failed first publish: %v", err)
			}

			fsys.setFault(pos.kind, 0, nil)
			if _, err := pub.Publish(testBundle("1")); err != nil {
				t.Fatalf("retry: %v", err)
			}
			assertBoundedFootprint(t, root, "v1")
		})
	}
}

// TestPublishFaultSurfacesErrorAndSweepsRoot pins the two behaviours the
// shadowed error branches in Publish must keep: a faulted first publish
// reaches the caller with the injected cause (never a successful result),
// and a failure after this invocation created the root sweeps the
// still-empty root back. The sweep works because every error branch returns
// explicitly, and an explicit return assigns the named err before the
// deferred sweep runs — a bare return or a swallowed error would leave
// either a phantom ~/.nocx or a false Published result.
func TestPublishFaultSurfacesErrorAndSweepsRoot(t *testing.T) {
	origBound, origPoll := lockWaitBound, lockPollInterval
	lockWaitBound, lockPollInterval = 100*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { lockWaitBound, lockPollInterval = origBound, origPoll })

	for _, pos := range []struct {
		kind      string
		n         int
		rootSwept bool // the fault fires before anything is written under the fresh root
	}{
		{"mkdir", 2, true},   // tmp mkdir: root exists and is still empty
		{"mkdir", 3, false},  // integration mkdir: tmp/ already written
		{"create", 2, false}, // first generation file write
	} {
		t.Run(fmt.Sprintf("%s#%d", pos.kind, pos.n), func(t *testing.T) {
			home := t.TempDir()
			fsys := newFaultFS(NewOSFS())
			pub := NewPublisher(testLogger(), fsys, filepath.Join(home, dirName))
			root := filepath.Join(home, dirName)

			fsys.setFault(pos.kind, pos.n, errInjected)
			res, err := pub.Publish(testBundle("1"))
			if err == nil {
				t.Fatalf("fault at %s#%d reported a successful publish: %+v", pos.kind, pos.n, res)
			}
			if !errors.Is(err, errInjected) {
				t.Fatalf("fault at %s#%d: caller must see the injected fault, got %v", pos.kind, pos.n, err)
			}
			if res.Published {
				t.Fatalf("fault at %s#%d reported Published=true", pos.kind, pos.n)
			}
			_, statErr := os.Stat(root)
			if pos.rootSwept {
				if !errors.Is(statErr, fs.ErrNotExist) {
					t.Fatalf("empty root created by this publish must be swept back, stat: %v", statErr)
				}
			} else if errors.Is(statErr, fs.ErrNotExist) {
				t.Fatal("root was swept although content was written under it")
			}

			fsys.setFault(pos.kind, 0, nil)
			if _, err = pub.Publish(testBundle("1")); err != nil {
				t.Fatalf("retry after fault at %s#%d: %v", pos.kind, pos.n, err)
			}
			assertBoundedFootprint(t, root, "v1")
		})
	}
}

// assertBoundedFootprint checks the invariants that must hold after any
// successful publish: the manifest names exactly the active generation,
// every file verifies, at most two generations and no tmp/ leftovers.
func assertBoundedFootprint(t *testing.T, root, active string) {
	t.Helper()
	vr, err := NewPublisher(testLogger(), NewOSFS(), root).Verify()
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !vr.Installed || vr.Generation != active {
		t.Fatalf("Verify = %+v, want generation %s installed", vr, active)
	}
	gens, err := os.ReadDir(filepath.Join(root, integrationDir))
	if err != nil {
		t.Fatalf("readdir integration: %v", err)
	}
	if len(gens) > 2 {
		t.Errorf("integration/ has %d generations after publish", len(gens))
	}
	tmpEntries, err := os.ReadDir(filepath.Join(root, tmpName))
	if err != nil {
		t.Fatalf("readdir tmp: %v", err)
	}
	if len(tmpEntries) != 0 {
		t.Errorf("tmp/ has %d leftovers after publish", len(tmpEntries))
	}
}

// TestConcurrentPublishSameVersion: two concurrent publishes of the same
// version produce one active generation, no duplicated work and no lost
// bytes. Run under -race.
func TestConcurrentPublishSameVersion(t *testing.T) {
	home := t.TempDir()
	fsys := newFaultFS(NewOSFS())
	root := filepath.Join(home, dirName)
	b := testBundle("10")

	const workers = 2
	results := make([]PublishResult, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	for i := range workers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			pub := NewPublisher(testLogger(), fsys, root)
			results[i], errs[i] = pub.Publish(b)
		}(i)
	}
	wg.Wait()

	published := 0
	for i := range workers {
		if errs[i] != nil {
			t.Fatalf("worker %d: %v", i, errs[i])
		}
		if results[i].Published {
			published++
		}
	}
	if published != 1 {
		t.Fatalf("exactly one publish must win, got %d winners: %+v", published, results)
	}

	// No duplicated work: both contenders serially take the lock and each
	// writes its identifying nonce (2 creates), while exactly ONE publisher
	// writes the generation files and the manifest temp (len(b.Files)+1).
	// The loser's re-check under the lock skips all of that.
	wantCreates := 2 + len(b.Files) + 1
	fsys.mu.Lock()
	creates := fsys.counts["create"]
	fsys.mu.Unlock()
	if creates != wantCreates {
		t.Errorf("create calls = %d, want %d (one publisher did the generation work)", creates, wantCreates)
	}

	// No lost bytes: the active generation verifies against the bundle.
	vr, err := NewPublisher(testLogger(), NewOSFS(), root).Verify()
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !vr.Installed || vr.Generation != "v10" {
		t.Fatalf("Verify = %+v", vr)
	}
	for _, f := range b.Files {
		if got := readFileT(t, filepath.Join(root, integrationDir, "v10", f.Name)); string(got) != string(f.Data) {
			t.Errorf("%s lost or corrupted bytes", f.Name)
		}
	}
	assertBoundedFootprint(t, root, "v10")
}

// TestConcurrentPublishDifferentVersions: when two versions race, the newer
// one wins and the older one is refused, never downgrading the result.
func TestConcurrentPublishDifferentVersions(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, dirName)
	fsys := newFaultFS(NewOSFS())

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, v := range []string{"1", "2"} {
		wg.Add(1)
		go func(i int, v string) {
			defer wg.Done()
			pub := NewPublisher(testLogger(), fsys, root)
			_, errs[i] = pub.Publish(testBundle(v))
		}(i, v)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("worker %d: %v", i, err)
		}
	}
	m := readManifestT(t, root)
	if m.Generation != "v2" {
		t.Fatalf("manifest names %s after a v1/v2 race, want v2", m.Generation)
	}
	assertBoundedFootprint(t, root, "v2")
}
