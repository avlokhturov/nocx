# Backup keeps its promise, and the page is rebuilt around two verbs

Worker report for `task_9920edbda428` (run_258e21979eb1) — `nocx-ojxa` + `nocx-u0rv.2`.
Working tree: `/home/dev/orca/workspaces/nocx/backup-restore` (branch `shady2k/backup-restore`).
No commit, no push, no branch created — work left in the tree as instructed.

## 1. What import was dropping, and how the round trip now pins it

Two silent drops, both in the import end of the export/import pair:

- **Settings.** `export.configExport` carried settings (`ConfigExport.Settings`, populated from the
  settings registry's `GetSnapshot`), but neither import path applied them. `export.import`
  and `export.importPortable` only ran the profile/group atomic import
  (`ImportConfigurationWithService` → `svc.AtomicImport(profiles, groups)`); `data.Settings` was
  unmarshalled and ignored. A backup restored profiles and groups and quietly left the machine's
  settings as they were — the manifest said "Settings and preferences" were carried.
- **Private content.** `export.portableEncrypted` collected conversations and command history
  into the payload when the user opted in, but `export.importPortable` decrypted the payload and
  only imported `plain.Config` — `plain.Private` was never written anywhere.

The fix, with the symmetry property enforced on both ends:

- `internal/settings`: new `Registry.ApplyValues(map[string]any) error` — the write-side
  counterpart of `GetSnapshot`. Every value is validated through its declaration before anything
  is committed (unknown keys and secret-class keys are rejected; an invalid map leaves the
  registry unchanged). The typed checks mirror the `settings.set` handler's.
- `internal/export`: new `SettingsSink` interface (transport wires the registry; the export
  package still never imports `credential` — the structural test enforces it). `ImportDeps` gains
  `Settings`; both import functions restore settings after a successful profile/group import.
  **An export that carries settings imported without a sink is an error** — silent drop is the
  defect, so the import refuses instead.
- `internal/export`: new `RestorePrivateContent(db, pc)` — writes conversations (IDs, titles,
  message timelines preserved) and command history (timestamps preserved; row IDs are
  backend-assigned by `CommandHistory().Add`, documented in code) through the existing
  `ContentDB` write seams. A payload with `Available=false` (stub source) carries nothing and
  no-ops; a payload that **does** carry content onto a machine with no store fails the whole
  import rather than reporting success after a silent drop. No `internal/content` files touched.
- `internal/transport`: `settingsSinkAdapter` + wiring in `handleExportImport` /
  `handleExportImportPortable`; the portable handler now calls `RestorePrivateContent`.

**The round-trip tests pin it field by field, not by absence of error:**
`TestImportConfiguration_FullRoundTrip_FieldByField` exports a profile with every non-secret
option populated (plus a group with defaults and a settings map), imports it into an empty
world, and compares stored profile/group to exported with `reflect.DeepEqual` and the applied
settings map to the exported map. It fails if a single option, the group defaults, or any
settings key is lost. `TestRestorePrivateContent_*` covers the no-op cases, both slices
restored with fields preserved, and the failure paths (conversation save fails, history add
fails, no DB with carried content → all errors). Over the wire, `ws_export_test.go` drives the
real socket: settings land in the registry, unknown settings keys fail loudly, and a portable
backup made from a recording DB restores both slices into a second recording DB.

## 2. Related defects found while making the pair symmetric

- **`nocx-jb20.1` (forged secret references) — fixed as a side effect, deliberately.** The
  shared import boundary now strips `PasswordSecret` / `KeySecret` / `KeyPassphraseSecret` from
  every imported profile before persistence, exactly as the export strips them. A renderer-forged
  reference no longer survives into storage where the resolver would honour it at connect time.
  Pinned by `TestImportConfiguration_StripsForgedSecretReferences` (export-package level) and
  `TestExportImport_StripsForgedSecretRefsOverTheWire` (real socket). This closes jb20.1's
  acceptance criteria; the bead itself was not touched (different epic — flag for its owner).
- **Dead portable-import control.** `ProfileClient.importPortable` called
  `export.portableImport`, which the server never dispatches (the case is
  `export.importPortable`). Pre-existing on `HEAD` — the old `.enc` import control returned
  "Method not found" on every click. Fixed the client to call the real method; verified in the
  browser (restore now works end to end).
- **`nocx-hdwh` (non-transactional import) — NOT fixed, per the brief.** One observation that
  makes it cheap to fix later: `ImportConfigurationWithService` commits profiles/groups
  atomically, then settings apply; a settings failure leaves profiles imported. A natural next
  step is a settings-apply-first (validate into a temp registry) then commit ordering, or a
  rollback seam. Needs its own tests; left alone.

## 3. The page, rebuilt

`frontend/src/export-section.tsx` (649 lines → 469) now presents the two verbs plus the one real
third thing, each a `PageSection` built from the kit (no controls drawn inside the surface):

- **Make a backup** (`#st-export-backup`) — one action, one file (`nocx-backup.enc`), the
  passphrase + confirm, the "Show passphrase" reveal (kept with its reason: a mistyped
  passphrase on this screen is permanent — the manifest warns the file is unrecoverable), the
  "Include private content (conversations, command history)" checkbox, and the honest
  carry/omit statement from `export.manifest` (which now lists settings and opt-in private
  content as carried).
- **Restore a backup** (`#st-export-restore`) — one action, one file (`.enc`), the passphrase,
  a statement of what will happen to what is already here (replace, not merge), and the import
  manifest (now truthful: settings are carried). After success the file stays picked and only
  the passphrase clears, so a repeat restore is one step.
- **Import from Tabby** (`#st-export-tabby`) — the preview-first flow kept whole, as its own
  thing rather than a third item in a list of file inputs.

**Deleted from the page:** the plaintext Configuration Export card (`.json`), the Same-Machine
Backup card ("Show Backup Paths" — a path listing, not a file; the copy step is a later task's),
the separate `.json` import input, and the "Import from ~/.ssh/config" button (that entry point
already lives in the Connections dialog). The transport methods behind the removed controls still
exist; the page no longer produces a format it cannot stand behind. No control whose backend did
not exist was *removed* — the one found (portable import) was *fixed*.

`export.css` updated to match (the mode-card summary class is gone; `PageSection`'s description
slot owns that line).

## 4. Verified

- **Gates:** `gofumpt -l .` clean; `golangci-lint run` (export, settings, transport) clean;
  `go test -race ./...` clean (exit 0, 23 ok packages); frontend `npm run typecheck`, `npx
  eslint .`, `npm test` (1457/1457), `npx prettier --check` (frontend), `npm run contracts:check`
  all clean.
- **Browser (real Chromium from the Nix store, viewport 1365×768, deviceScaleFactor 1.25, dev
  stand on NOCX_WS_PORT=9882 / NOCX_WEB_PORT=5182, backend built from this tree):** the page
  renders the three sections with manifests served live by the real backend. Full round trip
  exercised: filled passphrase + confirm → "Make backup" → real `export.portableEncrypted` →
  `nocx-backup.enc` (508 B NaCl secretbox ciphertext) downloaded to disk → success toast
  "Backup downloaded — keep the passphrase safe". Then uploaded that file + passphrase →
  "Restore backup" enabled → click → toast "Restored 1 profiles, 0 groups" (decrypt + import on
  the real socket), passphrase cleared, button re-disabled.
- **Contracts:** new `contracts/export.import.schema.json` and
  `contracts/export.importPortable.schema.json` (both `additionalProperties:false` + `required`),
  generated TS committed, `profiles.ts` re-exports the generated `ImportResult` instead of a
  hand-written one, DTO + over-the-wire conformance tests added for both methods.

## 5. What I could not verify

- **Private content restore in the browser.** The devharness ContentDB is a stub, so a backup
  carrying private content cannot be produced there (export correctly yields `Available=false`);
  the restore path is covered by the Go wire tests with a recording ContentDB. End-to-end
  history restore needs the history-record worker's real store.
- **Tabby import in the browser** (needs a real Tabby config; the preview→confirm→execute flow
  is covered by jsdom behavior tests and the existing transport suite).
- **Root `npx prettier --check .`** fails on pre-existing
  `contracts/vault.resetPreview.schema.json` (unformatted on `HEAD`, untouched by me — editing
  existing contract files is off-limits per the brief). Frontend prettier is clean.
- **The e2e Playwright suite** was not run (heavy; needs the e2e harness the brief did not
  require; grep shows no e2e spec references the export page).

## Files

- Backend: `internal/export/{import,portable,export}.go`, `internal/settings/settings.go`,
  `internal/transport/ws_export.go` (+ tests: `export_test.go`, `settings_test.go`,
  new `ws_export_test.go`)
- Contracts: `contracts/export.import.schema.json`, `contracts/export.importPortable.schema.json`,
  generated `frontend/src/generated/export.import.ts`, `export.importPortable.ts`
- Frontend: `export-section.tsx`, `export-section.behavior.test.ts`, `profiles.ts` (RPC name fix
  + generated type), `export-utils.ts` (dead `downloadJSON` removed), `styles/surfaces/export.css`
