# ADR-0036 — An assistant turn is one ledger entry: the question is its intent, the answer is its body

- **Status:** Accepted
- **Date:** 2026-08-23
- **Related:** [ADR-0019](0019-one-authoritative-ledger-disposable-projections.md) (the one ledger; §6 derived
  text is an artifact with provenance, §7 retention evicts bodies and leaves entries),
  the AI-assistant surface design
  (`.internal/specs/2026-08-13-ai-assistant-surface-design.md`, §5 "What lands in the
  ledger" — **superseded in part by this ADR**), the ledger design's §6.1 (the pane is a
  block's durable anchor, `nocx-rtg0.28`), AD-8 (one owner per behaviour), `nocx-4em1z`,
  `nocx-69x9e`.

## Context

The assistant design gave each ask three ledger identities: the frame it referenced, an
entry for the **question**, and a second entry for the **answer**, joined to the question
by a `caused-by` edge. The reason §5 gives is about the answer's BODY: derived text is an
artifact with provenance and never "a string held in a map that dies with the process".

Two things were then observed in the shipped product.

**Dialogues did not survive a restart.** The restore read is `WHERE pane_id = ?` — the
pane is a block's durable anchor because it outlives the backend, while a session does not
(D5). `SubmitAgentAsk` wrote both of its entries with `session_id` and **no** `pane_id`, so
a restored tab found nothing at all: not a mis-rendered dialogue, an absent one. Nobody
had decided that; `entries` has two writers, and the pane-anchor decision reached
`Submit` and never `SubmitAgentAsk`, whose own input struct had no pane field to fill.

**And two rows for one block cost the reader a fold.** On screen a turn has always been
ONE block — the question in the header, the answer in the body — which is the same shape a
command block has. Restoring two rows meant deciding, per row, whether it was a question
needing its answer attached or an answer needing its question, from a link the wire did
not carry. The owner, shown this: «вопрос — это команда. А ответ — вывод. Зачем что-то
изобретать?»

## Decision

**A turn is one entry.** `kind = agent`, the question is `intent`, and the answer is an
artifact on the turn's own run execution. There is no answer entry and no `caused-by` edge
between them.

**The turn is anchored to its pane, and the transport is what anchors it.** The renderer
does not send a `paneId`: the backend already resolved which pane a session is the pipe
of, and `ledger.open` states in its own comment why a second copy on the wire is wrong —
"a paneId on the envelope would put the same input under a second owner, and the
renderer's copy would be the one nobody checked".

**One id on the wire.** `agent.ask` answers with `entryId` where it used to answer with
`questionId` and `answerEntryId`. Deltas, reasoning, tool-call lines and the copy path all
address the turn.

## Consequences

**§5 of the assistant design is superseded on this point and only this point.** Its stated
reason survives intact: the answer is still an artifact with provenance, not a string in a
column (ADR-0019 §6). What is dropped is the answer's separate identity — which nothing
used as an identity. It was an ADDRESS for the stream, and the turn's own id is that
address.

**Restore needs no new fact to tell a turn from a command.** A command's drawn body is
`application/vt`, with its `text/plain` copy marked `derived_from` it; a turn's body is a
`text/plain` original and no terminal body is ever written for one. So the block's grammar
— a grid must not re-wrap, prose must — is read from a stored fact. A stored `role` column,
a backend-derived `role`, and splitting author from kind were each considered for this and
are each unnecessary. The last remains true as a defect and is filed separately
(`nocx-69x9e`): `entries.kind` is documented as the author and also carries what the row
is, so a question the person typed is stored saying the agent authored it.

**A turn is a block, so it appears where blocks appear.** `blocks.list` therefore offers
the model only entries that have ENDED — otherwise the open entry in the pane is the
question being answered right now, and the model is handed its own unanswered question as
context. The same rule covers a command still running.

**The reasoning is not persisted, deliberately** (the owner's call, same session): it is
several times longer than the answer and closed by default, so a restored turn has no
reasoning note at all rather than an empty one.

**A tool call stays its own entry and stays out of the restore** — "an action has no block
and no command line". It is drawn as a line inside the turn's flow. It is currently
anchored to nothing at all, which means a restored turn comes back without the calls it
made; `caused-by`, freed by this decision, is the relation that will join an action to its
turn.
