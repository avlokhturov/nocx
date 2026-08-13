# Snippets — a library of reusable text, fired where you already are

**Status:** design, approved 2026-08-13
**Brainstorming bead:** `nocx-d8q7`
**Scope:** snippets only. Markdown notes are a **separate** spec and a separate epic;
this document says where they will attach and nothing more.

---

## 1. What a user can do that they cannot today

> Save a phrase once, and put it back into whatever is taking input — the command
> editor, a TUI running in the pane, or the clipboard — from a keystroke, with the
> parts that change filled in.

The concrete case that drove this: the owner types the same phrase into `claude`
running in a nocx pane, several times a day, by hand.

**The epic closes when one automated check has watched that happen end to end** (§12).

## 2. Deliberately out

- **Markdown notes.** Next spec. They will reuse this one's namespace registry (§7.2) and
  its destination seam (§9); they do **not** share its store, because the shape a note
  store needs is not yet known and guessing it here would be guessing wrong in a file that
  is hard to change later.
- **Sync between machines, sharing a library, importing someone else's.** No transport,
  no merge, no conflict model. A library is one machine's.
- **Any new mechanism around secrets.** nocx already owns "this looks like a secret"
  (`secret-candidate.ts`), "this is a reference to one" (`secret-reference.ts`,
  `secret-chip.ts`) and "resolve it" (`vault.resolveLine`). Snippets add **none** of
  those. What this design does owe is a statement of what happens when an existing
  reference rides a snippet somewhere that cannot resolve it — §11.1.
- **Firing at the assistant.** `nocx-x8s2` is in flight and has no surface yet. Its
  arrival must be a _registration_ in the destination seam (§9), not an edit to this
  feature. That is the test this design is written to pass.
- **A "run this snippet" that presses Enter for you.** Decided in §9.3.

## 3. Prior art, and what we take from it

`~/repos/termic` — `src/store/prompts.ts`, `src/lib/runPrompt.ts`,
`src/lib/promptFire.ts`, `src/components/dialogs/PromptPalette.tsx`,
`src/components/settings/PromptLibrarySection.tsx`.

**Taken:** a library is title + body and the destination is chosen at fire time, not
stored on the record. A palette on a chord, a menu in the bar, and a management page,
all reading one list.

**Rejected, with reasons:**

| termic does                                                        | we do not                                            | because                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localStorage` in the renderer                                     | backend store (§5)                                   | it must survive a webview reset and be backup-able at all; the renderer is not the owner of user data (AD-6). Backup is **not** free — see §5.4                                                                 |
| ships 13 built-in agent prompts, persists only the delta from them | seeds two ordinary records (§5.3)                    | the delta machinery (`overrides`/`deletedBuiltins`/`disabled`/`order`) exists **to serve** shipped defaults. Without defaults it is pure cost. And we would be owning the text of other vendors' CLI workflows. |
| types the body into the PTY and follows it with a delayed `CR`     | inserts, never submits (§9.3)                        | a template with fields cannot be filled after it has been submitted, and in a shell "insert" and "execute" are not the same act                                                                                 |
| a fire-time destination dialog on every fire                       | destination derived from where input is going (§9.2) | the answer is already knowable; asking is a click for nothing                                                                                                                                                   |

`~/repos/orca` — floating workspace with markdown notes. Read for the **notes** spec,
not this one.

### 3.1 Where the value actually is, and where it is not

**Added by the stress test (branch 7),** because the honest version of this sharpens the
scope. For a plain shell command, this feature is competing with `alias`, a shell
function, and `Ctrl-R` — three mechanisms the user already has, all of which survive
outside nocx. We are not going to beat them and should not claim to.

The value is in the destinations that have **no** such mechanism: a phrase typed into an
agent TUI, a multi-line block of prose, text that carries live session context into a
prompt. That is the case the palette (§10.1) exists for and the case §12's end-to-end
check watches.

The shell destination exists because the **editor** is a destination and the editor is
where the user is at a prompt — not because we think we improve on aliases. Anyone reading
this later and wondering whether to invest in shell-side snippet features: the answer is
that the shell already has them.

## 4. The boundaries this crosses, and what they already decided

Per AGENTS.md: a brief that crosses a boundary names the `AD`s and ADRs it touches and
what they already decided, **before** it says what to build.

- **AD-1 (transport).** Control plane is JSON-RPC; every result shape is declared once
  in `contracts/`. → `snippets.*` methods get schemas in the same commit that adds them
  (§6). Snippet **text** reaching a PTY travels the data plane as an ordinary paste; it
  is never wrapped in JSON.
- **AD-6 (single-owner state).** Already owned, and not re-owned here: bracketed-paste
  wrapping (the terminal engine — `renderers/types.ts:153-155` says the renderer defers to
  xterm's `term.paste()`, and `bd memories` records a session that hand-rolled `ESC[200~`
  and broke), "is this a
  secret" (`secret-candidate.ts`), the reference grammar (`secret-reference.ts`, whose
  own comment calls itself _"one scan shared by every consumer … the one writer of the
  grammar, beside its one reader"_), the completion dropdown's key ownership
  (`suggest/controller.ts`).
- **AD-8 (one owner per behaviour).** ~~`input-target.ts` already exists…~~ **Struck
  2026-08-14 (`nocx-9zij`): that file has no production caller, and citing it here is what
  let a second destination derivation into this design.** The behaviour "where does text
  go when the user is typing in this pane" is owned by `TerminalContent.insertSecret`
  (`terminal-content.ts:2248`), wired from `main.tsx:738`. → snippets become a **second
  policy over that one derivation** (§9.2), and this document may not cite
  `input-target.ts` as an existing seam until it has a production caller (§9.2a).
- **ADR-0013 + `frontend/src/ui/README.md`.** Surfaces place kit components and never
  repaint them; no colour literals. → the palette is a `FloatingPanel` variant (§10.1),
  the settings page is `PageSection`/`EditableRowList`/`Field`, empty is `EmptyState`
  (the kit exports `EditableRowList`, not `RowList` — `ui/row-list.tsx:46`).
- **ADR-0016/0017 (vault references).** `{{secret:NAME}}` is an existing, owned grammar
  resolved by `vault.resolveLine` at submit. → §7 shares the **namespace registry** and
  leaves `secret-reference.ts` and the secret path untouched.

Nothing here proposes changing an `AD`, and after the stress test nothing here edits a
file on the vault's path either (§7.3). The one change to an existing production type is
the extraction in §9.2: `TerminalContent` grows one private derivation that
`insertSecret` then calls instead of inlining. That is a refactor of one method's first
three lines, and `insertSecret`'s behaviour must be unchanged across it — a
characterisation test asserting that is part of the work.

> **Method note, kept because it is the lesson and not the fix.** The struck bullet above
> was written from `input-target.ts`'s own header comment, which describes a registry that
> is real code and has no caller. A file describing itself is not evidence that the
> product uses it, and a brief that cites one as an existing seam has skipped the cheapest
> check there is. Every "already exists" claim in a spec is a `grep` for the constructor
> away from being true or false.

## 5. The store

### 5.1 Backend, `internal/snippet`

A collection store, modelled on `internal/profile` (`store.go` + `service.go`), not on
`internal/settings` — settings is a typed registry of scalar declarations and a
collection is not one of those.

```go
// A snippet is a named body. Nothing about destinations lives here:
// where it goes is decided when it is fired (§9).
type Snippet struct {
    ID    string // opaque, backend-minted
    Title string // what the palette and the menu show
    Body  string // the template text, references intact (§7)
}
```

**There is no `Enabled` flag** — cut by the stress test (branch 4). termic needs one
because it ships built-ins a user may want out of the menu without losing the ability to
restore them. We ship no built-ins (§5.3), so "disabled" means only "deleted, but still
taking up a row in Settings". It would also be a second visibility concept beside order,
and a user cannot tell from the menu why a snippet they wrote is not in it.

Persistence: one document under the app profile directory via the shared
`storage.Module` protocol (`internal/storage/document.go`), `Current: 1`, empty
migration chain. Order is the document's slice order — position is data, not a
per-record integer that two writers can disagree about.

**Every mutation rewrites the whole document, and that is correct at this size** — checked
by the stress test (branch 9) with numbers rather than a shrug. A generous library is a few
hundred records of a few kilobytes: 500 × 4 KB ≈ 2 MB, one write, on a user action that
happens by hand. There is no incremental write path and none should be added later without
a measurement that says otherwise; an append log for a list a human edits by hand would be
complexity bought with nothing.

**Why an explicit `ID` and not the title:** the connection manager shipped broken
because _"`groups.create` refused every call the UI could make, because all nine backend
tests passed an explicit id and the renderer minted none"_ (AGENTS.md). The id is minted
**by `Create`, backend-side, always**, and `Create` takes no id parameter — there is no
call shape in which the renderer could mint one.

### 5.2 Service

`Create(title, body) (Snippet, error)`, `Update(id, patch)`, `Delete(id)`,
`Reorder(ids []string)`, `List() []Snippet`. `Reorder` takes the **full** id list and
rejects a list that is not a permutation of what is stored: a partial reorder is how two
clients silently drop a record.

### 5.3 Seeds

On the **first** open of an empty document, two ordinary records are written:

1. one showing `{{env:…}}` — e.g. `Explain what changed in {{env:branch}} under {{env:cwd}}`
2. one showing `{{ask:…}}` — e.g. `ssh -L {{ask:local=8080}}:localhost:{{ask:remote=8080}} {{env:host}}`

They are records, not built-ins: no override layer, no restore-defaults, no reset.

**Seeding is triggered by document creation, not by emptiness.** The document is written
with the two records at the moment it first comes into existence; an existing document is
never inspected for whether it "looks empty". Otherwise deleting both seeds would bring
them back on the next start, and a record the user deleted would be undeletable. Their
only job is to teach §7's syntax at the moment the library would otherwise be empty.

### 5.4 Backup is a section somebody writes, not a thing that happens

**Corrected by the stress test's reflexion pass**, which caught this spec asserting
something about a subsystem it had not read. `internal/backup` does **not** enumerate
`storage.Module` documents. `backup/document.go` is a hand-written `Document` with named
sections — `Settings.Overrides`, `Connections.Profiles`, `Connections.Groups` — and
`service.go` fills them explicitly. A new document under the profile directory is
therefore **not** in a backup, silently, and would be lost by a restore.

Since "it can be backed up" was part of why §3 chose a backend store over `localStorage`,
this is a **work item in this epic, not a note**: a `Snippets` section on `backup.Document`
plus its create/preview/restore paths, with the `Included` count the other sections carry.
The acceptance list in §12 asserts a round trip, because a backup that silently omits a
section is worse than no backup — the user believes they have one.

### 5.5 Delete asks first

A body is prose the user wrote, sometimes long, and there is no undo and no version
history. `Delete` from the settings page confirms through the kit's `Dialog` first. Cheap,
and the alternative is a misclick that destroys work with no way back.

## 6. The wire

Methods, each with a schema in `contracts/` in the **same commit** (AD-1, and
`nocx-bt3w` tracks the sweep):

| Method             | Result                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| `snippets.list`    | `{ snippets: Snippet[] }` — never `null`; an empty library is `[]`       |
| `snippets.create`  | the created `Snippet`, id included                                       |
| `snippets.update`  | the updated `Snippet`                                                    |
| `snippets.delete`  | `{ id }`                                                                 |
| `snippets.reorder` | `{ snippets: Snippet[] }` — the new order, so the renderer never guesses |

**No `snippets.changed` notification.** One window, one client: every writer of the list
is a surface inside it, and the renderer store is the one thing they all read. A change
notification would exist only for a second client that does not exist — YAGNI. If a
second window ever ships, that is when the notification is designed, against a real
second reader.

Every schema carries `additionalProperties: false` and an explicit `required`; a schema
without both is theatre (`contracts/README.md`). Renderer types are **generated** into
`frontend/src/generated/` and committed; the client re-exports and declares nothing of
its own.

Three checks per method, and the third is the point: `contracts:check`,
`…_DTOConformsToContract`, and `…_OverTheWireConformsToContract` — the real result off
the real socket. `vault.status` shipped for weeks without `defaultProvider` while both
suites were green; that is what the third check exists to catch.

## 7. One reference grammar, three namespaces

### 7.1 The collision, stated

`{{secret:NAME}}` already exists in the product: `SecretPicker` inserts it on `@`,
`secret-chip.ts` decorates it, `submit.ts` decides whether a line needs resolving, and
`vault.resolveLine` substitutes the value backend-side immediately before the PTY write.
`secret-reference.ts` owns the scan and says so in its own header comment.

A snippet placeholder written as `{{cwd}}` would put a **second owner on one token
shape**. AGENTS.md names that failure directly — two derivations of one predicate agree
everywhere anyone looks and disagree at the one moment that matters.

### 7.2 The decision — share the namespace registry, not the scan

**Revised by the stress test (branch 1).** The first draft extended `REFERENCE_RE` into a
general `{{ns:arg}}` parser. That was wrong, and the reason it was wrong is worth keeping:

`env` and `ask` spans are resolved **before** the text reaches any destination (§8). No
document that `secret-reference.ts` scans ever contains one. So a shared scan buys nothing
at runtime — while `REFERENCE_RE` sits on the vault's resolution path, where `submit.ts`
reads it to decide whether a line needs `vault.resolveLine` at all. A regression in that
regex has a specific shape: a span stops matching, `submit.ts` concludes there is nothing
to resolve, and `{{secret:prod-db}}` is written to the shell as literal text. That is a
failed command **and** a disclosure of vault naming. Putting the snippets feature on that
path, for a benefit that does not exist, is a bad trade.

What is genuinely one concept is **who may claim a namespace**. That is what gets shared:

```ts
// A new, tiny module: the namespace registry. One declaration, so a third
// namespace cannot be claimed twice by two features that never meet.
export const REFERENCE_NAMESPACES = {
  secret: 'vault (secret-reference.ts / vault.resolveLine)',
  env: 'snippets (resolved at fire time)',
  ask: 'snippets (resolved at fire time)',
} as const
```

- `secret-reference.ts` is **untouched**. `REFERENCE_RE`, `findReferences`,
  `secretReference` keep their exact current behaviour, and the vault path is not in this
  feature's change budget.
- The snippets module owns its own scan over `env` and `ask` only.
- A test asserts the two scans' namespace sets are disjoint and that their union is
  `REFERENCE_NAMESPACES` — so a fourth namespace added to one and forgotten in the other
  fails the build rather than colliding at runtime.

Two scans over **disjoint** namespaces are not two implementations of one concept. They
are two concepts that share a bracket shape, and the registry is what keeps that true.

The grammar rules the vault bought are inherited verbatim by the snippets scan: the arg is
**open** (spaces are legal — `internal/secrets` tests `echo {{secret:with space in
name}}`), only `}` is structural, and a malformed span matches nothing.

| ns       | example                                                         | resolved by                                    | when                        |
| -------- | --------------------------------------------------------------- | ---------------------------------------------- | --------------------------- |
| `secret` | `{{secret:prod-db}}`                                            | the vault, `vault.resolveLine` — **unchanged** | at submit, backend-side     |
| `env`    | `{{env:cwd}}`, `{{env:host}}`, `{{env:user}}`, `{{env:branch}}` | snippets, from live session state              | at fire time, frontend-side |
| `ask`    | `{{ask:port}}`, `{{ask:port=8080}}`                             | the user, via the palette's field form         | at fire time, frontend-side |

An **unknown namespace is one error in one place**. Both scans use a closed alternation
rather than `[a-z]+`: `{{scret:x}}` matches nothing anywhere, so it stays literal text the
user can see, exactly as a malformed secret reference does today.

### 7.3 What does not change — the list is the point

- `secret-reference.ts`: not edited. No line of it appears in this feature's diff.
- `secret-chip.ts`: not edited. It decorates exactly what it decorates today. `env`/`ask`
  spans are plain text in the editor — by the time a snippet reaches the editor they are
  already resolved (§8), so a live one there is an anomaly, not a state to style.
- `submit.ts`: not edited. Its "does this line need resolving" test and its cost
  characteristics are untouched.
- `vault.resolveLine` and its schema: untouched.

### 7.4 The `env` table

A closed table, extended by adding a row — never by a parameter or a mode flag (AD-8).
Each entry names the **existing** owner it reads from; snippets derive nothing itself:

| `env:` key | read from                                                            |
| ---------- | -------------------------------------------------------------------- |
| `cwd`      | the session's cwd, as the ledger already tracks it                   |
| `host`     | the session's host label (local ⇒ the local machine's name)          |
| `user`     | the session's user                                                   |
| `branch`   | `git.status`'s branch for the session cwd, when a repository is open |

**A key that cannot be answered right now does not resolve to an empty string.** It
resolves to _unavailable_, and §11.2 says what the fire does about it. Silently
substituting `""` is how `cd {{env:cwd}}` becomes `cd`.

**`last_command` was cut by the stress test (branch 3).** It was in the first draft on the
strength of "an agent prompt might want it", which is a guess, not a case — and it is the
one key that moves a previous command's text into a prompt bound for a model. The table is
defined to grow by addition; that is exactly the argument for not shipping a row nobody
has asked for. Adding it later is one row and one resolver.

### 7.5 `ask:` is not a secret channel

A user can type anything into an `ask:` field, including a password. Stated so it is not
discovered later:

- An `ask:` value is **never persisted**. Not into the snippet, not as a "last value"
  convenience, not into settings. It lives for the duration of one fire.
- It is never logged. `log/slog` sees the snippet's **title**, never a resolved body.
- Once resolved into the text, it is ordinary text at the destination and is subject to
  whatever that destination does — including, on the editor path, being recorded by
  `history.record` on submit. That is **not** a new leak: it is identical to the user
  typing the value by hand, which is what they would otherwise do.
- The field is a plain text field and is not styled as a password field. A masked field
  would imply a protection that does not exist on the far side of the fire.
- The value that belongs in the vault has a namespace already: `{{secret:…}}`. `ask:` is
  for the port number, the branch name, the ticket id.

## 8. Resolution happens at fire time, once

One resolution point, whatever the destination:

```
snippet.body
   │  parse spans (§7)
   ├── env:*   → resolve from live session state
   ├── ask:*   → the palette shows one field per distinct arg, defaults prefilled
   └── secret:* → LEFT INTACT — not ours to resolve (§11.1)
   ▼
resolved text → the destination (§9)
```

CM6 ships snippet tab-stops and it was tempting to use them for `ask:` in the editor and
a form elsewhere. **Rejected:** two implementations of "fill in the blanks" that would
agree in every case anyone tried. One form, every destination, including the editor —
where the text is then ordinarily editable anyway.

A snippet with no `ask:` spans skips the form entirely; that path is the common one and
must cost nothing.

## 9. Where the text lands

### 9.1 The seam this section first named does not exist in the product

**Revised 2026-08-14 (`nocx-9zij`), after an adversarial review found this section's
premise false.** What was written here before:

> `input-target.ts` (ADR-0004 §3) is the registry … Snippets need _insert without submit_,
> so `InputTarget` gains one optional member.

`input-target.ts` says exactly that about itself, and §4 of this document quoted it as the
reason no parallel seam was needed. It is true of the file and false of the product:

```
grep -rn "createRegistry" frontend/src
→ input-target.ts:60  (the definition)
→ input-target.test.ts (its own tests)
```

No production caller. This is the `nocx-rtg0` shape — real code, real tests, an
unreachable half — and the check that catches it is AGENTS.md "Before you fix anything"
#5, _is the code reachable, who constructs it_. It was not run against `input-target.ts`
when this section was written, and "the seam already exists" was written from the file's
own comment rather than from the call graph.

### 9.1a What actually owns this, and already does most of it

`TerminalContent.insertSecret` (`terminal-content.ts:2248`), wired from
`main.tsx:738` / `757`:

```ts
async insertSecret(name: string): Promise<'reference' | 'value' | 'unavailable'> {
  if (this.editor?.isVisible === true) {
    this.editor.insertText(secretReference(name))
    return 'reference'
  }
  if (!this.session || !this.vault) return 'unavailable'
  const resolved = await this.vault.resolveLine(secretReference(name))
  if (resolved.refs.some((r) => !r.resolved)) return 'unavailable'
  this.session.send(resolved.line + '\n')
  return 'value'
}
```

That is, already in production: the destination derivation this section proposed to
invent (**editor visible → the editor's draft; otherwise → the pty**), _and_ the refusal
on an unresolvable `{{secret:…}}` that §11.1 proposed to write a second time. Its own
comment states the principle this feature was going to restate: the pane decides what is
inserted "because only there is the answer known".

So snippets do not get a second derivation. They get a second **policy** over the one
derivation.

### 9.2 One derivation, two policies

Extract the question `insertSecret` already answers into a single owner on
`TerminalContent`:

```ts
/** Who owns input in this pane right now. The one derivation; every caller
 *  reads it and none re-derives it. */
type InputOwner = 'editor' | 'pty' | 'none'
private inputOwner(): InputOwner
```

`insertSecret` becomes a caller of it, unchanged in behaviour. Snippets become the second
caller. The two differ in ways that are **policy, not mode**, and are stated here so
nobody later "unifies" them into a flag:

|                 | secret policy (existing)                                                       | snippet policy (new)                                                    |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| into the editor | the **reference** `{{secret:NAME}}`, so the chip renders and submit resolves   | the resolved snippet text                                               |
| into the pty    | the **resolved value**, via `vault.resolveLine`                                | the resolved snippet text, `{{secret:…}}` resolved the same way (§11.1) |
| newline         | **appended** — a password prompt echoes nothing and wants the answer submitted | **never** (§9.3)                                                        |

Two policies over one derivation is what AD-8 asks for — the variation is what the caller
supplies, not a branch inside the owner. One derivation with two `if (owner === …)`
switches in two callers would be the thing it forbids, so the extraction must hand the
caller its policy rather than let each caller re-branch.

**The clipboard is not in the derivation at all.** It cannot be derived from live state —
it is a statement of intent about somewhere outside nocx — so it is an explicit modifier
(⌘Enter in the palette). ⌘Enter is free precisely because §9.3 refused to spend it on
"insert and submit".

**`none` is a refusal, never a fallthrough.** If the pane has no editor and no session,
the fire is refused and says so. The reviewed draft of this section let an absent
`insert` fall through to the pty, which would deliver text to a different owner than the
surface the user is looking at.

The pty branch is the primary case and the reason the palette exists at all: while
`claude` runs there **is no command editor** — `scrollback/controller.ts:249-279` names
`claude` among the TUIs that repaint a whole screen _without_ the alternate buffer, and
the editor yields its box. A snippets surface that lived only in the editor's dropdown
could not serve it. (This part of the original section was checked and holds.)

**The paste goes through the terminal engine, never hand-wrapped.** Bracketed-paste
(mode 2004) is the engine's to decide, and a recorded memory documents a session that
hand-rolled `ESC[200~…ESC[201~` and broke submission.

### 9.2a What becomes of `input-target.ts`

It is not this feature's to fix, and it must not be left as a seam that documents point
at. Either it gets a production caller deliberately, or it is deleted — `bd` decides,
under `nocx-9zij`. Until then **no section of this spec may cite it as an existing seam**,
which is the sentence that would have prevented this defect.

### 9.3 Insert, never submit

No `CR` is appended, on any path. Consequences, stated so they are chosen and not
discovered: firing into a shell **does not run the command**; firing into `claude` leaves
the phrase in its input box for the user to extend and send. There is no per-record
"auto-send" flag — that is a mode flag inside one behaviour, which AD-8 forbids, and it
is a setting nobody remembers the value of.

### 9.4 A multi-line body, and the one case where "insert" is not ours to guarantee

**Added by the stress test (branch 11), and it touches the primary case.** "Insert, never
submit" is a property of what we send. It is not a property of what the receiving program
does with a newline. Paste a two-line body into a program that has **not** enabled
bracketed paste (mode 2004) and the first newline is an ordinary Return — in a shell that
runs line one, and in an agent TUI that submits a half-written prompt. The owner's own
case is a multi-line phrase into `claude`, so this is not a corner.

The engine already knows the answer: xterm.js exposes the running program's
`bracketedPasteMode`. So:

- **Single-line body** — unaffected, always fires.
- **Multi-line body, mode 2004 active** — fires. The paste arrives as one document and no
  newline is read as Return. This is the ordinary case for a modern shell and for agent
  TUIs that accept multi-line input.
- **Multi-line body, mode 2004 not active** — **refused**, naming the reason, with the
  clipboard offered instead. We do not send it and hope, and we do not silently strip the
  newlines into one line — that would change the user's text without saying so.

This is the same principle as §11.1: when the destination cannot honour what the text
means, the fire is refused and says why, rather than sending something whose behaviour we
cannot state.

### 9.5 Which pane, and where focus lands

The destination is the **active** pane's target — the one the user is looking at, the same
pane the tab strip marks active. Not the last-focused, not the one a background program is
running in.

Firing returns focus to that destination: the palette closes and the terminal or the
editor has the keyboard, because the next thing the user does is type. A surface that
fires and keeps focus makes the user click to continue their own sentence.

## 10. Surfaces

Four entry points, **one list** behind all of them: a store in
`frontend/src/snippets/` fed by `snippets.list` and re-read after every mutation the
client itself made (there is no change notification — §6).

### 10.1 The palette — ⌥⌘P

A `FloatingPanel` variant (`ui/floating-panel.ts`), the same kit component the
`SecretPicker` is a variant of. Search filters by title and body; ↑/↓ move; Enter fires;
Esc closes. When the chosen snippet has `ask:` spans the panel becomes the field form in
place, rather than stacking a second surface.

**Chord collision, checked rather than assumed.** The global chords today are `⌘,`
(settings), `⌘⇧P` (**quick-connect palette** — taken), `⌘⇧O` (ports), plus TabManager's
`⌘T`/`⌘W`/`⌘1-9`. `⌥⌘P` is free and matches termic's. Implementation must also confirm
xterm's `customKeyEventHandler` (`renderers/xterm.ts`) lets it through, or the chord is
swallowed inside a focused terminal — which is the one place it is needed most.

The palette is **not** the quick-connect palette with extra rows. Two lists with two
jobs; merging them would make one surface own two vocabularies.

### 10.2 The completion dropdown — a provider, not a second list

A `suggest/` provider, alongside command/history/path/host. `CandidateSource` gains
`'snippet'` — the union grows by one word, which is the shape AGENTS.md asks for.

**What it answers to.** Command position, matched against the **title**, ranked below
command names — a real executable on `PATH` must never lose its row to a snippet that
merely starts with the same letters. Applicability is part of the provider contract in
this codebase, and this provider declares itself inactive in argument position: mid-line
the user is completing a token, and a snippet replaces the whole line.

**No sigil.** `@` is taken (it opens `SecretPicker`), and `!` is shell history expansion
— a prefix that silently means something to bash is not ours to claim. The row carries
its source word, the way a path candidate carries `Directory`/`File`, so a snippet row is
never mistaken for a command.

Two rules the type already knows how to state:

- `displayText` is the title; `insertText` is the **resolved** body. They are separate
  fields precisely so that what is shown and what is inserted can differ.
- **`eligibleForGhostText: false`, always.** Ghost text accepts on Right/End, before any
  `ask:` form could run — a snippet with unfilled fields must never be accepted by a
  cursor movement.

This provider serves the editor. It is **not** a substitute for §10.1, which is what
answers when the editor is not there.

### 10.3 The toolbar menu

A `ContextMenu` from the kit, opened from the top bar: every snippet in order, plus
"Manage snippets…" as the last row, which opens §10.4. Discoverable without knowing the
chord. It places a kit component and repaints nothing.

### 10.4 The settings page

A component page in `settings.tsx`'s registry, beside Vault and Backup — `PageSection` +
`RowList` for create / edit / reorder / delete, `EmptyState` when the library is empty.
Editing a body uses the same CM6 host the file viewer uses, in editable mode, with the
markdown language already in the bundle (`file-viewer/language-registry.ts`).

**The editor shows what it parsed** — added by the stress test (branch 6). Under the body
field, a line reports the spans the parser recognised and what each will become:
`{{env:cwd}} → /home/dev/repos/nocx · {{ask:port}} → you will be asked`. It exists for one
failure it makes impossible: a mistyped `{{ask:port}` with one brace matches nothing, and
without this line the author has no signal at all until a malformed literal is fired into
somebody's agent session. The parser is already there; this is a render of its output.

Recognition is also the honest place to report an unknown namespace: `{{cwd}}` and
`{{evn:cwd}}` both appear here as unrecognised text rather than as substitutions.

## 11. Failure paths and invariants

### 11.1 A `{{secret:…}}` riding a snippet past the editor

`vault.resolveLine`'s own schema states the principle: _"an unresolved name is reported,
never silently left as literal text."_

**Revised 2026-08-14 (`nocx-9zij`).** The first draft said the pty path could not resolve
a reference and therefore had to refuse. That was written from the same wrong premise as
§9.1: the pty path in `insertSecret` **does** resolve, by calling `vault.resolveLine` and
refusing only when a name comes back unresolved. Snippets inherit that, rather than
inventing a stricter rule for themselves.

- **To the editor.** Nothing special: the reference arrives as text, the chip decorates
  it, submit resolves it. This is the path that works, and the reason a snippet is
  allowed to contain one at all.
- **To a PTY.** The same call `insertSecret` already makes: `vault.resolveLine` over the
  resolved snippet text, then the substituted line to the session. A name that does not
  resolve refuses the whole fire and says which name — never the literal
  `{{secret:prod-db}}` into somebody's agent session. A **sealed** vault is an error
  distinct from "no such secret" (code `-32001`, the schema's own distinction), and the
  palette raises the unlock prompt rather than reporting a failure the user could have
  fixed.
- **To the clipboard.** **Refused**, and this is the one place a stricter rule than
  `insertSecret`'s is deliberate: the clipboard is read by everything on the machine and
  outlives the fire, so putting a resolved secret there is a different exposure from
  handing it to the program the user is looking at. The refusal names the reference and
  offers the pty instead.
- **Saving** a snippet containing one is allowed and unremarked. `secret-candidate.ts`
  already owns "this looks like a raw secret" on the editor path; a second detector here
  would be a second owner of one predicate.

**Consequence, stated because it is an authority decision and not an implementation
detail:** a snippet can put a real secret into a running program's input. That is not new
authority — `insertSecret` does exactly this today, from the same vault, into the same
pane, and the whole point of `{{secret:…}}` is that the value reaches the far side. What
would be new is doing it _silently_, so the palette reports which references it resolved,
the way `insertSecret`'s caller toasts "Secret sent — the prompt echoes nothing".

### 11.2 An `env:` key that cannot be answered

`{{env:branch}}` outside a repository; `{{env:host}}` before a session has one.
Unavailable is **not** the empty string. The fire stops before writing anything anywhere,
and the palette says which key and why. Half a command is worse than no command — a
snippet is fired at something that executes.

### 11.3 Every external call has a failing test

Mechanical and per AGENTS.md rule 3: `snippets.list` rejects (the palette opens onto a
stated error, never an empty list that reads as "you have none"); `create`/`update`/
`delete`/`reorder` reject (the row does not silently appear to have changed);
`git.status` is unavailable while `{{env:branch}}` is being resolved (→ §11.2, not `""`);
the clipboard write is refused by the OS; the PTY is gone between choosing and firing.

### 11.4 Invariants as intervals, not moments

- _A snippet id exists from before its record is first written until `Delete` returns._
  Not "`Create` mints an id" — that names only the opening event.
- _From the moment the palette resolves a body until the destination reports the write
  finished, no partially-resolved text exists at any destination._ Resolution completes
  in memory or the fire does not start.
- _A `reorder` leaves the stored list a permutation of its prior contents at every
  point an observer can read it_ — no window in which a record is absent.

### 11.5 The soft degrade must be visible

If the store fails to open, the palette, the menu and the dropdown provider say so where
the user is looking. A `slog.Warn` while Settings goes on offering an "Add snippet"
button that writes nowhere is exactly the shape AGENTS.md forbids.

## 12. Acceptance — as assertions, in the bead

Written now, before implementation, and by design not by the implementer's later reading
of their own code (AGENTS.md testing rule 4).

**The epic's one end-to-end check** (`cmd/devharness` + Playwright, no wails, no display):

1. GIVEN an empty library, a **single-line** snippet is created through the settings page
   with a body containing one `{{env:…}}` and one `{{ask:…}}` span
2. AND a long-running program owns the pane, so no command editor is showing
3. WHEN `⌥⌘P` is pressed and the snippet is chosen
4. THEN a field form appears for the `ask:` span, with its default prefilled
5. AND on confirming, the pane's grid shows the body with the `env:` span replaced by the
   session's real value and the `ask:` span replaced by what was typed
6. AND **no newline was sent** — the row count did not grow and the program produced no
   new output

**How the check stays honest** — tightened by the stress test (branch 8):

- **The program is `cat`.** Already present in every image, long-running, owns the pane,
  and the tty's own `ECHO` puts the pasted text on the grid **without** a newline — which
  is exactly what steps 5 and 6 need to distinguish. A program that only echoes after
  Return could not tell "inserted" from "submitted" apart, which is the whole assertion.
- **Single-line body, deliberately.** The multi-line path depends on the running program's
  bracketed-paste mode (§9.4) and belongs in its own two checks — one per branch of that
  decision — not smuggled into the happy path.
- **Every step waits on an observable state, never a duration** (AGENTS.md: a test may not
  depend on timing). Step 2 waits for the pane to report `running`; step 3 for the
  palette's rows to exist; step 5 for the grid to contain the text. No sleeps, no
  "settle" windows. termic's fire path needs a 5-second settle before injecting; ours must
  not inherit that, because a test that needs a slow machine is broken on a fast one too.
- **Container-suitable.** This spec is keyboard and text, not layout, so it should behave
  the same in `e2e/run-in-container.sh` as in CI. CI remains the source of truth.

Plus, per rule 2's paired-success requirement — for every "returns an error when…" there
is an "and on an ordinary machine it succeeds":

- `snippets.create` succeeds on a machine with an empty profile directory
- the resolver resolves every `env:` key in §7.4 in a plain local shell session at a
  trusted prompt

And the negative ones that carry the design's teeth:

- firing a body containing `{{secret:x}}` at a PTY writes **nothing** and states why
- firing a **multi-line** body at a program with bracketed paste **off** writes nothing
  and states why; with it **on**, the whole body arrives and no newline is read as Return
- a snippet candidate in the completion dropdown is never accepted by Right or End
- an `ask:` value is absent from the settings document, from `slog` output, and from the
  next fire's prefilled field
- the two namespace scans (§7.2) are disjoint, and their union equals
  `REFERENCE_NAMESPACES` — the test that makes a forgotten fourth namespace a build
  failure rather than a runtime collision
- `secret-reference.ts`, `secret-chip.ts` and `submit.ts` appear in **no** commit of this
  epic — §7.3's list, enforced by reading the diff at review
- a library of snippets survives `backup.create` → wipe the profile directory →
  `backup.restore` with every record and its order intact, and the preview reports a
  non-zero `Included` count for them (§5.4)
- `deadcode -filter 'nocx/internal/snippet'` is empty **and** `snippet.Service.Create`
  has a caller outside its own tests — the `nocx-rtg0` failure was a reachable read path
  hiding an unreachable write path in one package

## 13. Where notes attach later

The notes spec inherits §7's namespace registry (claiming its own namespace if it needs
one) and §9's destination seam — "insert this note's selection into the pane" is an
`insert` call, not new machinery. It brings its own store and its own backup section
(§5.4). Nothing in this document should be widened to accommodate it in advance.

---

## Stress Test Results: snippets design

Bead `nocx-y24g`. Eleven branches: nine mapped in Phase 2, two added by the reflexion
pass. The owner delegated the decisions ("реши сам"), so each was resolved against the
codebase rather than by asking.

### Resolved decisions

| #   | Branch                                            | Resolution                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Grammar: extend `secret-reference.ts`?            | **Reversed.** Share the namespace registry, not the scan. `env`/`ask` are resolved before insertion, so a shared scan buys nothing at runtime while putting the vault's resolution path in this feature's change budget. §7.2                                                                        |
| 2   | Security: `ask:` values may be secrets            | **Invariant added.** Never persisted, never logged, no last-value memory, not a masked field, and stated as no worse than typing by hand. §7.5                                                                                                                                                       |
| 3   | `{{env:last_command}}`                            | **Cut.** A guess, not a case, and the one key that moves prior command text into a model-bound prompt. §7.4                                                                                                                                                                                          |
| 4   | `Enabled` flag                                    | **Cut.** It exists in termic to serve built-ins; with none, "disabled" is "deleted but still in the way". §5.1                                                                                                                                                                                       |
| 5   | Optional `insert?()` vs AD-8                      | **Superseded 2026-08-14 by `nocx-9zij`.** The branch resolved correctly given a false premise: there is no `insert?()`, because the interface it would sit on has no production caller. The invariant it produced still holds in its new home — one derivation, policies supplied by callers (§9.2). |
| 6   | A malformed span fires silently                   | **Authoring-time preview added.** The settings editor renders what the parser recognised and what each span becomes. §10.4                                                                                                                                                                           |
| 7   | Shell destination vs `alias`/`Ctrl-R`             | **Scope sharpened, no change of shape.** We do not beat aliases and should not claim to; the value is in destinations with no such mechanism. §3.1                                                                                                                                                   |
| 8   | Is the e2e check actually runnable?               | **Tightened.** `cat` + tty `ECHO` makes "inserted, not submitted" observable; single-line on the happy path; every step waits on state, never a duration. §12                                                                                                                                        |
| 9   | Store scale                                       | **N/A, with numbers.** 500 × 4 KB ≈ 2 MB, whole-document rewrite per hand-made edit; no incremental path, and none to be added without a measurement. §5.1                                                                                                                                           |
| 10  | _(reflexion)_ Multi-line body into a PTY          | **New section.** "Insert, never submit" is not ours to guarantee when bracketed paste is off — refuse, name the reason, offer the clipboard. Touches the primary case. §9.4                                                                                                                          |
| 11  | _(reflexion)_ "Rides the existing backup surface" | **The spec was wrong.** `internal/backup` has a hand-written document with named sections and does not enumerate storage modules. Promoted from an assumption to a work item plus a round-trip assertion. §5.4                                                                                       |

Also added along the way: which pane and where focus lands (§9.5), and delete-confirms
(§5.5).

### Changes made

Design changed in five places (1, 3, 4, 10, 11); strengthened without changing shape in
four (2, 5, 6, 8); scope statement sharpened in one (7); one resolved as not-applicable
with numbers (9).

### Deferred / parking lot

- `{{env:last_command}}` — one row and one resolver whenever a real case turns up.
- A change notification for a second window, if a second window ever ships (§6).
- Markdown notes — their own spec (§13).

### Confidence assessment

- **Overall: high** for the shape; **medium** for §5.4, which is now the least-explored
  part of the epic — the backup document's create/preview/restore paths were read enough
  to know a section is required, not enough to size it.
- **Remaining concern:** §9.4 depends on xterm.js reporting the running program's
  bracketed-paste mode. That the API exists is known; that it reports what we need at the
  moment the palette asks is not yet verified against a live TUI. The first implementation
  task should prove it before the rest of the fire path is built on it.
