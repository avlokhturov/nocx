# Spike — a second channel on a hand-typed ssh (`nocx-qtnp`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first. **This is a spike: the
deliverable is measurements and a recommendation, not production code.** Write a throwaway
harness, keep it in the worktree, and do not touch anything under `internal/` or `frontend/`.

## The question

nocx rewrites a hand-typed `ssh user@host` to carry a ~35 KB integration payload in argv,
because the `ssh` process belongs to the user's shell and nocx has no channel to it. That is
why the line on screen is long.

**If we add `-o ControlMaster=auto -o ControlPath=<path>` to a line we are already
rewriting**, the user's own connection becomes a master. A second local process could then
open SFTP over it — no second authentication, no second entry in the server's auth log — and
push the payload into a temp directory. The line in argv shrinks to a short bootstrap that
waits for the file.

If that holds, the visible line is short from the **first** connection with no remote
footprint at all, which removes most of the reason for a persistent install. That is why this
is worth half an hour before more code is written.

## What to measure

Use `cmd/e2e-sshd` (a real sshd this repo already runs headless) — `e2e/shell-mode.spec.ts`
and `bd memories e2e` show how it is started. A real OpenSSH client and server, not a mock.

1. **Does the master work at all?** Run an interactive-shaped
   `ssh -o ControlMaster=auto -o ControlPath=<p> -t user@host '<sleep or read>'`, then from a
   second process: `ssh -O check -o ControlPath=<p> host`, and `sftp -o ControlPath=<p>`.
   Does the second process authenticate again — or not at all? Prove it from the **server's**
   side (auth log / session count), not from the absence of a prompt.

2. **Timing, which is the whole risk.** With a monotonic clock, from the moment the ssh
   command is submitted:
   - when does the control socket exist and answer `-O check`?
   - when does the remote command start relative to that?
   - how long does pushing 35 KB over the master take?
     Run it 20 times and report the distribution, not one lucky number. The remote bootstrap
     has to wait for the file; your numbers set that timeout and tell us how often it would
     fire.

3. **Failure modes**, each with the observed behaviour and whether fail-open is reachable:
   - `ControlMaster no` or `ControlPath none` in the user's own config — does our `-o`
     override win?
   - a `ControlPath` whose expansion exceeds the ~104-byte unix socket limit (a long `$HOME`,
     a long hostname — use `%C` and say whether it is enough).
   - a stale socket from a previous run, and a socket directory that is not writable.
   - the server refusing session multiplexing, or `MaxSessions 1`.
   - `ProxyJump` in the path.
   - what the user sees if the master never appears and the bootstrap times out.

4. **What the short bootstrap actually has to be.** Write the smallest POSIX-sh line that
   waits for `$TMPDIR/nocx-<id>/launch` and execs it, or execs a login shell on timeout, and
   measure its byte length. Compare with today's line (`buildBootstrapRewrite` in
   `frontend/src/ssh-transition.ts`).

## What to report

A short document with: the commands you ran, the numbers, a yes/no on each failure mode, and
a recommendation of one of —

- **take it**: multiplexing holds, the timeout is comfortable, fail-open is clean;
- **take it for some hosts**: it works but degrades in named cases we can detect in advance;
- **leave it**: name the specific thing that kills it.

Report numbers, not adjectives. If something is untestable on this box, say which and why
rather than guessing. `worker_done` carries the recommendation and the three or four numbers
that decide it; the document carries the rest.
