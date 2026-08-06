# Wave 5 D follow-up — nocx-gd84 + nocx-a44m: make the gates provision the shells

Worker D follow-up report. Continues the wave5-D change (fail-loud shell tests,
README, a44m header check) in this worktree. No commit, no push, no bd.

The change was right but could not land as it stood: fail-loud tests turned
two green gates red. This round fixes both gates, folds in the two named
follow-ups, and fixes one pre-existing test race and one pre-existing macOS
CI breakage found while measuring. All numbers below were measured in the
actual environments.

## The two gates, fixed

### 1. Pre-commit hook container (golang:1.26-bookworm) — derived image

Measured facts (verified in the image, `docker run golang:1.26-bookworm`):
`/bin/sh` is dash (`/usr/bin/dash` on PATH, Essential package); zsh is ABSENT.
So the three `TestZshLauncher_*` tests failed on every commit, for every
contributor, on a clean checkout — the coordinator's measurement, reproduced.

Chosen fix: a derived image `nocx-hook-go:1.26-bookworm` built from a new
committed Dockerfile (`.githooks/images/go-tests/Dockerfile`) that installs
dash+zsh. The hook builds it before every run (`.githooks/containerized-tests.sh`).
Why this over an apt-get in the run command — measured:

| Option                                             | Cost                                                                                                                                                                       | Verdict                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `apt-get update && apt-get install zsh` per commit | **27.6s** per commit, needs Debian-mirror network on EVERY commit, breaks the warm-run-offline property (image + caches are what make a repeat commit run with no network) | rejected on the numbers |
| Derived image, cold build (base cached)            | 34.3s, one-time                                                                                                                                                            | chosen                  |
| Derived image, warm build (BuildKit layer cache)   | **0.29s** per commit                                                                                                                                                       | chosen                  |

The build-every-run choice is deliberate and documented in the Dockerfile and
the script: the Dockerfile is the source of truth — a package added there
takes effect on the next commit with no manual rebuild, and the layer cache
makes the warm build ~0.3s. No `-count=1` was touched; the existing comment's
standard (cache keyed on inputs, defeating it buys nothing) still holds and
now sits next to the new image-build rationale.

### 2. CI macOS backend job (.github/workflows/ci.yml)

Added `brew install dash` before the Test step. macOS ships zsh but not dash;
`TestBashLauncher_RunsUnderDash` and (now) `TestPosixLauncher_EmitsMarkersFromPS1`
need dash. ubuntu-latest ships both shells — the ubuntu backend-linux job is
unchanged. The macOS-specific risk (bash 3.2 as the launcher's inner bash) is
pre-proven: the bash launcher tests already run green on that job.

## The two named follow-ups — both same shape, both folded

1. **`TestPosixLauncher_EmitsMarkersFromPS1`** (launcher_posix_test.go): was
   the same skip-not-fail shape as the four gd84 tests (`requireShell` skipped
   without dash). Folded: `requireIntegrationShell(t, "dash")` — same helper,
   same fail-loud message. Verified: runs and passes in the container
   (1.80s), fails loudly on a bare host.
2. **`.nocx-editor-chrome`** (style.css + tests): same latent class as a44m —
   `justify-content: space-between` is only correct for exactly two children.
   Same fix mechanism as the header: the row no longer distributes
   (`space-between` removed), the right-edge element (`.nocx-editor-time`)
   carries `margin-left: auto`, identical rendering today, correct for any
   child count. Contract checks extended: a stylesheet-contract assertion in
   terminal-content.test.ts (chrome must not distribute; time must carry the
   auto margin) and a DOM-order intent assertion in editor.test.ts (left group
   before clock; clock is the last direct child). jsdom computes no layout, so
   both pin what jsdom can see — same doctrine as the a44m check.

## Two pre-existing defects found while measuring (both fixed)

### 3. In-band pty termios seed race (inband_pty_test.go) — ~1-in-7 flake

The fixture seeded the pty's Cflag AFTER `pty.Start` had already forked the
child; when the child's terminal acquisition won the race, bash's termios
rewrite restored the kernel-default Cflag over the seed at the next prompt
(observed: `before` 0xF00BF, `after` 0xBF). Fired ~1 in 7 full-package runs
in the container. Fixed deterministically: open the pty with `pty.Open()`,
seed the already-open slave fd BEFORE `cmd.Start()` (no shell component exists
yet), then wire stdio + Setsid/Setctty exactly as `pty.Start` does. Verified:
20/20 package runs clean (was ~2/6), inband subset 15/15.

### 4. macOS CI could not compile internal/shellintegration (pre-existing)

`inband_pty_test.go` uses Linux-only `unix.TCGETS`/`TCSETS` with no build
constraint — x/sys has no TCGETS on darwin (checked v0.31–v0.47). The macOS
backend job runs `go test ./...`, so the package failed at COMPILE time on
every macOS run since the file landed (nocx-ynsx). The premise that macOS CI
was green before this change was wrong for this package. Fixed: `//go:build
linux` on the file — the suite's semantics are Linux-specific by design (the
0xF0000 seed bits are Linux Cflag encoding; on darwin the same bits are
flow-control flags, so running the suite there would assert Linux encodings
and could enable flow control on the test pty). The launcher/posix/zsh
suites (no termios seeding) cover the real shells cross-platform. Verified:
`GOOS=darwin go test -c` and `GOOS=linux go test -c` both compile.

## Numbers

**Hook (`go_test_containerized`, git-style argv0, on this box):**

| State                      | Wall time   | Notes                                                                                             |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| Warm, nothing changed      | **0.9s**    | 27/28 packages cached; includes 0.3s image build                                                  |
| Warm, a Go package changed | ~11–25s     | observed 11s (ssh re-ran) and 25.2s (shellintegration re-ran, ~24s of it); everything else cached |
| Cold caches, image present | **~74–80s** | includes full -race compile + run                                                                 |
| True cold (fresh machine)  | ~110s once  | +34.3s image build                                                                                |

**CI:** macOS backend job adds `brew install dash` (~5–15s on runner, zsh
ships). ubuntu jobs unchanged. No CI-side cost from the image (the hook is
local; CI runs the suite directly with the shells its runners ship).

**Environmental caveat on cold runs (this box):** 7.8 GiB RAM with ~2.9 GiB
swap already in use; a 12-way `-race` compile storm thrashes it (measured:
95 MB/s swap-out, 3 GB swapped, runqueue 21 on 6 cores). During the thrash,
the pre-existing 5s wall-clock bounds in internal/ssh
(`TestTunnelConn_DialAfterCloseFails` et al.) can trip: observed 2 of 3 cold
full-suite runs, while the same test passes in isolation in **52µs** and
passes in every warm run. This is environmental, not a code defect — the
notification is instant once the box breathes; CI runners (adequate RAM,
warm caches via setup-go) and contributor machines (16 GB+ typical) are
unaffected. Left at the original 5s deliberately: a raise would mask a
genuinely hung notification 6× longer on every machine to accommodate one
undersized host. Flagged for whoever owns internal/ssh if cold runs on
small hosts matter.

## Files changed

- `.githooks/images/go-tests/Dockerfile` (new) — derived image, dash+zsh, rationale
- `.githooks/containerized-tests.sh` — build the derived image before every run; comment block
- `.github/workflows/ci.yml` — `brew install dash` on the macOS backend job
- `internal/shellintegration/launcher_posix_test.go` — posix test folds into fail-loud
- `internal/shellintegration/inband_pty_test.go` — termios seed race fix (pre-Start seed); `//go:build linux` + rationale
- `frontend/src/style.css` — `.nocx-editor-chrome` stops distributing; `.nocx-editor-time` carries `margin-left: auto`
- `frontend/src/terminal-content.test.ts` — editor-chrome stylesheet contract check
- `frontend/src/editor.test.ts` — editor-chrome DOM-order intent check
- `README.md` — gates now provision the shells themselves

`internal/ssh` is byte-identical to HEAD (the one experimental edit was
reverted).

## Gates run

- Hook warm: exit 0 (0.9s idle; 25.2s after the tag edit re-ran shellintegration)
- Container full package: `ok 24.3s` — all five fail-loud tests PASS in the image
- Bare host: exactly the 5 fail-loud tests fail (posix + dash + 3 zsh), nothing else
- Inband flake: 15/15 subset + 5/5 full package after the fix (was ~2/6)
- Frontend: vitest 92/92 (2 new), tsc clean, eslint clean, prettier clean
- Go: gofumpt clean, go vet clean, golangci-lint clean, `GOOS=darwin`/`GOOS=linux` test-binary compiles
- ci.yml parses as valid YAML
