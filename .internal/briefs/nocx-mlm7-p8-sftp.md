# P8 — the SFTP carrier publishes through the same publisher (`nocx-gh90`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §4 and N4 of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md),
then `internal/shellintegration/publisher.go` — P1's publisher, which landed on this branch.

## What you build

The saved-connection path onto a remote host. nocx owns that transport, so it does not need
to ride an ssh command line: it can publish over SFTP directly. What it must **not** do is
publish differently.

`internal/shellintegration/install_remote.go` today writes scripts straight into live files,
sets no modes, and appends a gate to the user's `.bashrc`. Every one of those is now
forbidden (N4), and the transactional behaviour it lacks already exists in P1's publisher.
Your job is to make this file a **carrier**: an implementation of the publisher's filesystem
seam backed by `*sftp.Client`, handing the same bundle descriptor to the same `Publish`.

The rc-editing half is **retired, not fixed**. Delete it. Nothing in nocx may create or
modify a remote rc file again.

## The second half: it has to be reachable

`internal/app/app.go` constructs the launcher and the local stager but **no installer**, and
`internal/ssh/ssh_real.go` reaches the installer only when the launcher is absent — which it
never is. So this package has never run in the product. `deadcode` and a green test suite
both said fine; neither can report a feature that is missing.

Wire it at the composition root and make the precedence deliberate: a saved connection
publishes the bundle over SFTP, and the launcher it starts is the compact carrier when a
generation is committed. Say in your report exactly which call site now reaches it.

P3 left `ssh.LaunchPolicy` in `internal/ssh` as a translation of the new `desiredMode`, with
a note that you retire it. Do that: `raw` publishes nothing and integrates nothing, `script`
publishes, `relay` behaves as `raw` this epic.

## Files you own

`internal/shellintegration/install_remote.go` and its test, `internal/ssh/ssh.go`,
`internal/ssh/ssh_real.go` and their tests, and the `app.go` wiring.

P6 is editing `launcher*.go` in parallel — do not touch those, and do not modify
`publisher.go`, `manifest.go` or `publish_fs.go`. If the seam does not fit an SFTP client,
that is a finding to report, not a file to edit.

## What must be true when you are done

- the SFTP carrier and the self-installing launcher publish the same bundle descriptor
  through the same `Publish`; one behaviour, one owner (AD-8).
- **no remote rc file is created or modified on any path**, asserted by byte snapshots of
  `.bashrc`, `.bash_profile`, `.profile`, `.zshrc` and `${ZDOTDIR}/.zshrc` taken before and
  after a publish.
- modes are right over SFTP too: directories 0700, data 0600, the carrier 0700 — SFTP's
  `Create` does not set them for you.
- the fault paths survive the carrier: an interrupted transfer leaves the previous activation
  byte-identical and the next attempt converges.
- the installer is constructed at the composition root and reached by a saved connection.
- `ssh.LaunchPolicy` is gone.

`install_remote_test.go` already has an in-process SSH/SFTP fixture — use it rather than
inventing one.

## Verify

`go build ./...`, `go vet ./internal/shellintegration/ ./internal/ssh/ ./internal/app/`,
`gofumpt -l`, `golangci-lint run` on those three packages, and
`nix shell nixpkgs#dash nixpkgs#zsh --command go test -race ./internal/shellintegration/... ./internal/ssh/...`
(zsh and dash are absent from this box's PATH and five tests in shellintegration need them).
Nothing repo-wide, no frontend, no formatting passes.
