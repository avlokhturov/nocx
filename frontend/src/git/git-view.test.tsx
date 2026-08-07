// @vitest-environment jsdom
// The Git view, through the REAL mountSidebar — the deliverable is an
// activity-bar view (rule 1: a user opens it from the rail and does the
// things below). The origin values are fixtures (the TabContent capability
// is another worker's), while the whole mechanism around them — the signal,
// re-scope, staleness guards — is real.
//
// Named here, by the acceptance criteria: race 4 (a diff for a row clicked
// before the panel re-bound targets the click-time binding, with the frozen
// origin), the commit path (button exists, enabled from the state a user
// starts in, reaches the client), the row action owning its click, and the
// D14 absence (mutation controls ABSENT from an SSH tab's DOM, not disabled).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { cleanup, fireEvent } from '@solidjs/testing-library'
import { mountSidebar } from '../sidebar'
import { createGitView } from './git-view'
import { createGitStore, type GitStore } from './git-store'
import type { GitPanelServices } from './git-client'
import type { GitDiffTarget } from './git-diff/open-git-diff'
import type { Status } from '../generated/git.status'
import type { GitOpenResult } from '../generated/git.open'
import type { GitLogResult } from '../generated/git.log'
import type { ActiveOrigin } from '../tab-content'

// ── Fixtures ──────────────────────────────────────────────────────────────

const LOCAL_ORIGIN: ActiveOrigin = {
  tabId: 1,
  sessionId: 's1',
  kind: 'local',
  cwd: '/home/dev/repo',
  cwdVerified: true,
  cwdFollow: true,
  host: null,
}

const OTHER_ORIGIN: ActiveOrigin = {
  tabId: 2,
  sessionId: 's2',
  kind: 'local',
  cwd: '/home/dev/other',
  cwdVerified: true,
  cwdFollow: true,
  host: null,
}

const SSH_ORIGIN: ActiveOrigin = {
  tabId: 3,
  sessionId: 's3',
  kind: 'ssh',
  cwd: '/home/bob',
  cwdVerified: true,
  cwdFollow: true,
  host: 'srv',
}

const statusFixture = (over: Partial<Status> = {}): Status => ({
  branch: 'main',
  detached: false,
  unborn: false,
  head: 'abc1234',
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  staged: [],
  unstaged: [],
  conflicted: [],
  total: 0,
  completeness: 'complete',
  ...over,
})

const openOk = (over: Partial<GitOpenResult & { state: 'ok' }> = {}): GitOpenResult => ({
  state: 'ok',
  bindingId: 'b1',
  toplevel: '/home/dev/repo',
  envState: 'resolved',
  status: statusFixture(),
  ...over,
})

const logFixture = (over: Partial<GitLogResult['log']> = {}): GitLogResult['log'] => ({
  entries: [
    {
      hash: '5738d62b66777a78af894c0708d3a7e8798a4d8d',
      shortHash: '5738d62',
      subject: 'third',
      authorName: 'Test Author',
      authoredAt: '2020-01-01T00:00:00Z',
      refs: ['main'],
    },
    {
      hash: '98c56f29de7a461cbbb7bc3a208a292972265b76',
      shortHash: '98c56f2',
      subject: 'second subject',
      authorName: 'Test Author',
      authoredAt: '2020-01-02T00:00:00Z',
      refs: ['HEAD', 'v1.0'],
    },
  ],
  total: 2,
  completeness: 'complete',
  ...over,
})
function fakeServices(over: Partial<GitPanelServices> = {}): GitPanelServices {
  return {
    open: vi.fn().mockResolvedValue(openOk()),
    status: vi.fn().mockResolvedValue({ status: statusFixture() }),
    diff: vi.fn().mockResolvedValue({ state: 'ok', text: '', truncated: false }),
    log: vi.fn().mockResolvedValue({ log: logFixture() }),
    stage: vi.fn().mockResolvedValue({ status: statusFixture() }),
    unstage: vi.fn().mockResolvedValue({ status: statusFixture() }),
    stageAll: vi.fn().mockResolvedValue({ status: statusFixture() }),
    unstageAll: vi.fn().mockResolvedValue({ status: statusFixture() }),
    commit: vi.fn().mockResolvedValue({ state: 'ok', outputTruncated: false }),
    headMessage: vi.fn().mockResolvedValue({ state: 'ok', message: 'head' }),
    close: vi.fn().mockResolvedValue({ closed: true }),
    subscribeGitChanged: vi.fn().mockReturnValue(() => {}),
    ...over,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

interface Mounted {
  panel: HTMLElement
  open: ReturnType<typeof vi.fn>
  setActiveOrigin: (o: ActiveOrigin | null) => void
  services: GitPanelServices
  store: GitStore
}

const stores: GitStore[] = []

function mountApp(services: GitPanelServices): Mounted {
  const [activeOrigin, setActiveOrigin] = createSignal<ActiveOrigin | null>(null)
  const open = vi.fn()
  const store = createGitStore(services)
  stores.push(store)
  const git = createGitView({ services, store, opener: { open }, activeOrigin })
  const bar = document.createElement('div')
  bar.id = 'activitybar'
  const panel = document.createElement('div')
  panel.id = 'sidebar'
  document.body.append(bar, panel)
  /* eslint-disable solid/reactivity -- mountSidebar consumes this accessor
     reactively (SidebarViewProps.activeOrigin); the reads happen inside the
     view's tracked scopes, the same shape as main.tsx's own disable. */
  mountSidebar(
    bar,
    panel,
    [git],
    [],
    undefined,
    () => null,
    () => activeOrigin(),
  )
  /* eslint-enable solid/reactivity */
  return { panel, open, setActiveOrigin, services, store }
}

afterEach(() => {
  for (const s of stores) s.dispose()
  stores.length = 0
  cleanup()
})

/** The listitem whose text contains `path` — the row a user clicks. */
function rowNamed(panel: HTMLElement, path: string): HTMLElement {
  const rows = panel.querySelectorAll<HTMLElement>('[role="listitem"]')
  for (const row of rows) {
    if (row.textContent?.includes(path)) return row
  }
  throw new Error(`no row for ${path}`)
}

const unstagedFile = statusFixture({
  unstaged: [{ path: 'a.txt', x: '.', y: 'M' }],
  total: 1,
})

const stagedFile = statusFixture({
  staged: [{ path: 'a.txt', x: 'A', y: '.' }],
  total: 1,
})

// ── The states a user can land in ────────────────────────────────────────

describe('the panel renders what the store says', () => {
  it('noTab: no origin — the empty state', () => {
    const { panel } = mountApp(fakeServices())
    expect(panel.textContent).toContain('No repository to show')
  })

  it('remote: the mutation controls are ABSENT from the DOM, not disabled (D14)', async () => {
    const { panel, setActiveOrigin } = mountApp(fakeServices())
    setActiveOrigin(SSH_ORIGIN)
    await settle()
    expect(panel.textContent).toContain("Git on a remote host isn't supported yet")
    expect(panel.querySelector('[data-testid="git-stage-all"]')).toBeNull()
    expect(panel.querySelector('[data-testid="git-unstage-all"]')).toBeNull()
    expect(panel.querySelector('[data-testid="git-commit"]')).toBeNull()
  })

  it('ready: the lists and the header render from the wire status', async () => {
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: unstagedFile })),
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    expect(panel.querySelector('[data-testid="git-branch"]')?.textContent).toContain('main')
    expect(panel.querySelector('[data-testid="git-unstaged-list"]')?.textContent).toContain('a.txt')
  })

  it('tooManyChanges: the D9 cap banner says which answer it is, over the retained lists', async () => {
    const capped = statusFixture({
      completeness: 'capped',
      total: 6000,
      unstaged: [{ path: 'a.txt', x: '.', y: 'M' }],
    })
    const services = fakeServices({ open: vi.fn().mockResolvedValue(openOk({ status: capped })) })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    const banner = panel.querySelector('[data-testid="git-too-many-changes"]')
    expect(banner?.textContent).toContain('6000 changes, showing the first 1')
    // The retained row still renders under the banner.
    expect(panel.querySelector('[data-testid="git-unstaged-list"]')?.textContent).toContain('a.txt')
  })

  it('conflicted: stage-all and unstage-all are refused, visibly and with the reason (D19)', async () => {
    const conflicted = statusFixture({
      conflicted: [{ path: 'conf.txt', x: 'U', y: 'U' }],
      total: 1,
    })
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: conflicted })),
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    expect(panel.querySelector('[data-testid="git-stage-all"]')?.hasAttribute('disabled')).toBe(
      true,
    )
    expect(panel.querySelector('[data-testid="git-unstage-all"]')?.hasAttribute('disabled')).toBe(
      true,
    )
    expect(panel.querySelector('[data-testid="git-conflict-refusal"]')?.textContent).toContain(
      'Unresolved merge conflicts',
    )
    // The conflicted file shows with its status letter and no actions.
    expect(panel.querySelector('[data-testid="git-conflicted-list"]')?.textContent).toContain(
      'conf.txt',
    )
  })

  it('a conflict that DEVELOPS while the panel is open refuses too, and clearing it releases', async () => {
    // The defect an e2e caught and this suite did not. Every conflict test
    // above opens ONTO an already-conflicted repository, so a predicate that
    // read the status untracked agreed with all of them while never
    // re-evaluating. A merge happens in the terminal beside the panel, which
    // makes "the conflict arrives later" the ordinary case — and it left the
    // two destructive controls enabled with no reason shown.
    //
    // It has to be asserted HERE and not in the store: called directly, the
    // predicate returns the right answer either way. What broke was the
    // SUBSCRIPTION, and only a render can see that.
    const clean = statusFixture({ total: 0 })
    const conflicted = statusFixture({
      conflicted: [{ path: 'conf.txt', x: 'U', y: 'U' }],
      total: 1,
    })
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: clean })),
      status: vi
        .fn()
        .mockResolvedValueOnce({ status: conflicted })
        .mockResolvedValue({ status: clean }),
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    expect(panel.querySelector('[data-testid="git-stage-all"]')?.hasAttribute('disabled')).toBe(
      false,
    )
    expect(panel.querySelector('[data-testid="git-conflict-refusal"]')).toBeNull()

    panel.querySelector<HTMLElement>('[data-testid="git-refresh"]')?.click()
    await settle()
    expect(panel.querySelector('[data-testid="git-stage-all"]')?.hasAttribute('disabled')).toBe(
      true,
    )
    expect(panel.querySelector('[data-testid="git-unstage-all"]')?.hasAttribute('disabled')).toBe(
      true,
    )
    expect(panel.querySelector('[data-testid="git-conflict-refusal"]')?.textContent).toContain(
      'Unresolved merge conflicts',
    )

    panel.querySelector<HTMLElement>('[data-testid="git-refresh"]')?.click()
    await settle()
    expect(panel.querySelector('[data-testid="git-conflict-refusal"]')).toBeNull()
    expect(panel.querySelector('[data-testid="git-stage-all"]')?.hasAttribute('disabled')).toBe(
      false,
    )
  })
})

// ── Race 4: a diff for a row clicked before the panel re-bound ───────────

describe('race 4 — the diff target captures the click-time binding', () => {
  it("a row clicked before the panel re-bound opens the diff under the ROW's binding, with the frozen origin", async () => {
    const services = fakeServices({
      open: vi
        .fn()
        .mockResolvedValueOnce(openOk({ status: unstagedFile })) // tab A
        .mockResolvedValueOnce(openOk({ bindingId: 'b2', toplevel: '/home/dev/other' })), // tab B
    })
    const { panel, open, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()

    // The user clicks the row — the handler captures the binding as it is
    // at the click: b1, before any re-bind.
    fireEvent.click(rowNamed(panel, 'a.txt'))
    expect(open).toHaveBeenCalledTimes(1)
    const target = open.mock.calls[0][0] as GitDiffTarget
    expect(target.bindingId).toBe('b1')
    expect(target.toplevel).toBe('/home/dev/repo')
    expect(target.path).toBe('a.txt')
    expect(target.side).toBe('unstaged')
    // The frozen origin: the diff tab answers activeOrigin() as the same
    // machine, with NO opinion about where the shell is now — the panel
    // keeps the binding the tab reads through.
    expect(target.origin).toEqual({
      sessionId: 's1',
      kind: 'local',
      cwd: '/home/dev/repo',
      cwdVerified: true,
      host: null,
      cwdFollow: false,
    })

    // The panel then re-binds to tab B. The diff already issued under b1 —
    // the click-time binding, never the re-bound one.
    setActiveOrigin(OTHER_ORIGIN)
    await settle()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('an untracked row opens the untracked side (diff against /dev/null)', async () => {
    const untracked = statusFixture({
      unstaged: [{ path: 'new.txt', x: '?', y: '?' }],
      total: 1,
    })
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: untracked })),
    })
    const { panel, open, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    fireEvent.click(rowNamed(panel, 'new.txt'))
    const target = open.mock.calls[0][0] as GitDiffTarget
    expect(target.side).toBe('untracked')
  })
})

// ── The commit path — what a user can do (rule 1) ────────────────────────

describe('the commit path', () => {
  it('the Commit button exists, is disabled from the state a user starts in, and is enabled after staging a file and typing a subject — and reaches the client', async () => {
    const stage = vi.fn().mockResolvedValue({ status: stagedFile })
    const commit = vi.fn().mockResolvedValue({ state: 'ok', outputTruncated: false })
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: unstagedFile })),
      stage,
      commit,
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()

    const commitButton = () => panel.querySelector<HTMLButtonElement>('[data-testid="git-commit"]')
    // The state a user starts in: nothing staged, empty subject — disabled.
    expect(commitButton()?.disabled).toBe(true)

    // Stage the file from the row's own control.
    fireEvent.click(panel.querySelector('[data-testid="git-row-stage"]') as HTMLElement)
    await settle()
    expect(stage).toHaveBeenCalledWith('b1', ['a.txt'])

    // Still disabled: a staged file with an empty subject is not a commit.
    expect(commitButton()?.disabled).toBe(true)

    // Type a subject.
    const subject = panel.querySelector('#git-commit-subject') as HTMLInputElement
    fireEvent.input(subject, { target: { value: 'my subject' } })
    await settle()
    expect(commitButton()?.disabled).toBe(false)

    // Commit reaches the client.
    fireEvent.click(commitButton() as HTMLButtonElement)
    await settle()
    expect(commit).toHaveBeenCalledWith('b1', 'my subject', false)
  })

  it('a failed commit shows git output with the truncation mark and keeps the typed message (D11)', async () => {
    const commit = vi.fn().mockResolvedValue({
      state: 'failed',
      output: 'error: pre-commit hook failed\n  lint\n',
      outputTruncated: true,
    })
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: stagedFile })),
      commit,
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()

    const subject = panel.querySelector('#git-commit-subject') as HTMLInputElement
    fireEvent.input(subject, { target: { value: 'keep me' } })
    fireEvent.click(panel.querySelector('[data-testid="git-commit"]') as HTMLButtonElement)
    await settle()
    expect(panel.querySelector('[data-testid="git-commit-output"]')?.textContent).toContain(
      'pre-commit hook failed',
    )
    expect(panel.querySelector('[data-testid="git-commit-output-truncated"]')).not.toBeNull()
    // The message stays in the form.
    expect((panel.querySelector('#git-commit-subject') as HTMLInputElement).value).toBe('keep me')
  })
})

// ── The row action owns its click ────────────────────────────────────────

describe('row actions', () => {
  it('the stage control reaches the store and never opens the diff — the kit guarantee, proven anyway', async () => {
    const stage = vi.fn().mockResolvedValue({ status: stagedFile })
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: unstagedFile })),
      stage,
    })
    const { panel, open, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()

    fireEvent.click(panel.querySelector('[data-testid="git-row-stage"]') as HTMLElement)
    await settle()
    expect(stage).toHaveBeenCalledWith('b1', ['a.txt'])
    expect(open).not.toHaveBeenCalled()
    // The row moved to Staged.
    expect(panel.querySelector('[data-testid="git-staged-list"]')?.textContent).toContain('a.txt')
  })

  it("a typechange (T) row renders as the kit's modification letter", async () => {
    const typed = statusFixture({
      unstaged: [{ path: 'bin', x: '.', y: 'T' }],
      total: 1,
    })
    const services = fakeServices({ open: vi.fn().mockResolvedValue(openOk({ status: typed })) })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    // The row's status glyph is the kit's M — never an empty tone.
    const row = rowNamed(panel, 'bin')
    expect(row.querySelector('.ui-file-status-row__status')?.textContent).toBe('M')
  })

  it('the diff opens for a staged row with the staged side', async () => {
    const services = fakeServices({
      open: vi.fn().mockResolvedValue(openOk({ status: stagedFile })),
    })
    const { panel, open, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    fireEvent.click(rowNamed(panel, 'a.txt'))
    const target = open.mock.calls[0][0] as GitDiffTarget
    expect(target.side).toBe('staged')
  })
})

// ── The Commits section (brief, git.log) ──────────────────────────────────

describe('the Commits section', () => {
  it('lists the branch commits newest first, with subject, hash, relative time and refs', async () => {
    const { panel, setActiveOrigin } = mountApp(fakeServices())
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()

    const log = panel.querySelector('[data-testid="git-log"]')
    expect(log).not.toBeNull()
    const rows = panel.querySelectorAll('[data-testid="git-log-row"]')
    // Newest first: the fixture's stream order is the render order.
    expect(rows[0]?.textContent).toContain('third')
    expect(rows[0]?.textContent).toContain('5738d62')
    expect(rows[1]?.textContent).toContain('second subject')
    // The refs are the kit's chips; a bare HEAD is the detached marker.
    const refs = panel.querySelectorAll('[data-testid="git-log-ref"]')
    expect(refs[0]?.textContent).toContain('main')
    expect(refs[1]?.textContent).toContain('HEAD')
    expect(refs[2]?.textContent).toContain('v1.0')
  })

  it('an unborn branch renders "No commits yet" — the empty list is a state, not a failure', async () => {
    const services = fakeServices({
      log: vi.fn().mockResolvedValue({ log: logFixture({ entries: [], total: 0 }) }),
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    expect(panel.querySelector('[data-testid="git-log-empty"]')?.textContent).toContain(
      'No commits yet',
    )
  })

  it('a capped log says so — the bounded read must not look complete (D9)', async () => {
    const services = fakeServices({
      log: vi.fn().mockResolvedValue({
        log: logFixture({ entries: logFixture().entries, total: 51, completeness: 'capped' }),
      }),
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    expect(panel.querySelector('[data-testid="git-log-capped"]')?.textContent).toContain(
      'More than 2 commits',
    )
  })

  it('a failed read renders the failure with Retry, and the rest of the panel stays live', async () => {
    const services = fakeServices({
      log: vi.fn().mockRejectedValue(new Error('git log: exit 128: fatal: bad object HEAD')),
    })
    const { panel, setActiveOrigin } = mountApp(services)
    setActiveOrigin(LOCAL_ORIGIN)
    await settle()
    expect(panel.querySelector('[data-testid="git-log-failed"]')?.textContent).toContain(
      'bad object HEAD',
    )
    expect(panel.querySelector('[data-testid="git-log-retry"]')).not.toBeNull()
    // The status half is untouched by a failed commits read.
    expect(panel.querySelector('[data-testid="git-branch"]')?.textContent).toContain('main')
  })
})
