package shellintegration

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// LocalBashRcfile renders the bash rcfile for a LOCAL enhanced session
// (nocx-u7uh.21): the same template the remote bash tier uses, so "how a
// shell learns its addressing and its capability" has exactly one owner —
// launcher.go's LaunchOptions plus the rcfile builders. The caller writes
// the result to a transient file and starts `bash --rcfile <path> -i`
// (pty.Config.Command/Args). The capability and the one-shot recovery fence
// are substituted into the rcfile TEXT, never the environment, exactly as
// the remote tier (ADR-0024 decision 2).
//
// The @NOCX_BASH@ slot carries the embedded script: the template already
// rewinds an installer-era install from the user's ~/.bashrc (it sources
// the user's rc first) and reinstalls with THIS session's authenticators,
// which is what makes the local channel live rather than the installed
// generation's stale one.
//
// Only the bash tier is supported for local enhanced sessions today: bash
// is the integration-first shell (it is what the local pty already prefers
// when $SHELL is unset), and the zsh/posix local tiers would each need
// their own launch semantics (transient ZDOTDIR, ENV file) — deliberately
// not built here; a non-bash $SHELL on a local enhanced session is a
// follow-up, not a silent degrade (a zsh user still lands on a visible
// conventional terminal, which is the safe direction).
func LocalBashRcfile(opts LaunchOptions) (string, error) {
	if !opts.Enhanced || opts.SessionID == "" {
		return "", fmt.Errorf("shellintegration: local lifecycle bootstrap requires an enhanced session with a session id")
	}
	return bashRcfile(launcherEnvBlock(opts), bashScript, opts.Capability, opts.Recovery), nil
}

// WriteLocalRcfile writes the rendered rcfile to a transient file whose
// name matches the template's self-delete guard (`*/nocx-bash.??????` —
// exactly six characters after the prefix, which is the mktemp shape the
// guard was written for; a longer random suffix would never be removed and
// every session would leave a file containing the capability in TMPDIR).
// The file is created mode 0600 from the start (no create-then-chmod
// window) with O_EXCL (no symlink pre-emption), so the capability it
// carries is never world-readable. The shell removes it once bash has read
// it; the caller removes it on spawn failure.
func WriteLocalRcfile(rc string) (string, error) {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("shellintegration: local rcfile name: %w", err)
	}
	path := filepath.Join(os.TempDir(), "nocx-bash."+hex.EncodeToString(b))
	//nolint:gosec // path is os.TempDir() plus a random name minted here, and
	// O_EXCL with mode 0600 is precisely the defence: no pre-existing file is
	// opened and no other user can read the capability it carries.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("shellintegration: local rcfile: %w", err)
	}
	if _, err := f.WriteString(rc); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("shellintegration: local rcfile write: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("shellintegration: local rcfile close: %w", err)
	}
	return path, nil
}
