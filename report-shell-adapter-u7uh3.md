# Shell adapter and bootstrap security — nocx-u7uh.3

## What shipped

The shell side of the authenticated lifecycle channel (ADR-0024, docs/lifecycle-protocol.md):

1. **The hooks** — `internal/shellintegration/scripts/nocx.bash` (+~250 lines) and `nocx.zsh` (+~230): hello/accept handshake (bounded, fail-open), start on preexec, complete with exit status + fence nonce, the fence written to the pty after the command's output as OSC `1337;NOCX_FENCE;<64hex>`, prompt_ready at the prompt, domain_closed on exit, a strictly-increasing per-domain sequence and the bearer capability on every frame, and the prompt overlay gated on a live channel (ADR-0024 decision 9 — a shell without an accept keeps a visible native prompt). The envelope wire names follow the protocol doc (`v/lane/dom/epoch/seq/cap/evt`); the shell sends start and complete WITHOUT attempt ids (kernel resolves the single open attempt — decision A, already implemented in the kernel). The POSIX tier gets an honest note: the channel is not implementable in POSIX sh (no preexec/precmd, forked PS1 expansion cannot carry state, no bounded binary read); it stays conventional, per decision 4.
2. **Capability delivery** — the capability (64 hex chars) is substituted into script text (`@CAP@` in the launcher rcfiles; `__nocx_cap` set by the in-band wrapper from the first streamed line), never the environment. Non-negotiables proven by exec tests: absent from `env` and `/proc/<pid>/environ` of the shell, a live child, and a grandchild; held in a non-exported variable; a well-formed frame without the capability produces no accepted event.
3. **The in-band installer** (`inband.go`) — the wrapper captures the FIRST raw-mode stream line into `__nocx_cap` before anything is staged; the staged file stays capability-free, and the payload stays capability-free (it crosses the renderer, ADR-0024 decision 7). The dispatcher substitutes the channel config (`@LANE@/@DOM@/@EPOCH@/@PORT@`, names only) via `InBandBootstrap(sessionID, ch *ChannelConfig)`. Backward-compatible: a first line that is not 64-hex is treated as the first payload line (legacy flow).
4. **The launcher** (`launcher*.go`, `launch.go`) — the argv tier rcfiles now SOURCE the installed generation files instead of embedding the scripts (the coordinator's option 1): the full remote launcher dropped from **171,678 bytes (over the 120 KiB cap and over Linux's 128 KiB per-arg limit) to 101,359 bytes**, a 29.7 KB margin under MAX_ARG_STRLEN (the 8 KB margin test passes). The transient-integrated middle tier is deleted per the coordinator: a failed publish lands in a clean visible native prompt (source errors suppressed), and the two publish-failure tests were rewritten to assert exactly that. `LaunchOptions` gains Capability/Lane/Domain/Epoch/LifecycleFD/LifecyclePort; the env block exports the non-secret config; `@CAP@` is substituted into the rcfile text.
5. **`internal/transport/ws_shell.go`** (granted scope) — `InBandBootstrapper` takes the channel config; the result copy (`shellIntegrateResultFromPlan`) is field-by-field and never copies `InBandPlan.Capability`; the new test proves over the real socket that a capability-carrying plan leaks nothing into the JSON-RPC result.

## Verification (all green)

- `go build ./internal/shellintegration/...` and `./internal/transport/...`
- `go test ./internal/shellintegration/...` — full suite, 51.6 s
- `go test -race ./internal/shellintegration/...` — 52.9 s
- `go test -race ./internal/transport/...`
- `golangci-lint run ./internal/shellintegration/... ./internal/transport/...` — clean (fixed G115/G204/shadow/errcheck findings)
- `gofumpt -l` on both packages — clean
- New tests (real shells on real ptys against a fake kernel adapter that validates cap+seq and answers accept):
  - `TestBashChannel_HandshakeAndLifecycle` — hello(seq 1, shell kind) → start(command) → complete(exit 0, 64-hex fence) → prompt_ready; strict sequence; the fence OSC reaches the pty AFTER the command output, exactly once.
  - `TestBashChannel_CapabilityNeverInAnyEnvironment` — `env`, `/proc/<pid>/environ` of the shell AND a live child; `SHELL_VAR_HAS_CAP=yes` (non-exported).
  - `TestBashChannel_ChildProcessCannotReadTheCapability` — child/grandchild `env` carries nothing.
  - `TestBashChannel_ChildFrameWithoutCapabilityProducesNoAcceptedEvent` — a second connection writes a well-formed wrong-cap frame: rejected, no accepted event, the live domain's next command still completes.
  - `TestBashChannel_NoTransportFailsOpen` — refused transport → immediate conventional terminal.
  - `TestBashChannel_LocalDescriptorTransport` — socketpair via ExtraFiles (fd 3), the local shape.
  - `TestInBand_AuthenticatedChannelFromStreamedCapability` — wrapper typed, READY, cap line + payload + terminator streamed, the sourced hooks handshake with the STREAMED cap; payload asserted capability-free.
  - `TestZshChannel_HandshakeAndLifecycle`.
  - `TestShellIntegrate_ResultNeverCarriesTheCapability` (over the real socket) + `TestShellIntegrateResultFromPlan_DropsCapability`.
  - Marker-only tests updated for decision 9 (no suppression without a live channel; the visible prompt keeps the render-only B partition marker).
- The in-band real-shell pty suite exposed and fixed a real bug: the wrapper's `[!0-9a-f]` class triggered zsh's `!0` history expansion at the interactive prompt (`zsh: event not found: 0`) — switched to `[^0-9a-f]`, verified under bash/zsh/dash.

## The capability-in-a-named-file question, resolved

- **In-band path: the capability never enters any named file.** The wrapper captures it from the raw-mode stream into a non-exported variable before anything is staged; the staged file, the payload, and the JSON-RPC result are all capability-free. Same-user bootstrap inspection has nothing to inspect.
- **Launch paths: the capability enters the transient rcfile by construction.** The ADR's own mechanism is "substituted into the integration script text", and the argv rcfiles are per-session text; the cap lands in the mktemp rcfile (mode 600, unlinked at source) exactly like the old `@SID@`. A same-user process can read that transient file during the source window. I am NOT relying on the mode bits: this is the "inspect the integration bootstrap as the same user" exclusion in ADR-0024 decision 10, stated plainly. The coordinator should amend decision 10 to name the transient bootstrap window explicitly (and the installed generation files and the carrier stay capability-free).

## What I could not verify / remaining wiring (numbers not adjectives)

- **bash 3.2 (macOS)**: I avoided the 3.2-unsafe constructs (`exec {var}<>` is 4.1+, `\xHH` in `$'...'`; the /dev/tcp connect uses a fixed high fd 200) but only ran bash 5.3. The macOS CI runner must confirm sourcing under 3.2.
- **The Go transport adapter's wire type**: the kernel's `Envelope` struct has NO json tags (protocol.go:49-57); the doc pins `v/lane/dom/epoch/seq/cap/evt`. If the adapter unmarshals the kernel struct directly, every frame fails the version check. Flagged in escalation msg_11eecf30322e... (this was escalation about size; the tag gap is in the escalation trail) — the adapter must use a tagged wire type or the kernel struct must gain tags. **This is the highest-risk open item for the integration.**
- **In-band backend delivery**: the transport worker must (a) mint the domain at integrate time, (b) pass `ChannelConfig` into `InBandBootstrap` (the seam interface now accepts it), (c) after READY, write cap line + payload + terminator into the pty (the seam exists: `session.Session.EnqueueWrite`). The handler currently passes nil — in-band integration stays conventional until that wiring lands. The renderer's flow changes to "type the wrapper only".
- **The launch carrier** stays capability-free; a per-epoch handoff for carrier-launched sessions was attempted (argv pass-through) and abandoned because interactive shells treat an argv file as a script. Remaining decision for the transport worker: how the carrier delivers the cap (transient-rcfile substitution at runtime, or argv with the excluded-boundary note).
- **Fence encoding**: the renderer must parse `ESC ] 1337 ; NOCX_FENCE ; <64hex> BEL` from the pty stream and freeze the block only when both the authenticated complete and the matching fence have arrived (doc §8 carve-out). The frontend worker needs this contract.
- **Deferred, honest**: refresh_request/snapshot answering (desync recovery) is not implemented in the hooks — a Desynchronized domain cannot yet be restored by the shell side; nested-environment suspend/activate is not implemented. Both are documented in the scripts.
