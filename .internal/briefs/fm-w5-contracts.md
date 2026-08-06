# W5 — the `files.*` wire contracts

## Where you are

You are in your OWN git worktree. **Run `pwd` first and use that path for everything.**
Never write to `/home/dev/orca/workspaces/nocx/feat-file-manager-2` — that is the
coordinator's checkout.

The issue tracker is NOT in your worktree; `bd` will find nothing. Everything is here.

## Read these, in this order

1. **`contracts/README.md`** — the convention, and it is binding. Especially "Adding a method".
2. Two existing schemas, to match shape and comment style: `contracts/ports.status.schema.json`
   and `contracts/fs.complete.schema.json`. Read the second one carefully — see the naming note
   below.
3. `.internal/specs/2026-08-06-file-manager-design.md` **§5.2 and §5.3**, plus §5.1 for the
   field semantics you are describing.

## What you own — and nothing else

- `contracts/files.open.schema.json`
- `contracts/files.list.schema.json`
- `contracts/files.read.schema.json`
- `contracts/files.watch.schema.json`
- `contracts/files.close.schema.json`
- `contracts/files.reveal.schema.json`
- `contracts/files.changed.schema.json` — **the notification; see below, it is not optional**
- the generated `frontend/src/generated/files.*.ts`, produced by `cd frontend && npm run contracts`
  and committed alongside

**Nothing else.** Do not write Go. Do not touch `internal/**` — two other workers are in there
right now. Do not touch `frontend/src/` except the generated files the generator itself emits.
Do not edit a generated file by hand; that is editing the wrong end of the contract.

## Why the namespace is `files.` and not `fs.`

`contracts/fs.complete.schema.json` already exists and its description declares that namespace
**local-only**: "This method is consulted ONLY by the local path provider, and the provider is
inactive on a remote session — a local path must never masquerade as a remote one."

Our methods are remote-capable. A remote-capable `fs.list` sitting beside a local-only
`fs.complete` is a misread waiting to happen, and the misread is "the panel showed the wrong
machine's files". Hence `files.*`. Say this in the description of `files.list` so the next reader
does not undo it.

## Build them

Take the six methods and one notification from the §5.2 table. Every schema, without exception:

- `additionalProperties: false`
- an explicit `required` list

Without **both**, the schema accepts anything and the gate is theatre — that is the README's
word for it and it is accurate.

Points that need care, all from §5.1:

- **`files.list` has three possible successful results**: a normal listing, `tooLarge
{observedCount, limit}`, and `timedOut {timeout}`. Model that explicitly — a `oneOf` with a
  discriminating field, not an optional-everything object that accepts all three at once and
  nothing precisely.
- **`entries[]` is never `null`.** An empty directory is `[]`. A schema that permits `null` here
  re-admits a defect this repo has already shipped once (`providers` marshalling as `null`).
- **`Kind` is a closed set** — `regular | dir | symlink | other` — so it is an `enum`, not a
  string.
- **`canonical` is required on every successful `files.list` result**, not only for symlinks, and
  required on `files.read`. Both are load-bearing: the first is how the frontend detects symlink
  cycles, the second is what deduplicates viewer tabs.
- **`rev` on `files.changed` is OPTIONAL and that is deliberate.** It is present when the backend
  already knew it (SFTP polling computed the digest to detect the change at all) and absent for a
  local watch event where nothing has been re-listed. Use `"required"` accordingly — and put the
  reason in the field description, because "optional" without a reason invites someone to make it
  required later.
- `endpointId` is `["string","null"]` — null for a local binding — rather than optional. The
  README is explicit about that distinction.
- `files.close` and `files.reveal` return `{}`. Declare them anyway: an empty result is still a
  contract, and `additionalProperties: false` on it is what makes "returns nothing" enforceable.

Descriptions are not decoration here. Every existing schema in this directory explains what a
field means and why, and yours are read by whoever writes the Go handler next.

## The notification is the seventh shape and the one that matters most

`files.changed` is server-initiated and unsolicited, so it has no request to correlate against
and no caller checking its shape. It carries `{bindingId, path, rev?}` and **never entries**. It
is exactly where an addressing or shape defect would hide, which is why the design gives it the
same three checks as a method rather than treating it as "just a notification".

## Verify

```
cd frontend
npm run contracts          # generates frontend/src/generated/files.*.ts
npm run contracts:check    # must pass — the committed output matches the schemas
./node_modules/.bin/tsc --noEmit
```

The type-check is repo-wide and that is deliberate: generated types that do not compile are the
failure this whole directory exists to prevent. If `tsc` reports errors in files you do not own,
**report them, do not fix them**. Errors in your generated files are blocking.

Do **not** run `npm run lint`, `npm test`, `prettier --write` or any Go gate.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.** Only the coordinator owns beads.
- **No new dependencies.**
- Report **numbers, not adjectives**: how many schemas, how many generated files, the exact
  `contracts:check` output, and every place where §5.2 was ambiguous and you had to choose. That
  last one is the most useful thing you can tell me — the spec has been through seven adversarial
  rounds, so an ambiguity you found is a real finding and I want it, not a silent decision.

## Lifecycle

Send a `heartbeat` with `--phase` at every phase change (reading the convention, schemas,
generation, check). One `worker_done` when finished, `--outcome succeeded` or `--outcome failed`.
