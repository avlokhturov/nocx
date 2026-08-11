package shellintegration

// The generation the prelude exports is what the rcfile sources — nocx-tr2n.
//
// The rcfile the full launcher installs does not embed the scripts; it
// sources `${HOME}/.nocx/integration/${NOCX_GENERATION}/nocx.bash`, with
// stderr suppressed so a failed publish lands on a clean native prompt.
// That makes NOCX_GENERATION load-bearing: empty, the path names no file,
// the source is silent, and the session is an ordinary terminal with no
// diagnostic anywhere. The prelude therefore has to export a generation on
// EVERY path where one is installed — not only on the path where this run
// is what installed it.
//
// Measured on the owner's host, 2026-08-10: `ls`/`pwd` in an ssh tab
// produced no blocks. NOCX_SHELL_INTEGRATION=1, NOCX_PROMPT_MODE=marker-only
// and NOCX_LIFECYCLE_PORT were all set, /root/.nocx/integration/v25/nocx.bash
// existed with the manifest's hash — and NOCX_GENERATION was empty, so
// nothing was ever sourced. Every proof of this launcher used a fresh $HOME,
// where the publish always happens, so the second connection to any host was
// the untested case — which is every connection after the first.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// preludeGeneration runs the prelude under a real /bin/sh and reports what
// it left in NOCX_GENERATION.
func preludeGeneration(t *testing.T, version, home string) string {
	t.Helper()
	prelude := buildPublishPrelude(version)
	cmd := exec.Command("/bin/sh", "-c", prelude+`; printf "GEN=[%s]\n" "${NOCX_GENERATION-}"`) // #nosec G204 — package consts.
	cmd.Env = append(os.Environ(), "HOME="+home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("prelude failed: %v\n%s", err, out)
	}
	text := string(out)
	i := strings.Index(text, "GEN=[")
	if i < 0 {
		t.Fatalf("prelude printed no generation line:\n%s", text)
	}
	rest := text[i+len("GEN=["):]
	j := strings.Index(rest, "]")
	if j < 0 {
		t.Fatalf("prelude printed a truncated generation line:\n%s", text)
	}
	return rest[:j]
}

// The first connection installs the bundle and names the generation. This is
// the case every existing proof covers; it is here as the paired positive so
// the fix below cannot be satisfied by exporting a generation unconditionally.
func TestShPublish_FirstConnection_ExportsGeneration(t *testing.T) {
	home := t.TempDir()
	if got, want := preludeGeneration(t, version, home), genDir(version); got != want {
		t.Errorf("NOCX_GENERATION after the installing run = %q, want %q", got, want)
	}
}

// The second connection publishes nothing — the version is already installed
// — and must still name the generation it found. Without it the rcfile
// sources nothing and the session is silently unintegrated.
func TestShPublish_AlreadyInstalled_StillExportsGeneration(t *testing.T) {
	home := t.TempDir()
	runShPublish(t, version, home) // the first connection installs

	got := preludeGeneration(t, version, home)
	if got != genDir(version) {
		t.Errorf("NOCX_GENERATION on a host that already has the bundle = %q, want %q — "+
			"the rcfile sources integration/$NOCX_GENERATION/nocx.bash with stderr "+
			"suppressed, so an empty value is a silently unintegrated shell", got, genDir(version))
	}
}

// A NEWER generation installed by some other client is not downgraded, and
// the prelude must name that newer generation rather than the version it
// carries: the rcfile sources whatever is on disk, and the manifest is the
// activation pointer.
func TestShPublish_NewerInstalled_ExportsTheInstalledGeneration(t *testing.T) {
	home := t.TempDir()
	newer := versionPlus(t, 1)
	root := filepath.Join(home, dirName)
	if _, err := NewPublisher(testLogger(), NewOSFS(), root).Publish(testBundle(newer)); err != nil {
		t.Fatalf("go publish v%s: %v", newer, err)
	}

	if got, want := preludeGeneration(t, version, home), genDir(newer); got != want {
		t.Errorf("NOCX_GENERATION with a newer generation installed = %q, want %q", got, want)
	}
}

// A generation the prelude cannot verify is not named. The manifest points at
// files; if one is missing or its bytes do not match the recorded hash, the
// activation is not provable and the session must be conventional rather than
// source something unproven. This is the launch carrier's own rule (design
// §3.3) applied at the only other place that resolves a generation.
func TestShPublish_InstalledButCorrupt_ExportsNoGeneration(t *testing.T) {
	home := t.TempDir()
	runShPublish(t, version, home)

	corrupt := filepath.Join(home, dirName, "integration", genDir(version), "nocx.bash")
	if err := os.WriteFile(corrupt, []byte("# not the published bytes\n"), 0o600); err != nil {
		t.Fatalf("corrupt the installed generation: %v", err)
	}

	if got := preludeGeneration(t, version, home); got != "" {
		t.Errorf("NOCX_GENERATION with a hash-mismatched generation = %q, want empty", got)
	}
}

// A protocol the prelude does not understand is left strictly alone, and
// nothing is named: an unknown layout may not be sourced.
func TestShPublish_UnknownProtocol_ExportsNoGeneration(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, dirName)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	manifest := `{"protocol":99,"version":"` + version + `","generation":"` + genDir(version) + `","files":{}}`
	if err := os.WriteFile(filepath.Join(root, manifestName), []byte(manifest), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	if got := preludeGeneration(t, version, home); got != "" {
		t.Errorf("NOCX_GENERATION with an unknown protocol = %q, want empty", got)
	}
}
