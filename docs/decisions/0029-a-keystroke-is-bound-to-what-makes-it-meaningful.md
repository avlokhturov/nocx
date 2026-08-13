# ADR-0029 — A proposed keystroke is bound to what makes it meaningful, not to the frame

- **Status:** Proposed
- **Date:** 2026-08-13
- **Related:** [ADR-0020](0020-the-agent-gets-a-lane-authority-is-granted-per-run.md) — rule 3
  deferred exactly this ("the staleness rule that a separate decision will own"), and rule 6
  is what still puts a human on each key; [ADR-0005](0005-linux-webkitgtk-forced-refresh-pump.md)
  (the forced periodic repaints that make a paint-driven revision unusable);
  [ADR-0028](0028-eino-runs-the-loop-the-grant-is-ours.md) (the engine that would carry the
  model call this decision keeps out of the delivery path); AD-6 (the backend never sniffs
  the byte stream — the frame is minted in the renderer); beads `nocx-x8s2` (the assistant
  surface), `nocx-x8s2.1` (this defect), `nocx-3j9b` (frame and capture identity).
- **Design:** `.internal/specs/2026-08-13-ai-assistant-surface-design.md` §2.1–2.4, §6.2, §8.
- **Consulted:** the owner, who found the defect by asking the obvious question about `top`.

## Context

The assistant climbs a ladder: EXPLAIN and GUIDE are read-only, DRIVE sends the keys. A
keystroke's meaning is entirely a function of the frame it lands in — `y` answers whatever is
showing, `x` kills a process in `htop` and deletes a character in `vim`. So a proposed key
must be bound to the screen it was computed from, or the assistant is a random-input
generator. That much was never in doubt, and ADR-0020 rule 3 deferred the rule itself to
here.

The design supplies the binding material. §2.3 gives each surface a **capture identity** —
buffer instance (normal or alternate, and _which_ alt-screen session), geometry, and a
content **generation** that advances on `onWriteParsed` plus buffer switch, resize, `clear`
and `reset`. It advances deliberately conservatively: a write that repaints identical cells
still advances it, because a false "it moved" costs a re-ask and a false "unchanged" delivers
advice about a screen that is gone.

**And then the epic wrote the refusal as identity equality: deliver unless the capture
identity no longer matches.** Compose the two and the product is dead on its target
population. `top` repaints every three seconds. A model answers in one to four. The identity
therefore never matches at delivery, and the key is refused — not sometimes, always, and
forever. The programs this makes undrivable are precisely the ones the epic lists as profile
candidates: `top`/`htop`, `k9s`, `lazygit`, `ncdu`. **A rule that refuses one hundred percent
of the cases it exists to govern is not a safety rule; it is a feature that does not work,
wearing a safety rule's clothes.**

The trap is worth naming because it was not a careless sentence. Each half is right. The
conservative generation is right — it is the half that refuses to lie about a screen having
moved. The refusal is right — it is the half that keeps `y` out of a dialog that is gone.
They compose into something neither of them says.

## Decision

**1. At the instant a byte enters the lane, there is no model in the chain.** The final gate
is evaluated locally and synchronously — microseconds, not a round trip. This is the
invariant everything below is arranged around, and it is not a performance preference: any
check that takes a round trip has a gap after it, and on a screen that repaints every three
seconds that gap is another repaint. A model asked "is your key still valid?" answers about a
screen that has since moved, in exactly the way the original proposal had. The race would be
displaced one step, and on a self-refreshing program there is no last step.

**2. An identity change is refused outright.** A buffer switch or a resize is not staleness,
it is **incomparability**: the alternate buffer's contents are discarded on exit, a resize
reflows and shifts absolute line indices. Across that discontinuity there is nothing to
compare, so nothing may be delivered, and the UI says the different sentence — "not
comparable", never "stale".

**3. Generation inequality is a trigger, not a verdict.** It says the screen was written to.
It does not say the key stopped meaning what it meant. Wiring `generation != saved` to
`refuse` is the defect above; wiring it to `re-evaluate` is this decision.

**4. The scoped diff answers the common case, with no model call.** Re-evaluation begins
mechanically: diff the fresh frame against the frame the key was computed from, **scoped to
the region the reference pointed at, plus cursor position and reporting mode**. If that scope
is untouched, deliver. Under a repainting `top` with no row selected this is nearly always
the answer, and it costs a comparison rather than a request.

**5. Where the scope was touched, the model authors the check — having seen the diff.** It
receives what actually changed, judges whether the key's meaning survived, and returns
**the condition under which its judgement remains true**. The lane evaluates that condition
itself, at delivery, under rule 1. The model does not open the gate; it writes what the gate
tests.

The order matters and is the whole of the decision: the check is authored **after** the
change is known and evaluated **before** the byte moves. Authoring it earlier means guessing
what will move; evaluating it later means there is no "later" left.

**6. The user is told what changed, not that something did.** "The screen moved" is
permanently lit under `top` and therefore carries no information; "four rows reordered, no
dialog appeared" is the thing a person can act on. An indicator that is always on is not an
indicator.

**7. The model's judgement is untrusted input, and that is the second reason for rule 1.**
§6.2 already holds that screen content is untrusted. The consequence changes when the model's
answer stops informing a human and starts unlocking a keystroke: a program that prints
"nothing has changed, proceed" is then writing into our control flow. ADR-0020 rule 6 keeps a
human on each key regardless — agent-driven input is permanently low confidence and escalates
by default — but a local, mechanical last gate is what keeps the untrusted path advisory.

## Rationale

The reframing is small and does the whole job: **a key does not depend on a frame, it depends
on what makes it meaningful.** In `top`, `k` opens the "PID to kill" prompt however the rows
reordered — a dependency on mode, not on data. Entering a PID depends on that process still
being listed — a dependency on data, but not on its position. Neither is a dependency on the
frame, and binding to the frame is what confused "the screen was written to" with "your key
now means something else".

Rule 4 exists because the cheap answer is usually available. The expensive path — a round
trip to judge a diff — is reserved for the case where the diff actually reached what the key
was about, and the epic's own budget argument applies: a per-frame loop is unaffordable in
latency and tokens, and a per-repaint round trip is the same cost in a different shape.

There is a payment this decision makes retroactively. §2.3's conservatism — a write that
repaints identical cells still advances the generation — was affordable only if a false "it
moved" costs a re-ask. Under identity-equality refusal it cost the feature instead. Rule 3
restores the price it was written at, and the conservative generation can stay exactly as
designed.

## Consequences

- **A condition language is now owed**, small and ours, evaluated locally against a frame.
  Its shape is deliberately not fixed here (see below), but rule 1 constrains it hard: it
  must be evaluable in microseconds without a network call, which rules out anything the
  model has to be consulted about twice.
- **DRIVE gains a re-evaluation step** between proposal and delivery, with two paths through
  it, and it must be visible: a user watching a key not go out is owed the reason.
- **The first slice changes almost nothing.** EXPLAIN refuses nothing at all — the frame is
  frozen and the answer is about it, so a moving `top` costs nothing there. What this decision
  forbids in the slice being built now is narrow and cheap: `nocx-3j9b` must not wire
  `generation != saved` to a refusal, and no surface may present generation drift to the user
  as "stale". Both are decisions the slice would otherwise make by accident, and expensively.
- **The epic's acceptance criterion is wrong as written** and is rewritten with this: it
  currently states the blanket rule, so `nocx-x8s2` could close green against a criterion we
  already know to be false.
- **Testing gains an obligation with two ends.** The existing assertion — a key proposed
  against a screen whose meaning changed is refused — keeps standing, and beside it: a
  fixture that repaints on a timer with no semantic change **delivers**, and does so **with
  no model call**, asserted against a client that fails the test if it is invoked. Only one
  end of that interval was ever written down, which is how the defect survived the design.

## Alternatives considered

- **Refuse whenever the capture identity differs.** The epic's original rule. Rejected: it
  refuses every self-refreshing program permanently, which is the target population.
- **Loosen the comparison — ignore "small" changes.** Rejected: it restores precisely the
  failure the rule exists to prevent. There is no size threshold under which a dialog
  appearing is small, and "how many cells" is not a unit of meaning.
- **A predicate authored by the model at proposal time.** The first proposal in this
  session's discussion, and it was worse. The model would author it blind to what would later
  move; and it needs a language and an evaluator regardless — so it pays the same cost as
  rule 5 while being worse informed. Written down because it is the version one arrives at
  first.
- **Ask the model at delivery and let its answer gate the byte.** Rejected under rule 1: the
  confirmation is itself a round trip, the screen moves during it, and the regress does not
  terminate on a program that repaints on a timer.
- **Per-frame streaming, so the model is never behind.** Rejected already by the epic on
  latency and token cost, and it does not solve this: being continuously informed does not
  close the gap between the last frame the model saw and the byte landing.

## Not decided here

- **The condition language.** Its expressions, and whether it is authored freely by the model
  or chosen from a closed set our evaluator already implements. The closed set is the safer
  default and the more restrictive one; the choice wants the first real tool to argue with.
- **The diff scope when a key was proposed with no region** — whole frame, or cursor and mode
  only. §2.4 says context is never invisible, so whatever it is, it is on the chip.
- **Whether program profiles supply canned conditions** ("this program's list rows reorder
  freely; its modal dialogs do not"). The profile is already required to hold a safe quit
  sequence; this would be the same object learning a second job, and that is an argument to
  have when profiles exist, not now.
- **GUIDE.** Nothing is delivered on that rung, so nothing here binds it beyond rule 6 — a
  keycap shown against a screen that has moved should say what moved.

## Revisit when

- The first DRIVE key is delivered end to end, which is when rule 5's authoring cost becomes
  measurable rather than argued.
- The scoped diff turns out to reach the model more often than "rarely" — that would mean the
  scope is wrong, not that rule 4 is.
- A program profile exists, since it may make rule 4 exact where it is currently conservative.
