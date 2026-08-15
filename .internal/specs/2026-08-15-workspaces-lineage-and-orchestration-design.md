# Workspaces, lineage, and orchestration as a view over sessions

- **Date:** 2026-08-15
- **Beads:** `nocx-kewo` (this session), `nocx-ms7v.4` (the attention queue this leans on),
  `nocx-jv3q` (the tab-strip epic it amends), `nocx-if6` (the phase-A argument it reuses),
  `nocx-457v` (the helper whose reservations it spends), `nocx-dw3` / `nocx-x8s2` (the agent),
  `nocx-hz94` / `nocx-jiwq` (notification delivery)
- **Amends:** `docs/vision.md` §11 (one factual claim), ADR-0020 (§5 gains a clause),
  `.internal/specs/2026-08-06-git-manager-design.md` line 251 (an exclusion loses its reason)
- **Status:** design, drafted 2026-08-15 from a working session with the owner; **not yet
  approved**; open questions are marked as open rather than resolved by the author

## 1. In one sentence

nocx gains **workspaces** — user-created, host-agnostic groups that carry a policy — and
**session lineage** — a structural parent/child edge that bounds what an agent may address;
on top of the attention queue that already exists, this makes running several agents across
several machines a *view over sessions* rather than a second product, and it does so without
nocx becoming agent-first, because every part of it is useful with no agent present.

**What a user can do that they cannot today:** create a workspace for one piece of work,
open sessions in it on the laptop and on two servers, start an agent in one of them, let that
agent open child sessions of its own, and — coming back from lunch — press one shortcut to
see which of them finished, which failed, and which is waiting on a human. And an agent in
one workspace cannot see, address or disturb anything in another.

## 2. What this design crosses, and what those documents already decided

AGENTS.md requires a brief that crosses a boundary to name the `AD`s and ADRs it touches and
what they already decided, **before** it says what to build.

| Boundary | What it already decides | What this design does about it |
|---|---|---|
| **AD-6**, byte-blindness | The backend never sniffs the byte stream; the renderer owns render state and parses OSC | **Unchanged.** Agent state derived from the terminal title or the screen is derived **frontend-side** and crosses the control plane as a typed fact, which AD-1's 2026-08-02 amendment already permits. The backend never receives the stream it was derived from |
| **AD-7**, session model | One PTY/channel per tab; the backend `session` module is the authoritative registry; session-id is **server-authoritative** | **Extended, not changed.** `parentId` and `workspaceId` join `sessionId` as server-authoritative fields on the same registry. The client may propose a parent; the server assigns and returns the record |
| **AD-8**, interface-first + DI | Variation is expressed by the interface, never by a fork inside an implementation | Binds §6: the built-in agent and an external CLI reach **one** dispatcher with differently minted grants — not two control surfaces with a `switch` between them |
| **AD-9**, replay ownership | Bounded per-session output ring keyed by byte offset; the frontend acks | The reason tmux/dtach is rejected as a durability substrate in D4 — it would be a second replay owner |
| **AD-1**, the wire | Binary data plane, JSON-RPC control plane; ledger **facts** may cross, raw bytes may not | Agent-state transitions cross as typed JSON-RPC records with provenance, like `history.record`. No new plane |
| **ADR-0020**, the lane and the grant | §5: workspace, resource scope and authority grant are three things; **the workspace mints the default grant from its policy and is not the enforcement object**; "Workspace as the security principal" is *rejected* because "membership changes by drag and drop". §6: the effect lattice, including `delegate`. "Scope expansion invalidates prior approval" | **Honoured, and amended in one place.** The workspace-with-rights the owner asked for *is* the minting role the ADR already grants it. Lineage is added as a **second, non-draggable** axis, which survives the ADR's stated objection for a reason the ADR does not currently record — see §9 |
| **ADR-0024**, the lifecycle leaves the byte stream | OSC 133 is an **anonymous broadcast channel**: "every process with that tty open can write it — a TUI, a `cat` of a hostile file, a remote host's MOTD". Hence an authenticated channel | Binds §5 and §6 absolutely. A spawn request may never ride the byte stream, and the terminal **title** is the same anonymous class — declared, not attributed |
| **ADR-0028**, the agent loop is ours | The grant is over **resources and effects, never tool names**; the dispatcher **narrows rather than checks** — the tool holds a scoped capability, so it cannot exceed the grant because it never holds more | Binds §6 verbatim. The external-agent capability token is that narrowing, applied to a caller outside the process |
| **ADR-0029** / `nocx-ng6f` / `nocx-9zmc` | The notification core already has **trust**, a default-deny router, and **backend-stamped provenance**; `nocx-hz94`'s acceptance says "**A heuristic event never reaches a target**" | The trust ladder in §5 is not a new concept — it is the existing trust field given five defined values |
| **`nocx-if6`** phase A | `(backendId, sessionId)`; retrofitting identity after tabs, restore, ledger and blocks key on a bare `sessionId` is "a wide, unpleasant change" | The same argument, reused verbatim, is why §8 keeps `parentId`/`workspaceId` in the non-deferrable half |
| **`nocx-457v`** / the remote helper | *(its own decision numbering, cited below as `helper-Dn` to avoid collision with this document's `Dn`)* `helper-D15` reserves `seq`/`ack`, an **instance id** in `hello-ok`, the `session` service name, and "a helper's lifetime is not tied to one channel". `helper-D4`: "the port is not the authenticator; the capability is". `helper-D7`: platform in the install path because one `$HOME` may serve two architectures. `helper-D25`: pruning removes only versions older than the one being installed | The remote `session` service is **deferred** (D5). When it lands it spends exactly these reservations and adds no generation machinery |
| **`nocx-jv3q.1` / `.2`** | Group identity is **session lineage plus the backend-attested endpoint**, not the display host; drag **between** groups was removed 2026-08-01 because a group is a fact about a session, not a position | **Both survive unamended.** Workspace filters; lineage groups. Moving a session between workspaces is a different act from dragging between lineage groups — see D8 |
| **git-manager design**, line 251 | "Multi-repository, submodules, **worktrees as a list**. nocx has **no 'project' concept**" — an exclusion whose stated reason is a missing concept | The workspace **is** that concept. The exclusion loses its reason; §9 records the amendment it owes |
| **git-manager design**, D13 | OSC 133 command-end was rejected as a refresh trigger: "**an agent is one long command**" | This contradicts `vision.md` §11, which asserts OSC 133 answers "is this agent done?". §9 records the correction |
| **`docs/vision.md`** §11 | Agent orchestration as a plugin is recorded as *undecided and not scheduled*, with a counterweight ("the hard part is not the terminal") and a smallest first step ("make the session model orchestration-ready without building orchestration") | This design **is** that smallest first step, made concrete. It does not schedule the plugin |

## 3. Decisions

| # | Decision | Rejected alternative, and why |
|---|---|---|
| **D1** | **Two independent axes.** A **workspace** is user-created, host-agnostic, optional, and carries a policy. **Lineage** (`parentId`) is structural, assigned at creation, and never editable. Workspace answers *what is in scope*; lineage answers *whom may an agent address* | One axis. Making the workspace also the addressability boundary reproduces exactly what ADR-0020 §5 rejected; making lineage also the rights boundary couples presentation to authority, so a UI change becomes a security change |
| **D2** | **A workspace holds zero or more heterogeneous rows: `(environment, path?, git binding?)`.** None is primary. `environment` is the **existing** connection-profile entity plus local — not a new type | A single root. It breaks the case the owner named: a devops task touching five servers has no primary host. It also breaks GitOps, where the repository is local and the targets are remote — the repository is **not** a property of an environment |
| **D3** | **Workspace is optional.** With none, `workspaceId` is null, the grant is minted from the global default policy, and roots lie in a flat list — today's behaviour exactly. **With no workspace, an agent may spawn children only into its own parent session's environment** | A hidden default workspace. It would lie in the UI, and "the environment list bounds spawning" would become a hole anyone could walk through by simply not creating a workspace |
| **D4** | **The remote durability substrate, when it lands, is a thin `nocx-helper` daemon** holding PTYs and the AD-9 ring and nothing else, over a unix socket in a runtime directory keyed by **host identity** (`helper-D7`'s problem, one step further). A version mismatch **refuses**; it never self-restarts | (a) **tmux/dtach.** It is a second VT engine, and rendering modern agent TUIs flawlessly is the product's table-stakes claim (`vision.md` §4) — inserting another emulator with its own `$TERM`, colour and mouse handling is the degradation nocx exists to remove. It is also a second replay owner against AD-9, and a prerequisite we cannot install ourselves. (b) **nelix-style generations** (`GenerationSupervisor`, `lifecycle_state`, epoch reconciliation). Those exist because *their* daemon carries drivers, a classifier and session state, so a mixed-version daemon is a correctness bug. Ours carries none, so the version-addressed install we already have (`helper-D7` + `helper-D25`) **is** the generation mechanism. (c) **Self-restart on version mismatch**, which `herdr --remote` does and which can kill a live session |
| **D5** | **Durability is deferred.** At stage 1, workers die with the backend — herdr's behaviour, accepted deliberately | Building D4 now. `vision.md` §11's own counterweight applies: MVP is not closed, and this would be starting a second product inside unfinished work. Deferring costs nothing later because `helper-D15` already reserved the protocol room |
| **D6** | **A parent's death never closes its children** — not on process exit, not on a backend restart, not on a dropped link. Only an explicit human act may, and closing a tab with live descendants **asks** rather than decides | Closing the subtree with its root. Three of the four ways to lose a parent are *failures*, and a failure carries no information about whether the work is still wanted. This rule is free to state now and expensive to reverse once habits form |
| **D7** | **A dead node reads as dead.** State is restored, never re-synthesised into something that looks alive | Reconstructing session shape on restart the way herdr does, where "агенты с поддержкой resume поднимаются" but arbitrary processes silently do not. A tree with three dead nodes drawn as live is a tree that lies — AGENTS.md: "A soft degrade must be visible in the product, not only in a log" |
| **D8** | **An agent addresses its own subtree only** — never its parent, never a sibling. Upward communication is by **event**, not by addressing: a child raises an event, the parent reads the attention queue | Letting a child address its parent. It would make the boundary advisory. The event channel loses nothing: a coordinator sees its workers because they are its children, and hears about them because they raise events |
| **D9** | **Spawning a child is the `delegate` effect** from ADR-0020's lattice, over the resource `environment`, and is permitted only into an environment the workspace lists (or, per D3, the parent's own). Reaching further is scope expansion and escalates | A free `spawn` capability. An agent that may spawn anywhere grows its own sandbox sideways and the tree becomes decorative |
| **D10** | **The git panel follows the active tab.** The session remains the sole owner of "which repository"; the workspace influences only where a new session opens | The panel following the workspace. It is a second owner of one input — the failure AGENTS.md is largely built around — and the loser goes on advertising what it can no longer deliver |
| **D11** | **Agent state is a state machine driven by events, each stamped with a provenance tier** (§5). A hook emits a `declared` event; a title match emits a `declared-anonymous` event; a screen match emits an `inferred` event. Precedence is time order, not source rank | One `status` field with source priority. It produces a stuck `done`: the hook fires at end of turn, the agent resumes without firing (hooks do not cover everything), and a higher-ranked stale value outranks a fresh lower-ranked one forever. It also cannot express "the turn ended but the work has not" |
| **D12** | **Detection rules are local, user-editable settings with shipped defaults, switchable off per agent, and accompanied by a live "what is this agent emitting" view** | herdr's remote manifest catalog (`ManifestCatalog`, `AgentRemoteStatus{cached_version, attempted_version, last_checked_unix}`). It is right for a public product supporting twenty agents for strangers; for us it is a network dependency for correct behaviour, against `vision.md`'s "no cloud, ever". With four agents in practice, a rule the user fixes in thirty seconds beats waiting for someone else's release. **The emitting-view is not optional** — a rule the user must write blind is a dead rule |
| **D13** | **The external control surface is reached with a per-session capability token in the environment**, resolved by the socket to that session and **narrowed** to its subtree | herdr's `HERDR_ENV=1`. A boolean tells the agent it is inside; it bounds nothing, and any process reaching the socket gets the whole server. D4 of the helper design already stated the rule: "the port is not the authenticator; the capability is" |
| **D14** | **Worktree discovery returns everything with a reason attached; the surface decides what to show and always states how many it hid** | Silent filtering. Which worktrees to hide is a UX question the owner wants to settle by trying — that is fine and cheap, *provided* the deferral cannot ship silent hiding in the meantime. orca has already erred in both directions here (#9388: "broader matches can hide legitimate user worktrees") |

## 4. The model

```
Workspace  (optional, user-created, host-agnostic)
  ├── policy ────────────────► mints a grant at session creation
  └── rows: [(environment, path?, git binding?), …]   zero or more, none primary

Session    (server-authoritative, AD-7)
  ├── sessionId       assigned by the server, as today
  ├── parentId        assigned at creation, never editable
  ├── workspaceId     nullable
  └── grant           minted at creation; immutable for the session's life
```

**Three shapes fall out without a branch in the model:**

- **the coder** — one row, environment `local`, path `~/repos/nocx/…`, git-bound. This is the
  `nocx / silver-river-0fc7` row in the owner's herdr screenshot;
- **the folder** — one row, no git binding. orca reaches the same place by projecting a
  "folder workspace" into the `Worktree` shape (`folder-workspace-worktree.ts`); we get it for
  free because rows are heterogeneous by construction;
- **devops / GitOps** — one git-bound row (`local`, `~/repos/ansible`) plus three unbound rows
  (`deploy@srv-01`, `…-02`, `…-03`). The repository is where the work is *authored*; the
  environments are where it *lands*. A pull-based GitOps host that also has a checkout is just
  another git-bound row, not a special case.

**Why the environment list is not merely UX:** ADR-0020's resource scope names *environments*
first, and the grant is minted over resources and effects. So the row list is literally the
policy's subject — "this workspace touches `srv-01` and `srv-02` as `deploy@`; production
`srv-03` is not in it" becomes something checked rather than something written on a label.

**Where the boundary is not.** Environments are shared. Two workspaces may both list
`srv-01`, and on that machine there is no wall between them. The workspace bounds
**reachability** — in the UI and in the grant — never **blast radius**. This is ADR-0020's
second objection to workspace-as-principal, and this design does not repeal it.

## 5. Agent state: a ladder of five provenances

`vision.md` §11 states that OSC 133 answers "did this command finish?", "which is the same
question as 'is this agent done?'". **That is false for agent TUIs**, and this repository
already found it out: the git-manager design's D13 rejected OSC 133 command-end because
"**an agent is one long command**". An agent process starts once and does not end between
turns, so the marker never fires.

Both prior-art projects converged on the same answer from opposite directions — herdr ships
twenty TOML manifests matching literal UI copy against screen regions; nelix calls per-tool
drivers "irreducibly per-tool" and budgets the cost explicitly. Both scrape because both are
*outside* the agent. nocx is not, for the cases that matter most.

| Tier | Source | Trust | May wake your phone? |
|---|---|---|---|
| 1 | **Known** — our own agent; the loop is ours (ADR-0028) | fact | yes |
| 2 | **Declared, authenticated** — a hook on the ADR-0024 channel → `notify.raise` | fact, attributed | yes |
| 3 | **Declared, anonymous** — the terminal title (OSC 0/2) | the agent means it; anyone on the tty may say it | **no by default**, per-agent opt-in |
| 4 | **Observed** — pty facts: process exit, alternate screen entered, blocked reading stdin, silence for *N* | observation | no |
| 5 | **Inferred** — pattern match against the bottom of the screen | heuristic; **override only**, never the primary source | no |

Tier 3 is the class ADR-0024 exists to name, and it is where termic reads state from. The
title is a far more stable signal than screen copy because it is a deliberate status field
rather than decoration — but it is written on the same anonymous channel, so a file containing
`ESC]0;Action Required BEL` would push a notification from a `cat`. Hence the conservative
default.

`nocx-hz94`'s acceptance criterion — "**a heuristic event never reaches a target**" — is
already the rule this table implements; the tiers give it defined values, and `nocx-9zmc`'s
backend-stamped provenance is already where the tier rides.

**Two questions, not one.** termic's "Still working (screen → not done yet)" exists "for
agents that background work and end their turn anyway, so the title says idle while the job
runs". So *has the turn ended* and *has the work ended* are different, and a single state
cannot carry both. The attention queue already distinguishes them: "finished while unfocused"
is the turn, "running too long" is the work.

**Launch configuration is data, per agent** (termic's shape, worth taking whole): command,
default args with placeholders, YOLO args, `--session-id {UUID}` / `--resume {UUID}`,
`--name {WORKSPACE_SLUG}`, environment lines. One subtlety is load-bearing for D2: in a
worktree row each tree has its own directory, so the agent's most-recent-CWD session *is* that
row's session and `--continue` is correct; in a shared main checkout it would lasso unrelated
sessions, so an explicitly minted UUID is required instead.

## 6. The control surface

**One dispatcher, two callers** (AD-8: variation is expressed by the interface, never by a
fork inside an implementation).

- The **built-in agent** reaches it in-process, with a grant minted per run (ADR-0028).
- An **external agent CLI** reaches it over a local socket, presenting a **per-session
  capability token** injected into its environment at spawn. The socket resolves the token to
  that session and hands the caller a capability **narrowed to that session's subtree**.

The narrowing is the mechanism, not a check performed against a claim: per ADR-0028 the caller
"cannot exceed the grant because it never holds more". Claude Code in tab X may open children
of X, read their output, wait on their state and receive their events. Tab Y does not exist for
it — not because a check refuses, but because nothing it holds names Y.

**A spawn request may never ride the byte stream.** ADR-0024 settled this at cost: OSC 133 is
an anonymous broadcast channel, so a `cat` of a hostile file would open tabs. Spawn requests
ride the authenticated channel (`nocx-u7uh`).

## 7. What is deliberately out

- The remote `session` service, a daemon, reattach, replay across a host boundary, orphan
  reaping and adoption (D5). Reserved by `helper-D15`; not built.
- Generation machinery of any kind (D4b).
- A remote manifest catalogue or any network fetch of detection rules (D12).
- Any change to the horizontal tab strip, and any change to `nocx-jv3q.1`'s grouping key.
- Windows remote hosts; anything the underlying epics already exclude.
- The orchestration *plugin* of `vision.md` §11. This design is the "smallest first step"
  that section names, and deliberately not the step after it.

## 8. What must not be deferred, and why

Everything above is deferrable except two fields and one rule, and the argument is `nocx-if6`
phase A's, reused without modification: retrofitting session identity after tabs, restore, the
ledger and blocks all key on a bare `sessionId` is a wide, unpleasant change, while adding it
now is mechanical.

1. **`parentId` on the session, server-authoritative.**
2. **`workspaceId` on the session, nullable, server-authoritative**, with the grant minted at
   creation.
3. **D6** — a parent's death never closes its children. Free to state now; once shipped the
   other way, it is a behaviour change, not a code change.

## 9. Amendments this design owes other documents

Each is a correction to a document that is currently wrong or currently silent, and each lands
with the work rather than after it.

1. **`docs/vision.md` §11** — the claim that OSC 133 answers "is this agent done?" is false for
   agent TUIs, and the git-manager design's D13 already contradicts it. §11 is the stated
   foundation for orchestration, so the error is load-bearing.
2. **ADR-0020 §5** — record *why* lineage survives the rejection of workspace-as-principal:
   the rejection's stated reason is that "membership changes by drag and drop", and parentage
   does not. Without this clause the next reader sees a design that walked around an accepted
   ADR. Also record that the workspace-with-rights the owner asked for is the ADR's own
   *minting* role, and that moving a session between workspaces therefore does **not** change
   its grant.
3. **`.internal/specs/2026-08-06-git-manager-design.md` line 251** — the exclusion of
   "worktrees as a list" is justified by "nocx has no 'project' concept". The workspace is that
   concept; the exclusion now needs a different reason or none.

## 10. Epic decomposition

This is more than one epic, and `vision.md` §11 warns specifically against bundling a second
product into unfinished work. **A is valuable alone** and is the only piece whose cost rises
with delay.

| | Epic | Depends on | Note |
|---|---|---|---|
| **A** | The session knows who opened it and what it belongs to — `parentId`, `workspaceId`, grant at creation, D6, D7 | — | No new UI. The non-deferrable half (§8) |
| **B** | Workspaces as a surface — the panel, heterogeneous rows, new-session behaviour, the stitch with `nocx-jv3q` | A | Carries the `nocx-jv3q.1` reconciliation |
| **C** | An agent addresses its subtree — `delegate`, spawn over the ADR-0024 channel, the capability token, the trust ladder | A, `nocx-dw3` | Where §5 and §6 land |
| **D** | Worktrees as a list | A, B | Unblocks the git-manager exclusion |
| **E** | The remote `session` service | A, `nocx-457v` | Deferred (D5). Spends `helper-D15`'s reservations |

## 11. Open questions

Marked open rather than answered by the author.

1. **The stitch with `nocx-jv3q`.** Workspace filters and lineage groups, and both `jv3q`
   decisions survive — but the strip's concrete behaviour when a workspace is active, and what
   `Cmd+1..9` selects then (`jv3q.1` has an explicit assertion about this), is not designed
   here.
2. **Worktree list hygiene.** Which worktrees to hide — the twenty-five under
   `~/.herdr/worktrees/` today, and whatever the next tool creates — is deferred to trying
   (D14 keeps the deferral honest). orca's prefix list and its bug #9388 are the prior art in
   both directions.
3. **The removal fence.** A session open in a worktree being deleted. orca fences PTY and
   watcher installs and has the renderer *recognise* the fence so a doomed pane does not
   surface it as a terminal error. We have no such situation today and will after epic D.
4. **The capability token's exact shape and lifetime** — minted per session, but whether it is
   revocable, whether it survives a backend restart, and what an external agent sees when it
   does not.
5. **Whether a child may ever belong to a different workspace than its parent.** This design
   assumes not (D3's reasoning), but the assumption has not been tested against a case where
   the owner would want it.
