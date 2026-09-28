// node --test .githooks/backlog-gate/commit-links.test.mjs
//
// What a push introduces, as CI sees it after the push: a scratch remote, a
// clone that pushed to it and fetched back, and commit-links.mjs run there.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'commit-links.mjs')
const TASK = {
  id: 'nocx-t1',
  title: 'a leaf',
  status: 'open',
  issue_type: 'task',
  priority: 1,
  created_at: '2026-09-28T00:00:00Z',
  updated_at: '2026-09-28T00:00:00Z',
}

let root, work
const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim()
const commit = (subject) => {
  writeFileSync(join(work, 'f'), `${subject}\n`)
  git('add', '-A')
  git('commit', '-q', '-m', subject)
  return git('rev-parse', 'HEAD')
}
const links = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, encoding: 'utf8' })

before(() => {
  root = mkdtempSync(join(tmpdir(), 'commit-links-'))
  work = join(root, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'remote.git')])
  execFileSync('git', ['clone', '-q', join(root, 'remote.git'), work])
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(work, '.beads'))
  writeFileSync(join(work, '.beads/issues.jsonl'), `${JSON.stringify(TASK)}\n`)
  commit('chore: the first commit (nocx-t1)')
  git('push', '-q', 'origin', 'HEAD:main')
})

after(() => rmSync(root, { recursive: true, force: true }))

test('a tag on a commit the remote already holds introduces nothing, and passes', () => {
  git('tag', 'v1')
  git('push', '-q', 'origin', 'v1')
  const run = links('--introduced', git('rev-parse', 'v1'), '--by', 'refs/tags/v1')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /refs\/tags\/v1 introduces no commits: nothing to check/)
})

test('a new branch on a commit the remote already holds introduces nothing, and passes', () => {
  git('push', '-q', 'origin', 'HEAD:refs/heads/release/a')
  git('fetch', '-q', 'origin')
  const run = links('--introduced', git('rev-parse', 'HEAD'), '--by', 'refs/heads/release/a')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /introduces no commits: nothing to check/)
})

test('a new branch carrying a linked commit is checked and passes', () => {
  git('checkout', '-q', '-b', 'release/b')
  const tip = commit('fix: a linked change (nocx-t1)')
  git('push', '-q', 'origin', 'release/b')
  git('fetch', '-q', 'origin')
  const run = links('--introduced', tip, '--by', 'refs/heads/release/b')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /1 commit\(s\) checked, 0 link problem/)
})

test('a new commit with no task link is refused, past the branch\'s own "before"', () => {
  const old = git('rev-parse', 'HEAD')
  const tip = commit('fix: a change that names nothing')
  git('push', '-q', 'origin', 'release/b')
  git('fetch', '-q', 'origin')
  const run = links('--introduced', tip, '--by', 'refs/heads/release/b', '--before', old)
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout, /1 commit\(s\) checked, 1 link problem/)
})

test('a tag on a new unlinked commit is refused', () => {
  git('checkout', '-q', '--detach')
  const tip = commit('chore: an unlinked release commit')
  git('tag', 'v2')
  git('push', '-q', 'origin', 'v2')
  const run = links('--introduced', tip, '--by', 'refs/tags/v2')
  assert.equal(run.status, 1, run.stdout + run.stderr)
})

test('a tip git cannot read, or a push with no ref, is misuse, never a pass', () => {
  assert.equal(links('--introduced', 'deadbeef', '--by', 'refs/tags/x').status, 2)
  assert.equal(links('--introduced', git('rev-parse', 'HEAD')).status, 2)
  assert.equal(links('--before', git('rev-parse', 'HEAD'), '--range', 'a..b').status, 2)
})
