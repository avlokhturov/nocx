# Connection manager: groups, shared credentials, and computed authorization

- **Date:** 2026-07-29
- **Brainstorming bead:** `nocx-52cd`
- **Status:** design approved, pending implementation plan
- **Supersedes in part:** [ADR-0006 — Reusable Credentials](../../docs/decisions/0006-reusable-credentials.md)
- **Adopts the diagnosis, rejects the mechanism of:** PR #59 / draft ADR-0013
  "Credential-Scoped Trusted Endpoints" (see §3.2; its §4, one owner of endpoint
  identity, is adopted in full)
- **Note:** that draft claims ADR number 0013, which `0013-plain-css-with-semantic-custom-properties.md`
  already holds on `main` — the collision is `nocx-yclf` and must be resolved before any
  ADR from this work is numbered.

## 1. The problem that started this

A fleet of servers shares one username and password. The password rotates. The owner
wants to change it **once** for the whole fleet.

Today that is impossible by construction. `Credential.Host` is **required**
(`internal/profile/profile.go:145-153`, enforced again in `store.go` `SaveCredential`),
so one credential serves exactly one host, and a fleet of forty needs forty credentials.
Rotation is forty edits.

The requirement is not "relax the host binding". `nocx-mon` made the binding required
deliberately: "any host" is what lets a compromised renderer aim a stored password at a
host it controls. The requirement is to find a shape where one credential legitimately
serves many hosts **without** the renderer being able to name a host the user did not
already save.

## 2. What we found in the code

Verified by reading, on `main` at `5c5eb2d`. Bold entries had no bead.

1. **Editing a credential wipes its stored password.** `credentials.list` strips
   `SecretID` before answering the renderer — correct, per ADR-0011 §2. But
   `credentials.create/update` (`internal/transport/ws.go`) unmarshals the renderer DTO
   whole and hands it to `JSONStore.SaveCredential`, which **replaces** the stored
   record. The round trip therefore writes back `SecretID: ""`. Renaming a credential
   orphans its keychain secret and the connection silently stops authenticating. Same
   for `PassphraseSecretID`. The orphaned secret is never collected.
2. **There is no group UI at all.** `groups.create/update/delete` exist in the RPC
   surface and on `ProfileClient` (`frontend/src/profiles.ts:213-221`) with **zero**
   callers. A group can only enter the system through the Tabby importer.
3. **`ProfileGroup.Defaults` is decoration.** `applyDefaults`, `mergeSSHOptions`,
   `mergeInto`, `BuildGroupTree`, `ResolveGroupPath` exist in Go and are unreachable
   from `main()` (`nocx-hhj3`); the live TypeScript copy implements the render tree and
   **no inheritance whatsoever**. Nothing a group carries reaches a profile today.
4. **Credential IDs are minted client-side** as `` `cred:${name}:${Date.now()}` ``
   (`connections.tsx`), unslugified and rebuilt on every keystroke while the record is
   new. The server's `NewCredentialID` is dead because the renderer always supplies one.
5. **`frontend/src/connections.tsx` is 916 lines** carrying the profile list, the profile
   form, the credential list, the credential form and the Tabby import — two entities
   sharing one list and one panel.
6. **`TextField` does not compose `Field`.** `ui/field.tsx:79` renders the required
   asterisk; `ui/text-field.tsx:51-59` re-implements its own label, description and error
   and passes `required` only to the DOM attribute. Every text input in the connection
   form is declared required and marked nowhere. Two label implementations in one kit.
7. **Multi-hop jump routes are broken.** `internal/connection/resolver.go:114-131` builds
   `jumpCfg` recursively but never copies the recursive `JumpHost` chain into the target
   config. Exactly one hop survives.
8. **Imports are alternate writers.** `internal/importer/tabby.go` and
   `internal/export/import.go` call `SaveProfile` directly, and credentials are imported
   in a second pass, so intermediate state is not referentially consistent.
9. **The pool is not invalidated on password rotation.** `internal/ssh/pool.go:67-73`
   keys on the _credential ID_, not the secret. Rotating the password leaves the key
   unchanged, so a new tab reuses a transport authenticated with the old password and
   never tests the new one — access survives server-side revocation.
10. **The replay ring holds raw output on the backend.** `internal/transport/ring.go:14`
    retains 256 KiB per session and survives disconnects by design. Any frontend-only
    masking is therefore a display feature, not a confidentiality guarantee.
11. From the tracker, in scope: `nocx-u5ai`, `nocx-3isn`, `nocx-49x`, `nocx-hhj3`.
12. **`nocx-3wjh` is stale and should be closed, not worked.** It describes
    `catch { // Silent fail }`; no such code remains, and `connections.tsx:333-349`
    raises a danger toast on delete failure.

## 3. Model

### 3.1 Authorization is computed, not stored

`Credential.Host` and `Credential.Port` are **deleted**. A credential carries identity
only: name, username, auth mode, key metadata, opaque secret references.

At connect time the backend proves authorization **locally**, from the selected profile:

```
selected saved profile
  -> resolve its group inheritance chain
  -> obtain its effective credentialId
  -> resolve its canonical endpoint once
  -> authorize that (credential, endpoint) pair
```

Repeated per credential-bearing hop of the jump route. This is O(inheritance depth +
jump depth), **not** a scan of every profile. Scanning all profiles would widen the
TOCTOU window, make authorization depend on unrelated records, and fail noisily when one
unrelated alias is malformed.

"Which connections use this credential?" is a **separate query for the UI**, never the
connect-time algorithm.

### 3.2 Why not PR #59's persisted grants

PR #59 replaces the host binding with backend-owned
`TrustedEndpoints []{ProfileID, Host, Port}`, minted when a profile referencing the
credential is saved. Its diagnosis is right and we keep it: the credential↔host
relationship must be _derived from the saved connection_, not typed twice into a
`Bind to Host` field that drifts.

We reject its mechanism. The grant table is derived data — it contains no fact absent
from the profile list — and the expensive machinery in that PR (a v0→1 storage
migration, an atomic `SaveProfileWithGrant`, an `AuthorizationRevision` for pool
invalidation, a `requiresReview` marker) exists only to keep that cache coherent.

Its stated threat model also does not hold. The ADR says "`open` must never add a grant,
else redirecting a profile to an attacker host would authorize itself" — but the grant
**is** minted by `profiles.update`, which the renderer can call. The same attack works,
one step longer. The existing code already concedes the point
(`internal/profile/profile.go:132-144`): a binding the constrained actor can rewrite is
not an authorization boundary; it stops a mistake, not an attacker.

Adversarial review (Codex, this session) surfaced the one thing the grant table _does_
buy over computed authorization: it turns **direct profile-file tampering** and
**`~/.ssh/config` drift** into fail-closed events rather than silent re-authorization.
That is real. We take the consequence deliberately (§3.6) rather than paying for a cache.

### 3.3 Groups carry defaults; inheritance is real and provenance-tracked

`ProfileGroup.Defaults` becomes genuine backend-side inheritance. `credentialId` is one
inherited field among port, jump host and keepalive — "one password for a fleet" is a
special case of "a group hands settings down", which is also what a fleet needs for a
non-standard port or a shared bastion.

Resolution order: **profile → nearest ancestor group → … → root group → global**.

Two binding rules:

- **An inherited value is never materialized into the stored profile.** If it were, the
  UI could no longer distinguish "inherited 2222" from "this profile overrides with
  2222", and the next reader would have no way to recover the difference.
- **Every effective field carries its provenance**, and the UI shows it. This is what
  answers the objection that folder membership silently controls authentication: it does
  not, because the surface states where the credential came from.

The Go implementation wins; the TypeScript copy is deleted (`nocx-hhj3`). `deadcode`
must report no unreachable functions in `internal/profile`.

### 3.4 One owner of endpoint identity

A single backend service composes: saved profile + group chain + credential metadata +
`~/.ssh/config` → an `EffectiveProfile` with per-field provenance → **one immutable
`CanonicalEndpoint`**, consumed by authorization, `known_hosts` verification, the pool
key and the dial.

Resolve once, not twice. Resolving for authorization and again for dialling reintroduces
TOCTOU and recreates the dual ownership this whole design exists to remove. This is the
one part of PR #59 we adopt in full (its §4).

Every writer — ordinary save, Tabby import, configuration import, `~/.ssh/config`
adoption — goes through this service. Today they do not (§2.8).

### 3.5 Precedence between nocx inheritance and `~/.ssh/config`

`internal/ssh/ssh_config.go:60-84` currently ranks "explicit profile option > config file

> default", and it cannot tell an explicit value from an inherited one because the merge
> never runs. Once inheritance is real, that distinction becomes load-bearing:

```
credentialId :  profile > nearest group > … > root > global        (ssh_config has none)
host alias   :  profile only — never inherited
port         :  profile > group chain > ~/.ssh/config > global > 22
user / key   :  effective credential > profile > group chain > ~/.ssh/config > system
operational  :  profile > group chain > ~/.ssh/config equivalent > global > hardcoded
```

A group default outranking the user's hand-written `~/.ssh/config` is a deliberate
choice: a group default is an explicit nocx policy ("all production is on 2222"). It is
only defensible while provenance is visible, which §3.3 requires.

`~/.ssh/config` must be evaluated by its own rules — OpenSSH is **first-obtained-wins per
keyword**, positional, including wildcard blocks. nocx does not merge parsed `Host`
blocks structurally; it asks the evaluator for the alias's obtained values and then
overlays only what the table above says outranks them.

### 3.6 The security consequence, stated plainly

> Editing a saved profile, its inherited groups, or the applicable `~/.ssh/config` is an
> authorization change and takes effect on the next open.

The root problem is a **confused deputy**, and it is not solved by any of the competing
designs: `profiles.json` is plaintext and same-user writable, so anyone who can write it
can name a credential and a target and make nocx spend a keychain capability the attacker
does not have. Every design that stores its proof in that same file — PR #59's grant
table, or an endpoint fingerprint of ours — is defeated by the same write.

The candidate answer is keyed integrity: MAC the document with a key held in the store
that already protects the secrets, so tampering is _detected_ rather than merely
inconsistent. It is **deliberately out of this feature's scope** and belongs in its own
ADR, because it is unresolved in four ways:

- it must authenticate a _canonical serialization_ plus schema version, generation and
  key ID — not raw bytes, which formatting and benign migrations would invalidate;
- rollback to an older correctly-MAC'd document needs a counter living outside it;
- it must cover the whole authorization closure (profiles, groups, global defaults,
  credential metadata), not one file;
- it collides with ADR-0011:69-71, which makes hand-editable documents a **feature**, so
  it needs an explicit detect → refuse → show the diff → review → re-sign path;
- and its strength must be measured per platform, not assumed from the interface name.
  On macOS it depends on the actual Keychain ACL and signing identity; on Linux, if a
  same-user process can read the Secret Service entry, it degrades to a corruption
  detector.

A secret-use **broker** — agent-shaped, signing the challenge rather than returning key
bytes, with "first use of a new endpoint requires confirmation" — is the materially
stronger primitive and the one that would finally provide the approval path outside the
renderer that `profile.go:144` says does not exist. Also its own ADR.

### 3.7 Pool identity must include the authenticator

`internal/ssh/pool.go:67-73` keys on host, port, user, credential **ID** and jump route.
The comment there states the rule: widen the key only by a component that distinguishes
two principals. Rotation is the case that rule missed — the _same_ principal with a
_different_ authenticator.

Add a derived fingerprint over `SecretID` (already reminted on every password change),
passphrase `SecretID`, auth mode and key identity, for the target **and every hop**;
`jumpRouteKey()` already mirrors the target's identity fields, so one change covers
bastion rotation. No persisted revision counter is needed.

### 3.8 Live-session semantics

Explicit, so nobody has to guess:

- an existing session and its channel continue when its profile is edited or deleted;
- its pooled transport survives until its last channel closes;
- a later `open(profileId)` re-reads current state and fails closed if the profile is
  gone;
- a reconnect after network loss is a **new authorization event** using current state,
  not the old session's snapshot.

Killing a live shell because somebody reorganized a folder would be hostile and is not
required.

## 4. `~/.ssh/config` as a live source

`~/.ssh/config` is already read at connect time (`ssh_config.go:44-59`) and is invisible
everywhere else: a user with fifty aliases opens Connections and sees "No connections
yet".

**Decision: a live, read-only source — never a copy.**

- Surfaced in the **quick-connect palette** and in a **terminal hint** when the user
  types `ssh <host>`. Not in the connection manager, which lists only nocx-owned records
  — so an empty manager honestly means "you have not saved any connections".
- **Priority is ours**: when an alias exists as a saved profile, the system duplicate is
  not offered.
- **"Save as connection"** adopts an external host after connecting, at the moment the
  user wants to attach something of their own (a credential, a group, a colour).
- A **one-off importer** sits alongside the Tabby one, labelled honestly: it produces a
  detached copy, not a synchronised view.

The terminal hint is a **frontend** feature. AD-6 forbids the backend interpreting the
byte stream; the frontend already owns input (AD-4) and parses OSC 133, so it knows a
command is being typed, and fetches the alias list over the control plane.

Rejected: a one-off import as the _only_ path — an imported record freezes one evaluation
of a positional config, and later edits to an earlier wildcard block, an `Include`, a
`Match` condition or alias ordering silently do not reach it. Rejected: writing profiles
back into `~/.ssh/config` — first-obtained-wins means an appended `Host foo` may fail to
override an earlier `Host *`, so nocx would have to reorder the user's own blocks, and a
bad serialization breaks `ssh`, `git` and `ansible`, not just nocx.

## 5. Surface

Organizing principle: **nothing hidden, nothing asked twice.** Both reference apps show a
blank Port field while the connection actually goes to 2222 because a group or
`~/.ssh/config` said so. We are building the engine that knows the effective value _and
its origin_; the surface must show it.

- **Settings rail gains three entries: Connections, Credentials, Vault.** The
  "Saved credentials" toolbar button — an entity switch disguised as an action — is
  deleted. Tabby import moves into the existing Export / Backup / Import section. One
  primary action remains in the toolbar.
- **Full-width list, dialog editor.** The screen's job is finding and connecting, which
  happens daily; editing happens rarely and does not deserve half the width permanently.
- **A row reports state, not just address.** Live connected/disconnected, the credential
  in force _and where it came from_, last used. The credential is a link to its record,
  which answers "used in 23 connections" — the reverse view, computed, never stored.
- **`Test` is a first-class row action, separate from `Connect`.** It is also the
  primitive fleet rotation needs (§6).
- **Creation starts from one field**, accepting `deploy@10.0.0.1:2222`, a bare alias, or
  `ssh://…`. `parseQuickConnect` (`frontend/src/profiles.ts:137`) already does this
  parsing and is currently used only by the palette. Everything else is inferred and
  shown with provenance.
- **Every field carries its provenance** — `2222 · from group Prod`, `deploy · from
credential prod-ops`, `22 · from ~/.ssh/config` — and editing flips it to
  "overridden here" with a revert control.
- **Failures speak.** "credential prod-ops was rejected", "host does not resolve", "the
  host key changed" — not `Internal error`, which is today's entire answer (`nocx-3isn`).
- **Groups get an interface** at last, including what a group hands down.
- **`TextField` composes `Field`**, so the required marker appears everywhere at once and
  the kit stops carrying two label implementations.

## 6. Rotation is a rollout, not an edit

Forty hosts do not switch atomically, and a design that assumes they do half-works
silently. A credential carries **versions**:

```
Credential "prod-ops"    current: v7    candidate: v8
```

Create a candidate without overwriting the current one; choose a canary set; run bounded
authentication probes; record per-endpoint status (accepts candidate / rejects /
unreachable / host-key problem / locked / needs interactive); roll forward in bounded
batches; promote on a threshold; keep the old version for explicitly selected stragglers;
retire deliberately, with the list of remaining dependents.

Safety constraints, none optional:

- **never** try several passwords against every host — that triggers account lockouts and
  is indistinguishable from password spraying;
- bound concurrency and retries;
- verify the host key before probing;
- distinguish a network failure from a rejected password;
- **never** silently fall back from candidate to current during an ordinary connection —
  that hides an incomplete rotation;
- show which secret version authenticated each pooled transport, and drain transports on
  the retired version when a candidate is promoted.

Later, and not now: for fleets already managed by an external secret system, a credential
becomes "username + policy + external secret locator" and nocx reports adoption without
being the rotation authority.

## 7. Work breakdown

Six deliverables, each named by an outcome that stops being false exactly once, chained
in this order. **One branch, one merge** — the split is about ownership and closure, not
about release.

1. **"Editing a credential no longer loses the password."** `SecretID`/
   `PassphraseSecretID` preserved across update, create distinguishable from update
   (`nocx-u5ai`), IDs minted backend-side, orphan collection, pool fingerprint (§3.7).
   _This is active data loss and must not wait for the redesign._
2. **"A connection knows what it inherited, and says so."** The effective-profile engine,
   provenance, `CanonicalEndpoint`, one owner, every writer routed through it, the
   TypeScript copy deleted, `deadcode` clean (`nocx-hhj3`), the multi-hop jump
   representation fixed (§2.7), `nocx-49x` re-checked against it.
3. **"A credential stops being a side door."** The existing epic `nocx-0w2f` — its own
   settings section, creation from inside the connection form, one shared form component.
   Reused, not re-created.
4. **"The connection list answers questions."** The surface of §5.
5. **"Hosts from `~/.ssh/config` appear where they are looked for."** §4, plus
   transactional imports.
6. **"Changing a fleet password is a rollout, not a hope."** §6.

Each carries a `discovered-from` edge to `nocx-52cd` and references this document; the
document, not a label, is what says these are one feature.

## 8. Deliberately out

- **The vault-versus-keychain decision** (`nocx-25k9`, `nocx-25k9.1`). The shipped binary
  wires the OS keychain and ~371 lines of AES-GCM vault are reachable only from their own
  tests. That is its own ADR and its own epic, and it must be answered before any vault
  UI.
- **Trust: MAC or broker** (§3.6). Its own ADR.
- **Stream semantics and redaction.** `nocx-23v`'s strong form — a vault-injected secret
  never leaves the machine unmasked — requires inspecting output before framing, which
  collides with AD-6, and matters most in the web target where bytes cross a network.
  Redaction is really three products (display masking; protected injection where the
  secret never enters the stream; producer-declared sensitive regions) and only the first
  is frontend-shaped. Separately, `architecture.md:74` leaves a session with no attached
  client unable to answer "what is the cwd". Both need an architecture decision, and
  AGENTS.md is explicit that an AD is changed in the document rather than routed around.
- **Replay confidentiality in a web/relay deployment.** AD-9 defines retention mechanics
  and says nothing about confidentiality or lifecycle; "auth token + bind-to-localhost"
  (`architecture.md:111`) is not sufficient for a remote deployment.
- **A second hierarchy** (folders for navigation, sets for policy). One tree, with visible
  provenance, is the answer for now.
- `nocx-3wjh` — already fixed; close it rather than working it.

## 9. Open questions for the plan

- Where the `EffectiveProfile` service lives, and its interface — this is the AD-8 seam
  everything else consumes.
- How provenance is represented on the wire without leaking anything the renderer must
  not have.
- Whether the terminal `ssh` hint is worth its complexity in wave 5, or is deferred to
  its own bead once the palette path exists.
