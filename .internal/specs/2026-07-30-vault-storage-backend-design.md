# Vault: storage backend, key hierarchy and seal lifecycle — design

- **Date:** 2026-07-30
- **Beads:** nocx-nfvd (this brainstorm), nocx-25k9 (epic), nocx-25k9.1 (the wiring bug this answers)
- **Touches:** ADR-0011 (amended — see §3), ADR-0006, AD-8
- **Status:** approved section by section on 2026-07-30; feeds ADR-0016 and the V1 implementation plan

This spec covers the whole architecture (V1–V4, §9). Only **V1** is planned and built now.

---

## 1. What is actually true today

Verified against the tree on 2026-07-30, not recalled:

- `internal/app/app.go:90` wires `credential.NewKeychain()`. That instance reaches the settings
  registry, the transport (`:116`) and the SSH profile resolver. **The vault has no caller.**
- `internal/credential/vault.go` is ~370 lines of AES-256-GCM + PBKDF2 reachable only from its own
  tests. `NewVault()` and `NewCredentialStore()` have no non-test callers.
- Two compatibility aliases exist whose own comments explain the bug: `credential.Keychain`
  ("retained for compatibility with the composition root", `keychain.go:3-6`) and
  `credential.CredentialStore` ("exists only to avoid editing app.go in this wave",
  `credential.go:14-21`). The wave ended; `app.go` was never edited.
- `credential.SecretStore` (`secretstore.go:26-31`) is the interface every consumer already uses,
  addressed by an opaque `SecretID` (`:11-14`). Plaintext escapes only through `Secret.Use`.
- `internal/storage` provides the DocumentStore capability (`document.go`, `paths.go`).
- `internal/importer/tabby.go:57-66` parses Tabby's `vault` section but never decrypts it.
- `frontend/src/connections.tsx:764,1576` already lets a profile and a group default select a
  `credentialId`; `credentials.tsx` and `credential-form.tsx` already provide credential CRUD.
- `internal/transport/ws.go:1371-1375` already rejects a renderer-supplied `secretId` on
  `credentials.create`; `ws.go:2204-2218` already broadcasts `settings.changed` to every client.
- **Greenfield:** no vault file and no keychain entry from a previous release exists in the field.
  There is nothing to migrate and no format to stay compatible with.

### 1.1 The keychain is not always available

This is the fact the whole design turns on, and it was measured rather than assumed:

- **macOS** — always present. `go-keyring` v0.2.8 shells out to `/usr/bin/security`
  (`keyring_darwin.go:29,44,86`).
- **Linux** — not guaranteed. `keyring_unix.go` needs `org.freedesktop.secrets` on the session bus;
  with no daemon every `Set`/`Get` fails, and `keyring_fallback.go` only returns
  `ErrUnsupportedPlatform`.
- **We ship Linux.** `.github/workflows/release.yml:179-288` builds a `linux/amd64` AppImage
  alongside `darwin/universal` (`:124`).
- **Measured on the primary dev machine, 2026-07-30:** no `org.freedesktop.secrets` on the session
  bus, no keyring daemon. nocx cannot store a single password there today.

### 1.2 "OS authentication" is not authentication

`security find-generic-password` reads an item whose ACL trusts `/usr/bin/security` — the utility
that created it — so the read is silent. Secret Service likewise returns from an unlocked
collection without prompting. Unsealing "through the OS" is therefore _not asking the user
anything_; it is a keychain read. A real prompt (LocalAuthentication/Touch ID on macOS, polkit on
Linux) is net-new cgo/platform work and is deferred (§9).

**Consequence for wording, in the ADR and in the UI:** the OS envelope means "do not ask for a
passphrase", never "the system verified who you are".

---

## 2. Threat model

Everything below is justified against this list. A control that protects nothing here does not ship.

**In scope:**

- **T1 — brief access to an unlocked machine.** A colleague, a conference, a glance over the
  shoulder. The dominant real-world case for a terminal. Countered by: idle seal, Reveal only on an
  explicit action, clipboard auto-clear.
- **T2 — data at rest.** Stolen or lost disk, a backup, a config directory that ends up in a
  dotfiles repo or a cloud folder. Countered by: AEAD-encrypted blob whose key is not stored beside
  it; the keychain encrypts on its own.
- **T3 — leakage through our own product.** A secret in a log, in a JSON-RPC response, in a config
  export, in scrollback. Historically the only class that has actually fired here — `nocx-jb20.1`
  is open right now. Countered by: the `Secret` type, opaque references, no plaintext in logs, and
  the rule that the renderer never names a locator.

**Explicitly out of scope:**

- **T4 — a malicious process running as the same user while the app runs.** It reads process
  memory, invokes `/usr/bin/security`, or replaces the binary. Neither store stops this.
- **T5 — a compromised OS, root, or cold boot.**
- **T6 — a hostile owner of the machine.** That is the owner of the secrets.

**Three consequences that must be written down, or they will be forgotten:**

1. The encrypted-file provider is **not stronger than the keychain against T4**. Its purpose is T2
   on platforms with no keychain, plus the choice of a user who does not trust the system store.
2. `sealed` on the keychain provider closes **T1 only** — it is application policy, not a
   cryptographic boundary. On the file provider it closes T1 and T2, because the data key is wiped.
3. While the OS envelope is enabled it **caps the achievable strength**: the root key is retrievable
   from the keychain, so the master passphrase adds nothing against T2. The passphrase only matters
   in the mode where the OS envelope is off. That toggle is therefore the single place a user picks
   a security level, and it must be labelled as such.

**Deliberately not defended:** the user copying a secret into another app; an already-established
SSH session (the secret was spent at authentication and seal cannot recall it); any form of sync
(vision §10, §11).

---

## 3. Decision, and its effect on ADR-0011

nocx gets a **Vault**: one domain entity that owns a catalogue of secret entries, a registry of
pluggable providers, the seal lifecycle, and the key envelopes. Providers only store and fetch
values. Two providers ship, compiled on every platform:

- **keychain** — the OS store, via `zalando/go-keyring`. Default wherever the Secret Service answers.
- **encrypted file** — the current `credential.Vault`, renamed and moved behind a provider
  interface. Default where no keychain exists; selectable by a user who does not want one.

**This amends ADR-0011.** Its §1 says, verbatim and with status Accepted
(`docs/decisions/0011-…md:72`):

> **SecretStore** — authenticators only, in the OS keychain. **Never a file we write.**

That clause is superseded: a file we write becomes a legitimate SecretStore backend, because a
shipped platform has no keychain and the alternative is a build on which no secret can be saved at
all. The rest of ADR-0011 — three storage capabilities, secrets as opaque references, backend-only
resolution — stands unchanged and is reinforced.

One further ADR-0011 nuance is affected: DocumentStore is justified there as "human-recoverable
configuration… a user can open these in an editor and repair them". The encrypted provider's blob is
the one document that is deliberately **not** human-recoverable. It still uses DocumentStore as the
mechanism (atomic JSON write); the exception is recorded rather than papered over with a new
capability.

---

## 4. Domain model and module boundaries

### 4.1 One identifier, not two

`credential.SecretID` is already defined as "an opaque, stable handle to secret material held by a
SecretStore". That **is** the identifier of a vault entry. A parallel `VaultEntryID` would be a
second name for one concept. The catalogue maps `SecretID → (ProviderID, Locator)`; `profile`,
resolver, transport and ssh are untouched.

### 4.2 One consumer contract, and it already exists

`Vault` **implements `credential.SecretStore`** (`Get`/`Set`/`Delete`/`Exists` by `SecretID`).
Consequences: the composition root swaps one constructor, no consumer changes, and the invariant
"credentials, connections and settings reach secrets only through the Vault" holds by construction
instead of by discipline.

A semantic `Resolve(ctx, query, use func(Secret) error)` is **not** introduced. Its `SecretQuery`
(host/port/user/fingerprint) existed only to serve a runtime Tabby provider, which is out (§7).
`SecretStore` already returns a `Secret`, which yields bytes only inside `.Use`.

`SecretStore` stays **without `context.Context`**. D-Bus timeouts live inside the keychain provider.
Threading ctx through four packages buys cancellation nobody uses — no one aborts a connect
mid-keychain-read — while a hung D-Bus call is fixed by a timeout in the provider either way.
The provider interface below does take a ctx: the Vault derives one per call from
`context.Background()` with the provider's configured timeout, so a wedged store fails the operation
instead of wedging the caller.

### 4.3 Packages

| Package                   | Owns                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `internal/vault`          | catalogue, provider registry, lifecycle, envelopes, default writable provider; implements `credential.SecretStore` |
| `internal/vault/keychain` | provider over `zalando/go-keyring` (moved out of `credential/secretstore.go`)                                      |
| `internal/vault/encfile`  | provider from today's `credential.Vault`, format v1 (§5.3)                                                         |
| `internal/credential`     | reduced to what it should be: `Secret`, `SecretID`, `SecretStore`                                                  |

### 4.4 Capability is an interface, never an enum

AD-8 is explicit: "variation is expressed by the interface, never by a fork inside an
implementation… the test is whether a new implementation can be added without editing a `switch`".

```go
type Provider interface {
    ID() ProviderID
    Status(ctx context.Context) Status // ready | unavailable
    Get(ctx context.Context, loc Locator) (credential.Secret, error)
}

type WritableProvider interface {
    Provider
    Put(ctx context.Context, s credential.Secret) (Locator, error)
    Delete(ctx context.Context, loc Locator) error
}
```

The backend branches only on a type assertion to `WritableProvider`. The RPC layer projects
capabilities into DTO flags for the UI — that is a **view**, not a dispatch mechanism.

`Locator` is backend-only and opaque: it never crosses the wire in either direction, never lands in
a profile, and is never logged. For the keychain provider it is the account string; for the file
provider, a key inside the encrypted blob.

`Status` has two values on purpose. A system store that exists but is locked (a locked macOS login
keychain) reports `unavailable` with the underlying error preserved, rather than earning a third
state we cannot exercise in CI.

### 4.5 Seal lives in the Vault, not in providers

A provider knows nothing about sealing. `Vault` refuses before delegating. This is exactly why
"policy for the keychain, cryptography for the file" is an observable property of the code rather
than a caveat: on seal the file provider has a data key to wipe and the keychain provider has
nothing.

### 4.6 Deleted outright

No compatibility shims, no dead code (AGENTS.md). Pleasingly, these are the very shims that caused
`nocx-25k9.1`:

- `credential.Keychain` + `NewKeychain` — its comment names the composition root we are now editing;
- `credential.CredentialStore` — "only to avoid editing app.go in this wave";
- `credential.vaultSecretStore` + `NewCredentialStore` — replaced by the provider;
- `StoredVault.IV` ("unused in v2, kept for backward JSON compat") and the legacy-version branch
  (`vault.go:190-198`);
- the false doc comment at `vault.go:88-92` claiming the passphrase lives in a package-level
  variable — it is a struct field (`:95`).

---

## 5. Keys, storage format, lifecycle

### 5.1 Envelopes over one root key

Three envelopes wrap one random 32-byte **Vault Root Key**:

| Envelope   | Opened by                                     | Stored in           |
| ---------- | --------------------------------------------- | ------------------- |
| passphrase | argon2id(passphrase, salt) → KEK, AES-256-GCM | vault document      |
| OS         | a keychain read                               | the keychain itself |
| recovery   | argon2id(code, salt), same construction       | vault document      |

An envelope exists only once it has been created. On a machine initialized silently (§5.2) the OS
envelope is the only one present; the passphrase and recovery envelopes appear when the user asks
for them or when no keychain answers.

**Exactly one recovery code**, not ten. Any code in a set of ten revokes the whole set on use, so
ten is one code printed ten times, with ten more places to leak from. It is shown once at setup with
Copy/Download; using it revokes and reissues.

**Only the file provider has a data key** — random, wrapped by the Root Key. The keychain provider
stores the value itself and has none. The benefits of the root-key indirection (change the
passphrase without re-encrypting; three ways to open one key; add or revoke a method as an envelope
operation) therefore apply to the file path only, and the ADR says so.

**KDF: argon2id**, m=64 MiB, t=3, p=4, 16-byte salt, 32-byte output. `golang.org/x/crypto/argon2` is
available in the already-direct dependency `x/crypto v0.54.0`. Parameters are stored beside the
envelope and bound as AAD, so they can be raised later without invalidating existing envelopes.

This retires the current PBKDF2-SHA512 / 100k / 8-byte salt, inherited from Tabby "for portability"
(`vault.go:16`) — portability we no longer need. `TestPBKDF2VaultParamsSHA512` was written under
`nocx-dcd` so that "a future change cannot silently break vault compatibility"; with nothing in the
field there is no compatibility to protect, so it is **deleted deliberately with the reason recorded
on the bead**, not quietly worked around.

### 5.2 Initialization is silent where a keychain exists

- **Keychain answers** → on the first saved secret the Root Key is minted silently and the OS
  envelope written. No passphrase, no recovery code: there is nothing to recover.
- **No keychain, or the user disabled the OS envelope, or chose the file provider as default** →
  explicit setup: master passphrase, recovery code shown once, Copy/Download. Confirmation is an
  ordinary acknowledgement; the user is not asked to type a code back.

A master passphrase exists exactly when it protects something.

What unseal then looks like on a keychain machine, spelled out because it is counter-intuitive: the
vault is `sealed` after every restart, and unsealing is a single click on **Unlock** with no prompt
of any kind — the app reads the OS envelope. The seal there buys the idle timer and the deliberate
click, nothing more (§2, consequence 2).

### 5.3 Encrypted-file format, version 1

Fresh, with no inherited fields — nothing is deployed:

```json
{
  "version": 1,
  "wrappedDataKey": "hex(nonce||ct||tag)",
  "contents": "hex(nonce||ct||tag)"
}
```

`wrappedDataKey` is sealed by the Root Key; `contents` by the data key. AAD binds the version. The
existing GCM helpers and the five tamper tests from `nocx-1vr` (ciphertext byte, tag byte, version
field, old-format refusal, wrong-passphrase indistinguishability) carry over. An unknown version is
refused; there is no version negotiation.

### 5.4 Vault document (DocumentStore, unencrypted)

Catalogue (`SecretID` → name, kind, provider, locator, timestamps), default writable provider, the
passphrase and recovery envelopes, whether an OS envelope exists, the auto-seal timeout, the
preferred unseal method. Only labels and structure are in the clear — no new exposure, since
`profiles.json` already stores hostnames that way.

### 5.5 Three states

- **uninitialized** — no envelopes. The app is fully usable: local terminal, SSH agent, creating
  profiles, connecting with a manually entered password. Only _saving_ a secret is unavailable, and
  it is what triggers initialization.
- **sealed** — the Root Key is not in memory. Provider status and the number of entries are visible;
  names and values are hidden (this defends T1, the glance, not the disk). `Get`/`Set`/`Delete`/
  `Exists` return `ErrVaultSealed`. The visibility half of this rule is realised by the Vault page in
  V2; V1 ships only the backend refusal, because V1 has no catalogue surface to hide anything on.
- **unsealed** — operations permitted, Reveal on an explicit action, the idle timer running.

Established SSH sessions are unaffected by seal. A new connect or a reconnect that needs a stored
secret gets a typed error and the UI offers **Unlock** — there is no silent auto-unseal on connect.

### 5.6 Auto-seal

Idle timer only. Default 15 minutes; settings Off / 5 / 15 / 30 / 60. Activity is keyboard, mouse
and UI actions. **Not** activity: terminal output, background jobs, network events, incoming
WebSocket messages. Consequence, accepted: reading logs for twenty minutes without touching the
keyboard means a reconnect asks to unlock.

Sealing on OS lock and sleep is deferred (§9): there is no OS-event infrastructure in the tree today
— no `login1`, `PrepareForSleep` or `NSWorkspace` anywhere in Go — and it would take a cgo path on
macOS, a D-Bus path plus per-DE screensaver handling on Linux, and it is close to untestable in CI.

---

## 6. Control plane

Both foundations already exist and are copied rather than invented: the broadcast set and
`broadcastSettingsChanged` (`ws.go:2204-2218`), and the forged-identifier refusal
(`ws.go:1371-1375`, verbatim `"secretId/passphraseSecretId are backend-owned"`).

**V1 methods:**

| Method          | Returns / does                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `vault.status`  | state, providers with capability flags and status, whether an OS envelope exists, entry count. No names, no locators. |
| `vault.setup`   | initialize: silent when the keychain answers; passphrase + one-time recovery code otherwise                           |
| `vault.unseal`  | method (`os` \| `passphrase` \| `recovery`) plus the secret input when one is needed                                  |
| `vault.seal`    | seal now                                                                                                              |
| `vault.changed` | broadcast notification on state change, modelled on `settings.changed`                                                |

`vault.list`, `vault.reveal`, settings, passphrase change and recovery reissue belong to V2.

**Invariants, not aspirations:**

1. The renderer never names a locator and never supplies a `SecretID` for a new entry — the backend
   mints both. This is the rule `credentials.create` already enforces, extended to everything new.
2. `vault.list` returns a view with no locator. A locator crosses no boundary, enters no profile,
   appears in no log.
3. Reveal is the single place plaintext travels upward (V2). It requires `unsealed`, an explicit
   action, and it logs the fact — operation and `SecretID` — never the value.

**Blocking dependency, named explicitly:** `nocx-jb20.1` (P0, open) — `export.configExport` still
emits `SecretID` and neither import path strips it. Until that closes, invariant 1 is false in the
product no matter how correct the new vault code is. It has its own epic and is not in the V1 plan,
but V1 references it as a precondition of "the Vault is the boundary".

**Typed errors — five, not ten:** `ErrVaultUninitialized`, `ErrVaultSealed`,
`ErrProviderUnavailable`, `ErrSecretNotFound`, `ErrBadPassphrase` (deliberately indistinguishable
from tampering, as `nocx-1vr` established). Dropped from the earlier draft: `ErrProviderLocked`,
`ErrProviderAuthenticationRequired`, `ErrExternalSourceChanged`, `ErrReadOnlyProvider` (no runtime
providers with their own auth — Tabby became an import), `ErrImportConflict` (V4) and
`ErrRecoveryRequired` (a way to unseal, not an error class). Each maps to one UI action: Set up,
Unlock, Retry, Choose another credential, Re-enter.

**Logging** through the existing `log/slog` interface. Permitted: operation name, `ProviderID`,
`SecretID`, lifecycle state, duration, error category. Forbidden: plaintext, passphrase, recovery
code, locator, encrypted blob, any request payload carrying a secret field.

---

## 7. Tabby: import only

There is no runtime Tabby provider. Lazy discovery, in-memory snapshots, fingerprint invalidation,
dynamic external credentials and per-connect selection of a foreign credential are all out. The one
capability lost is connecting with a Tabby password without importing it — and that flow made the
user pick a credential by hand on _every_ connect, which is worse than importing once.

- Decryption lives **only** in `internal/importer` as an adapter and never becomes an nocx format.
  `tabby.go:57-66` already parses the `vault` section; decryption is what V4 adds.
- The Tabby format is unauthenticated (PBKDF2-SHA512, 100k, 8-byte salt, AES-256-CBC, base64), so a
  decrypt result gets strict structural validation and bounded sizes: a doctored config must neither
  panic the parser nor push junk into the catalogue.
- The Tabby passphrase is asked once per import operation and stored nowhere.
- **The keytar mode is out of scope entirely.** It would mean reading another application's keychain
  entries; on macOS those are ACL-bound to Tabby, and `nocx-dm0` already records the principle that
  a shared keychain makes touching unrecognised entries unacceptable. With Tabby's vault disabled we
  import profiles without secrets and the password is entered on first connect.

### 7.1 Collision policy is inherited, not reinvented

`nocx-y910.1` already decided and tested it: profiles and groups overwrite, credentials refuse, and
an imported profile naming an existing local credential is marked `needs-review` and will not
resolve until cleared. V4 adds the one case that bead could not cover — an import that **carries** a
secret. Same spirit: a foreign secret never silently overwrites an existing one; the offer is
"import as a new version" (the version machinery exists after `nocx-383c`) or skip.

### 7.2 No journal

The earlier draft wanted a resumable import with a journal; `nocx-y910.1` requires one transaction
where "a failure halfway leaves nothing partially written". The resolution: metadata is written in a
single DocumentStore transaction, and secret writes to the keychain cannot join it — it is an
external store. So the order is **secret first, then metadata**, which guarantees metadata never
points at a missing secret. A crash in between strands an orphan, which is precisely the failure
mode ADR-0011 §4 accepts by design and which `nocx-dm0` owns. No journal.

---

## 8. Testability

The awkward consequence, accepted deliberately: with no Secret Service in CI or on the primary dev
machine, **the real keychain provider cannot be tested there**. Three requirements follow, the first
architectural rather than a testing detail:

1. **The provider registry is injected at the composition root** (AD-8 gives this for free) so a
   test can substitute a fake keychain provider. Without it the keychain path is untested anywhere.
2. **A contract suite both providers pass** — against the fake in CI, by hand against the real one
   on macOS. Otherwise they drift on absence, empty values and overwrite.
3. **V1 acceptance is user-shaped, not unit-shaped** (AGENTS.md: a test asserts what a user can do),
   run headless through `cmd/devharness` + the `NOCX_WS_PORT` shim (`e2e/harness.ts:26-37`) with no
   wails, GTK or display: open the app with no vault configured, save an SSH password, restart,
   unseal, connect.

Plus two tests that come straight from prior failures in this repo:

- every new RPC is called **the way the renderer calls it**, including the fields the renderer
  leaves empty (the `groups.create` defect);
- a negative test sending a forged `SecretID`/locator, mirroring what `nocx-jb20.1` demands.

E2E runs on Linux, therefore through the **file** provider by default. That is not a gap — it is why
both providers are compiled everywhere: the Root Key, envelope and seal paths execute in CI instead
of only on the platform nobody can automate.

---

## 9. Decomposition

**V1 — the app actually reaches a vault.** Domain entity, provider registry, both providers, Root
Key and envelopes, lifecycle, `VaultStore` over DocumentStore, replacing `NewKeychain()` at
`app.go:90`, typed errors, the four RPC methods plus `vault.changed`, and the minimum UI: setup,
unseal prompt, and a legible error on connect.
**Done when:** on a machine with no Secret Service a user can set up a vault, save an SSH password,
close the app, reopen it, unseal, and connect.

**V2 — the Vault page.** State, providers, entry catalogue, Reveal and clipboard clearing, default
provider, passphrase and recovery management. It is **not** a second credential manager: credential
CRUD already exists in `credentials.tsx` / `credential-form.tsx`, and duplicating it is exactly the
two-vocabularies defect the kit rules warn about.

**V3 — idle auto-seal.** Activity signal from the frontend, timer, Off/5/15/30/60.

**V4 — Tabby secret import.** Decryption, preview, write into the default provider, reconciled with
`nocx-y910.1`.

**Deferred to their own beads, outside this epic:** sealing on OS lock/sleep; real OS
authentication (Touch ID / polkit); a HashiCorp provider; a provider per credential _version_
(today's `CredentialVersion` has no `ProviderID`, and adding one reworks a model that landed a week
ago under `nocx-383c` — YAGNI until a second writable remote store exists); the orphan janitor
(already `nocx-dm0`).

---

## 10. Invariants for ADR-0016

1. The Vault is the only secret boundary. Credentials, connections and settings reach secrets only
   through it; no consumer imports a provider package.
2. Capability is expressed by interface satisfaction, never by a mode string or a `switch`.
3. A `Locator` is backend-only: not on the wire, not in a profile, not in a log.
4. The renderer never mints or supplies a secret reference; the backend does.
5. No plaintext in any ordinary list/get response. Reveal is the sole exception and is explicit,
   gated on `unsealed`, and audited without its value.
6. Global seal is a **policy** boundary for the keychain provider and a **cryptographic** one for
   the file provider. The ADR states this difference rather than implying uniform strength.
7. Only the default provider is used implicitly. The Vault never silently tries another provider.
8. The Vault and its providers never touch the filesystem directly — always a storage capability.
9. A secret write precedes its metadata write; a metadata delete precedes its secret delete
   (ADR-0011 §4).
10. Secrets are never serializable: the `Secret` type stands, and plaintext materializes only inside
    `Secret.Use`.

---

## 11. Open, needs checking on real hardware

- **macOS keychain ACL.** The claim that items created through `/usr/bin/security` are readable by
  any same-user process invoking the same utility is consistent with how `security` sets an item's
  trusted-application list, but neither CI nor the dev machine can verify it. It must be confirmed
  on a real Mac before §1.2 and threat T4 are stated as fact in the ADR. If it turns out a prompt
  does appear, the keychain provider is stronger than described here and the wording softens — no
  structural change follows either way.
- **Argon2id parameters on the slowest supported machine.** m=64 MiB / t=3 / p=4 should land near
  100–200 ms; measure before fixing it in the format.
