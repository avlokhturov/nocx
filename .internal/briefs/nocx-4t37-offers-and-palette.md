# Wave 7 — offers, and a palette that is not a host picker

Two workers. Ground rules first, then only your own section.

The owner's words, 2026-08-04: _"зачем нам ручная интеграция? Вот warp когда
входишь на сервер без warpify предлагает на него его поставить… В quick connect
оно зачем? Это странно."_

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

## A — `nocx-4t37.1`: a spotlight, and a quick connect that stays a list

**Rewritten after the owner's Raycast reference. If you were dispatched against
the "prefix-scoped modes" framing, this replaces it — prefixes are not the
model.**

The owner: _"quick connect должен превратиться в некий спотлайт, как у raycast,
там выбираешь что сделать и прямо в этом окне выбираешь сервер. А quick connect
по стрелке вниз должен остаться в текущем виде со списком серверов — это быстрый
способ подключиться."_

Two surfaces, two jobs, and the second one already exists.

### The chevron keeps its list, untouched

`tab-strip.tsx:143` and `:197` already call `onQuickConnect` from a
`ChevronDownIcon`. That stays exactly as it is: a list of servers, one keystroke
from connecting. Do not add search modes, type badges or commands to it. It is
the fast path and its speed comes from having one job.

### `Ctrl/Cmd+Shift+P` becomes the spotlight

One field, **mixed results**, and the row tells you what kind of thing it is
rather than making you remember a prefix — the Raycast shape:

```
conn|
Results
  Manage connections     Settings          Command
  production-api         deploy@10.0.0.4   Host
  Forward a port         ct-ziti-tunnel    Command
```

- The **type sits at the right of the row** (`Command`, `Host`, `Setting`), and
  the **subtitle names the context** — which host a command would act on, which
  user@host a row would connect to. Both are what let one list stay mixed
  without becoming a soup.
- A footer states the primary action for the highlighted row, with a secondary
  key for the rest. Copy Raycast's ergonomics here; they are well tuned.
- Prefixes may exist as an escape hatch for someone who wants to narrow to one
  kind. They are not how a normal user reaches anything.

### The part that matters most: choosing the server _without leaving the window_

A command that needs a target **drills in inside the same surface**. "Forward a
port" does not open a dialog and does not dead-end — the list becomes the list
of servers, then the list of ports, with the chosen steps shown as breadcrumbs
in the field. Backspace or Esc walks back out one step at a time; Esc at the top
closes.

This is the whole reason the owner pointed at Raycast, and it is the piece
neither the earlier plan nor the review had. Build the surface so a command can
declare "I need a host" (and later "I need a port", "I need a file") and get a
picker for free. Two commands with hand-rolled second steps is how this becomes
a mess.

### Keep shell commands out

The semantic command line is already the better palette for those: it has the
cwd, the host, shell grammar, history and command existence. Two command lines,
one of them stupider, is a worse product than one.

### Also worth taking from the reference

Provider failures must not be silently skipped. An unavailable `ssh -G` already
surfaces as a typed condition inside its own provider; the spotlight must
preserve that rather than rendering "no results" — a degraded source and an
empty source are different facts.

`QuickConnectProvider` is the wrong name for what this becomes and has already
bent the design toward "everything is somehow a connection". Rename the model
even if the visual shell is reused.

### Test what a user does

From the state a user starts in: the chord opens the spotlight; typing part of a
command name finds it; running a command that needs a host narrows **in place**
and reaches the client method with the host the user picked; Backspace returns
to the command list with the query intact; and the chevron still opens the plain
host list with no commands in it.

---

## B — `nocx-4t37.2`: a mode, not a nag

**This section was rewritten after the owner's second reading. If you were
dispatched against the earlier "offer" framing, this replaces it.**

The owner: _"мы не оставляем следов на сервере сейчас, то есть это ничего не
ломает на сервере. Может быть тогда просто сделать изменение режима (терминал
или nocxify или relay)?"_

That reframing is right, and the reason is worth stating because it is what
makes the design choice: **the choice is cheap and reversible, so it is a
control, not a decision.** An offer is the right shape for something with
consequences you cannot undo. Turning integration on writes nothing that
persists — the launcher hands bash an rc file through a pipe, zsh a transient
`ZDOTDIR` directory erased before any user code runs, and in-band delivery a
`mktemp` file removed by the same one-liner that sourced it. The legacy SFTP
installer that _would_ write rc gates is opt-in and wired nowhere at the
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
