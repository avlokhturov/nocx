package shellintegration

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The compact carrier ~/.nocx/launch (design §3.3): with a good manifest it
// execs the integrated shell, sourcing the INSTALLED generation; with a
// missing, truncated, hash-mismatched or protocol-incompatible manifest it
// execs a native login shell and emits no passport. These tests drive the
// real carrier script on a real pty against a disposable $HOME whose bundle
// was published by the GO writer — the second half of the bidirectional
// conformance criterion.

// runCarrierOnPTY execs the carrier the way the pinned remote command does —
// `exec "$HOME/.nocx/launch" <env-id>` under /bin/sh (the login shell's
// role), with SHELL naming the shell the carrier dispatches on — and returns
// the captured output.
func runCarrierOnPTY(t *testing.T, home, shellPath, envID string, lines ...string) string {
	t.Helper()
	cmd := `exec "$HOME/.nocx/launch" ` + shellQuote(envID)
	return runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "SHELL=" + shellPath, "TERM=xterm"}, lines...)
}

// publishForCarrier installs a Go-published bundle under the disposable HOME.
func publishForCarrier(t *testing.T) (home, root string) {
	t.Helper()
	home = t.TempDir()
	root = filepath.Join(home, dirName)
	if _, err := NewPublisher(testLogger(), NewOSFS(), root).Publish(launchBundle()); err != nil {
		t.Fatalf("Go publish for carrier: %v", err)
	}
	return home, root
}

// writeProfileMarker gives the native-login-shell refusal a fingerprint: a
// login shell reads ~/.profile, an integrated non-login bash/zsh never does.
func writeProfileMarker(t *testing.T, home string) {
	t.Helper()
	// #nosec G306 — test fixture file, intentionally created with restricted permissions.
	if err := os.WriteFile(filepath.Join(home, ".profile"), []byte("echo NATIVE_LOGIN_RAN\n"), 0o600); err != nil {
		t.Fatalf("write fixture .profile: %v", err)
	}
}

func TestLaunchCarrier_GoodManifest_BashExecsIntegratedShell(t *testing.T) {
	requireBinBash(t)
	home, _ := publishForCarrier(t)
	writeProfileMarker(t, home)
	// The integrated bash's rcfile sources ~/.bashrc first; give the user
	// rc a fingerprint.
	// #nosec G306 — test fixture file.
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte("echo USER_RC_RAN\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	const envID = "carrier-bash-1"
	out := runCarrierOnPTY(t, home, bashPath, envID, "echo hi", "exit")

	// The passport names the committed generation; the marker and the
	// user's rc prove the INTEGRATED shell ran, not the native one.
	if n := strings.Count(out, passportBytes(envID, "enhanced", genDir(version))); n != 1 {
		t.Errorf("passport emitted %d times, want exactly once; output:\n%s", n, out)
	}
	if !strings.Contains(out, "USER_RC_RAN") {
		t.Errorf("user rc did not run; output:\n%s", out)
	}
	if strings.Contains(out, "NATIVE_LOGIN_RAN") {
		t.Errorf("native login shell ran instead of the integrated one; output:\n%s", out)
	}
}

func TestLaunchCarrier_GoodManifest_PosixExecsIntegratedShell(t *testing.T) {
	dashPath := requireIntegrationShell(t, "dash")
	home, _ := publishForCarrier(t)
	writeProfileMarker(t, home)
	const envID = "carrier-posix-1"
	out := runCarrierOnPTY(t, home, dashPath, envID, "true", "exit")

	if n := strings.Count(out, passportBytes(envID, "minimal", genDir(version))); n != 1 {
		t.Errorf("passport emitted %d times, want exactly once; output:\n%s", n, out)
	}
	// No NATIVE_LOGIN_RAN assertion here: the minimal tier IS a login
	// shell and reads ~/.profile natively — that is the user's rc running,
	// not a refusal. The passport is the distinguishing signal.
}

func TestLaunchCarrier_GoodManifest_ZshExecsIntegratedShell(t *testing.T) {
	zshPath := requireIntegrationShell(t, "zsh")
	home, _ := publishForCarrier(t)
	writeProfileMarker(t, home)
	const envID = "carrier-zsh-1"
	out := runCarrierOnPTY(t, home, zshPath, envID, "echo hi", "exit")

	if n := strings.Count(out, passportBytes(envID, "enhanced", genDir(version))); n != 1 {
		t.Errorf("passport emitted %d times, want exactly once; output:\n%s", n, out)
	}
	if strings.Contains(out, "NATIVE_LOGIN_RAN") {
		t.Errorf("native login shell ran instead of the integrated one; output:\n%s", out)
	}
}

// TestLaunchCarrier_BadManifest_FailsOpenToNativeLoginShell drives every
// refusal shape the carrier must recognise: a missing, truncated,
// hash-mismatched or protocol-incompatible manifest, or a symlinked
// generation file. Each must exec a NATIVE login shell (the ~/.profile
// marker) and emit no passport and no tagged marker.
func TestLaunchCarrier_BadManifest_FailsOpenToNativeLoginShell(t *testing.T) {
	requireBinBash(t)
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	const envID = "carrier-bad-1"

	t.Run("missing-manifest", func(t *testing.T) {
		home, root := publishForCarrier(t)
		writeProfileMarker(t, home)
		// The carrier itself is absent only when nothing was ever
		// published — that case is the remote command's `[ -x … ]` guard,
		// not the carrier's. Here the carrier exists and the manifest is
		// gone: the activation pointer is missing, so the carrier refuses.
		if err := os.Remove(filepath.Join(root, manifestName)); err != nil { // #nosec G304 — test-owned.
			t.Fatal(err)
		}
		out := runCarrierOnPTY(t, home, bashPath, envID, "exit")
		assertNativeLogin(t, out)
	})

	t.Run("truncated-manifest", func(t *testing.T) {
		home, root := publishForCarrier(t)
		writeProfileMarker(t, home)
		data, err := os.ReadFile(filepath.Join(root, manifestName)) // #nosec G304 — test-owned.
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, manifestName), data[:len(data)/2], 0o600); err != nil { // #nosec G304 — test-owned.
			t.Fatal(err)
		}
		out := runCarrierOnPTY(t, home, bashPath, envID, "exit")
		assertNativeLogin(t, out)
	})

	t.Run("hash-mismatched", func(t *testing.T) {
		home, root := publishForCarrier(t)
		writeProfileMarker(t, home)
		// Alter a generation file: the manifest's recorded hash no longer
		// matches, so the activation proof fails.
		path := filepath.Join(root, integrationDir, genDir(version), "nocx.bash")
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0) // #nosec G304 — test-owned.
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString("\n# tampered\n"); err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
		out := runCarrierOnPTY(t, home, bashPath, envID, "exit")
		assertNativeLogin(t, out)
	})

	t.Run("protocol-incompatible", func(t *testing.T) {
		home, root := publishForCarrier(t)
		writeProfileMarker(t, home)
		m := readManifestT(t, root)
		m.Protocol = 2
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, manifestName), data, 0o600); err != nil { // #nosec G304 — test-owned.
			t.Fatal(err)
		}
		out := runCarrierOnPTY(t, home, bashPath, envID, "exit")
		assertNativeLogin(t, out)
	})

	t.Run("symlinked-generation-file", func(t *testing.T) {
		home, root := publishForCarrier(t)
		writeProfileMarker(t, home)
		gen := filepath.Join(root, integrationDir, genDir(version))
		if err := os.Remove(filepath.Join(gen, "nocx.bash")); err != nil { // #nosec G304 — test-owned.
			t.Fatal(err)
		}
		if err := os.Symlink("/etc/hostname", filepath.Join(gen, "nocx.bash")); err != nil { // #nosec G304 — test-owned.
			t.Fatal(err)
		}
		out := runCarrierOnPTY(t, home, bashPath, envID, "exit")
		assertNativeLogin(t, out)
	})
}

// assertNativeLogin asserts the refusal fingerprint: the ~/.profile marker
// ran and no passport or tagged marker was emitted.
func assertNativeLogin(t *testing.T, out string) {
	t.Helper()
	if !strings.Contains(out, "NATIVE_LOGIN_RAN") {
		t.Errorf("no native login shell marker; output:\n%s", out)
	}
	if strings.Contains(out, "]636;P") {
		t.Errorf("a passport was emitted on a refused manifest; output:\n%s", out)
	}
	if strings.Contains(out, "nocx_env=") {
		t.Errorf("a tagged marker was emitted on a refused manifest; output:\n%s", out)
	}
}

// TestLaunchCarrier_UserRcExitStillWins: the carrier's integrated shell
// reproduces the argv launchers' startup order — the user's rc runs first
// and an rc that exits wins, so nocx's hooks never install and no passport
// is emitted.
func TestLaunchCarrier_UserRcExitStillWins(t *testing.T) {
	requireBinBash(t)
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	home, _ := publishForCarrier(t)
	// #nosec G306 — test fixture file.
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte("exit 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	const envID = "carrier-exit-1"
	out := runCarrierOnPTY(t, home, bashPath, envID)
	if strings.Contains(out, "]636;P") {
		t.Errorf("a passport was emitted despite the user rc exiting; output:\n%s", out)
	}
}
