# Workspaces as a surface: a group of tabs now, an authorization boundary later

- **Date:** 2026-08-15
- **Beads:** `nocx-5azf0` (this session), `nocx-isoph` (the workspace epic), `nocx-ebl4`
  (epic A, the foundation slice), `nocx-jv3q` / `.1` / `.2` (the tab-strip epic),
  `nocx-wyp3p` and `nocx-ictcq` and `nocx-qfwrc` (filed here), `nocx-49d4` (the ledger's
  missing workspace owner), `nocx-jiwq.1` (the same addressing question from the
  notification side), `nocx-kewo` (the design this amends)
- **Amends:**
  `.internal/specs/2026-08-15-workspaces-lineage-and-orchestration-design.md` — D2 and D3
  are withdrawn, D9 loses its mechanism, §8 item 3 and the §10 decomposition change (§7).
  **And ADR-0020 §5**, which this design amends rather than merely interprets (§5.1).
- **Status:** design, second draft. Settled point by point with the owner, then revised
  after an adversarial review (codex, same day) that found sixteen defects. Fourteen were
  conceded, one was withdrawn by the reviewer under argument, and one was narrowed. **Four
  are open by name in §5.4 rather than answered** — the review was right that the first
  draft asserted a construction it had not built.
- **Review note.** The first draft claimed this design "does not repeal" ADR-0020 §5. That
  was false and is recorded here rather than quietly fixed: making `workspaceId` an operand
  the backend consults before addressing, spawning, observing or input **is** enforcement,
  whatever it is called. The ADR needs a clause; §5.1 says which.

## 1. In one sentence

A **workspace** is a user-created group of tabs — nothing else. It binds no host, no
directory and no repository; it is flat, never nested; a tab is always in exactly one; and
it exists only while it holds at least one tab.

**Two capabilities, deliberately not the same fact.** The review's sharpest finding was
that the first draft treated them as one, from its title down:

|                          | What it is                                                                                                              | When it ships                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Workspace membership** | Organisation and navigation: which tabs read as one piece of work                                                       | **Epic B**                       |
| **The workspace fence**  | An authorization boundary consuming membership as **one input**, bounding what nocx will do on request between sessions | **A later epic**, with the agent |

Everything in §4 is membership. Everything in §5 is the fence, and **§5.5 is the rule that
epic B may not advertise it.**

**What a user can do that they cannot today (epic B):** group the tabs of one task
together, switch between such groups, and keep the rest without losing them.

## 2. What this design crosses, and what those documents already decided

| Boundary                          | What it already decides                                                                                                                                                                                                                                                                                                                               | What this design does about it                                                                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-0020 §5**                   | "Authority is granted per run; a container never confers it." The workspace is "narrative and presentation scope"; it _mints_ the default grant but **"is not the enforcement object"**, because "workspaces get reorganised by dragging things around, and dragging a tab must never **silently** confer or revoke the right to write to production" | **Amended, not reinterpreted** — §5.1. The fence makes the workspace an operand in enforcement, which the ADR excludes. What survives intact is the ADR's actual prohibition, which is on _silence_: §5.3's move rule makes every change of authority visible and human-approved |
| **ADR-0020 §3, §6**               | Takeover **demotes, does not evict**; "scope expansion invalidates prior approval"                                                                                                                                                                                                                                                                    | The precedent §5.3 follows. Authority already changes under reorganisation in this ADR; what it never does is change quietly                                                                                                                                                     |
| **ADR-0028**                      | The dispatcher **narrows rather than checks**; a narrowed tool cannot exceed its grant because it never holds more                                                                                                                                                                                                                                    | The distinction §5.5 relies on: narrowing bounds what nocx dispatches, never what the host can do. The fence is the same kind of thing and gets the same honest name                                                                                                             |
| **AD-7**, session model           | Session-id is server-authoritative; the backend `session` module is the authoritative registry                                                                                                                                                                                                                                                        | `workspaceId` is a fact on the **session, in the backend**. §5.2 — and §5.2 also explains why the backend must never gain a _tab_ id                                                                                                                                             |
| **D6** of the prior design        | A parent's death never closes its children; only an explicit human act may, and closing a tab with live descendants **asks** rather than decides                                                                                                                                                                                                      | **Reused exactly.** §4.4's dialog is that rule applied to a container, which is why it must enumerate what is live                                                                                                                                                               |
| **D8** of the prior design        | `Delegation` is separate from lineage and revocable; a change of **authenticated authority context** moves it to `scope-suspended`, "from which control does not resume without human approval". The ADR's own §11.1 leaves "the exact trigger set, and who may re-approve" **open**                                                                  | §5.3 adds "a workspace move" to that trigger set — which **settles part of an open question rather than reusing a finished rule**, and is why §5.4 stays open                                                                                                                    |
| **D10** of the prior design       | The git panel follows the **active tab**; the session is the sole owner of "which repository"                                                                                                                                                                                                                                                         | **Reused, and it is what dissolves the worktree problem** (§6)                                                                                                                                                                                                                   |
| **`nocx-jv3q`** (the parent epic) | Acceptance: "**OUT OF SCOPE: any change to the horizontal strip**"                                                                                                                                                                                                                                                                                    | **Broken, and the epic must be amended** — a chip, a switcher, row filtering and workspace-scoped `+` are changes to it. "Still a flat row" is not "no change". §7                                                                                                               |
| **`nocx-jv3q.1`**                 | Groups exist only in the vertical strip. Grouping must not change what `Cmd+1..9` selects                                                                                                                                                                                                                                                             | First half honoured; second half **deliberately overridden** — §4.3 and §7                                                                                                                                                                                                       |
| **`nocx-jv3q.2`**                 | Drag **between** lineage groups was removed 2026-08-01: a group is a fact about a session, not a position                                                                                                                                                                                                                                             | **Survives.** Dragging between workspaces is a different act and is allowed                                                                                                                                                                                                      |
| **`origin/feat/sandbox-v2`**      | A per-tab Landlock/Seatbelt policy the backend refuses to launch without. **Not on `main`**                                                                                                                                                                                                                                                           | Deliberately **not** the fence — §5.5                                                                                                                                                                                                                                            |
| **`nocx-49d4`**                   | The ledger schema demands a workspace owner per session, and `workspace:default` is **synthetic fallback state nobody chose**, to be **deleted** after marked rows are re-parented to their real workspaces                                                                                                                                           | **The bead must be rewritten, and this design does not get to cite it as agreeing.** Its schema shape and §3.2's invariant coincide; its acceptance criterion — delete the default — is contradicted by a permanent invisible default. §7                                        |

## 3. The model

```
Workspace          user-created, flat, never nested
  id, name, colour
  exists ⟺ it holds ≥ 1 tab          (§4.4 — an interval, not a moment)

Session            server-authoritative (AD-7)
  workspaceId      NOT NULL — a fact in the backend, not a renderer grouping
  parent           immutable lineage edge, provenance only

Tab                the renderer's projection of one or more sessions
```

Two edges, and they are not the same kind:

- **Membership** — workspace → tab. Exactly **one level**. Set by the user.
- **Lineage** — tab → tab. **Unbounded depth**. Set by who spawned whom, never by hand.

"Many levels", which the owner asked for, is carried entirely by the second. Nested
workspaces were rejected: once a group can sit inside a group, "settings inherit from the
workspace" becomes a three-level override chain — set at the top, overridden in the middle,
reset at the bottom — and the user has to be told where the current value came from.
Everyone pays for that; a minority uses it.

**In epic B a workspace carries nothing** — no rights, no settings. The owner's words: there
is nothing to lose yet; when a consumer appears we will decide how to implement it.

## 4. Membership: what epic B ships

### 4.1 Lifecycle

A workspace **exists only while it holds at least one tab.** There is no empty state at any
moment, so:

- **Creation** is always creation-with-content. "New workspace" from the chip menu creates
  the workspace **together with its first tab**. Dragging one tab onto another creates one
  holding both. A tab's context menu offers "into a new workspace".
- **Dissolution.** The last tab leaving closes the workspace.
- **Closing a workspace closes all its tabs.** It does not spill them into the default. It
  asks first, and the dialog **names what is live** (D6).

The transactional shape of all three is §4.4, which is where the review found this design
had stated a moment and called it an invariant.

> An empty workspace was proposed by the author and **rejected by the owner**: a workspace
> with no tabs has no meaning. Creating it together with its first tab removes the empty
> state and removes the "open a tab somewhere it does not belong, then move it out" path.

### 4.2 The default workspace

A tab is **always** in a workspace. There is no null. The default workspace **never
renders** — no header, no name, no colour, no `+` of its own; its tabs are simply top-level
rows.

> "Invisible while it is the only one" was the owner's first proposal and was **withdrawn in
> discussion**. It would have to acquire a name at the moment a second workspace appears — a
> name the user never gave it. And the chrome would appear and disappear on a counter: drag
> one of two default tabs onto the other, the default empties, one workspace remains, and
> the whole structure vanishes again. Visibility must not depend on a count.

### 4.3 The two strips

**The vertical strip shows all workspaces.** This is the surface you look at coming back
from lunch; hiding another workspace's finished worker there would defeat the point.

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

**The horizontal strip shows the current workspace only** — a chip on the left, then its
tabs. In the default workspace the chip is a **neutral glyph with no label**: the default
never acquires a name, and the chip still has to exist or there is no way back.

```
┌───────────────────────────────────────────────────────────┐
│ ⬒ refactor-auth ▾ │ ~/nocx ● │ claude ⏳ │ srv-01 ! │ + ▾  │
└───────────────────────────────────────────────────────────┘
        └─ the switcher: every workspace, with attention counts,
           and "New workspace" at the foot
```

**What the chip buys, stated as navigation and nothing else.** The current workspace becomes
visible; the row stops growing (twenty tabs across four workspaces is five in the row); and
the tree stays in the vertical strip. The first draft's rationale here was "the fence becomes
visible" — see §5.5 for why that sentence is gone.

**The cost:** `Cmd+1..9` becomes workspace-scoped, contradicting `nocx-jv3q.1`'s explicit
assertion. That assertion was written when grouping was purely visual (by `surfaceType`);
here the group is a real container, and a position inside it is _more_ stable than a global
one. **`jv3q.1` must be edited to say so**; diverging silently is what this paragraph exists
to prevent. And per §2, the **parent** epic's exclusion is broken too and needs the same
treatment.

> Rejected: **Firefox-style inline chips**, which the owner's reference screenshot shows —
> Firefox groups are flat and lineage depth is not, so an agent with three workers one of
> which has two of its own cannot be laid out in one row. And **a second row**, which takes
> height in a terminal permanently for an action performed a few times an hour, and
> duplicates the vertical strip.

### 4.4 Lifecycle as an interval, with one owner

AGENTS.md testing rule 3 demands both ends of an invariant and the review was right that
"exists ⟺ it holds a tab" gives one. It is worse than a missing sentence: `workspaceId`
lives on the session in the backend while tabs live in the renderer, so **the two ends of
the invariant are in two processes and no one owns both.**

**One lifecycle authority.** The backend's session registry (AD-7) owns workspace
membership and its lifecycle. Every other path that today initiates closure becomes a
**request** to it, never a decision:

- the renderer's `closeTab` (`tabs.ts:691`),
- the auto-replacement when the last tab closes (`tabs.ts:703`),
- the session-exit closer (`terminal-content.ts:1902`) — which `nocx-ictcq` is separately
  fixing, because it cannot currently tell a clean exit from a dropped connection.

Choosing which one wins per case would leave competing owners in place; the review's larger
lesson, accepted.

**The interval, both ends named:**

> A workspace record exists **from before its first member session is durably recorded**
> until **the durable transition that records its last member leaving**. Membership is
> addressable only inside that span. On any failure between, recovery either completes the
> membership change or terminalizes the record — never leaves a session pointing at a
> workspace that does not exist, nor a workspace with no members.

**Crash cuts, each owing a recovery test** — the review supplied these and they are taken
whole: workspace persisted / session spawn fails; session opens with `workspaceId` /
renderer dies before creating its tab; renderer creates the tab / membership RPC fails;
backend commits a subtree move / renderer crashes before moving it; renderer moves first /
backend rejects; last tab gone in the renderer / backend cleanup fails; one of several
sessions in a tab closes while another remains.

**Two named cases the first draft did not have at all:**

- **The replacement tab's workspace.** Closing a workspace holding every open tab triggers
  `tabs.ts:703`'s auto-replacement. The replacement belongs to the **default** workspace,
  never to the one being closed — otherwise the closure resurrects what it just deleted.
- **Suppression during bulk close.** Each session's exit independently requests closure, so
  a bulk close must suppress the per-session closer for its own members and reconcile once
  at the end. Two closers racing over one set is the AD-8 shape.

**Subtree moves need an atomicity model, not an adjective.** §4.5 says a drag moves the
whole subtree. Concretely: P with children C1 and C2 moves to B, C1 commits, C2's backend is
unreachable — lineage now crosses the fence, the state the rule calls impossible. Required
and **not yet designed**: a snapshot boundary for the subtree taken at drag start, a
compare-and-swap on session epochs so a child spawned mid-drag is not silently included or
lost, and either an atomic commit or a recoverable journal. Until it exists, a partial
subtree move must fail closed — the move does not apply.

### 4.5 Dragging

A tab is dragged onto a group header in the vertical strip, or onto the chip in the
horizontal one. Two rules follow from membership being one level:

1. **The whole subtree moves.** Drag `claude` and its three workers go with it.
2. **A lineage child cannot be dragged out on its own.**

Dragging between **lineage** groups stays refused (`nocx-jv3q.2`): kinship is a fact, not a
position.

## 5. The fence: what a later epic ships

**A session in one workspace may not reach another** — no addressing, no spawning, no
observing, no input, through nocx.

### 5.1 This amends ADR-0020 §5, and here is the clause it needs

The first draft argued that a ceiling is not a grant and therefore nothing in ADR-0020
changes. **That is withdrawn.** The ADR says the workspace "is not the enforcement object",
and the fence makes it exactly that: an operand the backend consults before dispatching.
Subtraction is an authorization decision. Calling it a ceiling does not change what it does.

What the ADR actually prohibits, in its own words, is **silence**: "dragging a tab must
never _silently_ confer or revoke the right to write to production." The same ADR already
lets authority change under reorganisation — §3's takeover demotes rather than evicts, §6's
scope expansion invalidates prior approval. So the amendment is narrow, and §5.3 is what
buys it:

> **Proposed clause for ADR-0020 §5.** A workspace may additionally bound what nocx will
> dispatch between sessions. It remains true that a container never _confers_ authority: a
> move proposes a change and a human disposes of it. Every change of a session's workspace
> suspends the authority that depended on the old one, visibly, and no authority resumes
> without human approval.

The formula, in the review's own corrected form, which names the objects the first draft's
did not:

```
effective run authority =
    RunGrant(snapshot from the session's AuthorityBinding)
  ∩ current workspace fence
```

Both timing facts survive: approval belongs to the session's `AuthorityBinding`, exercised
authority belongs to the immutable per-run snapshot (ADR-0020 §5).

### 5.2 The fence has to live in the backend, and the backend must not gain a tab id

Addressing, spawning, observing and input are **backend** operations, and an enrolled
external agent (prior design D13) reaches the backend over its own socket without touching
the renderer. A fence the backend cannot name is a UI convention. So `workspaceId` is a
non-null field on the **session**, crossing every session wire and restore shape. This is
`nocx-ebl4`'s item 3, which that epic currently calls its weakest — it is not, but note that
the argument for it is **this design's**, not `nocx-wyp3p`'s.

**The backend must not gain a _tab_ id, and this is a separate conclusion with its own
reasons.** AD-7 makes the session the identity the backend owns; a tab can hold several
sessions, so "the tab that spoke" is not well defined from the backend's side; and the
renderer already knows which tab a session is in. So every backend→renderer address is a
`sessionId` the renderer resolves. That settles `nocx-jiwq.1` (a notification click has to
land somewhere) the same way.

`nocx-wyp3p` — `tabID(wconn)` in `ws_history_record.go:337` returns the WebSocket connection
id while `ws_lifecycle.go:145` says one socket owns several tabs and `sessionIDsOf` says a
tab holds several sessions — is **evidence of the confusion, not evidence for this
architecture**. Its own resolution is to rename the scope to the connection it is, or re-key
it on the session. The first draft spent it as support for a non-null `workspaceId`; the
review was right that it does not carry that weight.

### 5.3 What a move does

**A workspace move is a change of authenticated authority context**, so prior design D8's
`scope-suspended` applies: presentation changes immediately, authority does not resume
without human approval. That answers the two-horned failure the review posed — the run's
grant is not silently revoked mid-flight, and the tab does not sit in B advertising reach
into A, because what it has is visibly suspended.

It is **not** a finished rule being reused. The prior design's §11.1 leaves the trigger set
and the re-approval authority open; adding "a workspace move" settles part of that open
question. Hence §5.4.

Three cases, because suspending only delegations is insufficient:

- **No binding, no delegations** — a plain human-driven ssh tab. Nothing to suspend. The
  human is above the fence (§5.6), so the move is organisational only. This is the common
  case and it must stay free.
- **A binding, no delegations** — an agent approved to act but controlling no children.
  There is no delegation to suspend, and the binding would go on being an eligible grant
  source for runs minted after the move. **The binding itself must stop being an eligible
  grant source until re-approval.**
- **Delegations** — every edge whose authority context changed suspends. Incoming, outgoing,
  and — a case the design must decide deliberately rather than inherit — whether a subtree
  move suspends the edges _internal_ to the subtree, whose two ends moved together.

**The ordering interval**, which is separate from §4.4's and equally required:

> From before a session's membership becomes B, until every affected binding and delegation
> is suspended, **no new run may be authorized and no delegated request may pass under the
> old context.**

Otherwise a run starts in the gap. And immutability of the `RunGrant` must not be read as a
licence to keep dispatching: the historical record does not change, but **the dispatcher
requires both the immutable grant and a currently-active binding or delegation**, so
suspension stops subsequent operations without rewriting anything. Work already irreversibly
dispatched cannot be recalled and needs its own rule.

### 5.4 Open, by name

These are the parts of §5.3 the review showed were asserted rather than built. They belong
to the fence epic and must be answered before it ships:

1. Whether a subtree move suspends the delegation edges internal to the subtree.
2. Who may re-approve a suspended binding, and whether re-approval is per binding or per
   workspace.
3. The atomic ordering of membership change and suspension — the interval above states the
   requirement, not the mechanism.
4. What happens to work already dispatched when suspension lands.

### 5.5 Epic B may not advertise the fence

**The rule.** Until enforcement exists, the workspace UI is navigation and says only
navigational things. Honest in B: "current workspace", switching, creating, renaming,
attention counts, filtering the row. **Forbidden in B:** shield or lock iconography, "safe",
"isolated", "contained", and any copy of the form "everything here can reach everything
else" or "tabs outside cannot be reached".

The first draft's §4.2 said the chip made the fence visible and taught the security model
without prose. With epic B shipping no enforcement, that is a visible security promise with
no mechanism — AGENTS.md's named anti-pattern, and the review's strongest finding. When
enforcement lands, the same component gains an explicit, state-backed fence status. An
aspirational badge advertises machinery that is absent.

### 5.6 What the fence is not, in any epic

It bounds what nocx will **do on request**. It is not containment. Two tabs from different
workspaces on one `srv-01` share a user and a filesystem, and `kill` works; an enrolled
agent can observe or disturb the other workspace with ordinary process and filesystem
capability. Call it a **control-plane reachability boundary** and reserve "isolation" and
"containment" for mechanisms that provide them.

This is the same distinction ADR-0028 already draws for dispatcher narrowing — a narrowed
tool constrains what nocx dispatches, not what the host can do — so the vocabulary is
borrowed rather than invented.

**And it may never be described as filesystem isolation.** The sandbox on
`origin/feat/sandbox-v2` is real, but the owner's decision is that it stays **per-host and
OS-specific**: Landlock on Linux, Seatbelt on macOS, nothing on Windows, nothing on a remote
host. One wording cannot be true on a local Mac and on `srv-01` at once. Naming collision to
resolve before either ships: `sandbox-v2` already uses the word `workspace` for the sandbox
root directory.

### 5.7 The fence binds sessions, not the human

You are above it. You see every workspace at once, in the vertical strip and in the chip
menu, or "back from lunch, who finished" does not work.

### 5.8 An agent spawning a child

Lineage only: the child joins the **parent's** workspace and appears indented under it. No
group is minted. Rejected: auto-fencing (the tab silently leaves the visible row, and a
single worker mints a group for two rows) and a prompt (an extra notification for something
the user can do himself). Fencing a fleet stays a human act.

## 6. Git: branches and worktrees

**A branch is a label on a tab row**, derived from cwd. No new object.

**An ownerless worktree** — one with no session — is a **cleanup** concern and lives in the
Git sidebar view, whose repository already comes from the active tab's cwd (D10).

The owner named the difficulty exactly: an ownerless worktree belongs to a _project_, and a
tab is not a project. It dissolves because nocx does not need a project — it needs "the repo
of the tab you are looking at", and D10 already supplies one. An agent that creates a
worktree and opens a session in it produces **lineage**, drawn indented under the parent,
with no project concept involved; that is the case the design is for.

**Accepted cost, stated rather than papered over:** a worktree in a repository with no open
tab is not visible anywhere. Making it visible requires a registry of repositories that
outlives tabs — which is a project, a second organisational axis beside the workspace, and
the owner chose the workspace _over_ the project deliberately.

## 7. What this withdraws, and what it obliges others to change

|                                | What it said                                                                                                                                                                      | What now                                                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D2**                         | A workspace holds heterogeneous rows `(environment, path?, git binding?)`, none primary                                                                                           | **Withdrawn.** The owner: we will not bind a specific server or cwd to a workspace. nocx must stay excellent as an ordinary terminal, and D2 made the workspace a launcher configuration                                                                           |
| **D3**                         | A workspace is optional; `workspaceId` is null when there is none                                                                                                                 | **Withdrawn.** A tab is always in a workspace; the default never renders (§4.2)                                                                                                                                                                                    |
| **D9**                         | Spawning is `delegate` over `environment`, permitted only into an environment **the workspace lists**                                                                             | **Loses its mechanism** — there is no list. §8.1 records the candidate and why it is not decided here                                                                                                                                                              |
| **§8 item 3**                  | "Nullable `workspaceId`… the weakest item in the epic"                                                                                                                            | **Non-null.** `nocx-ebl4` must be updated — and per §5.2 the argument for it is this design's, not `nocx-wyp3p`'s                                                                                                                                                  |
| **§10, the A→C decomposition** | C (delegation, enrolment, the first live grant minter) is independent of workspace epic B, because D3 allowed no-workspace operation and D9 fell back to the parent's environment | **Stale, and this design owes the repair.** With workspaces mandatory and D9's rule gone, C has no decided reachable-resource rule and every session now participates in a fence. The dependency graph and the "critical path is A → C" claim must both be redrawn |
| **`nocx-jv3q`** (parent)       | "OUT OF SCOPE: any change to the horizontal strip"                                                                                                                                | **Broken.** The epic's acceptance must be amended, not only `.1`'s assertion                                                                                                                                                                                       |
| **`nocx-jv3q.1`**              | `Cmd+1..9` selects the same tab it selected before grouping                                                                                                                       | **Overridden deliberately** (§4.3)                                                                                                                                                                                                                                 |
| **`nocx-49d4`**                | `workspace:default` is synthetic state nobody chose; the acceptance is to re-parent marked rows and then **delete** `DefaultWorkspaceID`                                          | **Must be rewritten.** A permanent invisible default contradicts its acceptance criterion. The schema shape agrees with §4.2; the bead does not, and the first draft cited it as if it did                                                                         |
| **`nocx-isoph` acceptance**    | Create a workspace, add three rows, open a terminal in each from the workspace itself, restart, find them intact                                                                  | **Rewritten** — there are no rows, and see §9 on the restart                                                                                                                                                                                                       |

### 7.1 Discharged, 2026-08-16

Every obligation above is now paid **in the beads themselves**, which is where a worker
reads them. Two of them were left by this design as decisions rather than edits, and both
are settled here rather than in a conversation somebody has to remember.

**The chip is `nocx-isoph`'s, not `nocx-jv3q`'s.** `jv3q`'s note left the choice open —
land the chip in that epic, or narrow its exclusion. The design had already answered it:
§9 names the chip inside epic B's acceptance criterion, and a chip has nothing to display
until workspaces exist. So `jv3q`'s exclusion narrows to "any **grouping** in the
horizontal strip", which is the part §4.3 genuinely preserves — the tree stays in the
vertical strip.

**`nocx-49d4` promotes the default row rather than dropping it**, and that is neither of
the two answers the conflict offered. The bead and §4.2 were not describing one object:
the ledger's `workspace:default` exists because the product had no way to choose, while
§4.2's default exists because the product deliberately chooses it for anything unassigned.
A session that was never assigned belongs there under both readings, so nothing moves. What
goes is `captureEnsuredSessionMarker`, which is the part that actually encoded "unchosen".
This **dissolves** the bead's `ON DELETE CASCADE` hazard instead of scheduling it: with
nothing dropped there is no ordering to get wrong and no re-parenting migration to run.

**`nocx-jv3q.1`'s keyboard criterion is scoped, not flipped.** `jv3q.1` ships _before_
workspaces — `isoph` is blocked by that epic — so there is nothing to scope the keys to
when it lands. Its promise, that grouping by kind does not renumber, survives whole. What
is written down is that global numbering was never a promise, so its test may not pin one.

**`nocx-ebl4`'s own `WHAT LANDS` said "nullable"** while its note and its child `nocx-fraus`
said the opposite. The list is what a worker reads first, so the list is what was corrected.

## 8. Open questions

1. **What replaces D9** — see §8.1.
2. **The four fence questions** in §5.4.
3. **What "settings inherit from the workspace" covers**, when a consumer appears. Deferred
   by the owner.
4. **What dissolution costs once a workspace carries something.** Today nothing is lost. Once
   it holds approvals, closing the last tab destroys them — good hygiene (authority does not
   outlive the work) and a bad accident (one misclick).
5. **Whether grouping should become switchable, as in orca** — `Group by:
None / Status / PR / Project` over a flat list, with hosts and projects as independent
   scopes. Deliberately **not** in this cut. The model does not obstruct it later.
6. **`nocx-wyp3p`'s resolution** — renamed to the connection it is, or re-keyed on the
   session. §5.2 rules out a third identity.
7. **How restore is sequenced against epic B** — §8.3 settles that restore exists; only the
   ordering is open.

### 8.1 The candidate replacement for D9

Raised in discussion and **not decided**: the reachable set is not configured but **derived**
— the endpoints of the sessions currently in the workspace — so that widening it by dragging
a tab in is a scope expansion that asks at the next spawn (ADR-0020 §6) rather than granting
silently. Written here so the fence epic inherits the question, not the answer. Note that
§5.3's move rule and this proposal interact: under both, a drag proposes and a human
disposes.

### 8.2 Nothing survives a restart today, and the prior design says otherwise

**`restoreDescriptor` is written in four places, typed `unknown`, and read nowhere.**
`frontend/src/file-viewer/index.ts:85` says so: "nothing serialises the tab list and nothing
reconstructs a tab from a descriptor". **The only tab-related setting in `internal/settings`
is `TabPlacement`** (horizontal vs vertical strip) — the package carries plenty else, and the
first draft's "carries only `TabPlacement`" was simply false. `internal/session` has no
restore path. On start you get one fresh local tab.

The prior design's §4.2 states the opposite and uses it to argue the prepared→active interval
belongs to epic E rather than A. **The conclusion survives and is stronger** — there is even
less to preserve than it thought — but the supporting fact is false and must be corrected
there. Found by the worker on `feat/notificcations`, verified here, filed as `nocx-qfwrc`.

### 8.3 Restore exists, is a setting, and is its own epic

**The owner's decision**, with Warp as the reference: tabs come back on startup, the user
chooses whether they do, and what comes back includes **blocks and workspace membership**.

Warp ships **two settings for two features**, and conflating them would produce one control
governing two behaviours: General → "Restore windows, tabs, and panes on startup"; Session →
"Enable reopening of closed sessions" with a **grace period in seconds** (undo-close while
running).

**Restoring a tab is not resurrecting a process.** D5 stands: workers die with the backend.
What comes back is the tab — kind, endpoint, cwd, workspace — re-opened, plus its blocks.
Without that sentence someone builds epic E by accident.

**But "blocks are already durable" is weaker than the first draft claimed, in two ways, and
the restore epic inherits both.**

- `contentDB` starts as `content.NewStub(logger)` (`app.go:449`), is wired to the transport
  at `app.go:600`, and **both** failure paths in between leave it a stub — an unreadable
  content key and a store that will not open — each announced by a `slogger.Warn` and nothing
  else. That is AGENTS.md's own named anti-pattern, quoted with this very feature as its
  example.
- More sharply: `content.go:77-82` says of `Ledger()` that "the `ledger.*` wire methods
  (`nocx-rtg0.3`) **will** drive this surface; **until that cutover its only callers are
  tests**, and `command_history` remains the live history path." **The ledger is where
  `sessions` and `workspaces` live** — so the very rows `nocx-49d4` is about are on a
  test-only surface today.

So the restore epic's criterion must be stated at both ends: with a live store, a restart
returns the tabs **and** their blocks; with the store degraded, it returns the tabs and
**says so in the product** — never a restored tab silently missing its history.

**It is its own epic, not part of B.** It can be handed to one person whole, and folding it
in would turn "pure grouping" into an area.

## 9. Acceptance criteria

**Epic B — membership.**

> A user opens four tabs, drags one onto another to form a workspace, names it, opens a third
> tab inside it from the group header, switches to the default workspace and back via the
> chip, and finds the other two tabs still at top level with no header. Closing the workspace
> asks first and names the three tabs it will close; the replacement tab that appears if it
> held every tab belongs to the default workspace. No surface in the product describes the
> workspace as safe, isolated, contained, or as bounding what anything can reach.

The restart is deliberately absent and belongs to the restore epic (§8.3), whose own
criterion carries the workspace half. Out of scope for B: any authority behaviour, any
settings inheritance, the agent, the worktree list, and any change to the grouping axis.

**The fence epic.**

> An agent in workspace A, holding a grant that names a session in workspace B, is refused —
> at the backend, over the enrolled socket, not in the renderer. Dragging that agent's tab
> into B does not grant it: the request is still refused until a human approves, and the
> suspension is visible on the tab. Dragging a plain human-driven ssh tab between workspaces
> changes nothing but presentation.

That criterion cannot be written as an assertion until §5.4's four questions are answered,
which is the point of listing them.
