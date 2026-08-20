# Restore: what a block keeps, and what comes back when the app opens

- **Date:** 2026-08-19
- **Beads:** `nocx-o3fds` (this session), `nocx-2f0f` (output capture), `nocx-l21ib`
  (restore), `nocx-rtg0.30` (retention knobs), `nocx-o9jdu` (the unlock storm),
  `nocx-z5kdv` (a restore marks every tab unread)
- **Amends:** `.internal/specs/2026-07-31-command-blocks-history-syntax-design.md` §3.5 —
  the durable body of a block is **SGR text plus derived plain text**, not plain text
  alone. `.internal/specs/2026-08-16-tabs-panes-and-blocks-design.md` §8 — the inline-`ssh`
  clause is withdrawn as a thing to build; it needs no code (§7 here).
- **Status:** design, settled with the owner on 2026-08-19, one question at a time.

## 1. In one sentence

**A block keeps what it printed, and the application opens on what you left.** Capture
happens once, at block freeze; restore is a query over the ledger by `pane_id`, rendered as
blocks that are visibly not live.

**What a user can do that they cannot today:** quit with eight tabs across three
workspaces, reopen, and find them — with their commands, their directories and their output
in colour — where they were.

## 2. What this crosses, and what those documents already decided

| Boundary           | What it already decides                                                                                                             | What this design does about it                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **AD-6**           | The backend never parses the byte stream                                                                                            | **Intact and load-bearing**: both artifact bodies are produced in the renderer, which already holds the cells (§3)                       |
| **AD-1**           | Raw binary data plane, JSON-RPC control plane                                                                                       | Capture is a control-plane method (`ledger.capture`); no output byte ever rides the data plane in the other direction                    |
| **AD-8**           | One owner per behaviour                                                                                                             | The freeze-time serializer is the single producer of a block's body, in two emission modes; restore reuses `ledger.query`'s one ordering |
| **AD-9**           | A renderer re-attaches to live sessions                                                                                             | Why capture is idempotent on a client-minted artifact id: a capture whose ack was lost is retried and must not store the output twice    |
| **ADR-0019 §3**    | Restore is three promises; **live resumption may not be implied by the UI**                                                         | §6: a restored block is marked as restored, separated from the live shell, and offers no action that needs a process                     |
| **ADR-0019 §6**    | Derived text is an artifact with provenance, not a string                                                                           | §3 stores two artifacts joined by `derived_from`, each with capture method, version and terminal dimensions                              |
| **ADR-0019 §7**    | Reconstruction states its own horizon                                                                                               | §6: an evicted body renders as an honest marker; a degraded store says so in the product, never only in a log                            |
| **ADR-0008**       | "Output bytes are not retained (secrets)"                                                                                           | Already superseded by ADR-0019 and recorded as stale by the 2026-08-16 design §6.3. Secrecy is handled by §4's suppression rules instead |
| **D5** (lineage)   | Workers die with the backend; a process is never resurrected                                                                        | Unchanged, and narrowed further by the owner on 2026-08-19: process resurrection and inline-`ssh` restoration are both out (§7)          |
| **`nocx-2f0f` v6** | Capture is the freeze-time `serializeRange` pass; the byte-stream recognizer, the alt-screen case and `truncated='gap'` are deleted | **Adopted verbatim.** Children `.1` and `.2` predate it and are rewritten (§8)                                                           |
| **`nocx-rtg0.12`** | Eviction and the retention watermark are built and run on the write path                                                            | Not rebuilt. `nocx-2f0f` adds only the two knobs that are about OUTPUT; the size and age knobs stay `nocx-rtg0.30`'s (§4.3)              |

## 3. What a block keeps

Two artifacts per frozen block, both produced by the renderer at freeze, joined by
`derived_from`:

| Artifact         | Media type       | What it is                                                                       |
| ---------------- | ---------------- | -------------------------------------------------------------------------------- |
| the body         | `application/vt` | the block's text carrying **SGR attributes only** — colour, bold, inverse        |
| the derived text | `text/plain`     | the same text with the attributes stripped: what search, copy and the agent read |

**Why two and not one.** A single plain body loses colour, and a restored `ls`, `git diff`
or a compiler's diagnostics read as data loss rather than as history. A single SGR body
makes search index escape codes, so a needle spanning a colour change stops matching. Two
bodies is what the schema's `derived_from` was put there for.

**Why SGR and not the serialized HTML the frozen block already holds.** HTML is three to
ten times the bytes, and it embeds a _theme snapshot_ — restored blocks would stay in the
palette that was current when they ran while every live block repainted around them. SGR is
theme-independent: the restore path applies the palette that is current now, so a theme
change repaints the past as well as the present.

**Provenance is not optional** (ADR-0019 §6): `capture_method='terminal-cells'`,
`capture_version=SERIALIZER_VERSION`, `terminal_cols`/`terminal_rows` as the serializer saw
them. Without them a later reader cannot tell which transform set produced the text.

## 4. Capture

### 4.1 Where it happens

`frontend/src/scrollback/blocks.ts:1243` already calls
`serializeRange(snapshot, getLine, rec.outputStart, endLine)` at freeze and turns the
result into the frozen block's DOM. Capture is the **same pass in two more emission
modes**. Buffer and markers share the parser's clock, so there is nothing to reconcile —
this is `nocx-2f0f`'s own v6 correction, and the streaming recognizer, the `ipc.ts` capture
site and the alt-screen special case stay deleted.

**Alt-screen needs no rule.** A program that takes the alternate buffer writes no
scrollback lines, so the range a block serializes is empty by construction. There is no
classifier anywhere in this path and there must not be one.

### 4.2 How it reaches the store

A new control-plane method, `ledger.capture`, beside `ledger.open` / `bind` / `close`:

- The artifact id is **client-minted UUIDv7 and untrusted**, like every other id the
  renderer mints (2026-08-16 design §7). A capture whose ack was lost is retried, and the
  retry must return the first artifact rather than store the output twice.
- The body crosses in chunks, which is what `artifact_chunks` is: append-only, `(artifact_id, seq)`.
  A large block is several messages, never one.
- It is **not** folded into `ledger.close`. The close travels through the renderer's outbox
  and is retried on a socket drop (`nocx-rtg0.4`); a close carrying a megabyte would resend
  that megabyte on every retry, and a capture that fails would then cost the entry its
  outcome. They fail separately because they are separate facts.

### 4.3 What is not captured, and what bounds what is

| Case                                                              | What happens                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `entries.sensitivity='sensitive'`, leading space, `do-not-record` | no artifact; the block is sealed `truncated='suppressed'` |
| output above the per-entry cap                                    | head and tail kept, middle dropped, `truncated='cap'`     |
| output capture switched off in settings                           | no artifact; the entry and its metadata are unaffected    |

The per-entry cap is **128 KiB of head and 128 KiB of tail**. Errors live in the tail, the
invocation and its first diagnostics in the head, and the progress bar between them is of
no value to anyone. A cap on bytes rather than on lines is what bounds the budget almost
independently of what the user runs.

**Two knobs, and only two, belong to this epic**: "keep command output" and the per-entry
cap. The total size and the age are `nocx-rtg0.30`'s, which exists because the knobs the
Settings page already shows reach the interim sweep rather than the ledger. Two epics
writing the same four knobs is the one-owner defect, so they are split by which knob rather
than by which page.

## 5. Restore: the read

**The anchor is the pane** (2026-08-16 design §11): `entries.pane_id`, durable,
frontend-minted, nulled never — `session_id` beside it is provenance and dies with the
backend.

- `ledger.query` gains a **`paneId`** filter on the wire. `content.LedgerQuery.PaneID`
  already exists and `QueryEntries` already honours it; only the transport's params and the
  contract are missing. There is no second query and no second ordering: `seq DESC` stays
  the one total order, and the restore path reverses the page it is given.
- **The pane's `cwd` is kept current.** A new `panes.setCwd`, called by the renderer on a
  verified OSC 7 report. Today `Pane.Cwd` is written once at creation and never revised —
  `internal/content/layout.go` says so in as many words — so a restored local pane would
  otherwise open wherever the pane was first created rather than where it was left.
- **Fifty blocks per pane**, newest first, and they are fetched when a pane's content is
  first shown rather than at boot: eight panes at fifty blocks is four hundred blocks of DOM
  before the first frame. Anything older is reached through recall; paging upward inside a
  restored pane is deliberately not in this cut (`nocx-rtg0.31` is the cursor that would
  make it possible).

## 6. Restore: the drawing

**A restored block is built from the store, not from a terminal buffer.** A new
construction path in `blocks.ts` takes the entry's facts — command, cwd, status, exit code,
duration — and the SGR body. What is genuinely new is a reader that turns SGR sequences
back into the attribute set the serializer already understands; the mapping from that
attribute set to inline styles, and the palette it resolves against, stay
`serializer.ts`'s and are not written a second time. One vocabulary for a block's
appearance, reached from two entry points.

**It must be visibly not live** (ADR-0019 §3). Three rules:

1. Restored blocks carry `data-restored` and sit above an explicit boundary marking where
   the previous session ended and the fresh shell begins.
2. No action that needs the process it ran in is offered on a restored block.
3. Nothing in the surface says or implies that the shell continued.

**Every hole is named.** A block whose artifact retention has evicted renders with an
honest marker in place of its output — never as a command that printed nothing. A block
sealed `truncated='cap'` says where its middle went. And when the content store is degraded
to the stub — an unreadable content key, a store that will not open — the tabs still come
back and **the product states that history is unavailable**, through the surface
`nocx-rtg0.19` already built for it. A soft degrade visible only in a log is the named
anti-pattern this epic inherits.

## 7. What restore does not do

- **It does not resurrect a process.** D5 is unchanged: a local pane starts a fresh shell in
  the restored cwd, and a cwd that no longer exists falls back to home.
- **It does not restore an inline `ssh`.** A pane in which somebody typed `ssh host` comes
  back as its local shell, and no code is written for that case: the blocks that ran on the
  far host keep saying so because `environment_id` and the host are already columns on the
  entry. The owner settled this on 2026-08-19.
- **A pane opened AS ssh reconnects** — a new connection to the same endpoint, which is not
  a resurrection. It waits on `nocx-o9jdu`, where eight panes reconnecting behind a sealed
  vault raise eight unlocks and seven of them are already answered by the first.
- **Reopening a closed session** — the grace-period undo-close named in `nocx-l21ib`'s body
  — is **out**, and becomes its own epic. It shares nothing with startup restore but a
  settings page: it needs a buffer of closed panes, a timer, a deferred `DeletePane` and its
  own affordance.

## 8. The order, and what it costs

| #   | Epic         | What it is                                                           |
| --- | ------------ | -------------------------------------------------------------------- |
| 1   | `nocx-2f0f`  | a block keeps what it printed: two artifacts, one capture, two knobs |
| 2   | `nocx-l21ib` | the application opens on what you left                               |

The edge is real and belongs in the backlog: restore renders bodies that capture is the
only writer of, and both touch `blocks.ts`, `serializer.ts` and the ledger's artifact path.
Without 1, "the blocks come back" restores metadata against an empty artifact table.

**`nocx-2f0f`'s children `.1` and `.2` are rewritten, not worked.** They were written on
2026-07-31 against the premise the epic's own v6 note withdraws — capture in `ipc.ts`, a
streaming recognizer over the bytes, alt-screen toggles inside it. Working them as written
would rebuild the thing that was deleted for being a self-inflicted problem. `.3` is
narrowed: with capture at freeze there is no durable raw-VT stream to derive from, so the
`derived_from` chain is SGR → plain rather than VT → plain. `.5` is narrowed to the two
output knobs (§4.3).

## 9. Acceptance

> A user with eight tabs across three workspaces — one default, two named and coloured —
> runs commands in them, quits, and reopens. Every tab returns in its workspace with its
> name and colour; every pane returns in the directory it was left in; every block returns
> with its command, its status and its output in colour, repainted in whatever theme is
> current. No restored block is presented as live. With the setting off, the same quit and
> reopen gives one fresh local tab. With the content store degraded to the stub, the tabs
> return and the product says that history is unavailable. A block whose output was evicted
> shows a marker where the output was, and a restore marks no tab unread.

Watched end to end by an automated check, both directions of the setting.

Out of scope: process resurrection, inline-`ssh` restoration, undo-close and its grace
period, paging older blocks upward inside a restored pane, multi-window.
