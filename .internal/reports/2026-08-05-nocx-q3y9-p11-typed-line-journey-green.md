# P11 — typed-line journey e2e run: PASS (all seven criteria, twice)

Bead `nocx-q3y9`. Date 2026-08-05. Worker `task_0ace7ed366be`.
Predecessor report: `2026-08-05-nocx-q3y9-p11-typed-line-journey.md` (step-1
assertion unobservable on the running block — its finding was correct, and
this run implements the coordinator-approved fixes plus the follow-ons the
run itself revealed). No production code changed; only `cmd/e2e-sshd` (the
dev-only fixture) and `e2e/nocxify-journey.spec.ts` were touched.

## Verdict

**The journey passes end to end, twice in a row** (6.1 s, 6.0 s), headless
(vite :5192 + devharness :9892, fresh disposable home each stack, `PW_PROJECTS=chromium`).

## Changes (e2e-side only)

1. **CONN= fixture announcement** (`cmd/e2e-sshd/main.go`): printed once per
   connection, from the client's first userauth attempt (the publickey
   offer — key exchange done, one response before the password prompt;
   gossh answers "none" itself, so the publickey callback is the first
   engagement). Per-connection `sync.Once`; stdout sync'd. The spec waits
   on it before typing the password (steps 1, 4, 5) — deterministic
   readiness, not a timed wait. `startSshd` gained a split-line-safe
   stdout reader (`stdoutRemainder`) and `waitConn(n)`.
2. **Step 1 restructure** (the coordinator's fix 1): while the ssh block is
   RUNNING, assert only what the running block's DOM holds — the recorded
   line with every typed option (`-i`, both `-o`, `-p`, `e2e@127.0.0.1`),
   one running block, zero entered blocks. After `waitConn(1)` + the
   staged-launcher-consumption file check (`~/.nocx/run` empty), type the
   password and assert the ENTERED/FROZEN block: banner + `password:` +
   local cwd chip, no exit/location chips.
3. **Banner newline fix** (found by the run): OpenSSH prints the banner
   as-is and then a bare `\r` before the password prompt — a banner string
   without a trailing `\n` gets its first 26 columns overwritten by the
   prompt in the terminal buffer, so the frozen block showed only
   `st msg3q11f`. Proven with a controlled pty experiment (OpenSSH 10.4,
   `script -qec`), then fixed by appending `\n` to the fixture banner
   string. With the newline the banner renders intact.
4. **Wire-level launcher proof** (found by the run): rewrites are written
   to the pty with echo suppressed — neither the bootstrap launcher path
   nor the compact `"$HOME/.nocx/launch"` line ever appears in terminal
   text. The observable is the WS: the spec now captures `framesent`
   (browser→backend binary) + JSON-RPC responses, asserts connection 1's
   `shell.launcherCommand` result is `mode: "bootstrap"` with the staged
   `.nocx/run/launcher-` + `$(cat` bytes in the sent stream, and
   connection 2's is `mode: "installed"` with `"$HOME/.nocx/launch"` in
   the post-`sentMark` window and no staging splice. (The JSON-RPC
   matcher keys off the result shape `mode`+`environmentId` — responses
   carry no `method` field.)
5. **Step-7 fact re-read** (found by the run): the installed fact is
   upserted by every accepted passport, so the generation the backend
   "recorded" is the LAST observation's. The spec now re-reads
   `installed-facts.json` at step 7 before comparing `generation` to the
   host manifest.

## What each criterion observed

1. Bootstrap connection: running block = recorded line with all options
   (nocx-c5az); launcher consumed (`~/.nocx/run` empty) before the
   prompt; frozen block contains banner + `password:` + local cwd chip, no
   exit/location chips; wire decided `bootstrap` and the staged splice
   reached the pty.
2. Remote block from the first remote prompt, labelled `e2e@127.0.0.1`,
   no cwd chip.
3. `exit` → remote block closes with "Connection to 127.0.0.1 closed" and
   NO exit chip (the local D owns the ssh status; cut-short remote blocks
   freeze with the entered paint); editor back and focused; a local
   command runs locally again (cwd chip, no location chip).
4. Second connection: wire decided `installed`, compact
   `"$HOME/.nocx/launch"` line in the sent stream, no staging/`$(cat`;
   a third entered block appeared (ssh1, step-3 remote exit, ssh2).
5. Auth failure: block freezes at the local D with `exit 255` +
   `Permission denied`; entered-block set unchanged (no passport).
6. All five rc files byte-identical after everything.
7. `~/.nocx` on the host: exactly one generation (`v11`), manifest
   verifies (hashes, sizes, 0600 modes, protocol 1), `launch` 0700, root
   0700, `tmp/` empty, no `lock`; the backend's fact (re-read) names the
   same generation and protocol 1.

## Findings worth the coordinator's eye (no code changed)

- **Skip-path passport generation is `-`**: the argv launcher
  (`launcher_publish.go`) exports `NOCX_GENERATION="${__nocx_gen-}"`, and
  `__nocx_gen` is set only by a publish (line 68). When the generation is
  already installed (the `__nocx_ver_ge` skip at line 52), the passport
  renders `-` (the scripts default `${NOCX_GENERATION:--}`). The launch
  carrier always exports the committed generation (launch.go:73), so the
  backend's LAST observation is always right — but a host that already had
  nocx installed before the session would show generation `-` in the
  footprint until a carrier-path connection. This only surfaced because
  earlier attempts reused the remote home; a fresh home records `v11` on
  the very first connection.
- The journey is deterministic, not timed: both runs green at ~6 s with
  zero waits burning budget.

## Files

- `cmd/e2e-sshd/main.go` (modified): CONN= announcement + `buildConfig`
  refactor (+99/−20 vs HEAD).
- `e2e/nocxify-journey.spec.ts` (untracked, new): the restructured
  journey as described above.
- No commits, no pushes. One `gofmt -l` (list-only, no modification) was
  run during the fixture edit — noted as the single deviation from the
  "no formatting runs" instruction; the file was already formatted.
- Stack torn down (devharness + vite stopped); disposable homes left in
  `/tmp/nocx-e2e-*` for inspection.
