# Workspaces as a surface: the tab is the unit, the workspace is the fence

- **Date:** 2026-08-15
- **Beads:** `nocx-5azf0` (this session), `nocx-isoph` (the workspace epic), `nocx-ebl4`
  (epic A, the foundation slice), `nocx-jv3q` / `.1` / `.2` (the tab-strip epic),
  `nocx-wyp3p` (the backend calls a connection a tab — filed here), `nocx-49d4` (the
  ledger's missing workspace owner), `nocx-kewo` (the design this amends)
- **Amends:**
  `.internal/specs/2026-08-15-workspaces-lineage-and-orchestration-design.md` — **D2 and
  D3 are withdrawn, D9 loses its mechanism, §8 item 3 changes** (see §7)
- **Status:** design, first draft, settled point by point with the owner in one session.
  Every decision below is the owner's, and where I recommended something and was
  overruled the reason is recorded rather than dropped.

## 1. In one sentence

A **workspace** is a user-created group of tabs — nothing else. It binds no host, no
directory and no repository; it is flat, never nested; a tab is always in exactly one;
and it exists only while it holds at least one tab. Its purpose is twofold and both
halves are the same fact: it is how you organise your work, and it is the fence a
session cannot reach across.

**What a user can do that they cannot today:** group the tabs of one task together,
switch between such groups without losing the rest, and — once the agent epics land —
know that an agent in one group cannot address, spawn into, observe or type into
anything outside it.

## 2. What this design crosses, and what those documents already decided

| Boundary                          | What it already decides                                                                                                                                                                                        | What this design does about it                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ADR-0020 §5**                   | The workspace is **not** the enforcement object. "Workspace as the security principal" is rejected for three reasons: membership is draggable, environments are shared, organisation must not confer authority | **Honoured, and this is the subtle one.** The rejection is of the workspace as a **source** of authority. §5 here makes it a **ceiling**: membership can only subtract. A ceiling is not a grant, so all three objections survive untouched — see §5.1 |
| **AD-7**, session model           | Session-id is server-authoritative; the backend `session` module is the authoritative registry                                                                                                                 | **Extended, and this is load-bearing.** `workspaceId` is a fact on the **session, in the backend** — not a renderer grouping. §5.2                                                                                                                     |
| **AD-8**, one owner per behaviour | Variation lives in the interface, never in a fork inside an implementation                                                                                                                                     | Binds `nocx-wyp3p`: `tabID(wconn)` names a connection a tab, so two surfaces own one word                                                                                                                                                              |
| **D6** of the prior design        | A parent's death never closes its children; only an explicit human act may, and closing a tab with live descendants **asks** rather than decides                                                               | **Reused exactly.** §4.3's confirmation dialog is that rule applied to a container, which is why the dialog must enumerate what is live rather than ask "delete workspace?"                                                                            |
| **D10** of the prior design       | The git panel follows the **active tab**; the session is the sole owner of "which repository"                                                                                                                  | **Reused, and it is what dissolves the worktree problem** (§6). The repo comes from the tab you are looking at, so no project concept is needed                                                                                                        |
| **`nocx-jv3q.1`**                 | Groups exist only in the vertical strip; the horizontal one stays a flat row. Grouping must not change what `Cmd+1..9` selects                                                                                 | **First half honoured, second half deliberately overridden** — §4.2 and §7                                                                                                                                                                             |
| **`nocx-jv3q.2`**                 | Drag **between** lineage groups was removed 2026-08-01: a group is a fact about a session, not a position                                                                                                      | **Survives.** Dragging between **workspaces** is a different act and is allowed; dragging between lineage groups stays refused                                                                                                                         |
| **`origin/feat/sandbox-v2`**      | A per-tab Landlock/Seatbelt policy, owned by the backend, which **refuses to launch** what it cannot enforce and never degrades to an unsandboxed shell. **Not on `main`**                                     | Deliberately **not** the workspace boundary — §5.3                                                                                                                                                                                                     |
| **`nocx-49d4`**                   | The ledger schema already demands a workspace owner per session; `workspace:default` exists as a real row, and the migration must re-parent marked rows **before** dropping it (`ON DELETE CASCADE`)           | **This design is the owner it was waiting for.** §3's "always in a workspace" is the same invariant the schema already holds                                                                                                                           |

## 3. The model

```
Workspace          user-created, flat, never nested
  id, name, colour
  exists ⟺ it holds ≥ 1 tab

Session            server-authoritative (AD-7)
  workspaceId      NOT NULL — a fact in the backend, not a renderer grouping
  parent           immutable lineage edge, provenance only

Tab                the renderer's projection of a session
```

Two edges, and they are not the same kind:

- **Membership** — workspace → tab. Exactly **one level**. Set by the user.
- **Lineage** — tab → tab. **Unbounded depth**. Set by who spawned whom, never by hand.

"Many levels", which the owner asked for, is carried entirely by the second. Nested
workspaces were rejected: once a group can sit inside a group, "settings inherit from the
workspace" becomes a three-level override chain — set at the top, overridden in the
middle, reset at the bottom — and the user has to be told where the current value came
from. Everyone pays for that; a minority uses it.

**In the first cut a workspace carries nothing** — no rights, no settings. The owner's
words: there is nothing to lose yet; when a consumer appears we will decide how to
implement it. So this is pure grouping, and §5's rule ships as a **prohibition later epics
inherit**, not as a mechanism built now. That is the prior design's own §8 reasoning for
why the grant-source seam waits for a live minter, applied again.

### 3.1 Lifecycle

A workspace **exists only while it holds at least one tab.** There is no empty state at
any moment, so:

- **Creation** is always creation-with-content. "New workspace" from the chip menu creates
  the workspace **together with its first tab**, in one act. Dragging one tab onto another
  creates one holding both. A tab's context menu offers "into a new workspace".
- **Dissolution.** Closing the last tab closes the workspace.
- **Closing a workspace closes all its tabs.** It does not spill them into the default.
  This asks first, and the dialog **names what is live** (D6).

> An empty workspace was proposed by the author and **rejected by the owner**: a workspace
> with no tabs has no meaning. Creating it together with its first tab is strictly better
> than both alternatives — it removes the empty state and it removes the "open a tab
> somewhere it does not belong, then move it out" path.

### 3.2 The default workspace

A tab is **always** in a workspace. There is no null. The default workspace **never
renders** — no header, no name, no colour, no `+` of its own; its tabs are simply
top-level rows.

> "Invisible while it is the only one" was the owner's first proposal and was **withdrawn
> in discussion**, for two reasons. It would have to acquire a name at the moment a second
> workspace appears — a name the user never gave it. And the chrome would appear and
> disappear on a counter: drag one of two default tabs onto the other, the default empties,
> one workspace remains, and the whole structure vanishes again. Visibility must not depend
> on a count.

## 4. The surfaces

### 4.1 The vertical strip — everything at once

The vertical strip shows **all workspaces**. This is the surface you look at coming back
from lunch, and hiding another workspace's finished worker there would defeat the point.

```
▾ refactor-auth                    [+] [✎]
  │  ~/repos/nocx      main      ●
  │▾ claude                      ⏳
  │   │  go test ./...           ✓
  │   │▾ worker: srv-01          !
  │   │    ansible-run           ⏸
▾ ansible-rollout                  [+] [✎]
  │  ~/repos/ansible   master    ●
  │  deploy@srv-02               ●
   ~/notes                       ●            ← default workspace: no header
   deploy@srv-03                 ●
```

Name and colour are edited in the group header. `+` in a header opens a tab **in that
workspace**.

### 4.2 The horizontal strip — the current workspace only

A workspace chip on the left, then only the current workspace's tabs. In the default
workspace the chip is a **neutral glyph with no label** — the default never acquires a
name (§3.2), and the chip still has to exist or there is no way back.

```
┌───────────────────────────────────────────────────────────┐
│ ⬒ refactor-auth ▾ │ ~/nocx ● │ claude ⏳ │ srv-01 ! │ + ▾  │
└───────────────────────────────────────────────────────────┘
        └─ the switcher: every workspace, with attention counts,
           and "New workspace" at the foot
```

Three things this buys, and one it costs.

**The fence becomes visible.** Everything in the row can reach everything else in it;
what is not in the row cannot be reached. The interface teaches the security model
without prose.

**The row does not grow.** Twenty tabs across four workspaces is five in the row.

**`nocx-jv3q`'s exclusion survives** — the horizontal strip stays a flat row, and the tree
stays in the vertical strip, exactly as that epic says.

**The cost:** `Cmd+1..9` becomes workspace-scoped, which contradicts `nocx-jv3q.1`'s
explicit assertion that grouping must not change what those keys select. That assertion was
written when grouping was purely visual (by `surfaceType`); here the group is a real
container, and a position inside it is _more_ stable than a global one — another
workspace's tabs no longer shift your numbers. **`jv3q.1` must be edited to say so**;
diverging from it silently is what this paragraph exists to prevent.

> Two alternatives were considered and rejected. **Firefox-style inline chips**, which the
> owner's own reference screenshot shows: Firefox groups are flat, and lineage depth is not,
> so an agent with three workers one of which has two of its own cannot be laid out in a
> single row under any styling. **A second row**: it takes height in a terminal permanently
> for an action performed a few times an hour, and it duplicates the vertical strip, which
> already has the tree, the glyphs, search and a resize handle.

### 4.3 Dragging

A tab is dragged onto a group header in the vertical strip, or onto the chip in the
horizontal one. Two rules follow from the fence and are not cosmetic:

1. **The whole subtree moves.** Drag `claude` and its three workers go with it. Otherwise
   the parent leaves the fence and its children stay outside it.
2. **A lineage child cannot be dragged out on its own.** Otherwise a worker escapes its
   fence with one drag.

Dragging between **lineage** groups stays refused (`nocx-jv3q.2`): kinship is a fact, not
a position. Dragging between **workspaces** is a different act and is allowed.

## 5. The fence

**A resident of one workspace never reaches another** — no addressing, no spawning, no
observing, no input.

### 5.1 Why this does not repeal ADR-0020

```
effective authority = (what a human approved for this session) ∩ (the workspace fence)
```

Membership can only **subtract**. It never grants. ADR-0020 §5 rejected the workspace as a
**source** of authority, on three grounds — membership is draggable, environments are
shared, organisation must not confer authority. A ceiling meets none of them: dragging can
only move the right-hand term, and the left-hand term is unchanged by any drag. So
**dragging is safe by construction**, and the prior design's D1 ("membership is never an
input to authority") is not weakened but stated more precisely: never an input to the
_grant_; always an input to the _ceiling_.

This is why the rule can be written down now and built later. What epic B ships is the
prohibition; what a later epic ships is the intersection.

### 5.2 The fence has to live in the backend

Every operation the fence bounds — addressing, spawning, observing, input — is a **backend**
operation on the JSON-RPC control plane, and an enrolled external agent (prior design D13)
reaches the backend over its own socket without touching the renderer at all. **A fence the
backend cannot name is a UI convention.**

So `workspaceId` is a field on the **session**, in `internal/session`, non-null, crossing
every session wire and restore shape. The tab is the renderer's projection of it.

This is `nocx-ebl4`'s item 3, with one change: **not nullable**. That epic currently calls
the field "the weakest item in the epic", kept on `nocx-if6`'s retrofit argument alone. It
is no longer the weakest item — it is what makes the fence real, and it must be updated.

The state of the tree makes this urgent rather than theoretical, and it is filed as
`nocx-wyp3p`: the backend's only notion of a tab is `tabID(wconn)` in
`ws_history_record.go:339`, which returns the **WebSocket connection id** — while
`ws_lifecycle.go:147` says "one WebSocket owns several terminal tabs" and `sessionIDsOf` in
the same file says "a tab can hold several sessions". And `internal/session` has no restore
path at all: tabs survive a restart through `internal/settings`, re-opened by the frontend.

### 5.3 What the fence is not, and must never be called

The fence bounds reachability **through nocx**. It does not bound blast radius: two tabs
from different workspaces on one `srv-01` share a user and a filesystem, and `kill` works.
nocx is a terminal, not a hypervisor.

**The workspace fence may never be described to the user as filesystem isolation.** The
sandbox on `origin/feat/sandbox-v2` is real — Landlock on Linux, Seatbelt on macOS, and the
backend refuses to launch what it cannot enforce rather than degrading — but the owner's
decision is that it stays **per-host and OS-specific**. There is nothing on Windows and
nothing on a remote host. One wording cannot be true on a local Mac and on `srv-01` at
once, and a promise that holds in one tab and not the next is worse than no promise. The
sandbox remains its own feature with its own copy.

Naming collision to resolve before either ships: `sandbox-v2` already uses the word
`workspace` for the sandbox root directory.

### 5.4 The fence binds sessions, not the human

You are above it. You see every workspace at once, in the vertical strip and in the chip
menu, or "back from lunch, who finished" does not work.

## 6. Git: branches and worktrees

**A branch is a label on a tab row**, derived from cwd. No new object.

**An ownerless worktree** — one with no session — is a **cleanup** concern and lives in the
Git sidebar view, whose repository already comes from the active tab's cwd (D10).

The owner named the difficulty exactly: an ownerless worktree belongs to a _project_, and a
tab is not a project. It dissolves because nocx does not need a project — it needs "the repo
of the tab you are looking at", and D10 already supplies one. The scenario splits in two and
only the second half was ever hard:

- **An agent creates a worktree and opens a session in it.** That is lineage, drawn indented
  under the parent. No project concept is involved, and it is the case the whole design is
  for.
- **An orphan.** The Git panel, scoped to the current repo, lists it with "open a terminal
  here" and the means to remove it.

**Accepted cost, stated rather than papered over:** a worktree in a repository with no open
tab is not visible anywhere. Making it visible requires a registry of repositories that
outlives tabs — which is a project, a second organisational axis beside the workspace, and
the owner chose the workspace _over_ the project deliberately.

## 7. What this withdraws from the prior design

|                             | What it said                                                                                                                                                                                            | What now                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D2**                      | A workspace holds heterogeneous rows `(environment, path?, git binding?)`, none primary                                                                                                                 | **Withdrawn.** The owner: we will not bind a specific server or cwd to a workspace. nocx must stay excellent as an ordinary terminal, and D2 made the workspace a launcher configuration |
| **D3**                      | A workspace is optional; `workspaceId` is null when there is none                                                                                                                                       | **Withdrawn.** A tab is always in a workspace; the default one never renders (§3.2)                                                                                                      |
| **D9**                      | Spawning is the `delegate` effect over `environment`, permitted only into an environment **the workspace lists**                                                                                        | **Loses its mechanism** — there is no list any more. A replacement is owed; §8 records the candidate and why it is not decided here                                                      |
| **§8 item 3**               | "Nullable `workspaceId`… the weakest item in the epic"                                                                                                                                                  | **Non-null, and no longer the weakest** — it is what makes the fence real (§5.2). `nocx-ebl4` must be updated                                                                            |
| **`nocx-isoph` acceptance** | Create a workspace, add three rows (a local git worktree, a directory on an SSH host, a second SSH host with no path), open a terminal in each **from the workspace itself**, restart, find them intact | **Rewritten** — there are no rows. §9                                                                                                                                                    |
| **git-manager unblock**     | `nocx-isoph` supplies the "project concept" whose absence excludes "worktrees as a list"                                                                                                                | **No longer true.** The workspace is not a project (§6). That epic now hangs on the Git panel and D10, not on this one                                                                   |
| **`nocx-jv3q.1`**           | `Cmd+1..9` selects the same tab it selected before grouping                                                                                                                                             | **Overridden deliberately** (§4.2). The bead must be edited, not silently diverged from                                                                                                  |

## 8. Open questions

1. **What replaces D9.** The candidate raised in discussion and **not decided**: the
   reachable set is not configured but **derived** — the endpoints of the sessions currently
   in the workspace — so that widening it by dragging a tab in is a scope expansion that
   asks at the next spawn (ADR-0020 §6) rather than granting silently. It is written here so
   the agent epic inherits the question, not the answer.
2. **What "settings inherit from the workspace" covers**, when a consumer appears. Deferred
   by the owner.
3. **What dissolution costs once a workspace carries something.** Today nothing is lost.
   Once it holds approvals, closing the last tab destroys them — good hygiene (authority does
   not outlive the work) and a bad accident (one misclick). Undo, a confirmation, or saved
   groups: not decided, because the loss does not exist yet.
4. **Whether grouping should become switchable, as in orca** — its `Group by:
None / Status / PR / Project` over a flat list, with hosts and projects as independent
   scopes. Deliberately **not** in this cut: one axis (workspace) plus lineage nesting. The
   model does not obstruct it later.
5. **`nocx-wyp3p`'s resolution** — whether the capture scope is renamed to the connection it
   actually is, or a real per-tab identity crosses the wire.
6. **Restart.** `internal/session` has no restore path; tabs come back through
   `internal/settings`. Which side owns restoring workspace membership is not designed here,
   and it interacts with the prior design's §4.2 prepared→active interval (epic E).

## 9. The acceptance criterion this replaces

> A user opens four tabs, drags one onto another to form a workspace, names it, opens a
> third tab inside it from the group header, switches to the default workspace and back via
> the chip, restarts the app, and finds the workspace, its name and its three tabs intact —
> while the other two tabs are still at top level with no header. Closing the workspace asks
> first and names the three tabs it will close.

Out of scope for that criterion, and for epic B: any authority behaviour, any settings
inheritance, the agent, the worktree list, and any change to the tree's grouping axis.
