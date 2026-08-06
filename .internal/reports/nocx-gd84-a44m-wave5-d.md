# Wave 5 D — nocx-gd84 + nocx-a44m: two green suites that prove less than they look

Worker D report. Files touched: `internal/shellintegration/launcher_test.go`,
`frontend/src/terminal-content.test.ts`, `README.md`. No commit, no push, no bd.

## nocx-gd84 — the dash/zsh launcher tests skip silently

### The defect

`TestBashLauncher_RunsUnderDash` and all three `TestZshLauncher_*` resolved
their required shell through `requireShell`, which **skips** when the shell is
not on PATH. A bare dev box therefore reported the whole package green while
the launcher's riskiest path — the zsh transient-ZDOTDIR lifecycle, which
creates a directory on somebody else's machine and must erase it before any
user code runs — never executed. Exactly the silent success AGENTS.md's
testing rules exist to prevent.

### The choice: fail loudly, targeted, with the provisioning command named

Rejected: _harness auto-provisions_. There is no credible in-test way to
obtain a real dash or zsh without vendoring sources, network fetches, or a
package-manager subprocess — each a new invisible dependency worse than the
skip it replaces, and each would have made the tests depend on a machine
property (nix/brew/apt present) the suite cannot verify. The repo's own
established pattern for shell-dependent tests is provisioning **outside** the
test behind a documented command (the busybox in-band tests run under
`nix shell nixpkgs#busybox --command go test …`; the ssh conformance tests
have a `make conformance` target).

Chosen: _fail rather than skip_, scoped to the four named tests. New helper
`requireIntegrationShell` (launcher_test.go) fatals with an actionable message
naming the provisioning commands. Legacy skip semantics of the other tests
(`requireShell` for bash in the launcher suite, the inband and posix tests,
`requireBinBash`) are unchanged — the brief names only these four, and
changing `requireShell` globally would have made a dozen unrelated tests
brittle on minimal hosts.

Verified both directions on this machine (bash present, dash/zsh absent):

- Red path, bare `go test ./internal/shellintegration/ -count=1`:
  exactly the four tests FAIL with the message
  (`dash is required by this test and missing from PATH …` /
  `zsh is required …`); the other 13 launcher tests pass; no other failure
  in the package (10 pre-existing skips unchanged — inband, posix, tcsh,
  which are out of this brief's named scope).
- Green path, `nix shell nixpkgs#dash nixpkgs#zsh --command go test
./internal/shellintegration/ -count=1`: `ok … 23.4s`, exit 0 — all four
  pass (RunsUnderDash 1.4s, TransientDirFlow 1.4s, CleanupAfterEarlyExit
  0.6s, CleanupAfterSyntaxError 1.0s).

### The command CI runs, named where somebody will find it

Three places: (1) the helper's failure message — the developer who hits it
sees the command at the failure; (2) README §"Shell integration tests need
dash and zsh" (under the Quality gates section) with the exact install +
test commands; (3) the helper doc comment.

CI state after this change (facts, verified against the runner image
inventories): GitHub `ubuntu-latest` ships both dash and zsh, so the ubuntu
backend job now runs all four tests (previously the three zsh tests skipped
there); `macos-latest` ships zsh but **not** dash, so the macOS backend job
will fail the dash test until CI provisions it.

**Required follow-up (CI wiring, outside this worker's file lane):** add
`brew install dash` to the macOS backend job in `.github/workflows/ci.yml`
(the frontend and e2e jobs are unaffected). Until then the macOS backend job
goes red on `TestBashLauncher_RunsUnderDash` — a deliberate, loud failure of
exactly the kind the skip used to hide, and the README documents the command
that fixes it.

Secondary follow-up: `TestPosixLauncher_EmitsMarkersFromPS1`
(launcher_posix_test.go, not in this lane) still uses the old skip for dash;
once CI provisions dash it runs everywhere, but a bare box still skips it —
same treatment if it ever matters.

## nocx-a44m — the cwd chip parked centre in an SSH block header

### The defect

`.cmd-header-chips` used `justify-content: space-between` — right for two
children ([cwd, right], local block) and wrong for three (an SSH block adds
the location chip; three children space evenly, parking cwd centre). Fixed in
30014e3 by giving `.cmd-header-right` its own `margin-left: auto`, which
behaves identically for any child count. What was missing: a check that would
have caught the regression.

### Where the check belongs, and why the others were rejected

- **Playwright/e2e: rejected.** Slowest and most expensive gate; it can only
  observe one instance (an SSH header over a real SSH session), so the same
  class on another surface stays invisible; and the bug lives in CSS
  semantics, which the repo already polices in a cheaper layer.
- **A CSS-integrity lint rule: rejected.** A markup-driven rule needs TS
  parsing machinery (the header markup is DOM-building code, not JSX the
  scanner reads); a hard-coded rule on `.cmd-header-chips`'s text is exactly
  the "asserts the current rule's text" anti-pattern the brief warns about;
  a blanket space-between ban would flag legitimate two-child rows
  (`.nocx-editor-chrome`, `.secret-action`) and force production refactors
  outside this lane.
- **Chosen: a CSS-contract assertion + a DOM-order intent assertion in
  `frontend/src/terminal-content.test.ts`.** jsdom computes no layout, so a
  check that needs geometry is impossible — but the bug's two seams are both
  visible without layout. (a) The **intent**: a completed SSH block (built
  with the real `createCommandBlock`) orders its chips row location, cwd,
  then the right group, and the right group contains the duration and exit
  chips — asserted as DOM source order, the only thing jsdom can see.
  (b) The **stylesheet contract**: `.cmd-header-chips` must not declare a
  distributed justify value and `.cmd-header-right` must declare
  `margin-left: auto` — parsed from the real `src/style.css` with a small
  brace-matched extractor (no css-tree dependency; `@types/node` is not
  installed, so the node builtins follow theme-catalogue.test.ts's
  `@ts-expect-error` pattern, confined to a contained lint disable).

### Proven both directions

- The contract assertion **catches the original bug**: run against
  `git show 30014e3^:frontend/src/style.css`, both halves fail —
  `justify-content: space-between` present on the container, `margin-left:
auto` absent on the right group.
- The current tree passes: `vitest run src/terminal-content.test.ts
src/editor.test.ts` → 90/90 (3 new tests). `tsc --noEmit` clean, `eslint
--max-warnings 0` clean, `prettier --check` clean on the changed file.

## Scoped gates run

- `gofumpt -l internal/shellintegration/` — clean
- `go vet ./internal/shellintegration/` — clean
- `golangci-lint run ./internal/shellintegration/...` — clean
- `go build ./...` — clean
- `go test ./internal/shellintegration/ -count=1` (bare) — 4 intentional
  FAILs (missing dash/zsh), no other failures
- `nix shell nixpkgs#dash nixpkgs#zsh --command go test ./internal/shellintegration/ -count=1` — ok, exit 0
- `frontend`: tsc, eslint, prettier, vitest on both named test files — all
  clean; full `npm test -- --run` result in the worker report

## Files changed

- `internal/shellintegration/launcher_test.go` — `requireIntegrationShell`
  helper + 4 call sites
- `frontend/src/terminal-content.test.ts` — 3 new tests (DOM order ×2,
  CSS contract ×1) + small extraction helpers
- `README.md` — "Shell integration tests need dash and zsh" note naming the
  provisioning command and the CI shell inventory

## Follow-ups (outside lane)

1. `.github/workflows/ci.yml` macOS backend job: add `brew install dash`
   (required to keep that job green once the dash test fails loudly).
2. `TestPosixLauncher_EmitsMarkersFromPS1` still skips without dash on bare
   boxes — same treatment when the CI provisioning lands.
3. `.nocx-editor-chrome` still uses `justify-content: space-between` with
   `.nocx-editor-chrome-left` + clock — same latent class (two children
   today, three breaks it); left unfixed because style.css is outside this
   lane.
