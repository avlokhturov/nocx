# P1 — the remote bundle publisher (`nocx-ruwl`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §4, §4.1 and the
installation assertions of §7 in
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

## What you build

The thing that puts nocx's shell integration on a remote host **safely and repeatably**, and
nothing else. It is a Go package with no knowledge of SSH, SFTP, launchers or the renderer:
it takes a bundle descriptor and a filesystem-shaped interface, and publishes a versioned
immutable generation under `~/.nocx/`.

Two carriers will use it later — the launcher installing itself over the ssh command line
(P6) and SFTP for saved connections (P8). Neither is yours. **Design the seam so that a
carrier is a small implementation of your filesystem interface**, because that is what makes
the fault-injection tests below possible at all: your tests inject failures through the same
interface real carriers implement.

## Files you own

- new files under `internal/shellintegration/` — the publisher, the manifest type, the
  filesystem seam, and their tests.
- you may **read** `internal/shellintegration/install_remote.go` for what the old SFTP path
  did, but you do not edit it (P8 does) and you do not inherit its shape: it writes into live
  files, sets no modes, and edits rc files, all of which §4 and N4 forbid.

Do not touch `scripts.go` or `scripts/nocx.*` (P2 owns them) or any `launcher*.go` (P6).

## What must be true when you are done

Every one of these is a test, and the fault-injection ones are why the seam exists:

- exactly one committed manifest names exactly one active generation; older immutable
  generations may exist on disk and are unreachable from it.
- an active manifest ⟹ every file it names exists with the recorded hash and mode.
- the manifest rename happens **last**, after every file exists and is fsynced.
- a matching version string alone never proves an installation — a generation whose file was
  deleted or altered is not installed.
- a fault injected at **each** boundary (mkdir, each file write, each fsync, each rename,
  lock acquire, lock release) leaves the previous activation untouched and converges on the
  next attempt with no manual cleanup.
- two concurrent publishes of the same version produce one active generation, no duplicated
  work and no lost bytes. Run it under `-race`.
- an installed **newer** protocol-compatible generation is never downgraded. Equality is not
  the comparison.
- a symlink anywhere on the path — `~/.nocx`, a generation, `tmp`, `lock`, `manifest.json`,
  `launch` — refuses to write and returns a typed reason.
- an existing `~/.nocx` that is not recognisably ours is never modified and never has its
  mode changed.
- modes are set at creation, never left to umask: directories 0700, data 0600, the `launch`
  carrier 0700.
- a manifest entry naming an absolute path, a `..` segment, a symlink or an unknown key
  invalidates the whole manifest.
- at most two generations and one staging directory survive a publish; orphans are removed
  under the lock.
- uninstall removes only manifest-owned unmodified files, reports a conflict for anything the
  user changed, and never removes `~/.nocx` recursively.
- a read-only `$HOME` fails cleanly with a typed reason and writes nothing.

The lock is an atomic `mkdir` holding a nonce, with a bounded wait and a stale rule that does
**not** trust a remote PID or the remote wall clock — say in a comment what your rule is and
why it is safe.

## Deliberately not yours

Where the bundle bytes come from (P2 owns the scripts and their version), how a carrier
reaches the host, the `launch` carrier's own script body (P6), and any decision about when to
install (P7).

## Verify

`go build ./...`, `go vet ./internal/shellintegration/`, and
`go test -race ./internal/shellintegration/...`. Nothing repo-wide.
