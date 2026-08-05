# Wave 5 briefs

Four independent tasks. Each worker reads only its own section, plus the ground
rules, which are the same for all four.

## Ground rules (all workers)

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** Run, scoped to what you touch: `go build ./...`,
  `go vet`, `golangci-lint run`, `gofumpt -l` — `gofmt` alone has been caught at
  the merge gate twice this epic. From `frontend/`, if you touch it:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/ --max-warnings 0`,
  `npx prettier --check src/`, `npm run contracts:check`, `npm test -- --run`.
- **Stay inside your files.** Three other workers are live; the file lists below
  are disjoint on purpose. If you need something outside yours, say so in your
  report rather than taking it.
- Numbers, not adjectives. Heartbeat each phase. Report with
  `orca orchestration send`.

---

## A — `nocx-wzc4.5` + `nocx-pu4.1`: the composition root finishes two jobs

**Yours:** `internal/app/app.go`, `internal/transport/ws.go` and the open
handler, `internal/connectfwd/` if the seam needs a signature change.

Two things are built, wired to nothing, and both are the shape `AGENTS.md`
rule 2 names.

**`connectfwd.Replay`** opens a profile's stored forwards. `deadcode` names it
directly. The profile carries the list, the editor saves it, and connecting
forwards nothing. The seam is the transport's open handler, beside where
discovery comes up.

**`ssh.WithShell`** pins the far shell and beats auto-detection. Nothing calls
it, so a user who knows their host runs zsh cannot say so, and where detection is
wrong they have no override.

Prove both: `deadcode -filter 'nocx/internal/connectfwd' ./...` empty, output
verbatim in your report; and a grep for `WithShell(` finding a production caller.

The tests assert through the app, not by calling `Replay` or `WithShell`
directly — that is the difference between "the function works" and "connecting
does it". A profile with two stored forwards opens both; a busy local port
reports against its own row and leaves the session usable; one row's failure
never stops another's; a pinned shell reaches the launcher and an unpinned one
still sends `ShellAuto`.

---

## B — `nocx-wzc4.6`: the panel must show the bind caveat

**Yours:** `frontend/src/ports.tsx`, `frontend/src/ports.test.tsx`,
`frontend/src/styles/surfaces/ports.css`, and `frontend/src/ui/` if the kit is
genuinely missing a variant.

`Tunnel.Caveat()` crosses the wire as `caveat` on every forward record and
`ports.tsx` does not mention it. A `-R` forward whose bind address sshd silently
replaced renders identically to one that bound what was asked — and that is the
whole failure the field exists for: the user copies a URL that only works on the
server.

Render it as a caution on the row. The wording must say the bind address was
requested and is **not verified**; it must never say "failed", because nothing
failed — the forward is running. An empty caveat renders no extra chrome.

**Read `frontend/src/ui/README.md` and list `frontend/src/ui/` before building a
control.** A surface may place a kit component and may never repaint it. Two
epics were spent unwinding hand-rolled controls inside surfaces.

---

## C — `nocx-pu4.3`: in-band integration hangs on busybox

**Yours:** `internal/shellintegration/inband.go`, `inband_pty_test.go`,
`inband_test.go`.

```
nix shell nixpkgs#busybox --command go test ./internal/shellintegration/... \
  -count=1 -run TestInBandBootstrap_Real
```

All four real-shell tests time out at 15s. The transcript reaches
`\033]1337;NOCX_IB_READY` and then nothing — the payload is consumed and the
markers never arrive. Without busybox on PATH the same tests pass.

The wrapper depends on `stty`, `mktemp`, `sed`, `grep` and `printf`, and
busybox's applets differ from GNU coreutils'. Leading suspects are
`sed -n '/^NOCX_IB_EOF$/q;p'` and the `stty -g` string round trip — **but find
out which, and say so with the evidence.** A fix that makes the test pass without
naming the cause is a fix we cannot trust on the next applet.

This is not a test-environment detail. Integrating a shell you reached by hand is
exactly what you do after `ssh`-ing into an Alpine container, and the POSIX
minimal tier was built and measured against busybox ash because those hosts
matter.

Second, and separate: there must be a case where an applet is genuinely missing
and the wrapper **fails open to a usable shell rather than hanging**. A 15-second
freeze on somebody's terminal is the worst outcome available here.

---

## D — `nocx-gd84` + `nocx-a44m`: two green suites that prove less than they look

**Yours:** `internal/shellintegration/launcher_test.go` and any test-harness file
it needs; `frontend/src/editor.test.ts`, `frontend/src/terminal-content.test.ts`,
the CSS fixture harness, and the repo's test documentation.

**`nocx-gd84`:** twelve launcher tests pass and three run on a bare dev box.
`TestBashLauncher_RunsUnderDash` and all three `TestZshLauncher_*` skip when dash
and zsh are absent — and the zsh transient-`ZDOTDIR` path is the riskiest code in
the epic, because it creates a directory on somebody else's machine and must
erase it before any user code runs. `AGENTS.md` is explicit that a skipped test
reporting success is the failure the testing rules exist to prevent.

The fix is a choice, not obvious: fail rather than skip, or make the harness
provide the shells. Either way **the repo must name the command CI runs**, in a
place somebody will find it. Argue your choice in the report.

**`nocx-a44m`:** the cwd chip parked in the centre of an SSH block header —
`justify-content: space-between`, correct for two children and wrong for three.
Already fixed in `30014e3`; what is missing is a check that would have caught it.
jsdom computes no layout, so a unit test cannot see it. Decide where the check
belongs — a CSS fixture assertion, a Playwright check, or a rule that catches the
class of bug rather than this instance — and say why the others were rejected.
A check that only asserts the current rule's text is worth less than one that
asserts the intent: cwd left, duration and exit right.
