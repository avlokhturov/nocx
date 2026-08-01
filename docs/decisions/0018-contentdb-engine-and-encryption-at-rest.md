# ADR-0018 — ContentDB: SQLite, encrypted at rest, with its own key

- **Status:** Accepted
- **Date:** 2026-08-01
- **Related:** [ADR-0011](0011-persistence-storage-capabilities-and-secret-references.md)
  §1 and §5 (three storage capabilities; ContentDB declared as a seam, its SQLite
  dependency deferred until a feature needs it), [ADR-0017](0017-a-connection-references-a-secret.md)
  (a connection references a secret), AD-8 (interface-first + DI at one composition
  root), `docs/vision.md` §10 (no cloud sync, no telemetry — ever).
- **Design:** `.internal/specs/2026-07-31-command-blocks-history-syntax-design.md`
  §5, §9, §17.2.
- **Fulfils:** ADR-0011 §5's "the SQLite dependency lands with whichever feature needs
  it first". Durable command memory is that feature.

## Context

ADR-0011 named three storage capabilities and deliberately left one of them a stub:
`internal/content` declares `ContentDB`, `ConversationRepository` and
`CommandHistoryRepository`, and every method returns `ErrNotImplemented`. The ADR said
the SQLite dependency would be adopted when a feature needed it, and would be chosen
deliberately rather than by default.

Durable command memory is that feature, and it arrives with a property the earlier
decision did not have to price: **`content.db` will hold every command the user has run,
with hosts, working directories and — once output capture lands — a retained slice of
what those commands printed.** On production infrastructure, over years. `0600` on a
plaintext file was adequate for the stub and is not adequate for that.

Three things forced the question now rather than later.

**The engine choice is not reversible in practice.** The schema in the design's §5.2 is
already written against a relational store with foreign keys, cascades, partial indexes
and a full-text index that must be evicted in the same transaction as the rows it
covers. Choosing differently after the first release means rewriting persistence, not
swapping a driver.

**Encryption is not reversible either.** SQLCipher's page format is decided at database
creation. A database created unencrypted stays unencrypted unless it is migrated
wholesale, and a migration of years of history under a key the user may not have is
exactly the operation nobody wants to design after the fact.

**The obvious key source is wrong.** `internal/vault` already owns a root key and seals
itself on a timeout. Reusing it would make history unreadable whenever the vault is
sealed — including at startup, which is precisely when recall is wanted. A memory
product whose memory requires a passphrase to open a terminal is not the product.

The shell baseline is worth stating, because it cuts both ways. `~/.bash_history` is
plaintext with mode `0600` and no output at all; `~/.zsh_history` and fish's history are
the same shape. So plaintext-on-disk is the thirty-five-year industry norm for _command
lines_ — and we are proposing to store roughly two orders of magnitude more per command.
The norm does not license us; it does mean encryption puts us above the baseline rather
than catching up to it.

## Decision

### 1. SQLite is the ContentDB engine

Not because the write rate is small — hundreds of commands a day is nothing for any
engine — but because the requirements are almost a definition of a small transactional
database:

- a unique, backend-assigned `seq` as the only total order;
- idempotent state transitions (`open → bound → closed`), replay-safe;
- foreign keys with cascade across entries, artifacts and chunks;
- a graph of edges between entries;
- range selection over `(environment_id, cwd, seq DESC)`;
- a startup sweep over unclosed rows via a partial index;
- **deletion of an artifact and its full-text index row atomically**;
- full-text search over two distinct logical sources.

Every non-relational candidate answers the first seven by making us write them. The
decisive one is the eighth: any architecture that puts the search index in a second
store cannot commit both in one transaction, and an index that outlives its data answers
searches with content the store no longer holds. That failure is not hypothetical
housekeeping — it is what makes the privacy action "forget this output" a lie.

### 2. Encryption at rest via SQLCipher, chosen by spike and not by assumption

The database is encrypted. Metadata, chunks and the FTS index live in **one** encrypted
file — splitting them would reintroduce the cross-store atomicity problem this decision
exists to avoid.

The mechanism is SQLCipher, which encrypts at page level and therefore covers tables,
B-trees and the FTS shadow tables uniformly, leaving SQL and FTS5 as ordinary SQLite
mechanisms. It requires CGO. Wails already links the platform webview through cgo on
macOS and Linux, so this is not a new class of dependency — but it does enlarge the
release matrix, and that cost is real.

**No specific Go driver is named here, deliberately.** Adoption is gated on a spike that
proves, on macOS and Linux, in a _packaged_ app rather than on a developer's machine:

1. the driver builds SQLCipher with `STRICT`, JSON1 and FTS5 — verified by reading
   `PRAGMA compile_options`, not by trusting a README;
2. WAL, checkpointing, crash recovery and FTS all behave under encryption;
3. chunk ingest does not produce unacceptable write amplification;
4. eviction followed by compaction returns physical space, not only logical rows.

If the spike fails on packaging, the fallback is **not** a more convenient engine. It is
to ship without the encrypted-history feature until an encrypted build is proven.
Trading demonstrated transactional correctness for a build that is easier to compile is
the wrong exchange.

### 3. ContentDB has its own key, in the OS keychain, outside the vault's seal

```
OS keychain
  └── ContentDB key: 32 random bytes
        └── SQLCipher content.db
```

The key is minted once, stored as its own keychain item through the same platform
mechanism `internal/vault/system` uses, and read at application start. It is **not** the
vault root key from `internal/vault/keys.go`, and it is **not** wrapped by it.

This is the whole point of the separation: the vault's auto-seal governs _authenticators_,
and it must not govern _memory_. A sealed vault means "you must re-authorise before I use
your SSH password". It must never mean "I have forgotten what you did yesterday".

A single root of trust — a random ContentDB key wrapped by the vault root KEK with
purpose-bound AAD — is defensible and is **rejected for v1**, because it re-couples
history availability to the vault lifecycle and complicates reset and recovery for a
benefit that is aesthetic.

When the keychain is unreachable, the PTY still starts, ContentDB does not open, ledger
events accumulate in the bounded in-memory outbox, and the UI says plainly that durable
memory is unavailable. What happens when that outbox fills is a product contract, not an
implementation detail — see "Not decided here".

### 4. The threat model, stated rather than implied

Encryption with an automatically-available key protects against a specific and useful
set of things, and against nothing else. Both halves belong in this document, because a
security property that is overstated is worse than one that is absent.

**Protects:** a powered-off machine; a copy of `content.db` without the keychain — which
is what a backup, a Time Machine snapshot, a cloud-synced home directory, or a support
bundle actually is; another local account on the same machine; casual inspection with
the `sqlite3` CLI.

**Does not protect:** a process running as the same user while logged in, which can ask
the keychain for the same key; a compromised nocx; forensics against an unlocked
session.

The most common real-world path by which this data leaves a machine is a copy of the
file, and that path is closed. The rest is not, and the UI must not claim otherwise.

### 5. Losing the key loses the history, and the user is told before it matters

A destroyed or unmigrated keychain item renders years of history cryptographically
unrecoverable. This is an accepted consequence, not a defect: it is the same property
that makes the encryption meaningful. Two obligations follow — the database does not
silently migrate to a new machine, and export (design §10.12) is the supported path for
carrying anything forward.

Per ADR-0011 §5, the UI continues to say "removed from nocx", never "securely erased",
until checkpoint and vacuum behaviour under encryption has been designed deliberately.

## Rationale

The alternatives were evaluated against the eight requirements in §1 rather than against
general merit, and each fails at a nameable point.

| Candidate                                           | Where it breaks                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **bbolt**                                           | One write transaction over the whole file; secondary indexes, cascades and referential integrity by hand; no full-text search, so a second store and a reconciliation protocol.                                                                                                                                                                                                      |
| **BadgerDB**                                        | Built-in encryption is genuinely attractive and does not survive contact with the rest: edges, environment/cwd selection, total order and retention all become hand-written transactional indexes across several keyspaces, and FTS is still external. Value-log GC becomes a second heavy background process next to a terminal.                                                    |
| **Pebble**                                          | Lower-level than Badger, with neither encryption nor search. Building a database instead of a product.                                                                                                                                                                                                                                                                               |
| **DuckDB**                                          | Analytical and columnar. Our profile is frequent single-row mutations and streamed chunks — the shape it is worst at. CGO anyway.                                                                                                                                                                                                                                                    |
| **libSQL / Turso embedded**                         | SQLite-derived and therefore interesting, but its principal value is replication, which we do not want. Encryption maturity, FTS5 behaviour and Go packaging on both platforms are unverified. Keep as a spike candidate, not a default.                                                                                                                                             |
| **Genji / chai**                                    | Narrower ecosystem and far less operational history, with FTS, encrypted pages and migrations all still unsolved. Maturity risk exceeds the benefit.                                                                                                                                                                                                                                 |
| **KV + Bleve**                                      | Good search, wrong transactional boundary: primary store and index cannot commit atomically. Requires generation IDs, tombstones, a replay journal, authoritative result filtering and rebuild tooling — a distributed system inside one process.                                                                                                                                    |
| **Event log + projections**                         | Elegant for lifecycle and out-of-order events, and structurally incompatible with a storage budget: deleting old events destroys the ability to rebuild the projection, and keeping them all violates the retention and privacy rules. A query store and an index are needed regardless.                                                                                             |
| **Time-series engine**                              | Optimised for numeric samples at high rates queried by time-window aggregation. We have text and blobs at tens of writes per day, queried by point lookup, filtered scan and full text — and the design has already demoted wall time to display-only, with `seq` as the only order (§3.2, §6.3). A TSDB would restore time to the position the design deliberately removed it from. |
| **Column-level encryption on plain SQLite**         | Avoids CGO and does not deliver encryption at rest: intent, cwd, host, metadata and FTS tokens all remain plaintext. It also makes full-text search over output impossible, which is the strongest feature the design has.                                                                                                                                                           |
| **Plain SQLite inside an encrypted container file** | Interacts badly with mmap, WAL, crash consistency and random writes.                                                                                                                                                                                                                                                                                                                 |
| **A hand-written encrypted VFS**                    | Nonce reuse, partial writes and WAL semantics make this a place to have a security incident, not a differentiator.                                                                                                                                                                                                                                                                   |

Time partitioning deserves a separate note, because the instinct behind it is sound.
Dropping a whole time partition is far cheaper than `DELETE` plus vacuum, and it
sidesteps reclaiming space under encryption entirely. The corresponding architecture —
SQLite for metadata, graph and FTS, plus encrypted append-only segment files for sealed
output — is recorded as **plan B**, to be activated only if measurement shows chunks
inside SQLite are a real problem at multiple gigabytes. It is not adopted for v1 because
it buys sequential writes at the price of cross-store crash recovery, segment GC,
separate AEAD framing and key rotation.

## Consequences

- `go.mod` gains a CGO SQLite dependency, and the release matrix gains a native build
  per platform. Reproducible builds, code signing and packaging all get harder, and
  SQLite/SQLCipher updates become part of security maintenance.
- The composition root wires a real `ContentDB` in place of the stub. The stub stays as
  the null implementation for anything that does not need content, per AD-8.
- A new keychain item exists per installation, with its own creation, absence and
  failure paths — each of which needs a test in which it fails, per `AGENTS.md`.
- "Total size" as a user-facing budget becomes ambiguous and must be specified as two
  numbers: logical retained content, and a physical ceiling over the main database plus
  WAL. `DELETE` reduces the first and not the second.
- The design's §5.5 ("local-first is not private-at-rest") is superseded in its
  conclusion — the database is no longer plaintext — while its warning survives
  unchanged for the residual risks in §4 above.

## Alternatives considered

Every row of the table in Rationale, plus:

- **Do not encrypt; rely on FileVault and `0600`.** Defensible, and the industry norm
  for shell history. Rejected because full-disk encryption protects a powered-off
  machine and does nothing once the file is copied into a backup or a synced directory,
  which is the common way this data actually escapes.
- **SQLite SEE.** Technically strong and proprietary, with a separate supply-chain
  process. Not pursued.

## Not decided here

- The full-text indexing unit for chunked output, the tokenizer, and whether arbitrary
  substring search is promised (which would require trigrams, at a cost in index size,
  reindex time and privacy surface).
- The loss policy when the outbox overflows or ContentDB is unavailable. "The ledger
  never blocks execution" forces a choice between losing history, unbounded memory and a
  local spool; backpressure on the terminal is forbidden. Which one, and how it is
  surfaced, is a product contract.
- Retention defaults, and the durable watermark that makes search coverage computable
  after eviction.
- Vacuum strategy under encryption, including whether `auto_vacuum=INCREMENTAL` is set
  at creation — a decision that, like the page format, cannot be changed later.

## Revisit when

- The spike in §2 fails on either platform.
- Measurement shows chunk ingest or FTS inside SQLite is the bottleneck at multiple
  gigabytes — then plan B (segment files) becomes live.
- Conversations (ADR-0011's second ContentDB tenant) arrive and bring streaming writes
  with a different profile.
