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

- **Markdown notes.** Next spec. They will reuse this one's reference grammar (§7) and
  its resolver registry; they do **not** share its store, because the shape a note store
  needs is not yet known and guessing it here would be guessing wrong in a file that is
  hard to change later.
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
| `localStorage` in the renderer                                     | backend store (§5)                                   | it must survive a webview reset and ride the existing backup/restore surface; the renderer is not the owner of user data (AD-6)                                                                                 |
| ships 13 built-in agent prompts, persists only the delta from them | seeds two ordinary records (§5.3)                    | the delta machinery (`overrides`/`deletedBuiltins`/`disabled`/`order`) exists **to serve** shipped defaults. Without defaults it is pure cost. And we would be owning the text of other vendors' CLI workflows. |
| types the body into the PTY and follows it with a delayed `CR`     | inserts, never submits (§9.3)                        | a template with fields cannot be filled after it has been submitted, and in a shell "insert" and "execute" are not the same act                                                                                 |
| a fire-time destination dialog on every fire                       | destination derived from where input is going (§9.2) | the answer is already knowable; asking is a click for nothing                                                                                                                                                   |

`~/repos/orca` — floating workspace with markdown notes. Read for the **notes** spec,
not this one.

## 4. The boundaries this crosses, and what they already decided

Per AGENTS.md: a brief that crosses a boundary names the `AD`s and ADRs it touches and
what they already decided, **before** it says what to build.

- **AD-1 (transport).** Control plane is JSON-RPC; every result shape is declared once
  in `contracts/`. → `snippets.*` methods get schemas in the same commit that adds them
  (§6). Snippet **text** reaching a PTY travels the data plane as an ordinary paste; it
  is never wrapped in JSON.
- **AD-6 (single-owner state).** Already owned, and not re-owned here: bracketed-paste
  wrapping (the terminal engine — `input-target.ts` says so explicitly, and
  `bd memories` records a session that hand-rolled `ESC[200~` and broke), "is this a
  secret" (`secret-candidate.ts`), the reference grammar (`secret-reference.ts`, whose
  own comment calls itself _"one scan shared by every consumer … the one writer of the
  grammar, beside its one reader"_), the completion dropdown's key ownership
  (`suggest/controller.ts`).
- **AD-8 + ADR-0004 §3 (pluggable input targets).** `input-target.ts` already exists and
  already says: _"a registered InputTarget decides where a submitted document goes. New
  kinds (shell now, LLM agent later) are added by registering a target, never by editing
  the editor."_ → snippets **extend that registry** (§9). We do not invent a parallel
  `SnippetDestination`.
- **ADR-0013 + `frontend/src/ui/README.md`.** Surfaces place kit components and never
  repaint them; no colour literals. → the palette is a `FloatingPanel` variant (§10.1),
  the settings page is `PageSection`/`RowList`/`Field`, empty is `EmptyState`.
- **ADR-0016/0017 (vault references).** `{{secret:NAME}}` is an existing, owned grammar
  resolved by `vault.resolveLine` at submit. → §7 extends the **parser**, never the
  secret path.

Nothing here proposes changing an `AD`. If §7's grammar extension is judged to be a
change of decided behaviour rather than an extension of it, that becomes an ADR before
implementation, not during.

## 5. The store

### 5.1 Backend, `internal/snippet`

A collection store, modelled on `internal/profile` (`store.go` + `service.go`), not on
`internal/settings` — settings is a typed registry of scalar declarations and a
collection is not one of those.

```go
// A snippet is a named body. Nothing about destinations lives here:
// where it goes is decided when it is fired (§9).
type Snippet struct {
    ID      string   // opaque, backend-minted
    Title   string   // what the palette and the menu show
    Body    string   // the template text, references intact (§7)
    Enabled bool     // hidden from the menu and the palette without deleting
}
```

Persistence: one document under the app profile directory via the shared
`storage.Module` protocol (`internal/storage/document.go`), `Current: 1`, empty
migration chain. Order is the document's slice order — position is data, not a
per-record integer that two writers can disagree about.

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

### 7.2 The decision

**Extend `secret-reference.ts` into the general span parser it already almost is**, and
register resolvers by namespace.

```
{{ns:arg}}      ns ∈ { secret, env, ask }
```

```ts
// secret-reference.ts, extended. One scan, still the only writer.
export const REFERENCE_RE = /\{\{(secret|env|ask):([^}]*)\}\}/g

export interface ReferenceSpan {
  from: number
  to: number
  ns: 'secret' | 'env' | 'ask'
  arg: string
}
```

The existing grammar rules are preserved verbatim, because they were bought: the arg is
**open** (spaces are legal — `internal/secrets` tests `echo {{secret:with space in
name}}`), only `}` is structural, and a malformed span matches nothing so the chip never
decorates it.

| ns       | example                                                                                 | resolved by                                    | when                        |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------- |
| `secret` | `{{secret:prod-db}}`                                                                    | the vault, `vault.resolveLine` — **unchanged** | at submit, backend-side     |
| `env`    | `{{env:cwd}}`, `{{env:host}}`, `{{env:user}}`, `{{env:branch}}`, `{{env:last_command}}` | snippets, from live session state              | at fire time, frontend-side |
| `ask`    | `{{ask:port}}`, `{{ask:port=8080}}`                                                     | the user, via the palette's field form         | at fire time, frontend-side |

An **unknown namespace is one error in one place**. That is the whole argument for a
closed union in the regex rather than `[a-z]+`: `{{scret:x}}` fails to match, so it is
literal text the user can see, exactly as a malformed secret reference is today.

### 7.3 What does not change

- `secret-chip.ts` filters `ns === 'secret'` and decorates exactly what it decorates
  today. `env`/`ask` spans are plain text in the editor — by the time a snippet reaches
  the editor they are already resolved (§8), so a live one there is an anomaly, not a
  state to style.
- `submit.ts`'s "does this line need resolving" test reads `ns === 'secret'`. Its cost
  characteristics are unchanged.
- `secretReference(name)` stays the single writer of the `secret` form.

### 7.4 The `env` table

A closed table, extended by adding a row — never by a parameter or a mode flag (AD-8).
Each entry names the **existing** owner it reads from; snippets derive nothing itself:

| `env:` key     | read from                                                            |
| -------------- | -------------------------------------------------------------------- |
| `cwd`          | the session's cwd, as the ledger already tracks it                   |
| `host`         | the session's host label (local ⇒ the local machine's name)          |
| `user`         | the session's user                                                   |
| `branch`       | `git.status`'s branch for the session cwd, when a repository is open |
| `last_command` | the last completed block's command line from the ledger              |

**A key that cannot be answered right now does not resolve to an empty string.** It
resolves to _unavailable_, and §11.2 says what the fire does about it. Silently
substituting `""` is how `cd {{env:cwd}}` becomes `cd`.

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

### 9.1 The seam already exists

`input-target.ts` (ADR-0004 §3) is the registry. It carries `submit(doc, ctx)`. Snippets
need _insert without submit_, so `InputTarget` gains one optional member:

```ts
export interface InputTarget {
  readonly id: string
  readonly label: string
  submit(doc: string, ctx: SubmitContext): Promise<void>
  editorExtensions?(): Extension[]
  /** Put `text` where this target takes input, WITHOUT accepting it.
   *  Absent when the target has no such notion; §9.2 then skips it. */
  insert?(text: string): Promise<void>
}
```

Optional, not required: a target that cannot express "typed but not sent" must not be
forced to fake it. The assistant target, when `nocx-x8s2` lands, implements `insert` and
appears in §9.2 with no edit here — that is the seam's acceptance test.

### 9.2 Choosing the destination — derived, not asked

There is exactly one derivation, in one module:

| Live state                                                              | destination                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| the command editor is showing (at a trusted prompt)                     | the active `InputTarget.insert` — the shell target puts text in the editor document |
| a program owns the pane (`running`; the editor has yielded its box)     | the pane's PTY, via the terminal engine's paste path                                |
| the user held ⌘ on accept (⌘Enter in the palette, ⌘click on a menu row) | the clipboard, via `clipboard.ts`                                                   |

The clipboard is the one destination that cannot be derived from live state — it is a
statement of intent about somewhere outside nocx — so it is the one that takes an
explicit modifier. ⌘Enter is free precisely because §9.3 refused to spend it on
"insert and submit".

The second row is the primary case and the reason the palette exists at all: while
`claude` runs there **is no command editor** — `scrollback/controller.ts` names `claude`
among the TUIs that repaint a whole screen _without_ the alternate buffer, and the editor
"takes its box away when it hides". A snippets surface that lived only in the editor's
dropdown could not serve it, which is why that approach was rejected during design.

**The paste goes through the terminal engine, never hand-wrapped.** Bracketed-paste
(mode 2004) is the engine's to decide, `ShellInputTarget` says so in a comment, and a
recorded memory documents a session that hand-rolled `ESC[200~…ESC[201~` and broke
submission.

### 9.3 Insert, never submit

No `CR` is appended, on any path. Consequences, stated so they are chosen and not
discovered: firing into a shell **does not run the command**; firing into `claude` leaves
the phrase in its input box for the user to extend and send. There is no per-record
"auto-send" flag — that is a mode flag inside one behaviour, which AD-8 forbids, and it
is a setting nobody remembers the value of.

## 10. Surfaces

Four entry points, **one list** behind all of them: a store in
`frontend/src/snippets/` fed by `snippets.list` and refreshed on `snippets.changed`.

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

A `ContextMenu` from the kit, opened from the top bar: the enabled snippets in order,
plus "Manage snippets…" as the last row, which opens §10.4. Discoverable without knowing
the chord. It places a kit component and repaints nothing.

### 10.4 The settings page

A component page in `settings.tsx`'s registry, beside Vault and Backup — `PageSection` +
`RowList` for create / edit / reorder / enable / delete, `EmptyState` when the library is
empty. Editing a body uses the same CM6 host the file viewer uses, in editable mode, with
the markdown language already in the bundle (`file-viewer/language-registry.ts`).

## 11. Failure paths and invariants

### 11.1 A `{{secret:…}}` riding a snippet past the editor

`vault.resolveLine`'s own schema states the principle: _"an unresolved name is reported,
never silently left as literal text."_

- **To the editor.** Nothing special: the reference arrives as text, the chip decorates
  it, submit resolves it. This is the path that works, and the reason a snippet is
  allowed to contain one at all.
- **To a PTY or the clipboard.** Nothing on that path can resolve it, and shipping the
  literal `{{secret:prod-db}}` into someone's agent session is both useless and a leak of
  the vault's naming. **The fire is refused**, names the reference, and offers the one
  destination that can resolve it. Refusal is a rendered state on the palette, not a
  toast that disappears.
- **Saving** a snippet containing one is allowed and unremarked. `secret-candidate.ts`
  already owns "this looks like a raw secret" on the editor path; a second detector here
  would be a second owner of one predicate.

### 11.2 An `env:` key that cannot be answered

`{{env:branch}}` outside a repository, `{{env:last_command}}` in a fresh session.
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

1. GIVEN an empty library, a snippet is created through the settings page with a body
   containing one `{{env:…}}` and one `{{ask:…}}` span
2. AND a long-running program owns the pane, so no command editor is showing
3. WHEN `⌥⌘P` is pressed and the snippet is chosen
4. THEN a field form appears for the `ask:` span, with its default prefilled
5. AND on confirming, the program's input carries the body with the `env:` span replaced
   by the session's real value and the `ask:` span replaced by what was typed
6. AND **no newline was sent** — the program has not been given the input

Plus, per rule 2's paired-success requirement — for every "returns an error when…" there
is an "and on an ordinary machine it succeeds":

- `snippets.create` succeeds on a machine with an empty profile directory
- the resolver resolves every `env:` key in §7.4 in a plain local shell session at a
  trusted prompt

And the negative ones that carry the design's teeth:

- firing a body containing `{{secret:x}}` at a PTY writes **nothing** and states why
- a snippet candidate in the completion dropdown is never accepted by Right or End
- `deadcode -filter 'nocx/internal/snippet'` is empty **and** `snippet.Service.Create`
  has a caller outside its own tests — the `nocx-rtg0` failure was a reachable read path
  hiding an unreachable write path in one package

## 13. Where notes attach later

The notes spec inherits §7 (the span parser and resolver registry) and §9 (the
destination seam: "insert this note's selection into the pane"). It brings its own store.
Nothing in this document should be widened to accommodate it in advance.
