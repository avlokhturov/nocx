package shellintegration

// How the bash tier hands bash its rcfile, and why the answer is a file.
//
// The bash launcher used to deliver it through process substitution:
//
//	exec bash --rcfile <(printf %b "<escaped>") -i
//
// which is a PIPE carrying ~21KB (the whole embedded nocx.bash). On the macOS
// CI runner that produced, from a session that had already run the user's rc:
//
//	bash: /dev/fd/63: line 415: syntax error: unexpected end of file
//
// — the rcfile cut off mid-construct, so nothing after line 415 installed. It
// is scheduling, not syntax: identical bytes and an identical runner image ran
// green before and red after, and it never reproduced on an unloaded Mac. A
// user on a busy machine gets no shell integration and no error.
//
// The fix is not a bigger buffer, it is a seekable file: bash reads a regular
// rcfile whole, so there is no short read to lose the tail to. launcher_zsh.go
// already answered this exact question that way — mktemp, write, remove from
// inside the rc — and the bash tier had forked a second answer to it
// (nocx-azxe.1).
import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestBashLauncher_RcfileTravelsAsAFileNotAPipe pins the transport itself.
//
// Normally a mechanism is the wrong thing to assert — but here the mechanism
// IS the contract: "the reader cannot lose bytes to scheduling" is a property
// of being a regular file, and no black-box assertion can distinguish a pipe
// that happened not to short-read from a file that cannot.
func TestBashLauncher_RcfileTravelsAsAFileNotAPipe(t *testing.T) {
	arg, ok := remoteLauncher{}.bashArg(LaunchOptions{
		SessionID: "sess-1", Enhanced: true, EnvironmentID: "env-1",
	})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	if strings.Contains(arg, "--rcfile <(") {
		t.Error("the rcfile still travels through process substitution; a pipe is what loses the tail under load")
	}
	if !strings.Contains(arg, "mktemp") {
		t.Errorf("no mktemp: the rcfile must be written to a real file before bash reads it:\n%s", firstN(arg, 400))
	}
	// The carrier wraps this string in single quotes, so it must not contain
	// one — the same constraint the process-substitution form satisfied by
	// construction and which a hand-written script can break.
	if strings.Contains(arg, "'") {
		t.Error("the bash arg contains a single quote; it travels single-quoted inside the launch carrier")
	}
}

// TestBashLauncher_RefusesNothingWhenTempIsUnusable: fail-open is absolute
// (ADR-0004). A host with no writable temp gets a plain interactive bash — a
// shell without integration — never a dead session.
func TestBashLauncher_RefusesNothingWhenTempIsUnusable(t *testing.T) {
	arg, ok := remoteLauncher{}.bashArg(LaunchOptions{
		SessionID: "sess-1", Enhanced: true, EnvironmentID: "env-1",
	})
	if !ok {
		t.Fatal("bash launcher refused")
	}
	if !strings.Contains(arg, "exec bash -i") {
		t.Errorf("no fail-open exec: mktemp or the write failing must still leave the user in a shell:\n%s", firstN(arg, 400))
	}
}

// TestBashLauncher_WholeRcfileExecutes drives the real transport on a real pty
// with a payload past a pipe's capacity, and asserts the LAST line ran.
//
// The size is squeezed between two real limits, so it is derived rather than
// picked:
//
//   - ABOVE a pipe's capacity, 64 KiB on both Linux and macOS. That is the
//     regime the old process-substitution form was fragile in — the writer must
//     block for the reader at least once — and 21KB was already enough to lose
//     the tail on the CI runner.
//   - BELOW maxFullLauncherLen. The whole command travels as ONE argv word, and
//     Linux caps a single argument at MAX_ARG_STRLEN = 128 KiB. A first draft of
//     this test used a flat 128KB and died as `fork/exec /bin/sh: argument list
//     too long` on the Linux runner — the exact failure launcher.go's cap exists
//     to prevent, reproduced by a test that ignored it.
//
// Filler is plain ASCII so printfBEscape passes it through roughly 1:1 and the
// two bounds stay comparable.
func TestBashLauncher_WholeRcfileExecutes(t *testing.T) {
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()

	const pipeCapacity = 64 * 1024
	// Leave room for the template, the env block and the escaping overhead.
	target := maxFullLauncherLen - 16*1024

	var b strings.Builder
	// The filler is CODE, not comments: the shipped rcfile is
	// comment-stripped (nocx-z9s9.17), so a '#' filler would collapse to
	// nothing and the payload would stop exceeding pipe capacity. A no-op
	// ':' command per line pads the body just as well.
	for i := 0; b.Len() < target; i++ {
		fmt.Fprintf(&b, ": filler line %d: padding the rcfile past a pipe capacity\n", i)
	}
	b.WriteString("printf 'RCFILE_TAIL_RAN\\n'\n")

	arg := bashArgFor(bashRcfile(launcherEnvBlock(LaunchOptions{
		SessionID: "sess-tail", Enhanced: true, EnvironmentID: "tail-env",
	}), b.String(), "", ""))

	// The two bounds, asserted rather than assumed: a payload that drifted
	// under the pipe capacity would stop testing anything, and one that drifted
	// over the argv cap would fail for a reason that is not the subject.
	if len(arg) <= pipeCapacity {
		t.Fatalf("payload is %d bytes, which a pipe holds in one go — the test no longer exercises the regime it exists for", len(arg))
	}
	if len(arg) > maxFullLauncherLen {
		t.Fatalf("payload is %d bytes, past maxFullLauncherLen %d — Linux would refuse the argv word before bash ever ran", len(arg), maxFullLauncherLen)
	}

	out := runLauncherOnPTY(t, "/bin/sh", `exec /usr/bin/env -u BASH_ENV bash -c `+shellQuote(arg),
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "exit")

	if !strings.Contains(out, "RCFILE_TAIL_RAN") {
		t.Errorf("the end of the rcfile never executed — it was truncated in transit; output:\n%s", firstN(out, 1200))
	}
	// Whatever it was written to, it is not left behind.
	left, err := filepath.Glob(filepath.Join(tmp, "nocx-bash.*"))
	if err != nil {
		t.Fatalf("glob transient rcfiles: %v", err)
	}
	if len(left) != 0 {
		t.Errorf("transient rcfiles survived the session: %v", left)
	}
}

// TestBashLauncher_TransientRcfileIsGoneBeforeUserCode: the file exists only
// long enough for bash to read it. The user's own rc must never be able to see
// it — the same promise launcher_zsh.go makes about its transient ZDOTDIR.
func TestBashLauncher_TransientRcfileIsGoneBeforeUserCode(t *testing.T) {
	requireBinBash(t)
	tmp := t.TempDir()
	// The user's rc reports what it can see in TMPDIR at the moment it runs,
	// and the rcfile sources it before the install.
	home := writeBashFixtureHome(t, `if ls -d "${TMPDIR:-/tmp}"/nocx-bash.* >/dev/null 2>&1; then printf 'RC_PRESENT\n'; else printf 'RC_GONE\n'; fi`)

	arg, ok := remoteLauncher{}.bashArg(LaunchOptions{
		SessionID: "sess-gone", Enhanced: true, EnvironmentID: "gone-env",
	})
	if !ok {
		t.Fatal("bash launcher refused")
	}
	out := runLauncherOnPTY(t, "/bin/sh", `exec /usr/bin/env -u BASH_ENV bash -c `+shellQuote(arg),
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "exit")

	if strings.Contains(out, "RC_PRESENT") {
		t.Errorf("the transient rcfile was still on disk when the user's rc ran:\n%s", firstN(out, 800))
	}
	if !strings.Contains(out, "RC_GONE") {
		t.Errorf("the fixture rc never ran, so the check proves nothing:\n%s", firstN(out, 800))
	}
	if entries, err := os.ReadDir(tmp); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "nocx-bash.") {
				t.Errorf("transient rcfile %q survived the session", e.Name())
			}
		}
	}
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
