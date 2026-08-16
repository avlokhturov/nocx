import { describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../generated/git.status'
import {
  createSessionFactsProvider,
  type SessionFacts,
  type SessionFactsProvider,
  type SnippetGitStatus,
  type SnippetPaneSource,
} from './session-facts'

/** A status reply for one branch — the only field the provider reads. */
function statusOk(branch: string, detached = false): GitStatusResult {
  return {
    status: {
      branch,
      detached,
      unborn: false,
      head: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      conflicted: [],
      total: 0,
      completeness: 'complete',
    },
    envState: 'resolved',
  }
}

// A plain local shell at a trusted prompt: the composition root has already
// resolved the pane's facts — cwd from the verified OSC 7 report, host and
// user from the session's identity — and the session holds a git binding.
const LOCAL_TRUSTED: SnippetPaneSource = {
  paneFacts: () => ({
    cwd: '/home/dev/repos/nocx',
    host: 'vm-agents',
    user: 'dev',
    gitBindingId: 'b1',
  }),
}

describe('session facts provider', () => {
  // The paired success: every key in design §7.4 resolves.
  it('resolves every key on a plain local shell at a trusted prompt', async () => {
    const git: SnippetGitStatus = { status: vi.fn(() => Promise.resolve(statusOk('main'))) }
    const provider: SessionFactsProvider = createSessionFactsProvider(LOCAL_TRUSTED, git)
    await expect(provider.facts()).resolves.toEqual({
      cwd: '/home/dev/repos/nocx',
      host: 'vm-agents',
      user: 'dev',
      branch: 'main',
    } satisfies SessionFacts)
  })

  // Every external call has a failing test (AGENTS.md rule 3): the wire call.
  it('answers null for branch when git.status rejects, and the others still resolve', async () => {
    const git: SnippetGitStatus = {
      status: vi.fn(() => Promise.reject(new Error('binding gone'))),
    }
    const provider = createSessionFactsProvider(LOCAL_TRUSTED, git)
    await expect(provider.facts()).resolves.toEqual({
      cwd: '/home/dev/repos/nocx',
      host: 'vm-agents',
      user: 'dev',
      branch: null,
    } satisfies SessionFacts)
  })

  // The pane has no session: no binding id exists, so the branch cannot be
  // asked for — and the provider must not invent an id to ask with.
  it('answers null for branch when the pane has no session, and the others still resolve', async () => {
    const pane: SnippetPaneSource = {
      paneFacts: () => ({ cwd: '/tmp', host: 'vm-agents', user: 'dev', gitBindingId: null }),
    }
    const status = vi.fn(() => Promise.resolve(statusOk('main')))
    const provider = createSessionFactsProvider(pane, { status })
    await expect(provider.facts()).resolves.toEqual({
      cwd: '/tmp',
      host: 'vm-agents',
      user: 'dev',
      branch: null,
    } satisfies SessionFacts)
    expect(status).not.toHaveBeenCalled()
  })

  // No active pane: there is nothing to read at all, and no wire call may be
  // made for a pane that does not exist.
  it('answers all null when no pane is active', async () => {
    const pane: SnippetPaneSource = { paneFacts: () => null }
    const status = vi.fn(() => Promise.resolve(statusOk('main')))
    const provider = createSessionFactsProvider(pane, { status })
    await expect(provider.facts()).resolves.toEqual({
      cwd: null,
      host: null,
      user: null,
      branch: null,
    } satisfies SessionFacts)
    expect(status).not.toHaveBeenCalled()
  })

  // A detached HEAD has no branch name — git.status reports it as '' with
  // detached true — which is as unanswerable as a null fact.
  it('answers null for branch on a detached HEAD', async () => {
    const git: SnippetGitStatus = { status: vi.fn(() => Promise.resolve(statusOk('', true))) }
    const provider = createSessionFactsProvider(LOCAL_TRUSTED, git)
    await expect(provider.facts()).resolves.toEqual({
      cwd: '/home/dev/repos/nocx',
      host: 'vm-agents',
      user: 'dev',
      branch: null,
    } satisfies SessionFacts)
  })

  // The domain environment marks unknown as '' (a local shell has no host
  // and no user, a fresh domain has no cwd). The provider is the last
  // boundary before a substitution, so that marker becomes null here —
  // `cd {{env:cwd}}` must never become `cd`.
  it("maps the view's empty-string marker to null, never substituting it", async () => {
    const pane: SnippetPaneSource = {
      paneFacts: () => ({ cwd: '', host: '', user: '', gitBindingId: 'b1' }),
    }
    const provider = createSessionFactsProvider(pane, {
      status: vi.fn(() => Promise.resolve(statusOk('main'))),
    })
    await expect(provider.facts()).resolves.toEqual({
      cwd: null,
      host: null,
      user: null,
      branch: 'main',
    } satisfies SessionFacts)
  })
})
