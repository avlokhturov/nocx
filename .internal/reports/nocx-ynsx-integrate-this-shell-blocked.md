# nocx-ynsx — Integrate this shell: handoff, blocked on a termios/echo conflict

**Status: BLOCKED — coordinator decision required.** `worker_done` sent with `--outcome failed`.
Escalations sent: `msg_c45e1d3f6f29` (escalation), `ask` thread `ee21ca7d5fad` (timed out after 600 s, no reply).

## What was built (backend only — transport + frontend NOT started)

`internal/shellintegration/inband.go` (+ `inband_test.go`, `inband_pty_test.go`):

- `Impl.InBandBootstrap(sessionID)` returns `InBandPlan{Wrapper, Payload, Terminator}` (spec §4.4 in-band fallback).
- **Wrapper** (one line, typed at the trusted prompt): `saved=$(stty -g); NOCX_IB_SRC=$(mktemp "${TMPDIR:-/tmp}/nocx-ib.XXXXXX" ...) && stty raw && printf '\033]1337;NOCX_IB_READY\a' && sed -n '/^NOCX_IB_EOF$/q;p' > "$NOCX_IB_SRC"; stty "$saved"; if grep -qx '# nocx-ib-complete' ...; then . "$NOCX_IB_SRC"; fi; rm -f ...`.
  - READY OSC emitted only after `stty raw` → the frontend streams the payload only when raw mode is provably on (no readline merge, no MAX_CANON).
  - Delivery ends at a delimiter **line** (`NOCX_IB_EOF`), not a byte count → a truncated/cancelled stream still reaches `stty "$saved"`.
  - Completion marker `# nocx-ib-complete` is the payload's last line; grep gates the source.
  - `stty "$saved"` restore runs on every path (success, cancel, failure). Never `stty sane`.
- **Payload**: POSIX-sh dispatcher (detects `$ZSH_VERSION`/`$BASH_VERSION`/else posix from inside the shell, sed-extracts the right hook script from the staged file, sources it with `NOCX_SHELL_INTEGRATION=1 NOCX_PROMPT_MODE=marker-only NOCX_SESSION_ID='<sid>'`) + the three embedded scripts framed by `NOCX_IB_{BASH,ZSH,POSIX}_{START,END}` lines. Stray bytes after the payload land outside every extraction range → the sourced script is always byte-identical.
- Session id validated as 32-hex (embedded single-quoted); fail-closed on anything else.

## Fence verification (REAL pty tests — bash, zsh, dash; the harness uses one pump goroutine as the only reader; per-read goroutines were abandoned after they polluted observations)

| Fence | Result |
|---|---|
| Exact prior termios restored after success | **VERIFIED** (`stty -g` capture → `stty "$saved"` restore; bit-exact, incl. Cc array) |
| Exact termios restored on cancel (terminator sent, no payload) | **VERIFIED** — shell returns to a visible native prompt, no integration markers |
| Fail-open absolute (no mktemp on PATH) | **VERIFIED** — termios untouched, visible prompt, shell usable |
| Integration actually works end-to-end | **VERIFIED** — bash emits the 636 hello + A/B; zsh and dash emit A; echo works after |
| Payload works for bash, zsh, POSIX sh (dispatcher) | **VERIFIED** |
| **The shell at the prompt is never shown the payload bytes** | **FAILS — the conflict** |

## The conflict (measured, not argued)

GNU coreutils `stty raw` on this machine (NixOS) **leaves ECHO enabled**. Measured:

- `stty -a` while raw: `-isig -icanon iexten echo echoe echok ... echoctl echoke` (echo flags on).
- Termios at READY time (TCGETS on the master): `Lflag 0x8A38` — ECHO set, ICANON/ISIG clear.
- A probe byte written after READY is echoed back; the full 25 KB payload appears in the transcript (consumed correctly by sed — integration works — but **visible on the user's terminal**, i.e. inside the frozen block).
- POSIX `raw` includes `-echo`; this coreutils build deliberately leaves echo untouched, so the brief's premise ("raw mode ⇒ silent delivery") is platform-false.

The only clean fix is `stty raw -echo` inside the transient delivery window, restored by the exact `stty "$saved"` **before any user code runs** (no leak to child processes — this is NOT ADR-0004:24's rejected persistent editor echo-suppression). The brief's fence list names `stty -echo` among the rejected mechanisms and says "stop and escalate" if needed — **I escalated (twice); no reply within 10+ minutes; per instructions I did not add `-echo` and hand the decision back.**

Also identified (NOT fixed, per handoff guidance): the dispatcher falls through into the framed sections when sourced — `NOCX_IB_BASH_START` executes as a command after the dispatcher's cleanup. Harmless today (the section scripts' own `__nocx_loaded` guard returns from the outer source) but fragile; needs a top-level `return 0 2>/dev/null || exit 0` after `unset`.

## Test state (evidence preserved, not papered over)

- `internal/shellintegration` package: **one intentionally failing test** — `TestInBandBootstrap_RealBashIntegratesAndRestores`, failing only on the three payload-leak assertions. This is the conflict evidence; it stays red.
- All other package tests pass (unit: wrapper/payload framing, marker/terminator collisions, sid validation, no NUL; pty: cancel, fail-open, zsh, dash; plus the pre-existing launcher/script suites).
- `go build ./...` OK; `go vet` clean for shellintegration/transport/app.

## What's left once the decision lands

1. Wrapper: add `-echo` (or the coordinator's alternative) → the leak assertions go green.
2. Dispatcher: top-level return after cleanup (fall-through fix).
3. Transport RPC `shell.integrate` (`internal/transport/ws_shell.go` + dispatch case in `ws.go` + `WSServer` field/option) — needs the coordinator's all-clear for `ws.go`/`app.go` per the brief.
4. `contracts/shell.integrate.schema.json` + generated frontend type + over-the-wire conformance test.
5. Frontend: gate on `PROMPT_READY && trusted && owned` (input-state `owned` getter), the input lease (editor hidden, draft byte-for-byte, Esc cancel via terminator/Ctrl-C), OSC 1337 ready-wait in the renderer, `integrateShell()` on TerminalContent, palette item + keybinding in main.tsx, tests.

## Files modified

- `internal/shellintegration/inband.go` (new)
- `internal/shellintegration/inband_test.go` (new)
- `internal/shellintegration/inband_pty_test.go` (new)
