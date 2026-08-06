// Git-panel e2e fixture: disposable temporary git repositories (design §7 —
// each spec builds its own repo and drives the panel against it).
//
// git runs through execFileSync, never a shell, with user.email/user.name set
// in the repo itself: the suite never relies on the machine's git config
// (brief, and a hook-less machine default is exactly the kind of environment
// dependency a green run hides).
//
// The fixture root lives under the isolated home when the suite declares one
// (headless path), else under the system tmp dir (wails path) — the same
// choice files.spec.ts makes, so a run never writes into a developer's tree.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitRepo {
  root: string
  /** The tracked file the tests edit and stage, repo-relative. */
  file: string
  /** basename(root) — what the tab title shows once the OSC 7 cwd lands. */
  basename: string
}

/** Run git in the repo. Throws on non-zero exit (execFileSync semantics). */
export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/** Run git in the repo and swallow a non-zero exit (e.g. a conflicted merge). */
export function gitAllow(root: string, ...args: string[]): string {
  try {
    return git(root, ...args)
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

export interface CreateRepoOptions {
  /** The tracked file's name; default 'notes.md'. */
  file?: string
  /** The tracked file's initial content; default 'hello\n'. */
  initialContent?: string
  /** The initial commit's subject; default 'initial'. */
  initialSubject?: string
}

/** A temp repo on branch `main` with one tracked, committed file. */
export function createRepo(opts: CreateRepoOptions = {}): GitRepo {
  const base = process.env.NOCX_E2E_HOME_DIR ?? tmpdir()
  const root = mkdtempSync(join(base, 'nocx-git-e2e-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'e2e@nocx.local')
  git(root, 'config', 'user.name', 'nocx e2e')
  const file = opts.file ?? 'notes.md'
  writeFileSync(join(root, file), opts.initialContent ?? 'hello\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', opts.initialSubject ?? 'initial')
  return { root, file, basename: root.split('/').pop() as string }
}

/** A temp repo with NO commits and one staged file — the unborn branch the
 *  unstage-all test starts from (design D19: bare `git reset` is what works
 *  there, and this fixture is the case that dictated it). */
export function createUnbornRepo(file = 'new.txt'): GitRepo {
  const base = process.env.NOCX_E2E_HOME_DIR ?? tmpdir()
  const root = mkdtempSync(join(base, 'nocx-git-e2e-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'e2e@nocx.local')
  git(root, 'config', 'user.name', 'nocx e2e')
  writeFileSync(join(root, file), 'new file\n')
  git(root, 'add', '.')
  return { root, file, basename: root.split('/').pop() as string }
}

export function cleanupRepo(repo: GitRepo): void {
  rmSync(repo.root, { recursive: true, force: true })
}
