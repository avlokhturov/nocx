// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createRendererMock,
  resetSessionCounter,
  mountPaneManager,
  makeLayoutBackend,
  makeLayoutStore,
} from './test-support/panes-fixtures'
import { BasePaneContent, type ContentDescriptor, type ContentViewport } from './pane-content'

// The terminal renderer is mocked exactly as panes.test.ts mocks it: these
// tests are about the strip and the chain, and a real xterm in jsdom is
// neither available nor the subject.
vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

// THE RENDERER ASKS INSTEAD OF OWNING (nocx-isoph.4, design §4.1 and §4.5).
//
// panes.test.ts covers the chrome — a pane opens, a session starts, a tab
// closes. This file covers the line the bead is about: order, membership and
// decoration come from the backend, and the renderer renders what it is told.
// Each test therefore drives the REAL PaneManager against the in-memory chain
// and asserts what the STRIP shows, not what a method returned.

const showConfirmMock = vi.fn()
const showPromptMock = vi.fn()
// The toast host lives in App.tsx, which these tests do not mount, so the
// outcome is asserted where it is raised. A degrade that is only in a log is
// the defect AGENTS.md names; this is how the test says it is not.
const showToastMock = vi.fn()
vi.mock('./ui/toast', () => ({
  showToast: (...args: unknown[]) => {
    showToastMock(...args)
  },
}))

vi.mock('./ui/dialog', () => ({
  showConfirm: (...args: unknown[]) => showConfirmMock(...args) as Promise<boolean>,
  showPrompt: (...args: unknown[]) => showPromptMock(...args) as Promise<string | null>,
}))

/** The rows of a chain that already holds two decorated tabs — what a
 *  backend that has been running while a renderer was reloaded holds. */
async function seededBackend({ decorate = true } = {}): Promise<
  ReturnType<typeof makeLayoutBackend>
> {
  const backend = makeLayoutBackend()
  await backend.createTab({
    id: 'tab-a',
    workspaceId: 'workspace:default',
    position: 0,
    firstPane: { id: 'pane-a', cwd: '/repos/nocx', kind: 'local', endpoint: null, sizeShare: 1 },
  })
  await backend.createTab({
    id: 'tab-b',
    workspaceId: 'workspace:default',
    position: 1,
    firstPane: { id: 'pane-b', cwd: '/srv', kind: 'local', endpoint: null, sizeShare: 1 },
  })
  if (decorate) {
    await backend.renameTab('tab-b', 'release')
    await backend.recolourTab('tab-b', 'green')
    await backend.pinTab('tab-b', true)
  }
  return backend
}

/** The smallest PaneContent that is not a terminal: a view pane, which the
 *  chain never holds — Settings and the file viewer are surfaces the window
 *  shows, not durable panes with a cwd and a pipe. */
class ViewContent extends BasePaneContent {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  mount(_t: HTMLElement, _h: unknown, _s: AbortSignal): Promise<void> {
    return Promise.resolve()
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  viewportChanged(_v: ContentViewport): void {}
  focus(): void {}
  dispose(): void {}
}

function stripTabs(bar: HTMLElement): HTMLElement[] {
  return Array.from(bar.querySelectorAll<HTMLElement>('.nocx-tab'))
}

describe('the renderer draws the chain the backend holds', () => {
  beforeEach(() => {
    resetSessionCounter()
    vi.clearAllMocks()
  })

  // ── THE EPIC'S HEADLINE, at the renderer's own seam ──────────────────
  it('reopens the tabs, their colours, their names and their pinning without the backend restarting', async () => {
    const backend = await seededBackend()
    const { bar } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })

    const tabs = stripTabs(bar)
    expect(tabs).toHaveLength(2)
    // Pinned first: the strip places what the backend stores, and nothing
    // here was remembered by the renderer, which has just started.
    expect(tabs[0].querySelector('.nocx-tab-title')?.textContent).toBe('release')
    expect(tabs[0].getAttribute('data-colour')).toBe('green')
    expect(tabs[0].getAttribute('data-pinned')).toBe('true')
    expect(tabs[0].querySelector('.nocx-tab-pin')).not.toBeNull()
    expect(tabs[1].getAttribute('data-colour')).toBeNull()
    expect(tabs[1].getAttribute('data-pinned')).toBeNull()
  })

  it('opens no tab of its own when the backend already holds one', async () => {
    const backend = await seededBackend()
    const { manager, backend: b } = await mountPaneManager(
      undefined,
      undefined,
      undefined,
      undefined,
      { store: makeLayoutStore(backend).store, backend },
    )
    // The renderer adopted what was there and minted nothing: a boot that
    // opened a pane and then read would have decided what the window looks
    // like before finding out.
    expect(manager.paneCount).toBe(2)
    expect(b.rows().tabs.map((t) => t.id)).toEqual(['tab-a', 'tab-b'])
  })

  // ── the fourth criterion: no optimistic anything ─────────────────────
  it('does NOT reorder optimistically when the backend refuses', async () => {
    const backend = await seededBackend()
    const { bar, manager } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    const before = stripTabs(bar).map((t) => t.getAttribute('data-pane-id'))
    backend.fail('reorderTabs', new Error('ids must be a permutation of the workspace tabs'))

    const [first, second] = stripTabs(bar).map((t) => Number(t.getAttribute('data-pane-id')))
    manager.reorderPane(first, second)

    // Nothing to snap back from: the strip is drawn from the cache and the
    // cache is only ever written from an answer.
    await vi.waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'danger',
          message: expect.stringContaining('reorder') as string,
        }),
      )
    })
    expect(stripTabs(bar).map((t) => t.getAttribute('data-pane-id'))).toEqual(before)
  })

  it('reorders when the backend accepts, in the order the backend answered', async () => {
    // Two plain tabs: a PINNED one is placed at the head whatever the
    // positions say, and the positions are what this test is about.
    const backend = await seededBackend({ decorate: false })
    const { bar, manager } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    const [first, second] = stripTabs(bar).map((t) => Number(t.getAttribute('data-pane-id')))

    // Dragging the second onto the first: it lands where the first was.
    manager.reorderPane(second, first)

    await vi.waitFor(() => {
      expect(stripTabs(bar).map((t) => Number(t.getAttribute('data-pane-id')))).toEqual([
        second,
        first,
      ])
    })
    expect(backend.rows().tabs.map((t) => t.position)).toEqual([0, 1])
  })

  // ── decoration is asked for, never applied locally ───────────────────
  it('renames a tab through the wire, and clearing the name gives the panes their say again', async () => {
    const backend = await seededBackend()
    const { bar, tabStrip } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    const paneId = Number(stripTabs(bar)[0].getAttribute('data-pane-id'))

    showPromptMock.mockResolvedValueOnce('deploy')
    tabStrip.onRename?.(paneId)
    await vi.waitFor(() => {
      expect(stripTabs(bar)[0].querySelector('.nocx-tab-title')?.textContent).toBe('deploy')
    })
    expect(backend.rows().tabs.find((t) => t.id === 'tab-b')?.name).toBe('deploy')

    // An empty answer CLEARS the name — a real operation, and the tab goes
    // back to the label its panes give it (§4.5). Cancelling is the other
    // answer and changes nothing.
    showPromptMock.mockResolvedValueOnce('   ')
    tabStrip.onRename?.(paneId)
    await vi.waitFor(() => {
      expect(backend.rows().tabs.find((t) => t.id === 'tab-b')?.name).toBeNull()
    })
    expect(stripTabs(bar)[0].querySelector('.nocx-tab-title')?.textContent).not.toBe('deploy')

    showPromptMock.mockResolvedValueOnce(null)
    tabStrip.onRename?.(paneId)
    await Promise.resolve()
    expect(backend.rows().tabs.find((t) => t.id === 'tab-b')?.name).toBeNull()
  })

  it('colours and pins through the wire, and shows what came back', async () => {
    const backend = await seededBackend()
    const { bar, tabStrip } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    // The unpinned, undecorated one.
    const paneId = Number(stripTabs(bar)[1].getAttribute('data-pane-id'))

    tabStrip.onRecolour?.(paneId, 'red')
    await vi.waitFor(() => {
      expect(
        stripTabs(bar)
          .find((t) => t.getAttribute('data-pane-id') === String(paneId))
          ?.getAttribute('data-colour'),
      ).toBe('red')
    })
    expect(backend.rows().tabs.find((t) => t.id === 'tab-a')?.colour).toBe('red')

    tabStrip.onPin?.(paneId, true)
    await vi.waitFor(() => {
      // Pinning moves it to the head, because that is what pinned means and
      // the strip is what applies it (layout/strip-order.ts).
      expect(stripTabs(bar)[0].getAttribute('data-pane-id')).toBe(String(paneId))
    })
    expect(backend.rows().tabs.find((t) => t.id === 'tab-a')?.pinned).toBe(true)

    tabStrip.onRecolour?.(paneId, null)
    await vi.waitFor(() => {
      expect(stripTabs(bar)[0].getAttribute('data-colour')).toBeNull()
    })
  })

  it('registers every new pane in the chain, with the ids it minted', async () => {
    const backend = makeLayoutBackend()
    const { manager, backend: b } = await mountPaneManager(
      undefined,
      undefined,
      undefined,
      undefined,
      { store: makeLayoutStore(backend).store, backend },
    )
    await vi.waitFor(() => {
      expect(b.rows().tabs).toHaveLength(1)
    })
    manager.newPane()
    await vi.waitFor(() => {
      expect(b.rows().tabs).toHaveLength(2)
      expect(b.rows().panes).toHaveLength(2)
    })
    // Every pane in the chain has chrome, and every piece of chrome has a row.
    expect(manager.paneCount).toBe(2)
  })

  it('takes the pane off screen when the backend refuses to create it', async () => {
    const backend = makeLayoutBackend()
    const { manager, bar } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    await vi.waitFor(() => expect(stripTabs(bar)).toHaveLength(1))

    backend.fail('createTab', new Error('id already means something else'))
    manager.newPane()

    // The chrome appeared in the same turn the key was pressed — the id is
    // the renderer's — but a pane the backend refused must not stay: what is
    // on screen is what the chain holds.
    await vi.waitFor(() => {
      expect(stripTabs(bar)).toHaveLength(1)
    })
  })

  // ── the degrade is visible, not only logged ──────────────────────────
  it('says so on screen when the layout store cannot be read, and still opens a pane', async () => {
    const backend = makeLayoutBackend()
    backend.fail('read', new Error('layout store not available'))
    const { manager, bar } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })

    expect(stripTabs(bar)).toHaveLength(1)
    expect(manager.paneCount).toBe(1)
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('not being remembered') as string,
      }),
    )
    // And nothing was written: a renderer that cannot read the chain does not
    // half-write it either.
    expect(backend.rows().tabs).toHaveLength(0)
  })
})

// ── the chain can hold a row the renderer cannot draw ─────────────────
//
// An ssh pane is restored into the chain and NOT reopened: reconnecting needs
// the profile it was opened from and the chain stores an endpoint. That row is
// real, it occupies a position, and the renderer has no chrome for it — which
// is a state every one of these tests is about.

/** A chain holding one local tab the renderer can draw and one ssh tab it
 *  cannot, plus however many more local ones are asked for. */
async function backendWithAnSSHRow(locals = 2): Promise<ReturnType<typeof makeLayoutBackend>> {
  const backend = makeLayoutBackend()
  await backend.createTab({
    id: 'tab-ssh',
    workspaceId: 'workspace:default',
    position: 0,
    firstPane: {
      id: 'pane-ssh',
      cwd: '/srv',
      kind: 'ssh',
      endpoint: 'deploy@srv-01:22',
      sizeShare: 1,
    },
  })
  for (let i = 0; i < locals; i++) {
    await backend.createTab({
      id: `tab-${i}`,
      workspaceId: 'workspace:default',
      position: i + 1,
      firstPane: { id: `pane-${i}`, cwd: '/', kind: 'local', endpoint: null, sizeShare: 1 },
    })
  }
  return backend
}

describe('a row the renderer cannot draw', () => {
  beforeEach(() => {
    resetSessionCounter()
    vi.clearAllMocks()
  })

  it('is still named in a reorder, so the backend does not refuse the whole thing', async () => {
    const backend = await backendWithAnSSHRow()
    const { bar, manager } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    // Two of the three tabs are drawn; the ssh one is not.
    expect(stripTabs(bar)).toHaveLength(2)

    const [first, second] = stripTabs(bar).map((t) => Number(t.getAttribute('data-pane-id')))
    manager.reorderPane(second, first)

    // THE DEFECT THIS PINS: a request naming only the tabs on screen is not a
    // permutation of the workspace's tabs, and the backend refuses the whole
    // reorder — which is what shipped, and what the e2e gate found once a spec
    // had opened an ssh tab earlier in the run. The strip must move.
    await vi.waitFor(() => {
      expect(stripTabs(bar).map((t) => Number(t.getAttribute('data-pane-id')))).toEqual([
        second,
        first,
      ])
    })
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ level: 'danger' as const }),
    )
    // The undrawn row kept its place among the others rather than being
    // dropped from the order: it is a row the renderer cannot show, not a row
    // that stopped existing.
    expect(backend.rows().tabs.map((t) => t.id)).toContain('tab-ssh')
    expect(backend.rows().tabs).toHaveLength(3)
  })

  it('is reported once, however many of them there are', async () => {
    const backend = await backendWithAnSSHRow(1)
    await backend.createTab({
      id: 'tab-ssh-2',
      workspaceId: 'workspace:default',
      position: 9,
      firstPane: {
        id: 'pane-ssh-2',
        cwd: '/srv',
        kind: 'ssh',
        endpoint: 'deploy@srv-02:22',
        sizeShare: 1,
      },
    })
    await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })

    // One warning naming the count, not one per pane: four ssh tabs used to
    // mean four toasts on every load, and in the gate a leftover one sat
    // beside the toast another spec was asserting on.
    const warnings = showToastMock.mock.calls.filter(
      ([t]) => (t as { level?: string }).level === 'warning',
    )
    expect(warnings).toHaveLength(1)
    expect(String((warnings[0][0] as { message: string }).message)).toContain(
      '2 connections were not reopened',
    )
  })

  it('leaves a pane the chain does not hold where it already was', async () => {
    const backend = await seededBackend({ decorate: false })
    const { bar, manager } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    await vi.waitFor(() => expect(stripTabs(bar)).toHaveLength(2))

    // A view pane — Settings, a file viewer — is chrome the window shows and
    // is not in the chain at all.
    const view = manager.openPane(new ViewContent(), {
      surfaceType: 'nocx.settings' as ContentDescriptor['surfaceType'],
      singletonKey: null,
      restoreDescriptor: null,
      supportsAttention: false,
      defaultTitle: 'Settings',
    })
    await vi.waitFor(() => expect(stripTabs(bar)).toHaveLength(3))

    // Now open a tab the chain DOES hold. It is the newest, so it belongs at
    // the end — and the view pane must not be swept past it.
    //
    // "The last tab is the one that just opened" is a promise four specs make
    // (connections-settings, vault ×2, vault-settings ×2, each asserting the
    // last tab is not called Settings), and sweeping view panes to the end
    // broke all of them: the connection they had just opened appeared BEFORE
    // Settings.
    manager.newPane()
    await vi.waitFor(() => expect(stripTabs(bar)).toHaveLength(4))
    const order = stripTabs(bar).map((t) => Number(t.getAttribute('data-pane-id')))
    expect(order[2]).toBe(view.id)
    expect(order[3]).not.toBe(view.id)
  })
})
