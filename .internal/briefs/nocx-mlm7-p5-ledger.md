# P5 — one running block, one dormant transition record (`nocx-y5v5`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then N6 in §2, §5.3 and
§6 of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

## What you build

The model that lets a command **hand over** to an environment without either lying about it
or growing a second running block.

When a hand-typed `ssh` succeeds, two lifecycle facts are true at once: the `ssh` process is
still running and will one day exit with a real status, and the user is now typing commands
that belong to the far host. Today the ledger has one running slot and the block manager
finalises whatever is running when the next block starts — so one of those two facts always
gets destroyed.

The owner's decision is that **the UI keeps exactly one running block**. The model does not:
it grows a **dormant transition record** — open, not running, invisible as a block — which
the local D later completes with the real exit code (typically 255 when the connection
dropped).

## Files you own

`frontend/src/command-ledger.ts`, `frontend/src/scrollback/blocks.ts` and their tests.

Do not touch `terminal-content.ts` (P9 drives your API from the marker side; you provide it
and test it directly), `ssh-transition.ts` (P4), or `capability.ts` (P3).

## What must be true when you are done

- at most one running block exists in the UI at any moment; starting a remote command while
  a transition is dormant does **not** finalise or destroy the transition.
- freezing on entry paints the block as **neither success nor failure** and shows **no exit
  code**. Note `freezeBlock` currently renders `exitCode === null` as a failure — that is the
  bug this must not inherit.
- the dormant record calls no completion callback while dormant, reaches `history.record`
  **exactly once**, and does so only when the local D arrives.
- `entered` is a lifecycle/presentation state and **never** a `CommandStatus`. That enum is
  reflected in `contracts/history.query.schema.json`; an unfinished `entered` must never
  reach persisted history, and you must not change that contract.
- state-machine tests cover, at minimum: enter; several remote commands while dormant;
  disconnect (the active remote command becomes `interrupted`/`unknown` with reason
  `transition-lost`, and the transition takes the local D's code); ordinary `exit`; `Ctrl-D`
  with no running remote block; and a second `ssh` from inside — which in this epic never
  happens, so assert the model refuses to open a second dormant record rather than silently
  nesting.
- no duplicate `onComplete` on any path, and none at all for a record that never entered.

## Deliberately not yours

Deciding _when_ entry happened — that is the passport (P2) consumed by P9. You expose
`enter()`, `completeTransition(exitCode)` and whatever the state machine needs; your tests
call them directly.

## Verify

`cd frontend && ./node_modules/.bin/tsc --noEmit` and vitest scoped to
`src/command-ledger.test.ts` and `src/scrollback/blocks.test.ts`. Nothing repo-wide.
