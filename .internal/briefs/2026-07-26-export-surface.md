# Worker brief — export/import/backup: the user-facing surface (bead `nocx-6ek.3`)

## The situation

`internal/export` implements all four ADR-0011 §7 modes and **is already tested**. Nothing reaches
them: there are no export/import JSON-RPC methods in `internal/transport/ws.go`, the package is not
wired at the composition root in `internal/app/app.go`, and there is no UI entry point. The
capability exists and no user can invoke it.

The core was split off deliberately so it could land while another worker held `ws.go` and
`app.go`. **You are building the surface, not the core.** Read `internal/export` and use it; do not
reimplement or "improve" its modes.

## Read first

- `docs/decisions/0011-persistence-storage-capabilities-and-secret-references.md` — **§7** defines
  the four modes and what each carries. §2 is the secrets-as-opaque-references rule.
- `internal/export/**` — the actual mode implementations and their tests.
- `.internal/specs/2026-07-26-tab-and-settings-foundation-design.md` — Part A.1 for the snapshot
  contract you will sit next to, and the three-bucket rule if you touch the settings screen.

## The constraint that is not negotiable

From the bead, and it is the whole reason this design is safe:

> `internal/export` does not import `credential.SecretStore`, and that must stay true — it is what
> makes "no mode can resolve a secret" **structural** rather than a promise. Wire the RPCs so they
> call into the package, never so they resolve a secret and hand it in.

So: no code path may fetch a secret and pass it to `internal/export`. If a mode appears to need a
secret, it does not — re-read §7. Add a test that fails if `internal/export` ever imports
`credential`, so the property is enforced by the build rather than by memory.

## Acceptance criteria, from the bead

- Each of the four modes is invocable from the UI.
- Each **states, in the UI, what it carries and what it omits.** Not a bare mode name — the user
  must be able to tell what leaves their machine.
- The portable export **prompts for a new passphrase.**
- Private content is **never** included without an explicit choice.
- `internal/export` still does not import `SecretStore`.

## A judgement call that is yours to make and justify

The passphrase prompt currently has no good home: the settings screen asks for secrets through the
browser's native `prompt()` (a filed wart), and there is no modal primitive in the frontend. Pick
one and say why:

- reuse whatever the secret-replace flow does today, accepting the same ugliness, and note it; or
- build the minimum inline form the export flow needs, without inventing a general modal system.

Do **not** build a general Modal primitive — that is a separate filed concern, and YAGNI applies.

## Files you own

`internal/transport/**`, `internal/app/**`, `internal/export/**` (tests only — do not change its
behaviour), `frontend/src/settings-content.ts`, `frontend/src/settings.ts`,
`frontend/src/profiles.ts` (the client methods), `frontend/src/style.css`, and their tests.

**Another worker is active on a different branch** building the vertical tab strip; it owns
`frontend/src/tab-strip.ts` and `frontend/src/tabs.ts`. You are in a different worktree, so you
will not collide — but do not touch tab files, because your changes would fight its merge.

If you add a settings **declaration**, remember the invariant: the screen is generated, so a new
setting is one `MustRegister*` call in Go and zero frontend changes. Never write a setting key as a
string literal in TypeScript.

## Bootstrap

```bash
cd frontend && npm ci && cd ..
```

## Verification — you have this worktree to yourself, so run all of it

```bash
gofumpt -l .
golangci-lint run ./...
go test -race -count=1 ./...
cd frontend && npm run format:check && npm run lint && npm run typecheck && npm run test
```

Playwright is red on `main`, is not in the per-commit gate, and another worker owns it right now.
Do not run it, do not chase it, do not claim anything about it.

While you are in `style.css`: the integration merge already produced one exactly-duplicated
selector (`.st-search`, used by two sides for different elements, which would have double-bordered
the search field). Check for duplicated selectors in anything you add — neither `tsc` nor the test
suite can see that class of defect.

## Ground rules

- **Do not commit, push or branch.** The coordinator owns git.
- **Do not touch the issue tracker.** No `bd` commands.
- **If you finish early, STOP and report.**
- Format only the files you changed.
- Report numbers, not adjectives: which four modes, what each states in the UI, and the test that
  enforces the no-SecretStore-import property.
- **State explicitly anything you could not verify** — in particular whether you exercised a real
  round trip (export then import) or only the RPC surface.
