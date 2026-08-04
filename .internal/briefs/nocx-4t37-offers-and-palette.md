# Wave 7 — offers, and a palette that is not a host picker

Two workers. Ground rules first, then only your own section.

The owner's words, 2026-08-04: *"зачем нам ручная интеграция? Вот warp когда
входишь на сервер без warpify предлагает на него его поставить… В quick connect
оно зачем? Это странно."*

**The principle both sections serve: a palette answers what you know you want;
an offer answers what you do not know exists.** Integration is the second kind —
nobody searches a list for a feature they have never heard of — so putting it in
quick connect made it discoverable only to people who already knew. That is the
whole defect.

## Ground rules (both)

- **No commit, no push, no branch.** **Do not touch `bd`.**
- Frontend gates: `./node_modules/.bin/tsc --noEmit`,
  `npx eslint src/ --max-warnings 0`, `npx prettier --check src/`,
  `npm test -- --run`, `npm run lint`. Plus `go build ./...` if you touch Go.
- **Read `frontend/src/ui/README.md` and list `frontend/src/ui/` before building
  any control.** A surface places a kit component and never repaints it.
- One trap already paid for, in both your areas: **Solid wraps every prop
  expression in a getter**, so `pause={createThing(...)}` written inline builds a
  fresh instance on every read. Create controllers once, outside the JSX.
- Report to `.internal/reports/<bead>.md`. The coordinator reads the worktree.
- **A owns the palette surface, B owns the offer primitive and its two callers.**
  You will both want `main.tsx`: keep each edit to your own wiring and say in
  your report exactly which lines you touched.

---

## A — `nocx-4t37.1`: one palette, prefix-scoped

`Ctrl/Cmd+Shift+P` opens **quick connect** (`main.tsx:361`), which carries
"Local shell", "New connection" and until recently "Integrate this shell" and
"Ports" beside SSH hosts and aliases. It is neither a host picker nor a command
palette, and the owner noticed.

Build one surface with two modes, the model people already carry from VS Code:
**a `>` prefix means commands, no prefix means hosts.** One implementation, one
chord, and the mode is visible in the input rather than in the user's head.

- `Ctrl/Cmd+Shift+P` opens it in command mode with the prefix already present.
  Clearing the prefix returns to hosts **in the same surface** — no second
  dialog, no second component.
- Every item in `ActionsQuickConnectProvider` becomes a command and stops
  appearing in host results.
- The host side keeps everything it earned: ad-hoc `user@host` still connects, a
  saved profile still outranks the alias it covers, and a degraded `ssh -G`
  still surfaces the condition instead of an empty list.

Do not invent a second keybinding for hosts unless you can argue it; one entry
point with a visible mode is the point.

**Test what a user does**, not what renders: from the state a user starts in,
the chord opens the palette, a command is reachable and runs, and clearing the
prefix reaches a host.

---

## B — `nocx-4t37.2`: a mode, not a nag

**This section was rewritten after the owner's second reading. If you were
dispatched against the earlier "offer" framing, this replaces it.**

The owner: *"мы не оставляем следов на сервере сейчас, то есть это ничего не
ломает на сервере. Может быть тогда просто сделать изменение режима (терминал
или nocxify или relay)?"*

That reframing is right, and the reason is worth stating because it is what
makes the design choice: **the choice is cheap and reversible, so it is a
control, not a decision.** An offer is the right shape for something with
consequences you cannot undo. Turning integration on writes nothing that
persists — the launcher hands bash an rc file through a pipe, zsh a transient
`ZDOTDIR` directory erased before any user code runs, and in-band delivery a
`mktemp` file removed by the same one-liner that sourced it. The legacy SFTP
installer that *would* write rc gates is opt-in and wired nowhere at the
composition root (`ssh_real.go:549`, `internal/app/app.go`). So there is nothing
to warn about and nothing to regret.

Verify those four claims yourself before you build on them — this brief has
been wrong before by trusting what the conversation remembered.

### The axis

**terminal → nocxify → relay**, in ascending order of how much of ours runs on
the far host: nothing at all; a shell integration that leaves no trace; and the
`nocx-if6` phase-B relay, which is a real binary on a real disk and is the one
that will genuinely deserve a consent conversation.

`relay` goes in the model **now and is not selectable yet** — the same move the
tunnel model made by carrying all three directions before `-R` and `-D` existed
(`nocx-6nh6`). A third value added later becomes a flag threaded through a
switch; a third value present from the start is a mode with no implementation.

### It already half-exists — reconcile, do not duplicate

`nocx-p0ug` put `ShellIntegrationMode` (`auto | ask | off`) on the profile and
threaded it through the cascade with provenance. That is the same axis at
connection scope, and `ask` is exactly where an offer belongs — as a mode the
user chose, not as a nag we invented. Make the tab-level control the live view
of that setting: the profile decides the default, the tab can override it for
this session, and the two must never disagree on screen.

Read that commit before designing your own path, and if the existing enum is the
wrong shape for three modes, say so with an argument rather than adding a second
concept beside it.

### Discovery, which was the real defect

Putting integration in the palette made it findable only by people who already
knew it existed. A **visible mode indicator fixes that better than an offer
does**: it is always there, it states what is currently true ("terminal"), and
it invites a click instead of interrupting. That is the whole reason to prefer
this shape — say in your report whether what you built actually achieves it, for
a user who has read nothing.

### The two things that must not move

**The gate is unchanged.** Switching a live tab to `nocxify` runs the existing
`shell.integrate` path with its trusted A→B prompt window and its input lease.
Consent changes authorisation, not the identity of the foreground process — a
user flipping the mode while `vim` is open must still not get 25 KB typed into
their file. A mode control is a nicer way to ask; it is not a second permission
model. If you find yourself relaxing anything in `terminal-content.ts`'s gate,
stop and report.

**Do not sniff the byte stream** (AD-6). Whether markers have arrived is already
known to the input-state machine; read it there. If that seam cannot tell you
what you need, say so — do not reach for the stream.

### Also: save this as a connection

A host reached by a hand-typed `ssh` that is neither a saved profile nor a
`~/.ssh/config` alias should be one action from being saved. Whether that is a
second control beside the mode, or something else, is yours to argue — but it is
the same failure if it is only in a palette.

### Test first

The epic's happy path, and it is yours: a user who has never read the docs lands
on a plain SSH shell, sees the mode, switches it to nocxify, and gets blocks —
one automated check, end to end. `cmd/devharness` runs the real backend
headless, so there is no excuse about the harness. Plus: the mode a profile sets
is the mode the tab starts in; switching back to `terminal` leaves a usable
shell; and `relay` is present in the model and not offered as a choice.
