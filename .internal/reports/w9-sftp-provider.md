# W9 — SFTP provider: completion report

## What shipped

`internal/filesystem/sftp` — the same `filesystem.Provider` contract as the
local provider, over SFTP, consuming the `ssh.FSConn` lease through a narrow
consumer seam declared in the package (the discovery.go:113 pattern).

- `sftp.go` — the provider: `Root` (via `RealPath(".")`, never a shell),
  `List` (canonical-then-list, all three D14 caps, whole-directory `Rev`),
  `Read` (bounded, streamed, call-time openability, `Changed` interval),
  `Watch` (`ErrWatchUnavailable`), `Canonical`, `Close` (releases the lease).
  `path`, never `path/filepath` (grep-verified; only the doc comment names
  it).
- `fsfake_test.go` — the transport double, in-package beside the tests: a
  fake of the `fsConn` seam backed by the real local filesystem (real
  symlinks, permissions, FIFOs, mtimes), modeling the lease's split
  cancellation (ReadDir context-cancellable; everything else not).
- `sftp_test.go` — 49 tests mirroring the local suite over the double,
  including the never-replying-listing shape (blocked ReadDir released only
  by the D14 deadline) and the retargeted-symlink coherence tests.

## Numbers

| Gate                                                      | Result                   |
| --------------------------------------------------------- | ------------------------ |
| `go build ./internal/filesystem/...`                      | ok                       |
| `go vet ./internal/filesystem/...`                        | ok                       |
| `go test -race ./internal/filesystem/sftp/`               | ok, 49 tests             |
| `golangci-lint run ./internal/filesystem/sftp/...`        | 0 findings               |
| `go test ./internal/filesystem/...` (root + local + sftp) | ok                       |
| `go test -race -run TestFSConn ./internal/ssh/`           | ok, 177 tests in package |
| `golangci-lint run ./internal/ssh/...`                    | 0 findings               |

Nothing committed or pushed; no beads touched.

## Seam findings (escalated, then authorized)

Two findings in the committed `internal/ssh` seam, both confirmed against
code, both fixed under coordinator authorization (ask reply: option (b)):

1. **FSConn had no `ReadLink`**, so `Entry.LinkTarget` — a required Rev field
   per the brief and spec §5.1 — was unimplementable. `pkg/sftp` has
   `Client.ReadLink` (client.go:497) and its `fileInfo` carries no target
   (attrs.go:23: name + FileStat only). Added `ReadLink` to the FSConn
   interface and `*fsConn` in the **non-context group** (bounded lane,
   close-to-cancel, hard-timeout poison — same shape as Stat/Lstat/RealPath),
   plus tests: ordinary link returns stored text, **a broken link still
   returns its target text**, and ReadLink joined the close-unblocks
   wedged-call proof.

2. **`ReadFile` returned `io.EOF` for an empty file.** `io.ReadFull` returns
   `io.EOF` exactly when zero bytes were read; the guard tolerated only
   `io.ErrUnexpectedEOF`. Fixed with an `errors.Is(err, io.EOF)` addition and
   `TestFSConn_ReadFile_EmptyAndBoundaries` (empty file, file exactly at the
   bound, file one past the bound).

## Where local's answer did not transfer — decisions

1. **ReadLink seam gap** (above): without it, LinkTarget could only be
   approximated via RealPath — rejected (fails link-text fidelity and
   broken-symlink targets); escalated instead of silently deciding.

2. **Empty-file EOF** (above): no provider workaround, no test enshrining
   the broken behavior; fixed at the seam where it belongs.

3. **Entry metadata comes with readdir, not per-entry lstat.** The SFTP
   readdir response carries full attrs, so kind/size/mtime/mode for all
   entries arrive in one round trip — fewer than local's readdir + per-entry
   lstat, and all from the same packet. The local `KindUnreadable` entry
   (Info failed) case transfers to link-resolution failure: a symlink whose
   ReadLink fails is `KindSymlink` with `LinkKind=KindUnreadable`,
   distinguishable from genuinely broken (`LinkKind=KindOther`), refused by
   the openability table.

4. **FIFO swap between the check and the open does not transfer.** Local
   closes the window with O_NONBLOCK + fstat of the opened descriptor. Over
   SFTP the open-read-close is ONE lease lane call; the provider cannot fstat
   the opened object, and the race is the lease's (hard-timeout poison,
   proven in internal/ssh). The call-time cases DO transfer and are covered:
   a FIFO or directory at Stat time is `ErrNotRegular`, including a regular
   file swapped for a FIFO between list and read. The local `beforeOpen` test
   seam was therefore dropped (no test uses it).

5. **ENOTDIR wire shape.** pkg/sftp's `normaliseError` maps
   NO_SUCH_FILE/PERMISSION_DENIED → `os.ErrNotExist`/`os.ErrPermission`, but
   NOT_A_DIRECTORY stays a raw `*StatusError` (the server's
   `translateErrno` has no ENOTDIR row → sshFxFailure; OpenSSH's sftp-server
   maps ENOTDIR → NO_SUCH_FILE). So List-on-a-file arrives as `ErrNotFound`
   over the real wire; the `ErrNotDir` branch is retained for transports that
   deliver ENOTDIR and is exercised by the double.

6. **Never-replying server at the provider level** is the D14 cap riding a
   deadline derived once at entry into `ReadDirContext` (the double blocks
   until ctx fires). Everything else non-context (Stat/Lstat/RealPath/
   ReadFile) is the lease's close-to-cancel + lane, proven in the ssh
   package; the provider does not wrap them in goroutines.

7. **The close-unblocks proof now runs in two rounds of four.** The lane caps
   concurrent in-flight non-context calls at `fsLaneCap` (4), so all five
   non-context calls cannot be wedged at once — a fifth would wait for a slot
   that never frees and its request would never reach the server. Round A
   wedges the original four; round B wedges ReadLink + three others. Every
   call is genuinely in flight (its packet reached the never-reply server)
   before Close, and every one returns `ErrFSClosed`.

## Files changed (all uncommitted)

- `internal/filesystem/sftp/sftp.go` (new)
- `internal/filesystem/sftp/sftp_test.go` (new)
- `internal/filesystem/sftp/fsfake_test.go` (new)
- `internal/ssh/ssh_fsconn.go` (+ReadLink, +io.EOF fix)
- `internal/ssh/ssh_fsconn_test.go` (+ReadLink/broken-link tests,
  +empty/boundary tests, close-unblocks two-round restructure)
