# ADR-0077 — The lifecycle stream resumes at the coordinator's own cursor

- **Status:** Accepted
- **Date:** 2026-09-30
- **Decided by:** the owner, 2026-09-30 (recorded on `nocx-zg3k3.5.11`): "The old coordinator
  accepted something and wrote it into its database. The coordinator should say from which mark it
  needs events. For old events the helper no longer has, mark the blocks from what the helper
  reports." — and "yes" to the restatement: the lifecycle leg resumes from the coordinator's own
  stored cursor, as the PTY leg does; what it already applied is never replayed; what happened while
  it was away arrives once; a range the helper no longer holds is marked with its loss cause.
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
   re-adopt already reads (`content.Session.LifecycleApplied`, `RecordLifecycleApplied`). The
   binding is born with it at 0, because the leg attaches at the stream's start and its bridge starts
   only after the binding is written.
2. **The cursor is stored after the frame's effect, on the path that applied it, before the next
   frame is read.** The adapter reports each frame's end once the kernel has returned from it (a
   refused frame too — resuming before it would only offer it again), and the report writes the
   cursor synchronously, so the stored cursor never covers a frame whose effect is not stored. A
   coordinator going away finishes the frame it is applying — its effect and its cursor both land —
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
- **"Stored with its effect" is ordered, not transactional.** A frame's effect is itself several
  writes (a ledger entry, an execution, a block's artifact), and the cursor is one more after them.
  A process killed between the last of the frame's own writes and the cursor's write re-delivers that
  one frame to the next coordinator — never more than one, and never a skip. A single transaction
  spanning the effect and the cursor would close that window and is not built here; it needs the
  ledger's writes for one frame to share a transaction first.
- A coordinator's orderly shutdown waits for the frame it is applying, however long that frame's
  effect takes.
- Round 1's seam test that pinned the base resume is replaced by one that pins the stored cursor
  and one that pins the head for a binding without one.
