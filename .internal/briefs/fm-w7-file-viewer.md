# W7 — the file viewer: a read-only tab, one per file

## Where you are

You are in your OWN git worktree. **Run `pwd` first and use that path for everything.**
Never write to `/home/dev/orca/workspaces/nocx/feat-file-manager-2`.

The issue tracker is NOT in your worktree; `bd` will find nothing. Everything is here.

## Read these, in this order

1. `frontend/src/tab-content.ts` — the `TabContent` / `ContentDescriptor` seam.
2. `frontend/src/surface-registry.ts` and how **Settings** registers itself. Settings is a
   non-terminal tab that already works; yours is a sibling of it, not a new mechanism.
3. `frontend/src/tabs.ts` around `openTab` — `singletonKey` deduplication already exists.
4. `frontend/src/generated/files.read.ts` — already committed; your content type comes from here.
5. `.internal/specs/2026-08-06-file-manager-design.md` — **§5.4 "Viewer tab" onward**, plus D7,
   D12, D13 in §3 and the lifecycle table in §5.6.

## What you own — and nothing else

- `frontend/src/file-viewer/**` — a new directory: the content class, the CodeMirror host, the
  language registry.
- `frontend/src/styles/components/file-viewer.css`
- `frontend/package.json` — **only** to add the CodeMirror language packages (see below).

**You do NOT own `main.tsx`.** Export a registration function and an `openFileViewer` opener;
the coordinator wires both. Another worker is building the Files panel at the same time and
`main.tsx` is the one file you would both want.

You do **not** own `tabs.ts`, `tab-content.ts`, or `sidebar.tsx` — the panel worker is making
small additive edits there. If you need something from those seams, **escalate**; do not edit
them.

Do not touch `internal/**`, `contracts/**`, `frontend/src/ui/**`, `frontend/src/files/**`.

## The seam the panel will call — fixed, do not invent your own

```ts
export function openFileViewer(target: {
  bindingId: string
  endpointId: string | null
  path: string // lexical, as listed
  canonical: string // the identity
  displayHost: string | null // null for local
  name: string
}): void
```

## Build it

### The tab

A `ContentDescriptor` with:

- **`singletonKey = "${endpointId ?? 'local'}:${canonical}"`** — `tabs.ts` already deduplicates
  on this, so opening the same file twice activates the existing tab. Note it is the **canonical**
  path, not the lexical one: two symlinks to one file are one file, and using `path` here would
  open two tabs that claim to be different.
- **`restoreDescriptor: null`.** This one is deliberate and it is the interesting part of the
  task. The field has four writers — `tabs.ts:456`, `tabs.ts:504`, `main.tsx:226`,
  `state/tab-model.ts:255` — is typed `unknown`, and is **read nowhere**: nothing serialises the
  tab list and nothing reconstructs a tab from a descriptor. Adding a fifth writer would be
  committing the exact defect this repo documents having shipped before. So: `null`, as
  `main.tsx:226` already does. When tab restore grows a reader, `{type:'file', endpointId, path,
displayHost}` is the shape it should adopt — put that in a comment, not in the code.

### The title carries provenance, asymmetrically

A **remote** file's tab title is `srv-01 · nginx.conf`. A **local** file's title is the basename
alone — no prefix, no badge. **Absence of a host marker is what means "this machine"**, so the
marker must never be spent on the local case. Getting this backwards makes every title
uninformative.

### The content

CodeMirror 6 in **read-only** mode. `@codemirror/state`, `@codemirror/view` and
`@codemirror/commands` are already dependencies. You will need `@codemirror/language` plus
language modes — add a **small registry** of formats that actually turn up in terminal work
(JSON, YAML, Markdown, shell, Go, TypeScript/JavaScript, Python, and plain text as the fallback),
not one package per language that exists. Justify the set in your report with the added bundle
size. `termic` (a reference product) ships the full `@codemirror/lang-*` set if you want to see
the ceiling; we are deliberately below it.

Read-only means read-only: no edit affordance, no save keybinding, no placeholder for one.
Editing is a later epic and a half-wired editor is worse than none.

### The states that are not "the file"

Each is a real rendered state, not an error toast:

- **`binary: true`** — "binary file, N bytes". `text` is empty and there is nothing to show.
- **`truncated: true`** — the file exceeded the 2 MiB ceiling; say so, with the size.
- **`lossy: true`** — invalid byte sequences were replaced; say so, because the user is looking
  at something that is not byte-identical to the file.
- **`changed: true`** — size or mtime differed between the start and end of the read; the content
  is an unknowable mixture and must say so.
- **Source unavailable** — the binding is gone (its terminal was closed, or the SSH connection
  dropped). The content **stays on screen** and the viewer says the source is unavailable. It
  must issue **no further calls** against a dead binding.

### Reload is an offer, never automatic (D7)

A file that changed on disk gets a visible "File changed — Reload" affordance. It does **not**
silently reload: a log you are reading must not scroll out from under you. Reload is enabled only
when the viewer's binding is live; when it is not, the control is present and disabled, and the
reason is legible.

## Verify

```
cd frontend
./node_modules/.bin/vitest run src/file-viewer
./node_modules/.bin/tsc --noEmit                  # repo-wide, on purpose
```

`tsc` is repo-wide deliberately: vitest strips types and runs, so a file can pass its tests and
not compile. Errors in files you do not own: **report, do not fix**.

Do **not** run `npm run lint`, the whole `npm test`, `prettier --write`, or any Go gate.

## Tests

- Opening the same canonical path twice activates one tab rather than opening two.
- Two different lexical paths that share a canonical path are one tab.
- A remote file's title carries the host; a local file's does not. Assert **both**, because the
  local case is the one that silently rots.
- Each of binary / truncated / lossy / changed renders its own state.
- A dead binding renders "source unavailable", keeps its content, and makes no client calls —
  assert the absence of calls, not just the presence of the message.
- The content is read-only: there is no path by which a keystroke reaches the document.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.** Only the coordinator owns beads.
- New dependencies are limited to the CodeMirror language packages above; anything else,
  escalate. Report the exact `package.json` delta and the bundle cost.
- Report **numbers, not adjectives**: test count, tsc result, bundle delta, and anything you
  could not verify.

## Lifecycle

`heartbeat` with `--phase` at every phase change (registry, content, states, tests). One
`worker_done` at the end, `--outcome succeeded` or `--outcome failed`.
