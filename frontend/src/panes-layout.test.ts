// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NameColourDraft } from './name-colour-dialog'
import {
  createRendererMock,
  resetSessionCounter,
  mountPaneManager,
  makeLayoutBackend,
  makeLayoutStore,
  makeUIStateBackend,
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
const workspaceCreateMock = vi.fn()
const workspaceEditMock = vi.fn()
const tabEditMock = vi.fn()
// The toast host lives in App.tsx, which these tests do not mount, so the
// outcome is asserted where it is raised. A degrade that is only in a log is
// the defect AGENTS.md names; this is how the test says it is not.
const showToastMock = vi.fn()
vi.mock('./ui/toast', () => ({
  showToast: (...args: unknown[]) => {
    showToastMock(...args)
  },
}))

// PARTIAL: name-colour-dialog.tsx renders the kit's Dialog, so a wholesale
// mock of this module leaves it without one.
vi.mock('./ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ui/dialog')>()),
  showConfirm: (...args: unknown[]) => showConfirmMock(...args) as Promise<boolean>,
}))

// Naming and colouring are one form now, for both subjects (nocx-2mipw.2).
// The tests drive it through one mock and read back what was asked for.
vi.mock('./name-colour-dialog', () => ({
  showWorkspaceCreateDialog: (...args: unknown[]) =>
    workspaceCreateMock(...args) as Promise<NameColourDraft | null>,
  showWorkspaceEditDialog: (...args: unknown[]) =>
    workspaceEditMock(...args) as Promise<NameColourDraft | null>,
  showTabEditDialog: (...args: unknown[]) =>
    tabEditMock(...args) as Promise<NameColourDraft | null>,
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

    // Naming and colouring are one form now (nocx-2mipw.2), so the rename
    // intent opens the tab's edit dialog and what it answers is what the
    // backend is asked for.
    tabEditMock.mockResolvedValueOnce({ name: 'deploy', colour: null })
    tabStrip.onRename?.(paneId)
    await vi.waitFor(() => {
      expect(stripTabs(bar)[0].querySelector('.nocx-tab-title')?.textContent).toBe('deploy')
    })
    expect(backend.rows().tabs.find((t) => t.id === 'tab-b')?.name).toBe('deploy')

    // An empty answer CLEARS the name — a real operation, and the tab goes
    // back to the label its panes give it (§4.5). It is not a cancel, which
    // is the dialog answering null and is asserted below.
    tabEditMock.mockResolvedValueOnce({ name: '', colour: null })
    tabStrip.onRename?.(paneId)
    await vi.waitFor(() => {
      expect(backend.rows().tabs.find((t) => t.id === 'tab-b')?.name).toBeNull()
    })
    expect(stripTabs(bar)[0].querySelector('.nocx-tab-title')?.textContent).not.toBe('deploy')

    tabEditMock.mockResolvedValueOnce(null)
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

// ═══════════════════════════════════════════════════════════════════════════
// The session names the pane it is the pipe of (nocx-rtg0.29)
//
// The backend derives a block's anchor and a session's workspace by walking
// pane -> tab -> workspace from the id the renderer sends. Sending nothing is
// the state this bead found the product in: every anchor NULL, every session
// in the default workspace, with the id sitting in the renderer all along.
// ═══════════════════════════════════════════════════════════════════════════
describe('the session names the pane it is the pipe of (nocx-rtg0.29)', () => {
  /** design §7: the ids are UUIDv7 — version nibble 7, RFC 4122 variant. */
  const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('opens the session naming the pane the chain just stored', async () => {
    const backend = makeLayoutBackend()
    const { client } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })

    await vi.waitFor(() => expect(backend.rows().panes).toHaveLength(1))
    const row = backend.rows().panes[0]
    expect(row.id).toMatch(UUIDV7)

    // The id the OPEN carried is the id the CHAIN holds — one identity, not
    // two that happen to agree.
    await vi.waitFor(() => expect(client.openSession).toHaveBeenCalledTimes(1))
    expect(client.openSession.mock.calls[0][2]).toEqual({ paneId: row.id })
  })

  it('names the pane on a second tab too, not just the first', async () => {
    const backend = makeLayoutBackend()
    const { manager, client } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    await vi.waitFor(() => expect(backend.rows().panes).toHaveLength(1))

    manager.newPane()
    await vi.waitFor(() => expect(backend.rows().panes).toHaveLength(2))
    await vi.waitFor(() => expect(client.openSession).toHaveBeenCalledTimes(2))

    const opened = client.openSession.mock.calls.map((c: unknown[]) => c[2])
    expect(opened).toEqual(backend.rows().panes.map((r) => ({ paneId: r.id })))
  })

  it('names the pane on an ssh tab — an ssh tab is a pane too', async () => {
    const backend = makeLayoutBackend()
    const { manager, client } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })
    await vi.waitFor(() => expect(backend.rows().panes).toHaveLength(1))

    manager.newSSHPane('ssh:test:1', 'example.test')
    await vi.waitFor(() => expect(backend.rows().panes).toHaveLength(2))
    await vi.waitFor(() => expect(client.openSSHSession).toHaveBeenCalledTimes(1))

    const sshRow = backend.rows().panes.find((r) => r.kind === 'ssh')
    expect(sshRow).toBeDefined()
    expect(client.openSSHSession.mock.calls[0][3]).toEqual({ paneId: sshRow!.id })
  })

  // Criterion 4. No layout store is a DEGRADE, never a refusal: the id is
  // still minted and still one identity for history.record and
  // secrets.paneClosed — it simply names no row, so the open must not claim
  // it does. Before this bead the path opened unanchored; it still must.
  it('still opens — without a paneId — when there is no layout store', async () => {
    const backend = makeLayoutBackend()
    backend.fail('read', new Error('layout store not available'))
    const { manager, client } = await mountPaneManager(undefined, undefined, undefined, undefined, {
      store: makeLayoutStore(backend).store,
      backend,
    })

    expect(manager.paneCount).toBe(1)
    expect(client.openSession).toHaveBeenCalledTimes(1)
    // Not `{ paneId: '' }`: an empty id is MALFORMED to validateOpenRaw and
    // refused, while an absent one is legitimate. The two must not collapse.
    expect(client.openSession.mock.calls[0][2]).toEqual({})
    expect(backend.rows().panes).toHaveLength(0)
  })

  // Criterion 5. A create the backend REFUSED leaves an id naming no row.
  // `open` refuses such an id (-32602, nocx-isoph.2) and that refusal stays,
  // so the renderer must not send it — the session opens unanchored instead.
  it('does not name a pane the backend refused to create', async () => {
    const backend = makeLayoutBackend()
    const { manager, client, bar } = await mountPaneManager(
      undefined,
      undefined,
      undefined,
      undefined,
      { store: makeLayoutStore(backend).store, backend },
    )
    await vi.waitFor(() => expect(backend.rows().panes).toHaveLength(1))
    const admitted = backend.rows().panes[0].id

    backend.fail('createTab', new Error('id already means something else'))
    manager.newPane()

    // The chrome went up and came back down — that is the existing contract,
    // and reaching it is what says the refusal has been fully processed.
    await vi.waitFor(() => expect(stripTabs(bar)).toHaveLength(1))

    // THE INVARIANT, stated over every open rather than over a count: no
    // session names a pane the chain does not hold. In practice the refused
    // pane's chrome is disposed before its session is ever requested, so it
    // opens nothing at all — but asserting the count would be asserting that
    // race rather than the rule, and the rule is what must hold.
    const held = backend.rows().panes.map((r) => r.id)
    expect(held).toEqual([admitted])
    for (const call of client.openSession.mock.calls as unknown[][]) {
      const anchor = (call[2] ?? {}) as { paneId?: string }
      if (anchor.paneId !== undefined) expect(held).toContain(anchor.paneId)
    }
    // And the pane that WAS admitted is still named — the refusal of one
    // create does not unanchor the sessions around it.
    expect(client.openSession.mock.calls[0][2]).toEqual({ paneId: admitted })
  })
})

// ── WHICH TAB IS IN FRONT (nocx-mqie.4, ADR-0033) ──────────────────────────
//
// The chain says which tabs exist; it does not say which one a person was
// looking at, and it must not — a window is a viewport and two windows on one
// profile have two answers. That fact lives in the UI-state document, which
// the app writes without being asked. These tests drive the real client over
// a stored document and a REAL restart: a fresh mirror that knows nothing
// until it reads.
describe('the window reopens on the tab that was in front', () => {
  beforeEach(() => {
    resetSessionCounter()
    vi.clearAllMocks()
  })

  /** Which row the strip is showing as selected — the only place a person
   *  can see the answer, so the only place worth asserting it. */
  function activeTabIndex(bar: HTMLElement): number {
    return stripTabs(bar).findIndex((t) => t.getAttribute('aria-selected') === 'true')
  }

  it('records the tab moved to, and opens on it next launch', async () => {
    const backend = await seededBackend({ decorate: false })
    const ui = makeUIStateBackend()

    const first = await mountPaneManager(
      undefined,
      undefined,
      undefined,
      undefined,
      { store: makeLayoutStore(backend).store, backend },
      ui.newClient(),
    )
    // Cmd+2 — a seam a person actually reaches, rather than the private
    // activate() the implementation happens to expose.
    first.manager.activateByIndex(1)
    await vi.waitFor(() => {
      expect(activeTabIndex(first.bar)).toBe(1)
    })
    // A PANE ID and never an index: an index means nothing against a
    // different tab set, and the set is not what this document restores.
    await vi.waitFor(() => {
      expect(ui.stored().activeTab).toBe('pane-b')
    })

    const second = await mountPaneManager(
      undefined,
      undefined,
      undefined,
      undefined,
      { store: makeLayoutStore(backend).store, backend },
      ui.newClient(),
    )

    expect(activeTabIndex(second.bar)).toBe(1)
  })

  it('opens the first tab when the remembered pane is gone, and does not throw', async () => {
    // The tab SET is not restored yet (nocx-l21ib), so a remembered pane can
    // legitimately have gone. The window still has to open on something.
    const backend = await seededBackend({ decorate: false })
    const ui = makeUIStateBackend({ activeTab: 'pane-that-was-closed' })

    const { bar } = await mountPaneManager(
      undefined,
      undefined,
      undefined,
      undefined,
      { store: makeLayoutStore(backend).store, backend },
      ui.newClient(),
    )

    expect(stripTabs(bar)).toHaveLength(2)
    expect(activeTabIndex(bar)).toBe(0)
  })
})
