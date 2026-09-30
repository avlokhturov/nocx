# ADR-0077 — The lifecycle stream resumes at the coordinator's own cursor

- **Status:** Accepted
- **Date:** 2026-09-30
- **Decided by:** the owner, 2026-09-30 (recorded on `nocx-zg3k3.5.11`): "The old coordinator
  accepted something and wrote it into its database. The coordinator should say from which mark it
  needs events. For old events the helper no longer has, mark the blocks from what the helper
  reports." — and "yes" to the restatement: the lifecycle leg resumes from the coordinator's own
  stored cursor, as the PTY leg does; what it already applied is never replayed; what happened while
  it was away arrives once; a range the helper no longer holds is marked with its loss cause. And,
  the same day, on the escalation of this record's first draft: applying one lifecycle frame and
  storing the cursor are ONE SQLite transaction — no window in which a killed process re-delivers a
  frame — and every write a frame causes is idempotent, keyed by a stable identity of the block, so
  a frame delivered twice is a no-op.
- **Supersedes:**
  - [ADR-0024](0024-authenticated-shell-integration-channel.md), the 2026-09-02 amendment's bullet
    "The re-attachment resumes at the lifecycle window's HEAD, not its base." The re-attachment now
    resumes at the coordinator's own stored cursor; the head survives only as the answer for a
    binding that stored none. The bullet's REASON is kept whole — a replay from the base would
    re-deliver authenticated events into the new kernel — and this record is built on it.
  - The base resume of `nocx-zg3k3.5.11` Round 1 (`8b0586758`), which was never an accepted
    decision and contradicted that bullet.
- **Related, and NOT superseded:** [ADR-0076](0076-the-coordinator-going-away-changes-no-block.md)
  (decision 4 — an end the helper saw while the coordinator was away closes the block on return — is
  what this record delivers); [ADR-0024](0024-authenticated-shell-integration-channel.md) otherwise,
  including adoption itself.
- **Beads:** `nocx-zg3k3.5.11`.

## Context

When the coordinator (`nocx-server`) restarts, the helper keeps the shell and a bounded window of
the lifecycle bytes the shell wrote. The replacement adopts the shell's domain and attaches to the
session again, and it must say where in that lifecycle stream it wants to start.

Two answers had been tried, and each was wrong in one direction:

- **The window's head** (ADR-0024's amendment). Nothing is re-delivered, but every frame the shell
  spoke while no coordinator was attached is skipped — the end of a command that finished while
  nocx was away never reaches the new kernel, and its block stays running. ADR-0076 decision 4 says
  such an end settles the block.
- **The window's base** (Round 1). Nothing is skipped, but every frame the previous coordinator
  already applied is re-delivered with a capability the adopted domain still honours:
  `TestTheAdoptedChannelDoesNotReplayCommandsThatAlreadyRan` fails with the first command authenticated
  a second time.

Neither the head nor the base is a fact about what the previous coordinator did. Only the
coordinator knows that, and the PTY leg already works this way: it resumes from the recording's
length — what this machine stored — and never from anything the helper guesses.

## Decision

1. **Each coordinator keeps its own lifecycle cursor, and the next one resumes there.** The cursor
   is a `proto.StreamOffset` into the helper's lifecycle stream — one past the last frame this
   coordinator applied — and never a wall-clock time. It is kept in the session's binding, the row a
   re-adopt already reads (`content.Session.LifecycleApplied`). The binding is born with it at 0,
   because the leg attaches at the stream's start and its bridge starts only after the binding is
   written.
2. **A frame's writes and the cursor past it are one transaction.** `content.ApplyLifecycleFrame`
   runs the kernel's ingest of one frame under a context that carries the frame, and every store
   write the frame's projection makes under it — the entry, its execution, the block's artifact, the
   settle of a block the frame ends — joins one SQLite transaction whose last statement moves the
   cursor. They commit together or not at all: a process killed anywhere inside the frame leaves the
   store exactly as it was before it, and the next coordinator applies the frame once. A write that
   fails inside the frame fails the frame, and a failed frame commits nothing, cursor included; the
   leg then applies nothing more (an adapter halt, as a handover ends it — the shell's transport did
   not fail and nothing is marked lost), so no later frame is stored past one the store does not
   hold. A refused frame is scoped like any other: the stream carried it and the coordinator dealt
   with it. A coordinator going away finishes the frame it is applying — its transaction commits —
   and applies nothing after it: that frame is the next coordinator's.
3. **Nothing before the cursor is re-delivered; everything after it is delivered once.** A command's
   end spoken while nobody was attached reaches the returning coordinator exactly once and settles its
   block, however many times the coordinator is replaced around it.
4. **A binding with no cursor resumes at the head.** A coordinator that holds no record of what was
   applied may not offer any of it again; ADR-0024's answer stands exactly where nothing better is
   known.
5. **A cursor the helper no longer holds is a stated loss.** When the helper's window has moved past
   the cursor it answers from its base (`Resume.Reset` with a `Gap`), and the frames between are
   gone. The session's open block — the one those frames could have settled — is sealed as a block
   whose boundary never arrived whole (the store's `gap` truncation, the same statement a lost
   boundary makes) and its entry closes `unknown`. It is never left running on the hope that its end
   was not in the gap. The trigger is the helper's own statement of the loss (ADR-0076 decision 2).
6. **A replay's end waits for the replay to be applied, not merely read.** The per-session end hold
   (`ws_end_hold.go`) lifts when the leg's applied cursor reaches the window's head, or the leg
   stops — not when its bytes were read, since read bytes are not yet facts the kernel has published.

7. **A repeated frame is a no-op by the identity of its block, not only prevented by the cursor.**
   The cursor keeps a frame from being offered twice; identity makes a frame offered twice
   harmless. Every shipped shell that speaks the channel (bash and zsh; the POSIX tier has none,
   by design) mints an attempt id per command at start and names it on the start AND on the
   complete (script version 55), so every frame of a command carries the same stable name for its
   block, whatever coordinator applies it. The kernel resolves a named completion the way it
   resolves a snapshot's `last_completed`: exact id, then this domain's alias. A command the shell
   started is stored under that id; one submitted from nocx's editor is stored under the app's id,
   and its execution records the shell's id beside it (`StartExecution.ShellAttempt`), so a
   coordinator that knows the command only by the shell's id finds its entry by that id
   (`EntryForShellAttempt`, `storedAttempt`) instead of opening a second one. What each frame kind
   does when offered again to a fresh coordinator over the same store: a start finds its entry
   already bound and starts nothing; a complete finds its entry closed and changes nothing, and
   never closes the running next command in its place; the shell's exit settles nothing already
   settled; a snapshot is refused, because a fresh kernel asked for none.
8. **A frame holds its lane's emission turn from its first write to its end.** `Publisher.Ingest`
   takes the lane's turn before the kernel sees the frame. ReplayLane takes the same turn and then
   writes the store; were a frame to hold the store's connection and then wait for the turn, the two
   would wait on each other.

## Why not the helper's acknowledgement cursor

The helper already keeps a per-subscriber lifecycle `acked` cursor, and it is the obvious thing to
resume from. It cannot serve. The coordinator acknowledges lifecycle bytes as its reader hands them
to the bridge (`internal/helper/client/sessions.go`, `attachedLifecycle.Read`), before any frame is
decoded or applied, so the ack runs ahead of the effect by exactly the frames a coordinator dying
mid-stream loses. And it is keyed by a subscriber id each attachment mints afresh
(`session_readopt.go`, `rand.Read(subscriberRaw[:])`), so the next coordinator has no way to name the
previous one's cursor. A cursor that must survive the process has to live where the process's
effects live — the coordinator's store.

## Consequences

- `TestTheAdoptedChannelDoesNotReplayCommandsThatAlreadyRan` passes unmodified: its binding carries
  no cursor, and decision 4 resumes it at the head.
- **The guarantee is transactional.** A frame's rows and its cursor are one commit; there is no
  interleaving of rows stored and cursor not, whether the process is killed, a statement fails, or
  the coordinator detaches. Measured by `TestAFaultInsideALifecycleFrameLeavesNeitherItsRowsNorTheCursor`
  (a fault injected inside the frame's writes and one between its last row and the cursor) and
  `TestAFrameFailedAtTheCursorIsAppliedOnceByTheNextCoordinator` (the process restarts on the stored
  cursor and applies the frame once).
- **What this asks of every caller inside a frame:** each store call it makes carries the context the
  frame handed it. The store holds its one connection (`maxOpenConns` is one) from the frame's first
  write to its end, so a call on the frame's goroutine with any other context waits for a connection
  the frame will never release. The transport's lifecycle projection, the block stream and the
  completion downlink's loss report were threaded for this; a new path that writes the store from
  inside a frame must be too.
- Other store users wait while a frame holds the connection — for the length of one frame's writes.
  A completion the downlink finally gives up on is reported only after its queue has made room, so
  an Accept waiting for room inside a frame is never waiting on that report's write.
- A store failure inside a frame ends the leg for this coordinator. That is the price of never
  storing a later frame past one the store does not hold; the next coordinator resumes before it.
- A coordinator's orderly shutdown waits for the frame it is applying, however long that frame's
  effect takes.
- Round 1's seam test that pinned the base resume is replaced by one that pins the stored cursor
  and one that pins the head for a binding without one.
