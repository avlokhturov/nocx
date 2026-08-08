package shellintegration

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// The scripts are installed into ~/.nocx once and then never rewritten while
// the installed VERSION file still matches the `version` constant — that
// short-circuit is the whole point of the marker, and it is checked before
// anything reads the script's content. So a script edited WITHOUT bumping
// `version` reaches nobody: every existing shell keeps sourcing the copy
// installed the last time the number changed, and the change is invisible in
// the product while every test that reads the embedded string stays green.
//
// Measured on 2026-08-01: the OSC 636 command-existence hook shipped, the
// backend binary carried the new script, `go test ./internal/shellintegration`
// passed, and the feature did nothing in the app — ~/.nocx/shell-integration.bash
// was still the 6504-byte copy from 2026-07-26 because `version` was left at
// "7". The defect is structural: nothing connected the script bytes to the
// number that governs whether they are delivered.
//
// This test connects them. Change a script and the digest below stops matching,
// which is a failure that can only be resolved by deciding what the version
// should be — which is exactly the decision that was skipped.
func TestScriptVersionTracksScriptContent(t *testing.T) {
	// sha256 over each script's name and bytes, in a fixed order.
	//
	// WHEN THIS FAILS: you changed a shell integration script. Bump `version`
	// in scripts.go, then add an entry here for the new version with the digest
	// the failure prints. Do not edit an existing entry — a released version
	// number describes one exact set of scripts, and rewriting it in place is
	// the same as not having the check.
	// The digest covers every script in the `scripts` map: a change to
	// nocx.posix without a bump strands installs exactly like a bash change
	// would.
	digests := map[string]string{
		"8":  "ca89bf20e58c0a4669ecfb0754173ce721e436273b0b06549c7e0162e9b06dc8",
		"9":  "26ee0a75cf83df3a773c97ee39265c96912629c4bcdb629edea51ba5bcc5529d",
		"10": "17c0fdf278e54cd6fea16aed814b9c96b0daaff6e5d54c6ced03ebd93fc111aa",
		"11": "85b6105438f141628de8a87ecf013c7fad3df8053c81bd7b65975d26405c6a72",
		// v12: the first prompt's snapshot wait is bounded by elapsed time
		// rather than by a count of sleeps whose real cost it could not see
		// (nocx-0ije).
		"12": "7cc1e5d1f4af02ffa13b8654804e94efc19c51627471668ee204e72605a52655",
		// v13: the payload encoder gained a fast path for names needing no
		// escaping. It was ~85ms of the ~104ms snapshot pipeline, in front of a
		// 250ms grace that a fresh tab gets exactly one shot at — a shell idle
		// in readline runs no traps, so a job that misses it waits for a prompt
		// the user may never produce (nocx-z9s9.16).
		"13": "00383f333efb2633efb5b039302b36d834ffba9364dfb3b3406f4779d2cd3041",
		// v14: the authenticated lifecycle channel (ADR-0024) — the shell
		// speaks hello/accept/start/complete/prompt_ready over a transport
		// that is not the tty, authenticated by the per-epoch capability
		// (nocx-u7uh.3).
		"14": "1db018fdd91b47676ba3e71d75b9ac3f02346dcb57d6c314f0ad3ce8d5936490",
		// v15: the hooks answer a refresh_request with an authenticated
		// snapshot at the next prompt boundary and restore a visible prompt
		// while the domain is desynchronized (ADR-0024 decision 7/9,
		// nocx-u7uh.9). The snapshot names no attempt — the shell never
		// learns attempt ids — so open attempts reconcile as unknown.
		"15": "462c239042f18b149f94d8349bce08d5354595869eba785965dbb7037346ce7a",
		// v16: the snapshot names the shell's own attempts — the shell mints
		// an id per command at start, the kernel learns it at attach and
		// resolves it as a per-attempt alias, and a completion lost inside a
		// corrupted region reconciles to its real status instead of to
		// unknown; zsh answers refresh_request the way bash does; POSIX sh
		// documents the omission as decided (nocx-u7uh.19).
		"16": "d706a17d13634c274fcb0618dfd22c4eacd4427744d9848e23a5aa38a81a22a1",
		// v17: the shell-minted attempt id carries the domain (s-<dom>-<n>)
		// instead of the PID (s-$$-<n>): PID spaces are not shared across
		// domains, so a docker exec / ssh shell sharing a low PID with
		// another domain's shell minted a colliding id and the kernel
		// rejected the second domain's first command (nocx-u7uh.19).
		"17": "5edf9b249dd194fc3c43cd21cbb2a2608378afebd0f2f318928a7448f8671779",
	}

	h := sha256.New()
	for _, name := range []string{"scripts/nocx.bash", "scripts/nocx.zsh", "scripts/nocx.posix"} {
		h.Write([]byte(name))
		h.Write([]byte{0})
		h.Write([]byte(scriptFor(t, name)))
		h.Write([]byte{0})
	}
	got := hex.EncodeToString(h.Sum(nil))

	want, ok := digests[version]
	if !ok {
		t.Fatalf("version %q has no recorded script digest.\n"+
			"Add this entry to the digests map above:\n\n\t%q: %q,\n",
			version, version, got)
	}
	if got != want {
		t.Fatalf("the shell integration scripts changed but version is still %q.\n"+
			"An installed ~/.nocx carrying VERSION=%s will never be rewritten, so the\n"+
			"change reaches no shell. Bump `version` in scripts.go and add:\n\n\t%q: %q,\n",
			version, version, "<new version>", got)
	}
}

// scriptFor returns the embedded content for a script path, so the test hashes
// exactly the bytes that get installed rather than re-reading the file from
// disk (which would pass even if the go:embed directive pointed elsewhere).
func scriptFor(t *testing.T, path string) string {
	t.Helper()
	switch path {
	case "scripts/nocx.bash":
		return bashScript
	case "scripts/nocx.zsh":
		return zshScript
	case "scripts/nocx.posix":
		return posixScript
	default:
		t.Fatalf("no embedded script for %q", path)
		return ""
	}
}
