# ADR-0017 — A connection references a secret, not a credential

- **Status:** Proposed
- **Date:** 2026-07-31
- **Related:** ADR-0006 (reusable credentials), ADR-0011 §2 (secrets as opaque
  references), ADR-0016 (a secret owns its name), beads `nocx-b5bu` (a secret saved on
  the Secrets page cannot be attached to a connection), `nocx-gqzg`, `nocx-cx03`
- **Supersedes, if accepted:** ADR-0006's credential as a thing the user picks. The
  aggregate's other jobs are re-homed rather than dropped; the Decision says where each
  one goes, and none of them may be deleted before its replacement carries the same
  guarantee.

## Context

A user saved a password on the Secrets page, opened the connection editor, and could not
choose it. The Credential select offered one entry: "— None (specify below) —".

That is not a missing option. It is the model working exactly as designed, and the design
has drifted out from under itself.

**What the model is today.** A profile references a `credentialId`. The credential is a
reusable identity — username, auth mode, key path — that owns `Versions []CredentialVersion`,
and each version holds the opaque `SecretID`s. The connection editor therefore enumerates
**credentials**. A secret created on the Secrets page belongs to no credential, so it is
absent from that list by construction, and no amount of UI work will put it there.

**Why it drifted.** ADR-0006 was written when a secret had no independent existence: it was
an opaque reference inside a credential, and the credential was the only object a user could
name or reuse. ADR-0016 changed that six days later — the vault now persists a display name
per secret, precisely so a secret can exist _before_ the connection that will use it. The
Secrets page is that promise made visible: add, rename, rotate, and (soon, `nocx-pf8b`)
delete a secret on its own terms.

So the product now has two answers to "what is the reusable authentication thing the user
manages", and they are not nested cleanly:

|                                    | Credential           | Secret                |
| ---------------------------------- | -------------------- | --------------------- |
| Has a user-visible name            | yes                  | yes, since ADR-0016   |
| Can be shared across connections   | yes                  | yes                   |
| Can exist before any connection    | no                   | yes, since ADR-0016   |
| Is listed on a settings page       | was, wave 5; removed | yes, the Secrets page |
| Is what the user thinks they saved | no                   | **yes**               |

The last row is the finding. The user saved a password; the product stored a secret inside a
credential and then offered them the credential. Two objects, one intent.

**What the credential still uniquely holds.** Being fair to ADR-0006, three things:

1. **Identity** — username, auth mode, key path. But the profile already carries all three
   inline (`options.user`, `options.auth`, `options.keyPath`), and the editor shows the
   profile's, not the credential's. This is duplication, not a job.
2. **Versions and rollout** — `Versions`, `CurrentVersionID`, `CandidateVersionID`, and
   `rollout.run`, which stages a candidate and probes it before promotion. The backend is
   wired (`app.go:165`) and the method answers on the wire. **The user cannot reach any of
   it:** `RolloutPanel` is imported by its own test and by nothing else, because the
   Credentials page that hosted it was removed. So this is real, tested, unique — and
   currently a feature no user can invoke. It is filed as `nocx-si5z`.
3. **The authorization anchor** — ADR-0006 wave 2 removed host binding and replaced it with
   a computed proof: the saved profile resolves to an effective (credential version,
   endpoint) pair, and that pair is authorised at connect time. The argument there is subtle
   and worth keeping: authorisation is proven from the profile the user selected, never from
   the fact that some _other_ profile uses the same credential at the same endpoint.

Only (2) and (3) are jobs. Neither of them requires the user to see the word "Credential".

## Decision

**A connection references a secret.** The connection editor offers the secrets the vault
holds, and picking one is what "this connection authenticates with that" means. `Credential`
stops being a concept the user selects, names, or is offered.

Three parts, in the order they must land:

### 1. The editor picks a secret

The Authentication section shows User, Method, and — for a method that needs one — a
**secret picker** listing what the vault holds, filtered to the kind the method needs
(`password` for Password, `private-key` for Public Key). Creating a secret inline stays
exactly as it is today: typing a password still stores one, still auto-named per ADR-0016.
What changes is that a secret which already exists is reachable, which today it is not.

The word "Credential" leaves the interface.

### 2. Versions move onto the secret

Rotation belongs to the thing being rotated. The vault gains versioned material — a secret
keeps its `SecretID` and its name across a rotation, and `rollout.run` stages a candidate
version of the **secret** instead of the credential.

This is where the work is, and it is the part that must not be hand-waved: `ReplaceSecret`
overwrites material in place today, so there is no version history in the vault at all. The
rollout machinery is the reason ADR-0006's aggregate exists, and it may not be deleted
before its replacement carries the same guarantee — including the one ADR-0006 states
explicitly, that a rejected candidate is **never** silently retried with the working secret,
because that is indistinguishable from password spraying to the host being probed.

What this is _not_ is a reason to defer the decision. Rotation is unreachable from the
interface today (`nocx-si5z`), so nothing a user can do stops working while versions move.
The order above is about not deleting a guarantee before its replacement exists — it is not
a claim that a working feature is at risk.

### 3. The authorization proof is re-anchored, not weakened

The pair becomes (secret version, endpoint), proven the same way and from the same place:

```
selected saved profile
  -> resolve its group inheritance chain
  -> obtain its effective secretId and secret version
  -> resolve its canonical endpoint once
  -> authorize that (secret version, endpoint) pair
```

Per hop, justified by the effective profile that supplies **that hop's** secret. Nothing
about the argument in ADR-0006 wave 2 changes except the noun.

## Consequences

- **`internal/credential`'s metadata aggregate goes away** once §2 and §3 land. The
  `credential.SecretStore` boundary stays exactly as it is — ADR-0011 §2 is untouched, and a
  secret value still never reaches the renderer.
- **`credentials.*` RPCs are replaced by `vault.*` ones.** `savePassword`,
  `saveKeyMaterial`, `saveKeyPassphrase` become operations on a secret, and each gets a
  contract schema in `contracts/` as it is touched.
- **Profiles carry `secretId` where they carried `credentialId`.** Group inheritance is
  unchanged; it inherits a different field.
- **The "N connections" count becomes answerable directly** — it is the number of profiles
  whose effective secret is this one. `nocx-8pct` and `nocx-cx03` are both symptoms of
  counting through an owner that may not exist, and both dissolve here rather than being
  fixed twice.
- **Migration is a one-way conversion at load**, in the spirit of ADR-0006's own legacy
  handling: a profile with a `credentialId` resolves to the credential's current version's
  secret and is rewritten to name that secret. There is no compatibility shim afterwards —
  this is a greenfield product and the repository's rule is to break and refactor.
- **The renderer gets simpler in a way worth naming.** `AuthenticationEditor` currently
  juggles a credential id, a credential draft, a usage count and an inline-creation path
  that mints a credential the user never asked for. Most of that exists to keep an invisible
  object consistent.

## Alternatives considered

**Keep credentials and lazily attach one to an ownerless secret.** The editor lists secrets;
picking one that has no credential mints a credential behind the scenes. This fixes the
reported bug in a day and preserves every line of the rollout machinery.

Rejected as an end state, and it is the strongest alternative: it keeps two objects for one
concept, which is precisely the drift this ADR exists to stop, and every future surface pays
the tax of asking which one it means. It is, however, a legitimate **first step** if §2
proves large — with the ADR accepted, so the direction is not in doubt.

**Do nothing; teach the Secrets page not to create ownerless secrets.** This is the
consistent version of ADR-0006, and it means reverting ADR-0016's central promise: a secret
could not exist before its connection. The user asked for the opposite six days ago and was
right — storing a key before wiring it up is an ordinary thing to want.

## Not decided here

- Where versioned secret material is physically stored, and whether a version is a new
  `SecretID` or a generation inside one. §2 states the requirement; the storage design is
  its own decision.
- Whether a secret may be restricted to particular endpoints as a user-set property. Today
  authorisation is computed, never declared, and this ADR keeps it that way.
- The Secrets page's own surface (delete, kind badges, usage counts) — `nocx-pf8b`,
  `nocx-mg9r`, `nocx-8pct` are in flight and land against the current model.
