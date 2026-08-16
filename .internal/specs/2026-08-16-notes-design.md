# Notes — write it down without leaving the terminal

**Status:** design, awaiting the owner's approval
**Bead:** the epic filed from this document
**Comes from:** `nocx-d8q7` (the brainstorm that produced the snippets spec; notes were
deliberately left to a separate spec and a separate epic)
**Sibling:** `.internal/specs/2026-08-13-snippets-design.md` §13, which decided in advance
what notes may borrow and what they may not

---

## 1. What a person can do that they cannot today

Press one chord and be typing. What they type survives the app closing, is called
something without being asked, and is found later by a word they remember from inside it.

That is the whole feature. Everything below exists to keep that sentence true when the
disk fails, the schema changes, the library grows, or the person types a secret into it.

The case it comes from: something worth keeping shows up **while** you are working — a
host you were given, a step you had to figure out, a paragraph for the commit message you
have not written yet. Today it goes into another app, which means leaving the one you are
in, which means it usually does not get written down at all.

## 2. Deliberately out

- **Sync between machines, sharing, publishing.** Same line the snippets spec drew.
- **A folder hierarchy, tags, links between notes.** A flat list with search is the whole
  organisation. Every note app that started with a hierarchy spent its second year on the
  hierarchy; the thing being tested here is capture.
- **Attaching a note to a session, a directory or a command block.** Tempting and out:
  the attachment point is a decision that needs its own evidence, and a note that is
  attached to nothing is exactly what the "quickly write something down" case wants. §11
  says where an attachment would be added later without widening anything now.
- **Rendered markdown preview.** The editor shows markdown with highlighting; a second
  rendered view is a second surface for the same document, and nobody has asked for it.
- **A second editor implementation.** The body is the CM6 host the file viewer and the
  snippet body already use, in its editable mode.

## 3. The boundaries this crosses, and what they already decided

Named before anything is built, because a brief that crosses a boundary decides the
architecture whether or not it says so.

- **AD-1 (transport).** `notes.*` is a JSON-RPC control-plane domain like `snippets.*`.
  Bodies are user text in a JSON result — ordinary control-plane traffic, not PTY bytes.
  Every result shape gets a schema in `contracts/`.
- **AD-6 (single-owner state).** The note document's authority is the backend store. The
  editor holds a draft while it is open, and the draft is not the note until it is saved
  (§6.3 says exactly when that is).
- **AD-8 (interface-first + DI).** One store interface, one service, injected at the
  composition root. The frontend has ONE notes store object that every surface reads —
  the same rule §6 of the snippets spec states, and for the same reason.
- **ADR-0004 (who owns input).** Notes do **not** become a third input target. The prompt
  line answers "shell or agent"; a note is a document and it lives in a tab, so the
  question never reaches the input arbiter. This was the owner's first instinct and it is
  written down because the cheap-looking alternative is a mode switch on the prompt.
- **ADR-0013 (theme tokens).** The editor paints through `--color-*`, like every other
  surface; the CM6 host already does this, in the field colours its editable mode learned
  for the snippet body.
- **ADR-0027 (structured backup and restore).** Notes are a section somebody writes, the
  way the snippet library is (`§5.4` there). A backup without a notes section restores
  without touching notes; a notes section restores whole.
- **`internal/content` is NOT reused for storage** — §4.2 is the argument, and it is the
  most consequential decision in this document.

## 4. The store

### 4.1 SQLite, encrypted, in its own file

Notes live in SQLite, in `notes.db` under the profile directory, opened through the same
adiantum VFS and the same content key the history store uses
(`internal/contentkey.LoadOrCreate`). The reasons, in order:

1. **Search is the feature.** A note is found by a word from inside it, and that is a
   query, not a scan the frontend does over everything it loaded.
2. **The encryption already exists.** A note is at least as private as a command line, and
   command history is encrypted at rest with a key whose lifecycle is solved. Writing
   plaintext `.md` files beside an encrypted history would be an inconsistency nobody
   could defend in the one sentence it deserves.
3. **FTS5 is available and was measured, not assumed** (2026-08-16, driver v0.35.2):
   `ext/fts5.Register` on the connection, over the wasm module already in `go.mod`.
   Verified working with a Cyrillic match and with `snippet()` for the excerpt a result
   row shows. No new binary, no build tag.

### 4.2 Why NOT the existing content database

`internal/content` bumps `schemaVersion` and **rebuilds the file**: every user table is
dropped and the rows are discarded deliberately, because a half-broken store is worse than
no store and history is a log that can be re-made by living.

**Authored text may never be discarded by an upgrade.** A person who wrote something down
and finds it gone after an update has been robbed by us, and no honest message repairs it.
So notes get their own file with the opposite rule, stated here as the store's contract:

> The notes store never discards. A schema change ships with a migration, or it does not
> ship. If the file cannot be opened, notes are UNAVAILABLE and say so (§8) — an empty
> list is never how a read failure is reported.

Two files, two rules, one key. That is cheaper than one file with an exception in it,
because an exception in a rebuild path is a rule nobody can rely on.

### 4.3 The shape

```sql
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,   -- backend-minted, like every snippet id
  body       TEXT NOT NULL,      -- markdown, the whole note
  created_at INTEGER NOT NULL,   -- epoch ms
  updated_at INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  body, content='notes', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
-- plus the three triggers that keep the index in step with the table
```

**There is no title column, and that is the design.** §7 derives the title from the body;
a stored title beside the text it is derived from is two owners of one fact, and they
disagree the first time somebody edits the first line.

## 5. The wire

`notes.*`, one schema per result in `contracts/`, validated on the Go side and generated
into the renderer's types — the rule the vault taught this repo.

| method         | params         | result                                             |
| -------------- | -------------- | -------------------------------------------------- |
| `notes.list`   | —              | `{ notes: [{ id, title, excerpt, updatedAt }] }`   |
| `notes.get`    | `{ id }`       | `{ id, body, createdAt, updatedAt }`               |
| `notes.create` | `{ body? }`    | the created note                                   |
| `notes.update` | `{ id, body }` | the updated note                                   |
| `notes.delete` | `{ id }`       | `{ id }`                                           |
| `notes.search` | `{ query }`    | `{ matches: [{ id, title, excerpt, updatedAt }] }` |

`list` and `search` return a **title and an excerpt, never the whole body**: the list is a
list, and a hundred notes' worth of prose crossing the wire to render forty pixels of each
is the kind of thing that is invisible until it is not. `get` is what the editor opens
with. `search` is FTS5 with `snippet()` for the excerpt, so the row shows the words that
matched.

The domain is capability-gated beside `snippets.*` in the config lane: a note write and a
backup restore must not interleave.

## 6. The surfaces

### 6.1 The activity bar panel — where notes are found

A `SidebarViewDescriptor` beside Files, Ports and Git: a search field over a list of
titles with their excerpts, newest first. Activating a row opens the note's tab. `+`
creates one and opens it.

The panel is deliberately NOT an editor. It is 240px wide by default; that is a good width
for finding and a bad one for writing, and a surface that is bad at what it is for is worse
than not having it.

### 6.2 The tab — where a note is written

A tab like Settings and the file viewer: the CM6 host in editable mode, markdown language
from `file-viewer/language-registry.ts`, the kit's tokens. The tab's title is the note's
derived title (§7), so the tab strip shows what the note is about as it is typed.

One tab per note, deduplicated on the note id the way the file viewer deduplicates on a
file's identity: asking for the same note twice focuses the tab that is already open,
because two editors over one document is two drafts of it.

### 6.3 The chord — the whole point

**⌥⌘N creates a note and opens its tab with the caret in the body.** No panel, no menu, no
dialog: the distance between the impulse and the first character is one keystroke, and
that distance is the feature. The chord is one predicate in one module, read by the
keyboard boundaries that need it — the shape `snippets/chord.ts` already has, for the
reason AD-8 gives.

Saving is not a gesture:

- **On idle**, ~500 ms after typing stops. Not per keystroke: that is a disk write on the
  hot path of somebody's thinking.
- **On close and on hide** — closing the tab, closing the app, switching away.
- **A save that fails says so on the tab and keeps the draft.** The editor does not close
  over an unsaved note, and it never reports "saved" for a write that did not land.

## 7. The title nobody types

The title is **derived from the body, every time it is read**:

1. The first non-empty line, with leading `#`s and whitespace stripped, bounded to 80
   characters.
2. If the body has no non-empty line yet: `Note — <creation date>` in the person's locale.

Derived, never stored (§4.3). Edit the first line and the tab, the list row and the search
result agree in the same breath, because there is only one place the name comes from.

## 8. Failure paths, as intervals

- **The store cannot be opened** (disk, permissions, a key the keystore will not give
  back): the panel says why, offers Retry, and offers **no create** — an affordance that
  cannot be honoured is a lie. The soft degrade is visible in the product, never only in a
  log.
- **A save fails** while a tab is open: the tab shows the reason and keeps the text. The
  note is not lost by closing the app, because the next save attempt runs on close and
  the failure repeats visibly rather than silently.
- **A note is deleted while its tab is open**: the tab says the note is gone and offers to
  save the text as a new note. Nothing is dropped on the floor.
- **The key is unavailable**: the store is unavailable — notes are never written
  unencrypted as a fallback, and never silently discarded either.
- **Every external call has a failing test**: the store's open, each query, the key read,
  and the backup section's read and write.
- **The interval, stated with both ends**: from the first keystroke until a save lands,
  the text exists in exactly one place (the editor) and the product says so (the tab is
  marked unsaved); from the save landing until the next edit, the store is the authority
  and the editor is a view of it.

## 9. What is NOT a secret detector

A note may contain anything, including a password somebody pasted. Notes do **not** grow a
detector, a redactor or a warning: `secret-candidate.ts` owns "this looks like a secret" on
the prompt path, and a second owner of that judgement in a second place is how the two
disagree. The store is encrypted at rest, which is the honest answer to the question the
detector would be pretending to answer.

## 10. Backup

A `notes` section in the backup document, beside profiles, settings and snippets
(ADR-0027, snippets §5.4): every note, whole, with its timestamps. A restore replaces the
section under the same lane the rest of the restore holds. A backup written before this
feature has no notes section and restores without touching notes.

## 11. Where an attachment would attach later

If notes ever become attached to a directory, a session or a command block, the column is
`notes.scope` — a nullable typed reference — and the panel gains a filter over it. Nothing
in this document should be widened for it in advance: the flat library is what the capture
case needs, and an attachment nobody has asked for is a schema everybody pays for.

## 12. Acceptance — as assertions, not prose

The epic's DONE WHEN, and the shape each child's criteria take:

- [ ] **The sentence, end to end**: press ⌥⌘N in a terminal pane, type two lines, close the
      tab, restart the backend, find the note in the panel by a word from its second line,
      open it, and the text is exactly what was typed.
- [ ] `deadcode -filter 'nocx/internal/note'` is empty and `note.NewService` has a caller
      outside its own tests.
- [ ] The store's file survives a schema change: a migration test writes v1, opens with v2,
      and every row is still there — the rule §4.2 states, as a test that fails if anybody
      copies the content store's rebuild.
- [ ] `notes.search` finds a note by a word that appears only in its body, and the result
      carries an excerpt containing that word.
- [ ] A title is never stored: editing the first line changes the tab title, the list row
      and the search result, and the database has no title column.
- [ ] A failing save keeps the text on screen and says why; the tab cannot close silently
      over it.
- [ ] With the store unavailable the panel states the reason and offers no create.
- [ ] A library survives backup → wipe → restore with bodies and timestamps intact.
- [ ] `frontend/src/snippets/**` appears in no commit of this epic — notes borrow the CM6
      host and the tab machinery, and change neither.
