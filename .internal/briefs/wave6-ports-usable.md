# Wave 6 — the ports panel becomes usable

Two workers. Read the ground rules, then only your own section.

The owner reviewed the panel in the running app and raised four things. Three are
in section B, one is section A. The screenshots are not in the repo; the
descriptions below are what they showed.

## Ground rules (both workers)

- **No commit, no push, no branch.** **Do not touch `bd`.**
- Gates scoped to what you touch: `go build ./...`, `go vet`,
  `golangci-lint run`, `gofumpt -l`. From `frontend/`:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/ --max-warnings 0`,
  `npx prettier --check src/`, `npm run contracts:check`, `npm test -- --run`.
- Report by writing `.internal/reports/<your-bead>.md`. The coordinator reads the
  worktree.
- **A owns Go, B owns `frontend/src`.** The one thing you share is the target
  identity for a local tab — A defines it on the wire, B consumes it. A: put the
  exact shape in your report early.

---

## A — `nocx-wzc4.8`: the local machine listens too

Owner: *"почему для локального шелл мы не показываем порты? Давай показывать."*

A local tab renders "No active connection". That is wrong: the machine you are
sitting at listens on ports like any other, and the probe ladder that finds them
is not SSH-specific — only the transport is.

**The seam is in the wrong package.** `discovery.Connector` returns
`ssh.DiscoveryConn`, so `internal/discovery` names the transport it happened to
be built against first. Invert it: the exec seam becomes an interface in
`internal/discovery`, `ssh.DiscoveryConn` satisfies it (check — it may already,
structurally), and a local implementation runs the same ladder through
`exec.CommandContext`. Interface-first is not decoration here; it is what lets
the same five result states and the same three-valued process evidence describe
both cases without a second code path.

**Forwarding is the part that genuinely differs.** There is nothing to forward
from the machine you are already on, so a local row must not offer it. What
replaces it should be useful rather than disabled chrome — copying the address is
the obvious candidate; argue for whatever you pick. (Exposing a local port to a
remote host is `-R` and needs a chosen connection; that is a later bead, not this
one. Say so if you build toward it.)

**The wire needs a target identity for "this machine".** `ports.*` is keyed by
`profileId` and a local tab has no profile. Define it, put it in the schema, and
tell worker B the exact shape in your report before you finish — B is blocked on
that one fact and on nothing else.

Local probing has one difference worth thinking about: the process-owner column.
Non-root `ss` on the local box names only your own processes, exactly as it does
remotely, so `permission-denied` evidence must render the same way rather than
looking like a bug on the machine the user controls.

**Test first.** A local target lists the machine's listening ports; the ladder
degrades the same way when `ss` is absent; switching between a local tab and an
SSH tab re-scopes in **both** directions; the discovery package's own tests no
longer need an SSH server to exercise the ladder.

---

## B — `nocx-wzc4.9`: it has to be readable in a sidebar

Three defects the owner named, in one surface. The panel was designed against a
tab's width and now lives in a narrow sidebar; that is the root of two of them.

**1. There is no loading state.** Ports appear seconds after the view opens — the
settle delay plus a round trip — and until then the panel is blank, which reads
as broken rather than as working. First open shows that it is working. Later
refreshes must update **in place**: never blank a populated list to show a
spinner, because the list is what the user is watching.

**2. The rows do not fit.** In the screenshot the address — the row's primary
key, the thing the user came for — is truncated to `127.0....`, while the process
chip takes most of the width and wraps to three lines, making each row about
three times taller than it needs to be. The address must be fully readable at the
sidebar's default width; the process is secondary and must truncate before the
address does. The action is an icon, not a text button, and `Detected —
192.168.0.57` repeats what the tab already says in a column that has no room for
it.

**3. Retry and Pause should not be standing in the body.** Retry already exists
inside the failure states, which is where it belongs; the toolbar copy is a
second vocabulary for one concept. Pause is a real need — nobody wants a
background poll against a production host — but it belongs in the view's header
actions, which `SidebarViewDescriptor.actions` already provides. `last sample`
is muted micro-text, not a `Badge` chip.

**And answer the owner's actual question with a number.** They asked whether
sampling is heavy enough to justify a manual control at all. Measure one sample —
the exec channel open, the probe, the parse — against a real host, and put the
milliseconds in your report. If it is cheap, say so and let the cadence run
without asking; if it is not, say what makes it expensive. Do not answer this
one with an adjective.

**Read `frontend/src/ui/README.md` and list `frontend/src/ui/` first.** There is
no spinner or skeleton in the kit today. If you need one, it goes **into `ui/`**
with its CSS file, identity class, test and README row — not hand-rolled inside
the surface. That rule is what two epics were spent unwinding.

**Test first**, and assert what a user can do rather than what renders: the view
shows it is loading before the first sample lands, a populated list is not
blanked by a refresh, a failure state offers exactly one Retry, and pausing from
the header stops sampling.

Worker A is adding a local-target identity to `ports.*`. Until their report names
it, build against the SSH path and leave the local branch behind whatever they
define; do not invent a shape and hope it matches.
