# P6 — the launcher publishes the bundle, and the compact carrier fails open (`nocx-k47n`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §3.2, §3.3, §4 and
§5 of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

Wave 1 has landed and you build on it, so read these before writing anything:

- `internal/shellintegration/publisher.go`, `manifest.go`, `publish_fs.go` — P1's publisher.
  You **use** it; you do not modify it. `Publish(bundle)` over an FS seam, manifest-last
  activation, lock, fault paths, typed refusals.
- `internal/shellintegration/scripts/nocx.{bash,zsh,posix}` and the passport format in §5.2 —
  P2's. The scripts already emit `OSC 636;P` and tag their markers when
  `NOCX_ENVIRONMENT_ID` is set and well-formed; **wiring that variable through is your job**
  and is the piece P2 explicitly could not verify.
- `frontend/src/ssh-transition.ts` — P4's generated lines. Yours is the far side of both.

## What you build

**The full bootstrap launcher** (§3.2): it already travels in argv and starts the integrated
shell. It must now, before exec'ing that shell, publish the bundle through P1's publisher and
report the committed generation in the passport. Publication failure is never fatal — the
session continues transient-integrated and simply records no installed fact.

**The compact carrier** `~/.nocx/launch` (§3.3): a POSIX `sh` script, mode 0700, published as
part of the bundle. It reads `manifest.json`, refuses an incomplete or protocol-incompatible
generation, and in that case `exec`s a native login shell and emits **no** passport. The
remote command that invokes it already carries its own guard for the one case the file cannot
cover — its own absence:

```
ssh -t <flags> <dest> 'if [ -x "$HOME/.nocx/launch" ]; then exec "$HOME/.nocx/launch" <env-id>; else exec "${SHELL:-/bin/sh}" -l; fi'
```

## Files you own

`internal/shellintegration/launcher.go`, `launcher_auto.go`, `launcher_bash.go`,
`launcher_zsh.go`, `launcher_posix.go`, their tests, and the new `launch` carrier script plus
whatever assembles the bundle descriptor.

Do not edit the publisher, the three `nocx.*` scripts, `scripts.go`, or anything in
`frontend/`. P8 is working in `install_remote.go`, `ssh.go` and `ssh_real.go` at the same
time — do not touch those either; if you need something from that side, say so in your
report rather than reaching for it.

## What must be true when you are done

- the full launcher publishes, then emits a passport naming the committed generation; a
  publish that fails leaves the session usable and the passport's generation field `-`.
- the environment id reaches the far shell so P2's scripts emit their passport and tag their
  markers: a PTY test asserts the exact passport bytes for bash, zsh and POSIX.
- `~/.nocx/launch` with a good manifest execs the integrated shell; with a missing,
  truncated, hash-mismatched or protocol-incompatible manifest it execs a native login shell
  and emits nothing.
- a read-only `$HOME` runs transient-integrated and records **no** installed fact.
- restricted shells, `ForceCommand` and administrative policy are never bypassed by invoking
  `/bin/bash` directly.
- the user's own startup files still run in the order the current launchers already
  establish, and an rc that `exit`s or `exec`s still wins.

Prove it with PTY tests against a **disposable `$HOME`** for bash, zsh and POSIX —
`launcher_test.go`, `launcher_posix_test.go` and `stage_pty_test.go` show the shape. Note
five tests in this package need `zsh` and `dash`, absent from this box's PATH: run
`nix shell nixpkgs#dash nixpkgs#zsh --command go test -race ./internal/shellintegration/...`.

## Verify

`go build ./...`, `go vet ./internal/shellintegration/`, `gofumpt -l internal/shellintegration/`,
`golangci-lint run ./internal/shellintegration/` — the branch is green there, so anything it
reports on your files is yours. Report, do not fix, findings in files you do not own.
