# Git manager — design

- **Status:** draft, awaiting owner approval
- **Date:** 2026-08-06
- **Brainstorming bead:** `nocx-5nej`
- **Predecessor this is modelled on:** `.internal/specs/2026-08-06-file-manager-design.md`

## 0. The one rule

**The panel shows the repository your shell is standing in, and never another one.**

Everything below follows from that sentence: why the repository is resolved from the
tab's **verified** OSC 7 cwd rather than from the Files panel's root, why a `cd` into a
different repository re-binds instead of being ignored, why the panel on an SSH tab shows
nothing rather than the local repository, and why the Commit button disappears with the
repository rather than staying live "on the last one we knew".

The rule is stricter here than it was for the file tree, and the reason is the blast
radius. A tree listing the wrong machine is a nuisance you notice and correct. A
`Commit` that landed in the wrong repository is a corrupted history somebody discovers a
day later, on a branch they did not touch.

## 1. What this is

A **Git** view in the existing left activity bar, third after Files and Ports, showing
the working state of the repository the active tab's shell is in.

- **Primary reading:** what changed, split into Staged and Unstaged, with the branch,
  its upstream and ahead/behind above them.
- **Primary action:** stage and unstage files, then commit them — with a real commit
  message and a real Amend.
- **Secondary reading:** a unified diff of one file, in its own read-only tab.

### Why a git panel in a terminal at all

`docs/vision.md` does not list source control, so the argument has to be made rather
than assumed, and it is the same argument the file tree made: **when an agent TUI
occupies the terminal, the terminal cannot be used to run git.** `git status`, `git diff`
and `git add -p` all need a free prompt. The nocx user runs an agent in the tab and wants
to see what it just wrote and turn it into a commit — the one moment the normal tools are
unavailable.

Unlike the file tree, this argument does **not** immediately drag the remote case in with
it, because the way to reach a remote repository is already decided and is not exec — see
D3.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                              | Rejected alternative, and why                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A repository is addressed by a `bindingId` the backend issues** from `{sessionId, cwd}`. Only `git.open` takes a `sessionId`; every later call reaches its runner through `Registry.Acquire`, which re-checks caller ownership                       | Every call carrying `{sessionId, path}`. It spreads the authorisation check across every handler, where one that forgets it is a hole. This is `filesystem` D1/D15 restated, and the choke point is `Acquire`                                                              |
| D2  | **The repository is resolved by running `git rev-parse --show-toplevel` in the tab's verified OSC 7 cwd.** No verified cwd → no repository, and the panel says so                                                                                     | Deriving it from `session.Cwd()`. That is the session's **start** cwd, and for an SSH session with no explicit cwd it is the **local** `os.UserHomeDir()` — the $HOME substitution AD-5 forbids applying silently, and the file manager already refused it once (§2 of its spec) |
| D3  | **Local only. The remote case waits for the relay** (`nocx-if6` phase B), and on an SSH tab the panel shows one honest state and offers nothing                                                                                                       | Running git over `DiscoveryConn.Exec`. Every argument would become a string for a remote shell, reintroducing quoting we do not have to do, and it is a second answer to a question AD-2 already settled by naming the remote helper a build target                          |
| D4  | **The repository re-binds when the toplevel changes, and only then.** A `cd` inside the repository is a no-op; a `cd` into another repository swaps the binding; a `cd` out of any repository drops to the no-repository state                        | Pinning the repository at tab open. That is exactly the `nocx-r3bz` defect one layer up — a surface that keeps acting on the place you left — except the surface here has a Commit button                                                                                  |
| D5  | **The `git` binary, through `os/exec`, with argv and no shell.** Both reference products do this and neither ships a git library                                                                                                                       | `go-git`. It is a second opinion on "what does git think", it diverges in the corners (sparse-checkout, index extensions, submodules), and it **never runs hooks** — a commit from the panel would silently bypass this repository's own pre-commit gate                     |
| D6  | **git runs with a resolved login environment, cached once**, not with the backend's own                                                                                                                                                              | Inheriting `os.Environ()`. A GUI-launched `.app` has a bare launchd PATH; the pre-commit hook would not find `go`, `node` or `bd`, so a commit that works in the embedded terminal fails from the panel. termic documents this exact failure at `src-tauri/src/lib.rs:1082` |
| D7  | **One `git status --porcelain=v2 -z --branch --untracked-files=all` answers everything the panel's header and lists need** — branch, upstream, ahead/behind and the file split all ride in one output                                                 | A second subprocess for the branch and a third for ahead/behind. porcelain v2's `# branch.*` headers already carry them; orca's own code comments say the same thing about its polling loop                                                                                |
| D8  | **Paths and messages never ride in argv for a mutation**: `--pathspec-from-file=- --pathspec-file-nul` with paths on stdin, `commit -F -` with the message on stdin                                                                                   | Putting them in argv. argv has an OS length cap that "stage all" in a large repository will hit, a path beginning with `-` is read as an option, and a commit message with newlines and quotes is the normal case, not the exotic one                                       |
| D9  | **Status is bounded and the bound is a visible state**: at most `MaxStatusEntries` records, and past that the panel says how many there are instead of showing a prefix                                                                              | Rendering whatever arrived. A complete-looking prefix of a change set is worse than an honest refusal — `filesystem` D14, restated. orca caps and reports `didHitLimit`/`statusLength`; termic reports `truncated`                                                          |
| D10 | **git computes the diff; the frontend renders text.** Unified only                                                                                                                                                                                    | Shipping `@codemirror/merge` and diffing two file versions in the browser. That is a second diff algorithm in the product, disagreeing with `git diff` in exactly the places nobody looks                                                                                  |
| D11 | **A failed hook is a result, not a transport error.** `git.commit` answers a state; the panel shows the hook's output and **keeps the message in the form**                                                                                          | Mapping a non-zero exit to a JSON-RPC error. The message would be lost with it, and a hook rejection is the single most likely thing to happen on this repository                                                                                                          |
| D12 | **A mutation returns the fresh status.** Stage, unstage and commit all answer the new `Status` in the same call                                                                                                                                       | Letting the next poll discover it. It races: the poll in flight when the mutation lands answers with the pre-mutation state and the row flickers back                                                                                                                      |
| D13 | **Refresh is polling, gated on visibility**, plus a manual refresh and the D12 post-mutation status. One poll in flight at a time, never queued                                                                                                       | fsnotify on `.git` (a second refresh mechanism to keep in step with the first), a recursive worktree watch (a second `.gitignore` implementation, and expensive on a large repository), and OSC 133 command-end — which `filesystem` D5 already rejected: an agent is one long command |
| D14 | **What the panel cannot do, it does not draw.** On an SSH tab the mutation controls are **absent**, not disabled                                                                                                                                       | Disabled buttons with a tooltip. `files.reveal` set this precedent for the same reason: a disabled control advertises a capability the surface does not have                                                                                                               |
| D15 | **`internal/git` declares its own `Caller` interface** rather than importing `internal/filesystem`'s identical one                                                                                                                                     | Hoisting a shared `Caller` into a third package, or importing across feature packages. A consumer-declared interface is the Go idiom and keeps two feature packages independent; the duplication is one method signature, and the alternative couples them permanently     |
| D16 | **Execution sits behind a `Runner` interface from day one**, with everything above it — porcelain parsing, the status model, commit orchestration — machine-independent                                                                               | A single concrete local implementation "because remote is deferred". The relay's implementation then arrives as a second `Runner` rather than as a rewrite, and that is the whole cash value of the deferral in D3                                                          |

### D5 in full: why shelling out is the right second implementation

`internal/completion` and `internal/discovery` both already run commands. Under the
AGENTS.md rule "look for the existing answer before you write a second one", running a
subprocess is not a new concept in this codebase and needs no defence. What needs
defending is running **git** rather than reading the repository in-process, so:

The panel must say the same thing as `git` typed in the tab next to it. That is not a
nice-to-have, it is the product: a user reads the panel and then types `git commit` — or
reads the panel _because_ an agent is typing `git` — and any disagreement between the two
is a defect the user experiences as the panel lying. A library is by construction a
second implementation of "what does git think", and the divergences are silent: it agrees
about a modified file and disagrees about a sparse checkout, a submodule, or a
`core.excludesFile` the user set five years ago.

The decisive one is hooks. This repository's own pre-commit hook is the quality gate for
every commit in it. `go-git` does not run hooks. A Commit button that silently produced
commits nobody's gate had seen would be a defect of the kind AGENTS.md keeps naming: a
feature that is green everywhere you look and wrong where you did not.

**This reasoning goes in the code**, at `internal/git`'s package doc, not only here.

## 3. Scope

### In

- A **Git** view in the existing activity bar, ordered after Files and Ports.
- Repository resolution from the active tab's verified cwd, re-binding on toplevel change
  (D2, D4).
- Header: branch name, upstream name, ahead/behind, and a total changed count.
- Two lists — **Staged** and **Unstaged** — one row per file with a type icon, a
  one-letter status and the path.
- **Open a unified diff** of one file in its own read-only tab; sides chosen by the list
  the row was in (staged → `HEAD`↔index, unstaged → index↔worktree).
- **Stage / unstage** one file, and stage-all / unstage-all.
- **Commit**: subject, body, and **Amend** prefilled from `HEAD`.
- Polling while the view is visible, a manual refresh, and the post-mutation status (D13,
  D12).
- Honest states, each visible in the panel and not only in a log: no verified cwd, not a
  repository, git absent, git too old, unborn branch, detached HEAD, too many changes,
  remote tab.

### Out — each a refusal, not an omission

- **The remote repository.** Waits on the relay, `nocx-if6` phase B (D3). Filed there as
  a child, not here as a TODO.
- **discard / restore.** The one action that destroys work with no undo. Its own bead,
  with a confirmation design, and it must handle the three cases the panel would otherwise
  conflate: an untracked file (discard means **delete from disk**), a tracked
  modification (`restore`), and a partially staged file.
- **Branch checkout, branch creation, stash.** Checkout changes the reality underneath an
  agent that is running in the terminal right now, and checkout with a dirty tree is a
  stash-or-refuse decision. Its own bead.
- **push / pull / fetch / publish / Create PR.** The whole right-hand half of the orca
  screenshot. It needs remote authentication and a "which action is appropriate now"
  resolver — orca's is several hundred lines with its own test suite. Its own epic.
- **Git status markers in the file tree** — `nocx-terg` stays a separate bead and gains a
  dependency edge on this epic. The store is nevertheless designed so a second consumer
  reads the same state rather than issuing its own status (§5.4).
- **Multi-repository, submodules, worktrees as a list.** nocx has no "project" concept;
  there is exactly one repository — the one the shell is in. termic's repo pills exist
  because a termic task legitimately spans several checkouts; inventing that concept here
  would be inventing a product feature nobody asked for.
- **Hunk- and line-level staging.** Needs a patch editor. Its own bead.
- **Split (side-by-side) diff.** Its own bead; the `git.diff` contract is shaped so it can
  be added without breaking the schema (§5.3).
- **Merge conflicts as a surface.** A file in conflict shows with status `U` and is not
  stageable from the panel. Resolving conflicts stays in the terminal.
- **A resizable split between the two lists**, and **view modes (tree / list / combined)**.
  termic has both; they are preferences over a surface that must first exist.
- **Persisting the commit message across app restarts** (D12 of the frontend, §5.4).

## 4. Architecture

### 4.1 Backend — `internal/git`

Mirrors `internal/filesystem`'s shape, because the problems are the same shape: a
per-session resource the client must not be able to name directly, reached only through a
guarded handle.

```
internal/git/
  git.go          package doc (D5's reasoning), domain types, Runner + Caller interfaces
  binding.go      Binding, Handle, Registry, Acquire      (mirrors filesystem/binding.go)
  porcelain.go    the status parser — pure, machine-independent, reused by the relay
  diff.go         diff invocation and its bounded result
  commit.go       commit orchestration: identity check, message on stdin, hook outcome
  capability.go   git presence + version probe, cached per runner
  errors.go       the errors transport switches on
  local/
    local.go      Runner over os/exec
    loginenv.go   the resolved login environment (D6)
```

#### The `Runner` seam (D16)

```go
// Runner executes one git invocation somewhere. It is the ONLY part of this
// package that knows which machine the repository is on; everything above it —
// porcelain parsing, the status model, commit orchestration — is machine
// independent, so the relay's implementation arrives as a second Runner and
// not as a second git package.
type Runner interface {
    // Run executes `git <args...>` with dir as the working directory, feeding
    // stdin when non-nil. A non-zero exit is NOT an error: it is a Result the
    // caller interprets, because git uses exit status to say ordinary things
    // (1 from `diff --no-index` means "there are differences").
    // An error is reserved for "the invocation could not be made or completed":
    // git absent, the context cancelled, the output bound hit before exit.
    Run(ctx context.Context, dir string, args []string, stdin []byte) (Result, error)
    // Version is the probed `git --version`, cached.
    Version(ctx context.Context) (Version, error)
    Close() error
}

type Result struct {
    Stdout, Stderr []byte
    ExitCode       int
    Truncated      bool // an output bound was hit; Stdout is not complete
}
```

`local.Runner` is `os/exec` with three properties that are load-bearing and each have a
test:

1. **argv, never a shell.** No path or message is ever interpolated into a command
   string.
2. **The resolved login environment (D6).** Computed once, cached, and it is what the
   PTY's login shell would have computed. Resolution is bounded by a deadline and by an
   output cap; if it fails, git still runs — with `os.Environ()` and a **surfaced**
   degrade, because a commit whose hooks silently could not find their tools is exactly
   the failure this is here to prevent.
3. **A bounded output.** `Truncated` is set rather than the process being allowed to
   produce unbounded bytes into memory (D9).

#### Repository resolution

`git.open` receives `{sessionId, cwd}`. The composition layer:

1. Checks `caller.Owns(sessionId)` — the D15 authorisation choke point, satisfied by
   `connState.Owns`, which already exists (`internal/transport/ws.go:753`).
2. Refuses immediately if the session is an SSH session (D3, D14) — before spawning
   anything.
3. Probes capability: git present, and `>= 2.25`.
4. Runs `git rev-parse --show-toplevel --absolute-git-dir` in `cwd`.
5. On success, `Registry.Register(sessionID, runner, repo)` mints the binding.

Every outcome other than (5) is a **state in the result**, not a JSON-RPC error, because
each is a thing the panel must draw:

| State               | Cause                                                    |
| ------------------- | -------------------------------------------------------- |
| `ok`                | a repository was resolved                                |
| `notARepository`    | `rev-parse` said no                                      |
| `noCwd`             | the caller had no verified cwd to offer                  |
| `remoteUnsupported` | the session is an SSH session (D3)                       |
| `gitUnavailable`    | no `git` on PATH                                         |
| `gitTooOld`         | below the floor; the result carries the version it found |

**The version floor is 2.25** (January 2020). It is set by
`--pathspec-from-file`/`--pathspec-file-nul` (2.25); `--porcelain=v2` needs only 2.11.
The floor is named in one constant, and the constant's comment names which flag bought
it, so a later relaxation is a decision rather than an accident.

#### `Handle` — the only route to a repository

```go
type Handle interface {
    Status(ctx context.Context) (Status, error)
    Diff(ctx context.Context, path string, side Side, maxBytes int64) (Diff, error)
    Stage(ctx context.Context, paths []string) (Status, error)
    Unstage(ctx context.Context, paths []string) (Status, error)
    Commit(ctx context.Context, msg string, amend bool) (CommitOutcome, error)
    HeadMessage(ctx context.Context) (string, error) // Amend prefill
}
```

`Stage`/`Unstage` return the post-mutation `Status` (D12). `Registry.Acquire` returns the
handle plus a release, holds the use-guard for the call's duration, and re-checks
ownership on every acquisition — the binding id is not a bearer token, exactly as in
`filesystem/binding.go`.

#### Domain types

```go
type Status struct {
    Branch     string // "" when detached
    Detached   bool
    Unborn     bool   // a repository with no commits yet
    Head       string // short hash; "" when unborn
    Upstream   string // "" when the branch has none
    Ahead      int
    Behind     int
    Staged     []Entry
    Unstaged   []Entry
    Conflicted []Entry
    Total      int    // records seen before any cap was applied
    Truncated  bool   // the cap was hit; the lists are the first MaxStatusEntries
}

type Entry struct {
    Path    string
    OldPath string // renames and copies only
    Code    string // the porcelain column for THIS side: M A D R C ?, or U
    Kind    EntryKind // regular | submodule | symlink
}
```

`Staged`, `Unstaged` and `Conflicted` are never nil — an empty set marshals as `[]`, not
`null`. That exact bug was found by the first contract schema this repository ever ran
(`contracts/README.md`), and it is cheaper to not repeat than to rediscover.

#### `porcelain.go`

One `git status --porcelain=v2 -z --branch --untracked-files=all` produces everything
(D7). The parser is pure — bytes in, `Status` out — which is what makes it the part the
relay reuses whole.

Three properties the parser must have, each of which is a real repository's real output
and each of which gets a test with captured bytes:

- **`-z` is not decoration.** Records are NUL-terminated because a path may contain a
  newline. A line-oriented parser is correct until somebody checks in a file with a
  newline in its name, and then it is silently wrong.
- **Rename records carry two paths in one record**, separated by a NUL of their own
  (`2 <XY> ... <path>\0<origPath>\0`). Getting this wrong shifts every subsequent record
  by one field.
- **A file can be in both lists.** `XY` where both columns are non-`.` means staged
  changes *and* further unstaged changes to the same path — the file appears once in each
  list, which is why the panel's row key is `{side, path}` and not `path`.

Plus the header records: `# branch.head`, `# branch.upstream`, `# branch.ab +N -M`, and
the absence of the latter two, which is what "no upstream" looks like — never a zero.
`# branch.head` is the literal `(detached)` when detached, and an unborn branch has no
`# branch.oid` commit.

#### `commit.go`

The order matters and is the design:

1. **Refuse early if nothing is staged**, with `nothingToCommit` — before touching
   anything, and before running a hook that would then fail confusingly.
2. **Check identity.** `git config user.email` / `user.name`. Unset is the ordinary
   first-run state on a fresh machine, and git's own error for it is four paragraphs of
   shell instructions. We answer `identityMissing` and the panel says the one sentence
   that matters. Checked before the commit, not parsed out of its failure.
3. **`git commit -F - [--amend]`**, message on stdin (D8).
4. **Interpret the exit.** Zero → `ok`, with the new head. Non-zero → `hookFailed` when a
   hook produced it, `failed` otherwise, and in **both** cases the captured stderr and
   stdout ride back in the result (D11), because a hook's output is the only thing that
   tells the user what to fix.

`--amend` on an unborn branch is refused before invocation; there is nothing to amend.

**A commit never bypasses hooks.** There is no `--no-verify` in this design and no
setting that adds one. If that is ever wanted it is a deliberate decision with its own
bead, not a checkbox somebody adds because a hook was in the way.

#### `diff.go`

| Row is in     | Invocation                                       |
| ------------- | ------------------------------------------------ |
| Staged        | `git diff --cached --no-color -- <path>`         |
| Unstaged      | `git diff --no-color -- <path>`                  |
| Untracked (`?`) | `git diff --no-index --no-color -- /dev/null <path>` |

The untracked row is the interesting one: an untracked file has nothing to diff against,
and `--no-index` against `/dev/null` is git's own answer for it, producing a real unified
diff of all-additions. It exits **1** when there are differences, which is why `Runner`
treats a non-zero exit as data rather than as an error.

The result is a state, not a string:

| State      | Meaning                                                             |
| ---------- | ------------------------------------------------------------------- |
| `ok`       | unified diff text, possibly `truncated`                             |
| `binary`   | git said `Binary files differ`; there is nothing to render          |
| `tooLarge` | the byte bound was hit before the diff completed                    |
| `empty`    | no differences — the file changed back, or the poll raced the click |
| `gone`     | the path no longer exists in that side                              |

`empty` and `gone` exist because the panel is polling: a row can be clicked in the same
second the agent reverts the file.

### 4.2 Wire — control plane, JSON-RPC (AD-1)

Eight methods and one notification, in a new `internal/transport/ws_git.go` beside
`ws_files.go`.

| Method            | Params                                 | Result                                                       |
| ----------------- | -------------------------------------- | ------------------------------------------------------------ |
| `git.open`        | `{sessionId, cwd?}`                    | `{state, bindingId?, toplevel?, gitVersion?, status?}`       |
| `git.status`      | `{bindingId}`                          | `{status}`                                                    |
| `git.diff`        | `{bindingId, path, side, maxBytes}`    | `{state, text, truncated}`                                    |
| `git.stage`       | `{bindingId, paths[]}`                 | `{status}`                                                    |
| `git.unstage`     | `{bindingId, paths[]}`                 | `{status}`                                                    |
| `git.commit`      | `{bindingId, message, amend}`          | `{state, head?, output?, status}`                             |
| `git.headMessage` | `{bindingId}`                          | `{state, message}` — the Amend prefill                        |
| `git.close`       | `{bindingId}`                          | `{closed}`                                                    |
| `git.changed`     | *(notification)* `{bindingId, reason}` | the binding died — session closed, connection lost            |

Notes that are decisions, not descriptions:

- **`git.open` returns the first `status` inline.** Otherwise every panel open is two
  round trips and one guaranteed frame of empty lists.
- **`git.headMessage` is its own method and not a `status` field.** The Amend prefill is
  wanted once, when the box is ticked; carrying it in `status` would run `git log -1` on
  every poll to answer a question nobody asked. Its `state` distinguishes a message from
  an unborn branch, which has no HEAD to read and is not an error.
- **`side` is an enum** — `staged` | `unstaged` | `untracked` — because the sides of a
  diff are a closed set and a schema that says `string` is theatre (`contracts/README.md`).
- **`git.changed` exists from the start.** `nocx-lzfb` is an open bug against the files
  panel — "a session dying destroys its file bindings silently; the viewer never learns".
  Shipping the same hole again knowingly would be worse than having shipped it once.
- **A superseded `git.open` closes the binding it abandons.** `nocx-myts` is that bug in
  the files panel. The store owns exactly one binding and closes the previous one before
  it stores a new one, including when the new open fails.

Every method is authorised the same way `files.*` is: `git.open` through
`connState.Owns`, everything after it through `Registry.Acquire`.

### 4.3 Contracts

One schema per result shape, `additionalProperties: false` plus an explicit `required`,
generated TS committed, and both Go checks — the DTO test and the
`…_OverTheWireConformsToContract` test that drives the real method through the real
socket.

```
contracts/git.open.schema.json
contracts/git.status.schema.json
contracts/git.diff.schema.json
contracts/git.stage.schema.json      (result: the shared status shape)
contracts/git.unstage.schema.json
contracts/git.commit.schema.json
contracts/git.headMessage.schema.json
contracts/git.close.schema.json
contracts/git.changed.schema.json
```

`status` appears in six results. It is declared **once** and referenced with `$ref`; six
copies of one shape is six chances for five of them to be right.

The `git.diff` result carries `state` + `text`; a later split view adds `oldText`/`newText`
as new **optional** fields with their own state, so the schema grows by addition and the
committed generated type does not churn (§3, "split diff" is out).

### 4.4 Frontend — `frontend/src/git/`

```
frontend/src/git/
  git-client.ts     one method per wire call; every result a GENERATED type
  git-store.ts      binding lifecycle, poll controller, mutation queue, commit form
  git-view.tsx      createGitView(deps): SidebarViewDescriptor
  git-panel.tsx     the panel body
  git-diff/
    open-git-diff.ts       openGitDiff(target) + surface registration
    git-diff-content.tsx   read-only CodeMirror host with +/- decoration
```

This is the `files/` split, deliberately: a client that declares no types of its own, a
store that owns every state transition and is testable without a socket, and a view that
renders it.

#### The store's state machine

The input is the same reactive `activeOrigin()` accessor the Files panel takes — the
coordinator wires it through `onActiveTabChange`, and `ActiveOrigin` already carries
everything needed (`frontend/src/tab-content.ts:40`): `sessionId`, `kind`, `cwd`,
`cwdVerified` and `cwdFollow`.

The store derives one of these, and the panel renders exactly one:

| State               | Reached when                                       | What the panel shows                                                  |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `noTab`             | `activeOrigin()` is null                           | empty state, no controls                                              |
| `remote`            | `origin.kind === 'ssh'`                            | "Git on a remote host isn't supported yet" — and **no** mutation controls (D14) |
| `noCwd`             | `cwdVerified` is false                             | what is missing and why: no shell integration on this session         |
| `notARepository`    | `git.open` said so                                 | the directory, and that it is not a repository                        |
| `gitUnavailable`    | no git on PATH                                     | how to install it                                                     |
| `gitTooOld`         | below the floor                                    | the version found and the version needed                              |
| `ready`             | a binding and a status                             | the panel                                                             |
| `tooManyChanges`    | `status.truncated`                                 | the count, above the (capped) lists                                   |

`cwdFollow` is honoured exactly as the Files panel honours it: a diff tab's frozen origin
says no, so activating a diff tab never re-binds the panel to something stale.

**Re-binding rule (D4).** A cwd change re-runs resolution only when the new cwd is
outside the current `toplevel`. Cheap prefix test first, `git.open` only when it fails —
otherwise every `cd` in a big repository is a subprocess.

#### Polling (D13)

The controller runs only while **all** of: the Git view is the selected sidebar view, the
sidebar is expanded, the window has focus, and the store is `ready`. The
`SidebarViewDescriptor` already passes `visible` to the view (the Ports panel gates its
sampling on it); window focus is the same predicate the ports sampler uses.

- Interval: 2s, one poll in flight at a time, never queued.
- A mutation in flight suppresses the poll; the mutation's own result is the next status
  (D12).
- A poll that errors does not clear the lists. It marks the status stale and leaves the
  last good one on screen — blanking a panel because one subprocess failed loses the
  user's place for no gain.
- Manual refresh is a header `IconButton`, matching Files and Ports.

#### The panel body

Read the kit first (`frontend/src/ui/README.md`), and the kit covers this surface without
a new component:

| Element                         | Kit component                        |
| ------------------------------- | ------------------------------------ |
| Branch / upstream / ahead-behind | `StatusCard` or a `Toolbar` row + `Badge` |
| Filter box                      | `SearchField`                        |
| Section headers with counts     | `Section`                            |
| File rows                       | `TreeRow` (it already carries the type-icon and status-glyph slots) |
| Stage / unstage affordances     | `IconButton`                         |
| Commit subject and body         | `TextField`, and `TextField multiline` for the body (`text-field.tsx:20`) |
| Amend                           | `Checkbox`                           |
| Commit                          | `Button`                             |
| Empty and error states          | `EmptyState`, `StatusCard`           |
| Failures that are not states    | `showToast`                          |

The panel **places** them and never repaints them. If a row wants a colour the kit does
not have, the colour becomes a typed `data-*` variant on `TreeRow`, in `ui/` — that is
what the two epics `nocx-pp3y` and `nocx-v0ai` spent themselves establishing.

#### The diff tab

Registered like the file viewer, as its own surface. `openGitDiff(target)` with

```
singletonKey = `git:${toplevel}:${side}:${path}`
```

so clicking the same row twice focuses one tab, while the staged and unstaged diffs of one
file are legitimately two tabs — they show different things.

The content is the existing read-only CodeMirror host with a decoration layer over the
unified text: `+` lines, `-` lines, hunk headers. **No syntax highlighting inside the diff
in this slice** — it is a real gap, it is named in Out, and it gets its own bead rather
than a half-implementation that highlights the additions and not the context.

The tab is a **snapshot plus an offer**, the same as the file viewer (`filesystem` D7): a
diff whose underlying status changed says so and offers Reload; it never re-reads
underneath somebody who is reading it.

#### The commit form

- Lives in the store, per binding. Switching to another view and back keeps it; switching
  to another repository does not carry it across.
- **Not persisted to disk, and `.git/COMMIT_EDITMSG` is not written.** That file belongs
  to git and to a `git commit` a user may be running in the terminal at that moment.
- Amend prefills from `HeadMessage`, once, when the box is ticked, and only into an empty
  form — never over text the user has typed.
- Commit is disabled when nothing is staged or the subject is empty. On `hookFailed` the
  message **stays**, and the hook's output appears in the panel (D11).

### 4.5 Lifecycle

| Event                       | Behaviour                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Tab switch                  | origin changes → close the old binding, open the new (§4.2, `nocx-myts`)                     |
| `cd` inside the repository  | nothing (D4)                                                                                 |
| `cd` to another repository  | close, open                                                                                  |
| `cd` out of a repository    | close, state `notARepository`                                                                |
| Session closes              | backend closes the binding and sends `git.changed`; the store drops to `noTab`, the diff tab goes stale and offers nothing but its snapshot |
| WebSocket reconnect         | every binding is gone; the store re-opens on the next tick rather than trusting a stale id   |
| Sidebar collapsed / other view selected | polling stops; the binding stays (re-opening it costs two subprocesses)           |
| App quit                    | nothing to persist                                                                           |

## 5. Sequence

Each step is shippable and leaves the product working.

1. **`internal/git` core**: `Runner`, `local.Runner` with argv and bounded output,
   capability probe and the version floor. `porcelain.go` with its captured-bytes tests.
   No wire, no UI.
2. **The login environment resolver** (D6), with the paired tests rule 2 of AGENTS.md
   demands: the failure paths **and** "on an ordinary machine it succeeds".
3. **Binding, Registry, Acquire, `Handle.Status`** — the read half of the backend.
4. **Wire read half**: `git.open`, `git.status`, `git.close`, `git.changed`, their
   schemas, their generated types, both contract tests.
5. **Panel, read-only**: view descriptor, store, all eight states, polling. At the end of
   this step the panel is useful and shows nothing that can go wrong destructively.
6. **Diff**: `git.diff`, the diff tab surface, the three sides.
7. **Mutations**: `git.stage`, `git.unstage`, and their post-mutation status.
8. **Commit**: identity check, `commit -F -`, amend, hook outcome, and the form.
9. **The epic's happy path e2e** (§6) — written when the epic is created, run here.

Steps 1–2 and 3–4 are the natural parallel front; 5 onward is one chain.

## 6. Testing

The five rules apply, and three of them bite hard here.

**The epic's happy path (rule 2).** One automated check watches a user do the thing they
could not do before, end to end, headless against `cmd/devharness`:

> In a temporary git repository, edit a tracked file → the panel shows it under Unstaged
> → click the row → a diff tab opens showing the change → stage it → it moves to Staged →
> type a subject → Commit → both lists are empty, and the header's branch line reflects
> the new head.

It is written when the epic is created, not at the end.

**Failure paths (rule 3).** For every external call there is a test where that call fails:

- git absent; git below the floor; `rev-parse` refusing; `status` exiting non-zero;
  `status` truncated; a context cancelled mid-invocation.
- `commit` rejected by a hook — asserting the message survives and the hook's stderr
  reaches the result.
- `commit` with `user.email` unset.
- The login-env resolver failing, timing out, and succeeding.

**Intervals, not moments (rule 3).** The binding invariant is stated with both ends: *a
binding is reachable from the moment `Register` returns until `Close` returns, and no
provider call is in flight after `Close` returns*. The second half is what the use-guard
buys and what the test must assert — `filesystem` bought that lesson with four deadlocking
returns nobody covered.

**Acceptance criteria as assertions (rule 4).** Every bead in this epic states its
criteria as assertions, in the bead.

**The wire (rule 5).** Every one of the nine results gets a schema, a DTO conformance
test and an over-the-socket test. The `status` shape gets its own `$ref` and is exercised
through at least: an empty repository, an unborn branch, a detached HEAD, a rename, a file
in both lists, a path containing a newline, and a truncated status.

**Frontend store tests** cover every state transition in §4.4 without a socket, including:
poll suppressed while a mutation is in flight; a failed poll leaving the last good status
on screen; a superseded open closing its predecessor's binding; `cwdFollow: false` not
re-binding.

## 7. Bead changes

- **New epic**, labelled `mvp`, acceptance criterion = the happy path in §6, with the Out
  list of §3 named in it. Children per the §5 sequence, sequenced with `blocks` so the
  ready front stays around three.
- **`nocx-terg`** (git markers in the file tree) — stays a separate bead; add
  `bd dep add nocx-terg <this-epic>`.
- **New bead under `nocx-if6`**: "the Git panel works on an SSH tab, over the relay",
  child of the relay epic, carrying D3's reasoning so the next reader does not
  re-litigate `DiscoveryConn.Exec`.
- **New standalone beads** for each refusal in §3 that is a real product gap: discard,
  branch checkout/create, push/pull/PR (an epic), hunk staging, split diff, syntax
  highlighting inside the diff, conflicts as a surface.
- **The login-env resolver** is a child of this epic but is a shared capability —
  anything the backend ever spawns will want it — so it lands in `internal/git/local`
  with a note, and moves out when a second consumer appears rather than being hoisted
  speculatively.

## 8. Open questions

1. **Poll interval.** 2s is termic's and orca's neighbourhood, and `git status` on a large
   repository is not free. If it measures badly on this repository, the answer is a
   longer interval, not a partial status.
2. **`MaxStatusEntries`.** Needs a number with a reason. 5,000 is a starting proposal —
   large enough that a real change set is never capped, small enough that a stray
   `node_modules` is caught.
3. **Untracked directories.** `--untracked-files=all` lists every file inside an untracked
   directory, which is what makes an un-ignored `node_modules` a five-figure status. The
   alternative — `normal`, which collapses to the directory — makes staging a directory
   ambiguous. Proposal: keep `all` and let D9's cap be the answer; revisit if the cap
   fires in ordinary use.

## 9. Review history

- 2026-08-06 — brainstormed with the owner (`nocx-5nej`); five decisions taken by the
  owner directly: the termic-shaped slice, local-only with the relay carrying the remote
  case, live cwd-following repository resolution, unified diff in a tab, and
  stage/unstage/commit/amend with discard held back.
