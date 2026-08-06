// @vitest-environment jsdom
// Files is a SIDEBAR VIEW — the deliverable is the activity-bar icon, not a
// palette item and not a tab. AGENTS.md rule 1: a user opens the view from
// the activity bar — the FIRST icon — and sees the files of the tab they are
// looking at; expanding a directory lists a page; "show next" reveals the
// rest; clicking a file reaches the opener; switching tabs mid-flight never
// paints one machine's listing into another's tree; a symlink cycle renders
// cyclic; tooLarge and timedOut each render their own state.
//
// These start from a real TabManager and the real mountSidebar — the panel
// never mounts in a vacuum. The ACTIVE ORIGIN values come from a fixture map
// keyed by tab: the TabContent capability that terminal content will answer
// (design §5.4) is the one wire this wave cannot exercise, so the tests fake
// its VALUES while the whole mechanism around them — tab switch, signal,
// re-scope, staleness guard — is real.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { cleanup } from '@solidjs/testing-library'
import { FILES_VIEW_ID, FILES_VIEW_ORDER, createFilesView } from './files-view'
import { mountSidebar, type SidebarHandle, type SidebarViewDescriptor } from '../sidebar'
import { PlugIcon } from '../ui/icons'
import { createRendererMock, makeClient, mountTabManager } from '../test-support/tabs-fixtures'
import type { FilesListEntry, FilesListResult } from '../generated/files.list'
import type { FilesOpenResult } from '../generated/files.open'
import type { FilesReadResult } from '../generated/files.read'
import type { FilesPanelServices } from './files-client'
import type { ActiveOrigin, TabContent } from '../tab-content'

vi.mock('../renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────

const openFixture = (over: Partial<FilesOpenResult> = {}): FilesOpenResult => ({
  bindingId: 'b1',
  endpointId: null,
  root: { path: '/home/dev', display: '~/dev', inferred: false, inferredReason: '' },
  ...over,
})

const entryFixture = (over: Partial<FilesListEntry>): FilesListEntry => ({
  name: 'file',
  path: '/home/dev/file',
  kind: 'regular',
  size: 0,
  modTime: '2026-08-06T00:00:00Z',
  mode: 0o644,
  ...over,
})

const listFixture = (
  canonical: string,
  entries: FilesListEntry[],
  over: Partial<FilesListResult & { state: 'ok' }> = {},
): FilesListResult => ({
  state: 'ok',
  path: '/home/dev',
  canonical,
  entries,
  offset: 0,
  total: entries.length,
  hasMore: false,
  rev: 'r1',
  ...over,
})

const readFixture = (over: Partial<FilesReadResult> = {}): FilesReadResult => ({
  path: '/home/dev/notes.md',
  canonical: 'C:/home/dev/notes.md',
  text: 'hello',
  size: 5,
  modTime: '2026-08-06T00:00:00Z',
  truncated: false,
  binary: false,
  lossy: false,
  changed: false,
  ...over,
})

function fakeServices(over: Partial<FilesPanelServices> = {}): FilesPanelServices {
  return {
    open: vi.fn().mockResolvedValue(openFixture()),
    list: vi.fn().mockResolvedValue(listFixture('C:/home/dev', [])),
    read: vi.fn().mockResolvedValue(readFixture()),
    close: vi.fn().mockResolvedValue({}),
    ...over,
  }
}

// Fixture origins stand in for the TabContent capability (design §5.4) —
// the one wire this wave cannot exercise, because terminal content's
// implementation is the coordinator's to assign. The tabId values are
// fixtures too: the guard only needs them to differ between tabs.
const LOCAL_ORIGIN: ActiveOrigin = {
  tabId: 1,
  sessionId: 's-local',
  kind: 'local',
  cwd: '~/dev',
  cwdVerified: true,
  host: null,
}

const SSH_ORIGIN: ActiveOrigin = {
  tabId: 2,
  sessionId: 's-ssh',
  kind: 'ssh',
  cwd: '/home/alice',
  cwdVerified: false,
  host: 'srv-01',
}

const liveHandles: SidebarHandle[] = []

/** Full composition: a real TabManager, an origin signal fed on tab change
 *  (exactly the wiring main.tsx must provide for the Files view), and the
 *  real sidebar mounting Files FIRST (views sorted by order — the
 *  arrangement the coordinator's registration must produce). */
async function mountApp(services: FilesPanelServices) {
  const client = makeClient()
  const { manager } = await mountTabManager(client)

  // Keyed by CONTENT, not tab: TabManager keeps its active tab private, and
  // the seam's polymorphism means the map must not care which content class
  // is in front. newSSHTab returns its Tab, whose content is public.
  const originFor = new Map<TabContent, ActiveOrigin>()
  const initial = manager.activeTerminalContent()
  if (!initial) throw new Error('no initial tab')
  originFor.set(initial, LOCAL_ORIGIN)

  const [activeOrigin, setActiveOrigin] = createSignal<ActiveOrigin | null>(null)
  manager.onActiveTabChange = () =>
    setActiveOrigin(originFor.get(manager.activeTerminalContent()!) ?? null)
  setActiveOrigin(originFor.get(manager.activeTerminalContent()!) ?? null)

  // The opener's mock is kept as a bare reference (not `opener.open`): the
  // assertions call it detached from the object, and unbound-method exists
  // to catch exactly that detachment — the mock is the object's own.
  const open = vi.fn()
  const files = createFilesView({ services, opener: { open }, activeOrigin })
  // Ports stands in at order 0 (main.tsx registers it there); the views
  // reach mountSidebar in order-sorted arrangement, which is what makes
  // Files the FIRST activity-bar icon (SidebarSolid renders array order).
  const ports: SidebarViewDescriptor = {
    id: 'ports',
    title: 'Ports',
    icon: PlugIcon,
    view: () => null,
    order: 0,
  }
  const views = [files, ports].sort((a, b) => a.order - b.order)

  const bar = document.createElement('div')
  bar.id = 'activitybar'
  const panel = document.createElement('div')
  panel.id = 'sidebar'
  document.body.append(bar, panel)
  /* eslint-disable solid/reactivity -- mountSidebar consumes this accessor
     reactively (SidebarViewProps.activeOrigin, fed to the Files view the
     same way main.tsx feeds portsTargetId); the reads happen inside the
     view's tracked scopes, and the gate cannot see across the function
     boundary. Same justification as the existing main.tsx disable. */
  const handle = mountSidebar(
    bar,
    panel,
    views,
    [],
    undefined,
    () => null,
    () => activeOrigin(),
  )
  /* eslint-enable solid/reactivity */
  liveHandles.push(handle)
  return { manager, bar, panel, handle, open, originFor, setActiveOrigin }
}

function filesIcon(bar: HTMLElement): HTMLElement {
  const el = bar.querySelector<HTMLElement>(`button[data-view="${FILES_VIEW_ID}"]`)
  if (!el) throw new Error('no files activity-bar button')
  return el
}

function rowsOf(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('[data-testid="files-row"]')]
}

function rowNamed(panel: HTMLElement, name: string): HTMLElement {
  const row = rowsOf(panel).find((r) => r.textContent?.includes(name))
  if (!row) throw new Error(`no row named ${name}`)
  return row
}

afterEach(() => {
  for (const h of liveHandles) h.destroy()
  liveHandles.length = 0
  cleanup()
  document.body.replaceChildren()
})

describe('files sidebar view', () => {
  it('registers below Ports, so the Files icon is the FIRST view in the activity bar', () => {
    // Ports registers order 0 (main.tsx); below means the top of the view
    // zone — an owner requirement, asserted here, not a consequence of a
    // number somebody picked.
    expect(FILES_VIEW_ORDER).toBeLessThan(0)
  })

  it('from a cold start the Files icon is first, enabled, and opens the panel', async () => {
    const open = vi.fn().mockResolvedValue(openFixture())
    const services = fakeServices({ open })
    const { bar, panel } = await mountApp(services)

    await vi.waitFor(() =>
      expect(panel.querySelector('[data-testid="files-root-path"]')).not.toBeNull(),
    )
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('s-local', '~/dev'))

    // First in the view zone — before Ports.
    const viewButtons = bar.querySelectorAll<HTMLElement>('.activity-bar-top [data-view]')
    expect(viewButtons.length).toBeGreaterThanOrEqual(2)
    expect(viewButtons[0]?.dataset.view).toBe(FILES_VIEW_ID)

    // Enabled from a cold start (nothing gates it on prior state).
    const icon = filesIcon(bar) as HTMLButtonElement
    expect(icon.disabled).toBe(false)

    // Clicking the icon closes and reopens the panel with the tree intact.
    icon.click()
    await vi.waitFor(() => expect(panel.classList.contains('collapsed')).toBe(true))
    icon.click()
    await vi.waitFor(() => expect(panel.classList.contains('collapsed')).toBe(false))
    expect(panel.querySelector('[data-testid="files-root-path"]')).not.toBeNull()
  })

  it('expanding a directory reaches files.list and the returned entries appear as rows', async () => {
    const list = vi
      .fn()
      .mockImplementation((bindingId: string, path: string) =>
        Promise.resolve(
          path === '/home/dev'
            ? listFixture('C:/home/dev', [
                entryFixture({ name: 'docs', path: '/home/dev/docs', kind: 'dir' }),
              ])
            : listFixture('C:/home/dev/docs', [
                entryFixture({ name: 'notes.md', path: '/home/dev/docs/notes.md' }),
              ]),
        ),
      )
    const services = fakeServices({ list })
    const { panel } = await mountApp(services)
    await vi.waitFor(() => expect(rowNamed(panel, 'docs')).not.toBeUndefined())

    const docs = rowNamed(panel, 'docs')
    const disclosure = docs.querySelector<HTMLElement>('.ui-tree-row__disclosure')
    expect(disclosure).not.toBeNull()
    disclosure!.click()

    await vi.waitFor(() =>
      expect(list).toHaveBeenCalledWith('b1', '/home/dev/docs', 0, expect.any(Number)),
    )
    await vi.waitFor(() => expect(rowNamed(panel, 'notes.md')).not.toBeUndefined())
  })

  it('"show next" reveals the rest of a paginated directory', async () => {
    const list = vi.fn().mockImplementation((bindingId: string, path: string, offset: number) =>
      Promise.resolve(
        offset === 0
          ? listFixture('C:/home/dev', [entryFixture({ name: 'f1' })], {
              total: 3,
              hasMore: true,
            })
          : listFixture(
              'C:/home/dev',
              [entryFixture({ name: 'f2' }), entryFixture({ name: 'f3' })],
              {
                offset: 1,
                total: 3,
                hasMore: false,
              },
            ),
      ),
    )
    const services = fakeServices({ list })
    const { panel } = await mountApp(services)
    await vi.waitFor(() => expect(rowNamed(panel, 'f1')).not.toBeUndefined())

    const moreBtn = panel.querySelector<HTMLElement>('[data-testid="files-show-more"]')
    expect(moreBtn).not.toBeNull()
    expect(moreBtn?.textContent).toContain('Show next 2')
    moreBtn!.click()

    await vi.waitFor(() =>
      expect(list).toHaveBeenCalledWith('b1', '/home/dev', 1, expect.any(Number)),
    )
    await vi.waitFor(() => expect(rowNamed(panel, 'f2')).not.toBeUndefined())
    expect(rowNamed(panel, 'f3')).not.toBeUndefined()
    expect(panel.querySelector('[data-testid="files-show-more"]')).toBeNull()
  })

  it('clicking a file row reaches FileOpener.open with the right target', async () => {
    const read = vi.fn().mockResolvedValue(readFixture())
    const services = fakeServices({
      read,
      list: vi
        .fn()
        .mockResolvedValue(
          listFixture('C:/home/dev', [
            entryFixture({ name: 'notes.md', path: '/home/dev/notes.md' }),
            entryFixture({ name: 'docs', path: '/home/dev/docs', kind: 'dir' }),
          ]),
        ),
    })
    const { panel, open } = await mountApp(services)
    await vi.waitFor(() => expect(rowNamed(panel, 'notes.md')).not.toBeUndefined())

    rowNamed(panel, 'notes.md').click()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(read).toHaveBeenCalledWith('b1', '/home/dev/notes.md', 0)
    expect(open).toHaveBeenCalledWith({
      bindingId: 'b1',
      endpointId: null,
      path: '/home/dev/notes.md',
      canonical: 'C:/home/dev/notes.md',
      displayHost: null,
      name: 'notes.md',
      // The click-time scope minus the tabId — the viewer's activeOrigin
      // answer, which keeps the panel on this machine while the viewer tab
      // is in front (design §5.4).
      origin: {
        sessionId: 's-local',
        kind: 'local',
        cwd: '~/dev',
        cwdVerified: true,
        host: null,
      },
    })

    // A directory row opens nothing.
    rowNamed(panel, 'docs').click()
    expect(open).toHaveBeenCalledTimes(1)
  })

  // ── The §0 test, through the real wiring ───────────────────────────────
  it("switching tabs mid-flight does not paint one machine's listing into another's tree", async () => {
    let releaseRootA!: (v: FilesListResult) => void
    const pendingA = new Promise<FilesListResult>((res) => {
      releaseRootA = res
    })
    const list = vi
      .fn()
      .mockResolvedValueOnce(pendingA) // tab A's root listing, still in flight
      .mockResolvedValueOnce(
        listFixture('C:/home/alice', [
          entryFixture({ name: 'b-only.txt', path: '/home/alice/b-only.txt' }),
        ]),
      )
    const services = fakeServices({ list })
    const { manager, panel, originFor } = await mountApp(services)
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    // The user activates an SSH tab while A's listing is unresolved.
    const sshTab = manager.newSSHTab('p1', 'host.example', 'alice')
    originFor.set(sshTab.content, SSH_ORIGIN)
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(rowNamed(panel, 'b-only.txt')).not.toBeUndefined())

    // A's listing finally lands — it must not paint A's machine into B's tree.
    releaseRootA(
      listFixture('C:/home/dev', [
        entryFixture({ name: 'a-only.txt', path: '/home/dev/a-only.txt' }),
      ]),
    )
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(rowsOf(panel).map((r) => r.textContent)).not.toContain('a-only.txt')
    expect(rowNamed(panel, 'b-only.txt')).not.toBeUndefined()
  })

  it('a directory symlink whose canonical matches an expanded ancestor renders cyclic with no children', async () => {
    const list = vi.fn().mockImplementation((bindingId: string, path: string) =>
      Promise.resolve(
        path === '/home/dev'
          ? listFixture('C:/home/dev', [
              entryFixture({
                name: 'loop',
                path: '/home/dev/loop',
                kind: 'symlink',
                linkKind: 'dir',
                linkTarget: '/',
              }),
            ])
          : listFixture('C:/home/dev', [entryFixture({ name: 'leak.md' })]),
      ),
    )
    const services = fakeServices({ list })
    const { panel } = await mountApp(services)
    await vi.waitFor(() => expect(rowNamed(panel, 'loop')).not.toBeUndefined())

    rowNamed(panel, 'loop').querySelector<HTMLElement>('.ui-tree-row__disclosure')!.click()
    await vi.waitFor(() =>
      expect(list).toHaveBeenCalledWith('b1', '/home/dev/loop', 0, expect.any(Number)),
    )

    // Renders cyclic (a leaf — no disclosure), and no children were listed.
    // data-cyclic lives on the kit row (.ui-tree-row), not the surface
    // wrapper, so the assertion queries the attribute directly.
    await vi.waitFor(() => expect(panel.querySelector('[data-cyclic="true"]')).not.toBeNull())
    expect(rowNamed(panel, 'loop').querySelector('.ui-tree-row__disclosure')).toBeNull()
    expect(rowsOf(panel).map((r) => r.textContent)).not.toContain('leak.md')
    expect(list.mock.calls.filter(([, p]) => p === '/home/dev/loop')).toHaveLength(1)
  })

  it('tooLarge and timedOut each render their own state', async () => {
    const list = vi.fn().mockImplementation((bindingId: string, path: string) => {
      if (path === '/home/dev')
        return Promise.resolve(
          listFixture('C:/home/dev', [
            entryFixture({ name: 'big', path: '/home/dev/big', kind: 'dir' }),
            entryFixture({ name: 'slow', path: '/home/dev/slow', kind: 'dir' }),
          ]),
        )
      if (path === '/home/dev/big')
        return Promise.resolve({ state: 'tooLarge' as const, observedCount: 12_345, limit: 1_000 })
      return Promise.resolve({ state: 'timedOut' as const, timeout: 5_000 })
    })
    const services = fakeServices({ list })
    const { panel } = await mountApp(services)
    await vi.waitFor(() => expect(rowNamed(panel, 'big')).not.toBeUndefined())

    rowNamed(panel, 'big').querySelector<HTMLElement>('.ui-tree-row__disclosure')!.click()
    await vi.waitFor(() =>
      expect(panel.querySelector('[data-testid="files-state-too-large"]')).not.toBeNull(),
    )
    const tooLarge = panel.querySelector('[data-testid="files-state-too-large"]')
    expect(tooLarge?.textContent).toContain('More than 1000 entries')
    expect(tooLarge?.textContent).toContain('12345 entries')
    // No pagination offered for a capped directory.
    expect(panel.querySelector('[data-testid="files-show-more"]')).toBeNull()

    rowNamed(panel, 'slow').querySelector<HTMLElement>('.ui-tree-row__disclosure')!.click()
    await vi.waitFor(() =>
      expect(panel.querySelector('[data-testid="files-state-timed-out"]')).not.toBeNull(),
    )
    expect(panel.querySelector('[data-testid="files-state-timed-out"]')?.textContent).toContain(
      'took too long',
    )

    // timedOut retries the same enumeration.
    const retry = panel.querySelector<HTMLElement>('[data-testid="files-retry"]')
    expect(retry).not.toBeNull()
    list.mockImplementation((bindingId: string, path: string) => {
      if (path === '/home/dev')
        return Promise.resolve(
          listFixture('C:/home/dev', [
            entryFixture({ name: 'big', path: '/home/dev/big', kind: 'dir' }),
            entryFixture({ name: 'slow', path: '/home/dev/slow', kind: 'dir' }),
          ]),
        )
      if (path === '/home/dev/big')
        return Promise.resolve({ state: 'tooLarge' as const, observedCount: 12_345, limit: 1_000 })
      return Promise.resolve(
        listFixture('C:/home/dev/slow', [
          entryFixture({ name: 'x.md', path: '/home/dev/slow/x.md' }),
        ]),
      )
    })
    retry!.click()
    await vi.waitFor(() => expect(rowNamed(panel, 'x.md')).not.toBeUndefined())
  })

  it('a tab with no origin shows the no-files state, never a stale tree', async () => {
    const services = fakeServices()
    const { panel, setActiveOrigin } = await mountApp(services)
    await vi.waitFor(() =>
      expect(panel.querySelector('[data-testid="files-root-path"]')).not.toBeNull(),
    )

    setActiveOrigin(null)
    await vi.waitFor(() => expect(panel.textContent).toContain('No files to show'))
    expect(panel.querySelector('[data-testid="files-root-path"]')).toBeNull()
  })

  it('the header refresh re-lists the tree and the polling badge slot waits for the watching wave', async () => {
    const list = vi
      .fn()
      .mockResolvedValue(listFixture('C:/home/dev', [entryFixture({ name: 'a.txt' })]))
    const services = fakeServices({ list })
    const { panel } = await mountApp(services)
    await vi.waitFor(() => expect(rowNamed(panel, 'a.txt')).not.toBeUndefined())

    const refresh = panel.querySelector<HTMLElement>('[data-testid="files-refresh"]')
    expect(refresh?.closest('.ui-sidebar-view__header')).not.toBeNull()
    refresh!.click()
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2))

    // The §5.5 slot is beside Refresh in the header, empty until the
    // watching wave renders the degraded-mode badge into it.
    const slot = panel.querySelector<HTMLElement>('[data-testid="files-polling-badge-slot"]')
    expect(slot?.closest('.ui-sidebar-view__header')).not.toBeNull()
  })
})
