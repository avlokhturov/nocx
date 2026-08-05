# P1 revision — the linters the wave forbade you to run (`nocx-ruwl`)

Your publisher is accepted on substance: the manifest-last activation, the fault table over
the FS seam, the content-based stale rule and 29 green tests all stand. Nothing about the
design changes. But the repo gate runs `golangci-lint` and `gofumpt` over the whole tree, and
your files do not pass it — you were told not to run repo-wide gates, so this is the
coordinator's finding, not your failure.

Two of your seven files already carry small fixes made while reviewing (checked accessors in
`manifest_test.go`, renamed inner error variables in one `publisher_test.go` case). They are
in your worktree; start from what is there.

## The one that is not cosmetic — read it first

```
internal/shellintegration/publisher.go:208, 224, 237, 249 — shadow: declaration of "err" shadows declaration at line 207
```

`Publish` has **named return values** (`res PublishResult, err error`). Every `if err := …`
inside it declares a *new* `err`, so the named one keeps whatever it had. If any cleanup or
`defer` in that function reads or writes the named `err` — and a transactional publisher with
a lock release is exactly the shape that does — then a failure can be reported as a
successful publish, or a lock release error can overwrite the real cause.

**Do not rename these mechanically.** For each site, decide what the function must return
when that branch fails, and say so in the code. If the named returns are not actually needed,
the honest fix may be to drop them. Then add a test that fails the boundary in question and
asserts the caller sees the error — if none of your existing fault cases would have caught a
swallowed error here, that gap is the real finding.

The same shadow warnings exist in `Verify` and `Uninstall` if they follow the same shape;
check them.

## The mechanical rest

- `publish_fs.go:87, 99, 137` — gosec **G304** (file inclusion via variable). These are
  legitimate: the paths are the publisher's own, built from a validated root. The repo's
  convention is an inline suppression **with the reason**, e.g.
  `internal/shellintegration/shellintegration.go:93` and `stage_test.go:39`. Write the reason
  that is true for your call site; do not copy someone else's sentence.
- `publisher_test.go:221, 699, 702, 720, 723` — gosec **G302** (permissions above 0600).
  These are test fixtures deliberately creating a wrong mode so the publisher can refuse it,
  which is the point of the test. Suppress with that reason, in the form
  `launcher_posix_test.go:28` uses.
- Anything else `golangci-lint run ./internal/shellintegration/` reports on **your** files.

## How to verify — this once, you may run the package gate

```
gofumpt -l internal/shellintegration/
golangci-lint run ./internal/shellintegration/
go test -race ./internal/shellintegration/... -run 'TestPublish|TestManifest|TestUninstall|TestVerify|TestFault'
```

`golangci-lint` on that one package is allowed here because the other wave-1 workers have
landed and the branch is green; if you see a finding in a file that is not one of your seven,
report it rather than fixing it. Still no commits, no pushes, no `prettier`, no repo-wide
`go test ./...` — five tests in that package need `zsh` and `dash`, which are absent from this
box's PATH, and their failure is pre-existing and not yours.

One `worker_done`: what each shadow turned out to be, whether any of them could have reported
a failed publish as successful, and the suppression reasons you wrote.
