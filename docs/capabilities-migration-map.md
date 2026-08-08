# Capabilities — migration map

Worker F deliverable for the domain-capabilities wave. The typed, scoped
domain operations live in `internal/capability` (new package). This map is
the plan the migration bead executes: for every JSON-RPC control method,
the capability the handler is constructed with. **The handler migration is
not done here** — this document is the contract for the worker that does
it.

## The model, in one paragraph

A handler is constructed with exactly one Operation (a typed
`ConfigOperation`, `VaultOperation`, `SecretOperation`, …). `Run` acquires
the operation's conflict gates — a `control.Admission` composed in the
canonical order **config, vault, content, session, git, filesystem** — then
calls the callback with a domain service. The service is the ONLY store
reach a handler has; every service method checks the operation's guard and
fails with `capability.ErrOperationInactive` outside every in-flight Run,
so a captured service cannot be carried out of its operation. Gates are
non-blocking (`control.TryAcquire`): an overlapping operation is refused
with `*capability.RefusedError`, which the transport already maps to the
`control.saturated` wire error (`ws_saturation.go`). See the package doc
for the conservative-grain rationale and the per-domain read policy.

## Gate construction (composition root)

One gate per domain, capacity 1 (whole-domain exclusion — the conservative
posture):

```go
configGate  := capability.Gate(capability.GateConfig, 1)
vaultGate   := capability.Gate(capability.GateVault, 1)
contentGate := capability.Gate(capability.GateContent, 1)
sessionGate := capability.Gate(capability.GateSession, 1)
gitGate     := capability.Gate(capability.GateGit, 1)
fsGate      := capability.Gate(capability.GateFilesystem, 1)
```

The operation constructors take the gates as separate parameters and
compose them internally in the canonical order — a caller cannot get the
order wrong. The submission's execution bound is a separate semaphore
(the bounded worker pool); the gates are per-operation.

## Operation inventory

| Operation                                             | Gates               | Service                    | Constructed with (raw stores)                                                                                              |
| ----------------------------------------------------- | ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ConfigOperation`                                     | config, vault       | `ConfigService`            | profiles repo, groups repo, `*profile.ProfileService`, `*settings.Registry`, `RowResolver` (the vault seam; nil tolerated) |
| `VaultOperation`                                      | vault               | `VaultService`             | `VaultLifecycle` seam (`*vault.Vault`)                                                                                     |
| `VaultResetOperation`                                 | config, vault       | `VaultResetService`        | `VaultReset` seam (`*vaultreset.Service`)                                                                                  |
| `SecretOperation` (+ `SecretOperations.ForSecret`)    | config, vault       | `SecretService`            | profiles repo, groups repo, `SecretVault` seam, `credential.SecretStore`                                                   |
| `TabbyImportOperation`                                | config, vault       | `TabbyImportService`       | profiles repo, groups repo, `*profile.ProfileService`, `SecretVault`, `credential.SecretStore`                             |
| `ContentOperation`                                    | content             | `ContentService`           | `content.ContentDB`                                                                                                        |
| `ExportOperation`                                     | config, content     | `ExportService`            | profiles repo, groups repo, `*settings.Registry`, `storage.Paths`, `content.ContentDB`                                     |
| `RestoreOperation`                                    | config, content     | `RestoreService`           | `*profile.ProfileService`, `*settings.Registry`, `content.ContentDB`                                                       |
| `CaptureSaveOperation`                                | vault, content      | `CaptureSaveService`       | `SecretVault`, `content.ContentDB`                                                                                         |
| `SessionOperation` (+ `SessionOperations.ForSession`) | session             | `SessionService`           | `session.Registry`, `session.ProfileUsageTracker` (nil tolerated)                                                          |
| `OpenOperation`                                       | config, session     | `OpenService`              | `ProfileResolver` seam, `session.Registry`                                                                                 |
| `GitOpenOperation`                                    | session, git        | `GitOpenService`           | `session.Registry`, `git.RepoFactory`, `*git.Registry`                                                                     |
| `GitBindingOperation`                                 | git                 | `GitBindingService`        | `*git.Registry`                                                                                                            |
| `FilesystemOpenOperation`                             | session, filesystem | `FilesystemOpenService`    | `session.Registry`, `ProviderFactory`, `*filesystem.Registry`                                                              |
| `FilesystemBindingOperation`                          | filesystem          | `FilesystemBindingService` | `*filesystem.Registry`                                                                                                     |

## The migration map — every control method

Key: **capability** (gates) — what the handler does with it; _no capability_
means the handler keeps its injected seams and touches no domain store.

### Session plane (data-plane-adjacent)

| Method   | Capability                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`   | **OpenOperation** (config, session)                 | `Resolve` (profile resolver), `Open` (registry). The dial runs inside the callback; conservative grain, see `open.go`. The resolver reads the vault internally — the gates cannot see inside the seam.                                                                                                                                                                                                                                        |
| `resize` | **SessionOperation** via `ForSession(id)` (session) | Per-session.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `close`  | **SessionOperation** via `ForSession(id)` (session) | Per-session. **Finding:** `close` also triggers the git/files binding teardown (`gitSessionClosed`/`filesSessionClosed`). That teardown is shared transport lifecycle (it also runs on AD-9 disconnect via `monitorExit`), and the git/files registries are their own exclusion (per-call `Acquire` use-guard; a closed binding answers `unknownBinding`). Keep it in the transport lifecycle — do NOT route it through a handler capability. |
| `attach` | **SessionOperation** via `ForSession(id)` (session) | Also flushes `files.changed` dirty sets — transport-owned.                                                                                                                                                                                                                                                                                                                                                                                    |
| `ack`    | _no capability_                                     | Ring trimming, transport-owned state.                                                                                                                                                                                                                                                                                                                                                                                                         |

### profiles.* / groups.* / settings.* — the config domain

| Method                  | Capability                               | Notes                                                                                                                                |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `profiles.list`         | **ConfigOperation** (config, vault)      | Read. Returns stored form; handler applies the PURE ref→row mapping (`vault.RowFor`, kept in transport as `wireProfile`).            |
| `profiles.create`       | **ConfigOperation**                      | Row handles in options are resolved by the service (`ConfigService.CreateProfile`); handler never touches the vault.                 |
| `profiles.update`       | **ConfigOperation**                      | Same row-resolution contract.                                                                                                        |
| `profiles.delete`       | **ConfigOperation**                      |                                                                                                                                      |
| `profiles.effective`    | **ConfigOperation**                      | Pure reads + pure wire mapping.                                                                                                      |
| `profiles.patch`        | **ConfigOperation**                      | `PatchProfile` resolves the three secret paths, applies set/unset, persists.                                                         |
| `profiles.importTabby`  | **TabbyImportOperation** (config, vault) | Planning/parsing stays in the handler; `TabbyImportService` is the only store access (config reads, `CreateSecret`, `AtomicImport`). |
| `profiles.tabbyPreview` | **TabbyImportOperation**                 | Reads existing profiles/groups for collision info; conservative [config, vault] even though preview writes nothing.                  |
| `profiles.tabbyExecute` | **TabbyImportOperation**                 | `CreateSecret` + `AtomicImport`.                                                                                                     |
| `profiles.moveImpact`   | **ConfigOperation**                      | Reads only.                                                                                                                          |
| `groups.list`           | **ConfigOperation**                      |                                                                                                                                      |
| `groups.create`         | **ConfigOperation**                      | Row handles in defaults resolved by the service.                                                                                     |
| `groups.update`         | **ConfigOperation**                      | Same + the ParentGroupID/Defaults guard stays in the handler (reads via `ListGroups`).                                               |
| `groups.delete`         | **ConfigOperation**                      | `DeleteGroupAtomic`.                                                                                                                 |
| `groups.impact`         | **ConfigOperation**                      | Reads only.                                                                                                                          |
| `groups.apply`          | **ConfigOperation**                      | `ApplyGroups` (atomic; row-resolving).                                                                                               |
| `settings.describe`     | **ConfigOperation** (`Settings()`)       |                                                                                                                                      |
| `settings.getSnapshot`  | **ConfigOperation** (`Settings()`)       |                                                                                                                                      |
| `settings.set`          | **ConfigOperation** (`Settings()`)       | Typed key dispatch stays in the handler.                                                                                             |
| `settings.reset`        | **ConfigOperation** (`Settings()`)       |                                                                                                                                      |
| `settings.secretSet`    | **ConfigOperation** (`Settings()`)       | Vault-backed — one of the two reasons config holds [config, vault].                                                                  |
| `settings.secretDelete` | **ConfigOperation** (`Settings()`)       |                                                                                                                                      |
| `settings.secretExists` | **ConfigOperation** (`Settings()`)       |                                                                                                                                      |

### vault.* — lifecycle vs secret

| Method                     | Capability                              | Notes                                                                                                     |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `vault.status`             | **VaultOperation** (vault)              |                                                                                                           |
| `vault.setup`              | **VaultOperation**                      |                                                                                                           |
| `vault.unseal`             | **VaultOperation**                      |                                                                                                           |
| `vault.seal`               | **VaultOperation**                      |                                                                                                           |
| `vault.changePassphrase`   | **VaultOperation**                      |                                                                                                           |
| `vault.regenerateRecovery` | **VaultOperation**                      |                                                                                                           |
| `vault.setDefaultProvider` | **VaultOperation**                      |                                                                                                           |
| `vault.setAutoSeal`        | **VaultOperation**                      |                                                                                                           |
| `vault.activity`           | **VaultOperation**                      |                                                                                                           |
| `vault.inventory`          | **SecretOperation** (config, vault)     | Inputs computed inside the service from the profile/group stores.                                         |
| `vault.createSecret`       | **SecretOperation**                     | `CreateSecret(ctx, value, meta, resolve)`.                                                                |
| `vault.renameSecret`       | **SecretOperation**                     |                                                                                                           |
| `vault.replaceSecret`      | **SecretOperation**                     |                                                                                                           |
| `vault.deleteSecret`       | **SecretOperation**                     | Owns the metadata-first order: clear profile refs (one atomic write), then delete the stored value.       |
| `vault.resolveLine`        | **SecretOperation**                     | `ResolveLine` — the whole reference seam.                                                                 |
| `vault.resetPreview`       | **VaultResetOperation** (config, vault) | Deliberately not `VaultOperation`: reset must work on a broken vault and destroys profile references too. |
| `vault.reset`              | **VaultResetOperation**                 |                                                                                                           |
| `vault.unlockResolved`     | _no capability_                         | Ask machinery.                                                                                            |

### secrets.*

| Method                      | Capability                                | Notes                                                                                                                               |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `secrets.usage`             | **SecretOperation** (config, vault)       |                                                                                                                                     |
| `secrets.savePassword`      | **SecretOperation**                       | Mint → row (`vault.RowFor`, pure).                                                                                                  |
| `secrets.saveKeyMaterial`   | **SecretOperation**                       | Key parsing stays in the handler (pure); store via `CreateSecret`.                                                                  |
| `secrets.saveKeyPassphrase` | **SecretOperation**                       | Row→ref resolution and the verify-read move into the service (`ResolveRow` + `GetSecret`); passphrase parsing stays in the handler. |
| `secrets.detect`            | _no capability_                           | Pure detection.                                                                                                                     |
| `secrets.captureSave`       | **CaptureSaveOperation** (vault, content) | Capture registry stays in the handler (connection-scoped in-memory); the service owns create-then-rewrite.                          |
| `secrets.captureDismiss`    | _no capability_                           | Capture registry only.                                                                                                              |

### git.*

| Method            | Capability                          | Notes                                                                                                                                           |
| ----------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.open`        | **GitOpenOperation** (session, git) | Handler decides noCwd/remoteUnsupported from `Get` + params; `OpenBinding` owns the ownership-transfer rule; inline first status via `Acquire`. |
| `git.status`      | **GitBindingOperation** (git)       | Per-call `Acquire(bindingId, caller)` — bindings close at any moment, so validity is checked per call, not at construction.                     |
| `git.diff`        | **GitBindingOperation**             |                                                                                                                                                 |
| `git.stage`       | **GitBindingOperation**             |                                                                                                                                                 |
| `git.unstage`     | **GitBindingOperation**             |                                                                                                                                                 |
| `git.stageAll`    | **GitBindingOperation**             |                                                                                                                                                 |
| `git.unstageAll`  | **GitBindingOperation**             |                                                                                                                                                 |
| `git.commit`      | **GitBindingOperation**             |                                                                                                                                                 |
| `git.headMessage` | **GitBindingOperation**             |                                                                                                                                                 |
| `git.log`         | **GitBindingOperation**             |                                                                                                                                                 |
| `git.remote`      | **GitBindingOperation**             |                                                                                                                                                 |
| `git.close`       | **GitBindingOperation**             | `Close` after the ownership re-check via `Acquire`.                                                                                             |

### files.*

| Method         | Capability                                        | Notes                                                                                                                                      |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `files.open`   | **FilesystemOpenOperation** (session, filesystem) | `OpenBinding` returns the binding + endpoint attestation; inline root via `Acquire`. Bookkeeping (`filesBindings`) stays in the transport. |
| `files.list`   | **FilesystemBindingOperation** (filesystem)       |                                                                                                                                            |
| `files.read`   | **FilesystemBindingOperation**                    |                                                                                                                                            |
| `files.watch`  | **FilesystemBindingOperation**                    | Digest-poll loop stays in the transport; `Acquire` is the surface it needs.                                                                |
| `files.close`  | **FilesystemBindingOperation**                    |                                                                                                                                            |
| `files.reveal` | **FilesystemBindingOperation**                    | Uses `Acquire` (domain) + transport bookkeeping for the local-only guard + the revealer seam.                                              |

### history.* — the content domain

| Method           | Capability                     | Notes                                                                            |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `history.query`  | **ContentOperation** (content) |                                                                                  |
| `history.record` | **ContentOperation**           | `RecordCommand` + `RewriteRedaction`; the capture registry stays in the handler. |

### export.*

| Method                     | Capability                             | Notes                                                                                           |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `export.manifest`          | **ExportOperation** (config, content)  | `ManifestFor` is pure; the operation type is shared with the content-reading modes.             |
| `export.configExport`      | **ExportOperation**                    |                                                                                                 |
| `export.portableEncrypted` | **ExportOperation**                    |                                                                                                 |
| `export.backup`            | **ExportOperation**                    |                                                                                                 |
| `export.import`            | **RestoreOperation** (config, content) | Wraps `export.RestoreImport` (one transaction, one rollback). Handler decodes the payload only. |
| `export.importPortable`    | **RestoreOperation**                   | Decrypt + `Import`.                                                                             |

### The rest

| Method                                                            | Why                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `sessions.status`                                                 | **SessionOperation** (session) via `NewSessionOperation` (whole-domain instance; `List` + `LastUsedForProfiles`). |
| `connections.test`                                                | Resolver + prober seams; no direct store access.                                                                  |
| `connections.trustHostKey`                                        | hostKeyTruster seam.                                                                                              |
| `connections.passwordResolved`                                    | Ask machinery.                                                                                                    |
| `sshConfig.aliases` / `sshConfig.path`                            | sshConfigResolver seam.                                                                                           |
| `tunnel.open` / `tunnel.stop`                                     | Resolver + connector seams; the tunnel ledger is transport-owned.                                                 |
| `ports.status` / `ports.sample` / `ports.pause` / `ports.visible` | Discovery scheduler seam.                                                                                         |
| `shell.complete`                                                  | Uses `session.Registry.Get` → **SessionOperation** via `ForSession(id)` (session).                                |
| `shell.integrate`                                                 | Uses `session.Registry.Get` → **SessionOperation** via `ForSession(id)` (session).                                |
| `shell.launcherCommand`                                           | launcherStager seam.                                                                                              |
| `shell.environmentObserved`                                       | Passport seam.                                                                                                    |
| `shell.footprint.status` / `shell.footprint.uninstall`            | installedFacts / remoteUninstaller seams.                                                                         |
| `shell.openUrl`                                                   | urlOpener seam.                                                                                                   |
| `dialog.openFile`                                                 | dialogService seam.                                                                                               |
| `fs.complete`                                                     | Pure local path completion.                                                                                       |

## Code the migration worker must delete from the transport

These moved into `internal/capability`; leaving both copies would be two
owners of one behaviour (AD-8):

- `optionsFromWire`, `groupFromWire`, `sparseFromWire`, `secretRowInputs`,
  `rowToSecretRef` (ws_secrets.go) — the row→ref resolution is now inside
  `ConfigService`.
- `vaultInventoryInputs` (ws_vault.go) — now `capability.inventoryInputs`.
- `settingsProviderAdapter`, `settingsSinkAdapter` (ws_export.go) — now in
  `internal/capability/export.go`.
- `buildRestoreDeps`, `buildConfigExportDeps` (ws_export.go) — the deps
  are built inside `RestoreService`/`ExportService`.

KEEP (pure, no store): `wireProfile`, `wireGroup`, `sparseToWire`,
`optionsToWire`, `wireEffectiveSecretFields`, `secretRefToRow`
(=`vault.RowFor`), `createSecret`'s callers now call the service instead.

## Known conservative postures (refinable without touching handlers)

1. **Config holds [config, vault]** — every config operation serializes
   with every vault operation. Reason: row resolution (ADR-0017) and
   secret-class settings. Refinement: split the row-resolving write
   surface out of the read surface.
2. **Whole-domain gates, capacity 1** — per-session/per-binding grain is
   deferred; the `ForSession`/`ForSecret` factories exist now and their
   grain is an implementation detail.
3. **`open` holds [config, session] for the whole dial** — a concurrent
   config request is refused during a slow dial rather than frozen. If
   refusals during probes prove noisy, split the resolve phase from the
   dial phase inside the operation.
4. **Refusals, not queues** — overlapping work is refused with
   `*RefusedError` (→ `control.saturated`), never blocked. This is the
   control package's contract; the renderer already has the refusal
   surface.

## Findings

- **`export.manifest`/`export.configExport` don't need content or the
  vault**, but share the `ExportOperation` [config, content] type with the
  content-reading modes. Acceptable: export is rare and the type is one
  surface. Split only if measurements say the content gate is contended.
- **The session-teardown binding cleanup** (git/files) is shared lifecycle,
  not a handler capability; the registries are their own exclusion.
- **A nil `RowResolver`** is tolerated (dev-web with no vault): a config
  write carrying a row handle fails loudly ("no vault: cannot resolve a
  secret row") instead of storing a row — same contract as the transport's
  `rowToSecretRef` today.
