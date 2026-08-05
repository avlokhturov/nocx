package shellintegration

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The full bootstrap launcher's acceptance surface, watched end to end on a
// real pty against a disposable $HOME: the launcher publishes the bundle,
// then the integrated shell emits the readiness passport naming the COMMITTED
// generation (not "-"), and the Go publisher verifies the published state.

// passportBytes is the exact OSC 636 P sequence the scripts emit for an
// identified environment (design §5.2): protocol 1, the environment id, "-"
// parent, script version 11, the tier, and the generation dir name.
func passportBytes(envID, tier, generation string) string {
	return "\x1b]636;P;1;" + envID + ";-;11;" + tier + ";" + generation + "\x07"
}

func TestBashFullLauncher_PublishesAndPassportNamesGeneration(t *testing.T) {
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()
	const envID = "bash-env-42"
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{
		SessionID: "sess-bash", Enhanced: true, EnvironmentID: envID,
	})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "echo hello", "exit")

	if n := strings.Count(out, passportBytes(envID, "enhanced", genDir(version))); n != 1 {
		t.Errorf("passport naming %s emitted %d times, want exactly once; output:\n%s", genDir(version), n, out)
	}
	if !strings.Contains(out, "USER_RC_RAN") {
		t.Errorf("user rc did not run; output:\n%s", out)
	}
	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") == 0 || countMarkers(ms, "B") == 0 {
		t.Errorf("no A/B markers: the remote shell did not come up integrated; output:\n%s", out)
	}

	// The launcher's own publish is the Go-verifiable installed fact.
	vr, err := NewPublisher(testLogger(), NewOSFS(), filepath.Join(home, dirName)).Verify()
	if err != nil || !vr.Installed || vr.Generation != genDir(version) {
		t.Errorf("Verify after full launcher = %+v err=%v, want installed %s", vr, err, genDir(version))
	}
}

// TestZshFullLauncher_PublishesAndPassportNamesGeneration is the zsh tier's
// half: the transient-ZDOTDIR lifecycle plus the publish plus the passport.
func TestZshFullLauncher_PublishesAndPassportNamesGeneration(t *testing.T) {
	requireIntegrationShell(t, "zsh")
	home := writeZshFixtureHome(t, "")
	tmp := t.TempDir()
	const envID = "zsh-env-7"
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellZsh, LaunchOptions{
		SessionID: "sess-zsh", Enhanced: true, EnvironmentID: envID,
	})
	if !ok {
		t.Fatal("zsh launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "echo hi", "exit")

	if n := strings.Count(out, passportBytes(envID, "enhanced", genDir(version))); n != 1 {
		t.Errorf("passport naming %s emitted %d times, want exactly once; output:\n%s", genDir(version), n, out)
	}
	vr, err := NewPublisher(testLogger(), NewOSFS(), filepath.Join(home, dirName)).Verify()
	if err != nil || !vr.Installed || vr.Generation != genDir(version) {
		t.Errorf("Verify after full launcher = %+v err=%v, want installed %s", vr, err, genDir(version))
	}
}

// TestPosixFullLauncher_PublishesAndPassportNamesGeneration is the minimal
// tier's half: dash parses the command, the publish lands, and the passport
// names the generation with tier minimal.
func TestPosixFullLauncher_PublishesAndPassportNamesGeneration(t *testing.T) {
	dashPath := requireIntegrationShell(t, "dash")
	home := t.TempDir()
	// #nosec G306 — test fixture file, intentionally created with restricted permissions.
	if err := os.WriteFile(filepath.Join(home, ".profile"), []byte("echo USER_RC_RAN\n"), 0o600); err != nil {
		t.Fatalf("write fixture .profile: %v", err)
	}
	tmp := t.TempDir()
	const envID = "posix-env-3"
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellUnknown, LaunchOptions{
		SessionID: "sess-posix", Enhanced: true, EnvironmentID: envID,
	})
	if !ok {
		t.Fatal("posix launcher refused")
	}

	out := runLauncherOnPTY(t, dashPath, cmd,
		[]string{"HOME=" + home, "SHELL=" + dashPath, "TMPDIR=" + tmp, "TERM=xterm"},
		"true", "exit")

	if n := strings.Count(out, passportBytes(envID, "minimal", genDir(version))); n != 1 {
		t.Errorf("passport naming %s emitted %d times, want exactly once; output:\n%s", genDir(version), n, out)
	}
	vr, err := NewPublisher(testLogger(), NewOSFS(), filepath.Join(home, dirName)).Verify()
	if err != nil || !vr.Installed || vr.Generation != genDir(version) {
		t.Errorf("Verify after full launcher = %+v err=%v, want installed %s", vr, err, genDir(version))
	}
}

// TestFullLauncher_ReadonlyHome_TransientAndGenerationDash: a read-only
// $HOME publishes nothing and records no installed fact, yet the session is
// still transient-integrated — markers arrive and the passport carries "-".
func TestFullLauncher_ReadonlyHome_TransientAndGenerationDash(t *testing.T) {
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()
	const envID = "ro-env-9"
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{
		SessionID: "sess-ro", Enhanced: true, EnvironmentID: envID,
	})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	// #nosec G302 — test fixture deliberately making HOME read-only so the
	// publish's fail-open can be proven.
	if err := os.Chmod(home, 0o500); err != nil {
		t.Fatalf("chmod home: %v", err)
	}
	// #nosec G302 — restoring the test fixture's HOME mode.
	t.Cleanup(func() { _ = os.Chmod(home, 0o700) })
	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "echo hello", "exit")

	if n := strings.Count(out, passportBytes(envID, "enhanced", "-")); n != 1 {
		t.Errorf("passport with generation '-' emitted %d times, want exactly once; output:\n%s", n, out)
	}
	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") == 0 {
		t.Errorf("no A marker: the session did not come up transient-integrated; output:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(home, dirName)); !os.IsNotExist(err) {
		t.Errorf("read-only HOME gained a ~/.nocx (err=%v)", err)
	}
}

// TestFullLauncher_ForeignRoot_RefusedAndStillIntegrated: an existing
// ~/.nocx that is not recognisably ours is never modified, and the session
// still integrates from argv with a "-" generation.
func TestFullLauncher_ForeignRoot_RefusedAndStillIntegrated(t *testing.T) {
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	root := filepath.Join(home, dirName)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "not-ours.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	const envID = "foreign-env-1"
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{
		SessionID: "sess-f", Enhanced: true, EnvironmentID: envID,
	})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "exit")

	if n := strings.Count(out, passportBytes(envID, "enhanced", "-")); n != 1 {
		t.Errorf("passport with generation '-' emitted %d times, want exactly once; output:\n%s", n, out)
	}
	if _, err := os.Stat(filepath.Join(root, manifestName)); !os.IsNotExist(err) {
		t.Errorf("foreign root was modified (manifest appeared, err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(root, "not-ours.txt")); err != nil {
		t.Errorf("foreign file touched: %v", err)
	}
}
