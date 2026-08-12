# ADR-0027 — Backup and restore is one structured file, and it carries no credentials

- **Status:** Accepted
- **Date:** 2026-08-12
- **Related:** ADR-0011 (persistence: storage capabilities and secrets as opaque
  references), ADR-0017 (a connection references a secret), ADR-0026 (control plane runs
  off the read loop), beads `nocx-u0rv` (take your terminal to a new machine),
  `nocx-u0rv.2`, `nocx-u0rv.3`, `nocx-u0rv.4`.
- **Supersedes:** ADR-0011 §7, in full. The other six sections of ADR-0011 — the three
  storage capabilities, secrets as opaque references, data classification, cross-store
  workflows, SQLite as a seam, and the shared-schema rule — are untouched and remain
  binding.

## Context

ADR-0011 §7 said export and backup are four products: a configuration export, a portable
encrypted export, a same-machine backup, and an import that maps credentials afterwards.
`internal/export` built all four, and none of them ever reached a user — no JSON-RPC
methods, no composition-root wiring, no UI (`nocx-6ek.3`). The surface was added later
and the four modes finally shipped; using them is what showed the shape was wrong.

Three problems, and the first is the load-bearing one.

**The portable encrypted mode cannot deliver what its name promises.** Encrypting
credentials for transport means reading secrets back out of the keychain, and ADR-0011 §2
forbids that: a secret exists only inside secret-specific types and APIs. `internal/export`
honoured the rule structurally — it did not import `credential.SecretStore`, and a test
inspected the production import graph to keep it that way — so no mode could resolve a
secret, portable included. What shipped under that name was a configuration export with a
passphrase wrapper around it. The mode was not under-implemented; it was undeliverable as
specified, and the passphrase told the user otherwise.

**The same-machine backup was documentation wearing a feature's clothes.** It printed
where `profiles.json` and `content.db` live so the user could copy them. That is a
paragraph in a guide. A backup feature should produce a file.

**Import without credential resolution restores broken connections that look whole.** A
profile whose `credentialId` is empty or points at nothing on this machine renders
identically to one that works, and fails at the moment the user tries to connect. The gap
has to be named at restore time, in the product, not discovered later.

## Decision

### One product: Backup & Restore

The four modes are replaced by one capability that produces one versioned, structured,
plaintext JSON document — `nocx-backup` v1, at most 8 MiB of UTF-8 JSON
(`backup.MaxDocumentBytes`). The document is self-contained: it references no keychain
entry, no secret store and no content database.

It is plaintext, deliberately. Encryption of the file is the user's filesystem's job — a
FileVault volume, an encrypted USB stick, an age-wrapped copy. Putting a passphrase in
front of a document that provably contains no secrets buys confidence rather than
confidentiality, which is the mistake ADR-0011 §7's portable mode made.

### What the backup carries

- **Saved non-secret settings overrides** — every `Registry` value whose `DataClass` is
  `PublicConfig`, `PrivateMetadata` or `PrivateContent`. `SecretAuthenticator` values are
  excluded. Only user-saved overrides travel; declared defaults do not.
- **SSH connections** — every field of `SSHProfile` except `CredentialID`. A profile that
  had a credential — directly, or through its group's
  `defaults.ssh.options.credentialId` — carries `requiresCredential: true` instead.
- **Profile groups** — identity (`ID`, `ParentGroupID`, `Name`, `Icon`, `Color`,
  `Editable`) plus a typed, enumerated subset of `defaults.ssh.options`: `port`, `user`,
  `auth`, `keepaliveInterval`, `keepaliveCountMax`, `readyTimeout`, `jumpHost`,
  `agentForward`, `desiredMode`, `portDiscovery`. That is ten of the twelve non-secret
  fields a `SparseSSHOptions` can hold; `keyPath` and `behaviorOnSessionEnd` are dropped
  and listed by name in `omittedDefaultKeys`, as is any key the document did not recognise.

  The subset is an enumerated assignment, not a filter over whatever the provider exposes.
  A field added to `SparseSSHOptions` upstream is therefore silently absent from group
  defaults until somebody adds it here on purpose — it is not even reported as an omission,
  because `UnknownKeys` only sees keys that failed to unmarshal, and a newly-known field
  unmarshals fine. That is the cost of the safe direction, and it is the right one: a
  backup that carried options it had never been taught about is how a credential reference
  travels by accident.

  The three secret references a group default can hold (`passwordSecret`, `keySecret`,
  `keyPassphraseSecret`) are counted through `credentialBindingRemoved` and never listed by
  name. A backup must not name a secret key, not even to say it left it behind.

And what it never carries, structurally rather than by convention: `Credential` records,
any `credentialId` key on any object, `SecretID` or `PassphraseSecretID`, any keychain
material, `ContentDB` content, and app state such as window layout or open tabs.

`ContentDB` is excluded from v1 rather than gated behind a flag. Conversations and command
history are `PrivateContent` under ADR-0011 §3, they are large, and they are SQLite rather
than JSON. Carrying them is its own decision with its own format question, and
`nocx-u0rv.1` already holds the part of it that bites first — a content database restored
onto a second machine has to be re-keyed there.

### Two restore strategies, both previewed

**Merge** is the default and is additive. Backup overrides win per key; local overrides for
keys the backup does not mention survive. Profiles and groups with matching IDs take the
backup's fields. Records only present locally are kept.

Credential bindings are where merge has to make a judgement, and it makes the conservative
one. A local connection's direct `credentialId` survives only when its trimmed host and
effective port (0 read as 22) are unchanged from the backup — a connection that now points
somewhere else must not silently keep authenticating with the old host's secret. A matching
group loses its group-default credential binding unconditionally, because a group default
is not tied to one host identity and so nothing about it can be revalidated.

**Replace** is the destructive one and says so. Non-secret settings overrides become
exactly the backup's set and everything else resets to its declared default; connections
and groups become exactly the backup's set, in the backup's order, with no credential
bindings at all.

Both strategies leave credential records and keychain entries alone. The backup cannot
describe them, so restore cannot touch them.

### The preview binds the restore that follows it

Restore is not a call the UI may make on its own. `Preview` returns counts (included,
added, updated, removed, reset — for settings, connections and groups), the connections
that will need a credential reassigned by ID and name, and the omissions: credential
bindings dropped from connections, from groups, and group-default keys the backup format
does not carry.

It also returns a `previewToken`: SHA-256 over the file contents, the chosen strategy and
the canonical current state. `Restore` recomputes that token from the state it is about to
overwrite and refuses if it differs. So a preview the user read, then left on screen while
something else changed the configuration, cannot be confirmed — the write is rejected
before it starts and the UI re-previews. The interval this closes runs from the moment the
user is shown numbers until the moment those numbers are applied; without the token the
user confirms a description of a state that no longer exists.

### The gate is the one the config domain already has

Backup create, preview and restore acquire the **existing** `configGate` admission from
ADR-0026, then the bounded execution lane, in that order — the canonical order every
config operation uses. `capability.NewBackupOperation` composes them, and `BackupService`
is reachable only inside `BackupOperation.Run`.

This is worth stating because the first implementation did not do it. It introduced a
second gate of its own — a `configMu`/`configErr` pair with an exclusive mode for backup
and a shared mode for CRUD — beside the admission machinery that already serialises the
config domain. Two owners for "may this configuration operation proceed" is the defect
whichever one wins, so the private gate was deleted rather than reconciled. Backup gets no
special locking discipline; it is a config operation, and the config domain already knows
how to serialise those.

### Restore is journalled, and recovery runs before the app exists

Restore writes a crash-safe journal document through `storage.DocumentStore`, moving
`prepared → committed → idle`:

1. Durably record `prepared`, carrying before-snapshots of connections and settings.
2. One atomic connection write.
3. One atomic settings write, with the change notification held back.
4. Durably record `committed`, still carrying the before-snapshots.
5. Best-effort cleanup to `idle`.
6. Publish the deferred settings notification.

A journal document that is absent reads as `idle`. `Recover` resolves each state: `idle` is
a no-op; `prepared` rolls both stores back to their before-snapshots and cleans to `idle`;
`committed` means the applied state is already correct and only needs cleaning. An unknown
version or state, or a document that will not parse, is an error — never a guess.

The interval opens at the durable `prepared` write and closes at the durable `committed`
write. Every failure inside it calls `Recover` immediately and reports both errors if
recovery also fails.

**And `Recover` runs at startup, before the app is built.** `app.New` calls it on the
backup service and returns an error if it fails, so a machine whose journal cannot be
resolved does not start a terminal with a half-applied configuration behind it. There is no
degraded mode where the app runs and refuses configuration writes — a soft degrade the UI
contradicts is exactly what AGENTS.md forbids, and here there is nothing for the user to do
in a running app anyway.

### The format has its own version

`version: 1` in the document is the backup format's version, unrelated to the app-wide
schema version or any per-module one. v1 accepts v1 files and nothing else. A second
version needs a migration rule, and that needs an ADR.

## Consequences

- `internal/export` and its six `export.*` JSON-RPC methods are gone. `internal/backup`
  replaces them with `backup.create`, `backup.preview`, `backup.restore` and
  `backup.saveToFile`, each with a schema in `contracts/`.
- `internal/profile.JSONStore` gains `LoadConnectionSnapshot` and
  `ReplaceConnectionSnapshot` — a whole-aggregate read and one atomic whole-aggregate
  write, preserving credential metadata the backup never saw.
- `internal/settings.Registry` gains `NonSecretOverrides`, `ReplaceNonSecretOverrides` and
  a `PendingNotification`/`Publish` pair, so a restore can write settings and announce the
  change after the journal commits rather than during it.
- The Export / Backup / Import page becomes one Backup & Restore page.
- The backup file format is a contract from here on. Changing it needs an ADR.
- ADR-0011 §7 is superseded. Its remaining sections are not.

## Revisit when

- **Users ask for an encrypted backup.** The decision to make then is _where_: the app
  encrypts the file, or the user encrypts the directory. Reaching for a passphrase in the
  app is how §7's portable mode happened.
- **`ContentDB` needs to travel.** A new opt-in section or a separate product, and it
  collides with `nocx-u0rv.1` (re-keying on the destination machine) before it collides
  with anything about format.
- **A v2 format is needed.** Migration rules and a backward-compatibility policy have to
  be decided, not inferred.
- **8 MiB stops being enough.** The limit exists so the document stays debuggable by hand;
  raising it or going binary trades that away and should be argued, not adjusted.
