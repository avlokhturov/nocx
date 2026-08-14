# ADR-0032 — The vault raises its own unlock

**Status:** accepted
**Date:** 2026-08-15
**Bead:** `nocx-y7fg` (filed 2026-07-31, P0, still open)

## Context

A sealed vault cannot answer for a secret. Something has to ask the person to
unlock it, and today that something is **the caller**.

`RequestUnlock` exists on the transport, and `vault.unlockResolved` is in the
closed ingress-critical set precisely so an unlock resolution can never queue
behind the lane. But the requester is threaded into exactly one call site:

```go
// internal/app/app.go
resolver := connection.NewResolver(
    profileStore, profileStore, v,
    connection.WithUnlockRequester(tp.RequestUnlock),
    ...
)
```

So opening an SSH connection raises the unlock dialog because somebody wired it
there by hand. `secrets.Get(ctx, id)` from anywhere else returns an error, and
that caller is left to describe the obstacle instead of clearing it.

The AI endpoint path arrived without it, exactly as any fourth caller would.
Its Test button reported _"the endpoint's credential is unavailable — unlock the
vault"_ — telling a person to do the thing the product already knows how to
offer. A dead end with good manners.

**This was already diagnosed, correctly, on 2026-07-31.** `nocx-y7fg` says it
in one line — _"Needing the vault is a property of the call, not of the call
site"_ — and then predicts precisely what happened next: _"Doing it per call
site guarantees the next new method reintroduces the bug."_ It was raised P0
and never finished, so the mechanism stayed per-call-site, and two weeks later
`endpoints.probe` became the next new method. `nocx-25k9.22` had fixed an
earlier instance of the same shape before that.

This ADR does not decide anything new. It writes down a decision that was made
once, acted on twice, and recorded nowhere a later reader would look — which is
why it kept having to be rediscovered. The owner, on being shown the third
instance: _"Да, сам vault, когда понимает, что запрос требует хранилище,
должен сам запускать разблокировку. Мы не должны это делать во всех местах, где
нужен vault."_

## Decision

**The secret-access layer raises the unlock, and callers do not.**

A caller asks the vault for a secret. If the vault is sealed, the vault raises
the unlock, waits for the resolution, and answers the original request. The
caller sees a secret or a refusal; it never sees "sealed" as a state it has to
know what to do about.

Threading `RequestUnlock` into the assistant path as well was the obvious fix
and is rejected: it would make a **third** owner of one behaviour, and the
fourth caller would arrive without it for the same reason this one did. This is
AD-8 applied to a behaviour rather than a package — one owner, and the owner is
whoever already has the vault.

## Consequences

- The seam is the DISPATCHER, as `nocx-y7fg` named it: a call that fails for
  want of an unsealed vault raises the prompt and is replayed. That is the same
  one place every control request already passes through — `connMethods` in
  `internal/transport/registration.go`, where the params middleware landed
  today (`3b47ae3`). One wrapper decides validation; the same wrapper is where
  "this call needed the vault" belongs.
- The vault gains a requester seam at the composition root, wired once, instead
  of once per consumer. `connection.WithUnlockRequester` comes off the resolver.
- Cancellation is part of the contract, not an afterthought: a dismissed unlock
  must reach the caller as a distinct, recognisable refusal — the shape
  `VaultOperationCancelledError` already has on the renderer side — so a person
  who chose not to unlock is never shown a failure they did not cause.
- Re-entrancy has to be answered: several requests may reach a sealed vault at
  once and must not raise several dialogs. One unlock in flight, and everyone
  waiting on it resumes from the same resolution.
- Deadlock has to be answered: the resolution arrives over the same socket the
  read loop consumes, which is _why_ `vault.unlockResolved` is ingress-critical.
  A blocking unlock must never be reachable from the read loop itself.
- "The vault may be locked" stops being a product sentence in most places. It
  survives only where a status is genuinely being _reported_ rather than a
  secret being _fetched_ — and `agent.status` must then stop saying it for the
  two other cases it currently covers (no reference at all, secret deleted),
  which are not about the vault being locked.

## Alternatives considered

**Thread the requester into each consumer** — what the code does today. It works
until somebody forgets, and the record shows that somebody forgets: the
endpoints path, written after the mechanism existed, did not use it, and nothing
reported anything missing because nothing required it.

**Report the sealed state and let the surface decide.** Honest, and it makes
every surface reimplement the same dialog-and-resume. It also produces exactly
the message this ADR exists to delete.

**Never seal while the app runs.** Rejected on its face: auto-seal is a feature
and the vault's whole point is that it can be shut.
