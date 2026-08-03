//go:build linux

package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// The enforcement suite proves behavior, not source shape: the test binary
// doubles as the sandbox helper (via TestSandboxChildProcess + env) and as
// the probe that runs INSIDE the cage after the helper exec's it. The helper
// applies real Landlock restrictions, so every probe assertion is executed
// under the enforced policy.

const (
	envHelperChild = "NOCX_SANDBOX_HELPER_CHILD"
	envProbe       = "NOCX_SANDBOX_PROBE"
	envPolicyFD    = helperEnvPrefix + "POLICY_FD"
	envStatusFD    = helperEnvPrefix + "STATUS_FD"
)

// TestSandboxChildProcess is the child entry point: with envHelperChild set
// it acts as the sandbox helper; with envProbe set it runs the assertions
// inside the cage. Production uses the argv marker instead (MaybeHelper).
func TestSandboxChildProcess(t *testing.T) {
	switch {
	case os.Getenv(envHelperChild) == "1":
		pfd, e1 := strconv.Atoi(os.Getenv(envPolicyFD))
		sfd, e2 := strconv.Atoi(os.Getenv(envStatusFD))
		if e1 != nil || e2 != nil {
			os.Exit(helperExitSetup)
		}
		os.Exit(helperMain(pfd, sfd))
	case os.Getenv(envProbe) == "1":
		os.Exit(runProbe())
	}
}

// TestLandlockEnforcement is the parent: builds a fixture, launches the
// helper with a real policy, waits for enforcement readiness, and checks the
// probe's verdict inside the cage.
func TestLandlockEnforcement(t *testing.T) {
	abi, err := detectABI()
	if err != nil || abi < minLandlockABI {
		t.Skipf("landlock enforcement requires kernel ABI >= %d (detected %v, err %v)", minLandlockABI, abi, err)
	}

	base := t.TempDir()
	workspace := filepath.Join(base, "workspace")
	home := filepath.Join(base, "runtime", "home")
	tmp := filepath.Join(base, "runtime", "tmp")
	sentinel := filepath.Join(base, "sentinel-secret.txt")
	for _, d := range []string{workspace, home, tmp} {
		if mkErr := os.MkdirAll(d, 0o750); mkErr != nil {
			t.Fatalf("mkdir %s: %v", d, mkErr)
		}
	}
	if wErr := os.WriteFile(sentinel, []byte("top secret"), 0o600); wErr != nil {
		t.Fatalf("write sentinel: %v", wErr)
	}
	// A hard link to the sentinel that already exists inside the writable
	// root before launch: the documented hierarchy-not-inode limitation.
	preHard := filepath.Join(workspace, "pre-hard-link")
	if lErr := os.Link(sentinel, preHard); lErr != nil {
		t.Fatalf("pre-link sentinel: %v", lErr)
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("executable: %v", err)
	}

	probeEnv := append(os.Environ(),
		envProbe+"=1",
		"NOCX_SB_WORKSPACE="+workspace,
		"NOCX_SB_SENTINEL="+sentinel,
		"NOCX_SB_PREHARD="+preHard,
		"NOCX_SB_HOME="+home,
		"NOCX_SB_TMP="+tmp,
		helperEnvPrefix+"LEAK=must-be-stripped",
	)
	spec := CommandSpec{Path: exe, Args: []string{"-test.run=TestSandboxChildProcess"}, Dir: workspace, Env: probeEnv}

	pol, err := BuildPolicy(workspace, exe, filepath.Join(base, "runtime"), probeEnv)
	if err != nil {
		t.Fatalf("BuildPolicy: %v", err)
	}
	payload := helperPayload{Policy: pol, Command: spec}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	policyFD, err := unix.MemfdCreate("nocx-test-policy", unix.MFD_CLOEXEC)
	if err != nil {
		t.Fatalf("memfd: %v", err)
	}
	defer func() { _ = unix.Close(policyFD) }()
	if _, wErr := unix.Write(policyFD, data); wErr != nil {
		t.Fatalf("write memfd: %v", wErr)
	}
	if _, sErr := unix.Seek(policyFD, 0, 0); sErr != nil {
		t.Fatalf("rewind memfd: %v", sErr)
	}

	statusR, statusW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer func() { _ = statusR.Close() }()
	defer func() { _ = statusW.Close() }()

	helperEnv := append(os.Environ(),
		envHelperChild+"=1",
		envPolicyFD+"=3",
		envStatusFD+"=4",
	)
	cmd := exec.Command(exe, "-test.run=TestSandboxChildProcess") //nolint:gosec // test doubles as helper/probe
	cmd.Env = helperEnv
	cmd.Dir = workspace
	cmd.ExtraFiles = []*os.File{os.NewFile(uintptr(policyFD), "policy"), statusW}
	var out strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &out

	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := readStatus(ctx, statusR, statusW); err != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		t.Fatalf("readiness failed: %v\nhelper output:\n%s", err, out.String())
	}

	if err := cmd.Wait(); err != nil {
		t.Fatalf("probe inside the cage failed: %v\noutput:\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "PROBE RESULT: ok") {
		t.Fatalf("probe did not report success:\n%s", out.String())
	}
}

// runProbe executes the behavior assertions inside the enforced cage. It
// exits 0 only when every assertion holds, printing OK/FAIL lines for the
// parent to surface on failure.
func runProbe() int {
	failures := 0
	fail := func(format string, args ...any) {
		failures++
		fmt.Printf("FAIL: "+format+"\n", args...)
	}
	ok := func(format string, args ...any) {
		fmt.Printf("OK: "+format+"\n", args...)
	}

	w := os.Getenv("NOCX_SB_WORKSPACE")
	sentinel := os.Getenv("NOCX_SB_SENTINEL")
	preHard := os.Getenv("NOCX_SB_PREHARD")
	home := os.Getenv("NOCX_SB_HOME")
	tmp := os.Getenv("NOCX_SB_TMP")
	if w == "" || sentinel == "" || preHard == "" || home == "" || tmp == "" {
		fmt.Printf("FAIL: probe missing fixture env\n")
		return 1
	}

	// Writable roots: create, truncate, rename.
	f := filepath.Join(w, "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		fail("create in workspace: %v", err)
	} else {
		ok("create in workspace")
	}
	if err := os.WriteFile(f, []byte("longer content"), 0o600); err != nil {
		fail("truncate-rewrite in workspace: %v", err)
	} else {
		ok("truncate-rewrite in workspace")
	}
	if err := os.Rename(f, filepath.Join(w, "b.txt")); err != nil {
		fail("rename in workspace: %v", err)
	} else {
		ok("rename in workspace")
	}
	if err := os.WriteFile(filepath.Join(home, "f"), []byte("h"), 0o600); err != nil {
		fail("create in runtime home: %v", err)
	} else {
		ok("create in runtime home")
	}
	if err := os.WriteFile(filepath.Join(tmp, "f"), []byte("t"), 0o600); err != nil {
		fail("create in runtime tmp: %v", err)
	} else {
		ok("create in runtime tmp")
	}

	// Read-only system root.
	if _, err := os.ReadFile("/etc/hostname"); err != nil {
		fail("read /etc/hostname: %v", err)
	} else {
		ok("read system root")
	}

	// Sentinel outside all roots: unreadable and unwritable.
	if _, err := os.ReadFile(sentinel); err == nil { //nolint:gosec // probe asserts the cage denies
		fail("read of sentinel outside roots succeeded")
	} else {
		ok("sentinel unreadable")
	}
	if err := os.WriteFile(sentinel, []byte("x"), 0o600); err == nil {
		fail("write to sentinel outside roots succeeded")
	} else {
		ok("sentinel unwritable")
	}

	// Symlink escape: resolution is path-checked, the target is outside.
	link := filepath.Join(w, "escape")
	if err := os.Symlink(sentinel, link); err != nil {
		fail("create symlink in workspace: %v", err)
	}
	if _, err := os.ReadFile(link); err == nil { //nolint:gosec // probe asserts the cage denies
		fail("symlink escape read succeeded")
	} else {
		ok("symlink escape blocked")
	}

	// Hard-link creation to an outside file is denied at link(2).
	if err := os.Link(sentinel, filepath.Join(w, "hard")); err == nil {
		fail("hard link to sentinel created")
	} else {
		ok("hard-link creation to outside file denied")
	}

	// Renaming an outside file into the workspace needs REFER on the source
	// hierarchy, which is outside the roots.
	if err := os.Rename(sentinel, filepath.Join(w, "moved")); err == nil {
		fail("rename of sentinel into workspace succeeded")
	} else {
		ok("rename of sentinel blocked")
	}

	// Subprocess: children inherit the domain.
	sub := exec.Command("/bin/sh", "-c", "cat '"+sentinel+"' >/dev/null 2>&1") //nolint:gosec // probe asserts the cage denies the escape
	if err := sub.Run(); err == nil {
		fail("subprocess read the sentinel")
	} else {
		ok("subprocess blocked from sentinel")
	}

	// Pre-existing hard link inside a writable root: documented limitation,
	// reachable through the in-root path (hierarchy-based rules, not inode).
	if _, err := os.ReadFile(preHard); err != nil { //nolint:gosec // probe asserts the documented limitation
		fail("pre-existing hard link unreadable: %v", err)
	} else {
		ok("pre-existing hard link reachable (documented limitation)")
	}

	// Outbound TCP (loopback): network is outside the contract and must work.
	ln, lErr := net.Listen("tcp", "127.0.0.1:0")
	if lErr != nil {
		fail("tcp listen: %v", lErr)
	} else {
		ok("tcp listen (loopback)")
		addr := ln.Addr().String()
		conn, dErr := net.Dial("tcp", addr)
		if dErr != nil {
			fail("tcp connect: %v", dErr)
		} else {
			ok("tcp connect (loopback)")
			_ = conn.Close()
		}
		_ = ln.Close()
	}

	// Helper-internal env must never reach the shell.
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, helperEnvPrefix) {
			fail("helper env leaked into shell env: %q", kv)
		}
	}

	if failures > 0 {
		fmt.Printf("PROBE RESULT: %d failures\n", failures)
		return 1
	}
	fmt.Printf("PROBE RESULT: ok\n")
	return 0
}
