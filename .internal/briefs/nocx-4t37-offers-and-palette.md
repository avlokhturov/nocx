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

## B — `nocx-4t37.2`: the offer

One primitive, two callers on day one — which is exactly when a thing belongs in
`ui/` rather than in a surface.

An **offer** is a small, dismissible, in-context prompt attached to a tab. It
appears at the moment its capability becomes relevant and never returns once
refused.

**Caller 1 — integrate this shell.** The tab is at a prompt and no OSC 133
markers have arrived, so integration is available and absent. This is precisely
what Warp does when you enter a server without warpify, and it is the owner's
reference.

**Caller 2 — save this as a connection.** A host was reached by a hand-typed
`ssh` and is neither a saved profile nor a `~/.ssh/config` alias.

### The two things that must not move

**The gate is unchanged.** Accepting runs the existing `shell.integrate` path
with its trusted A→B prompt window and its input lease. Consent changes
authorisation, not the identity of the foreground process — a user pressing
"Integrate" while `vim` is open must still not get 25 KB typed into their file.
The offer is about discovery; it is not a second permission model. If you find
yourself relaxing anything in `terminal-content.ts`'s gate, stop and report.

**Do not sniff the byte stream** (AD-6). The absence of markers is already known
to the input-state machine; read it there. If you cannot get what you need from
that seam, say so — do not reach for the stream.

### Refusal

Refusing hides the offer and it does not come back for that host in that
session. Decide deliberately whether refusal outlives the session and **write
down why** — an offer that returns every time is nagging, and one that never
returns is a feature the user has silently disabled forever. Either is
defensible; the choice must be argued.

### Test first

The epic's happy path, and it is yours: a user who has never read the docs lands
on an unintegrated shell, is offered integration, accepts, and gets blocks — one
automated check, end to end. `cmd/devharness` runs the real backend headless, so
there is no excuse about the harness. Plus: refusing hides it and it stays
hidden; the offer never appears on a shell that is already integrated.
