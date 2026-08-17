// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createRendererMock,
  resetSessionCounter,
  mountPaneManager,
  type RendererMock,
} from './test-support/panes-fixtures'
import { VerticalTabStrip } from './tab-strip'

// A window is a VIEWPORT, not a container (tabs/panes design §10): it shows
// one workspace at a time, and the chip is that sentence in the UI. These
// tests are about the two halves of it — which tabs the window draws, and
// what the chip says about which workspace they are in — plus the rule the
// whole epic turns on: THE DEFAULT WORKSPACE NEVER RENDERS, and creating a
// second workspace does not change that.

vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock) as unknown as new () => RendererMock,
}))

const showConfirmMock = vi.fn()
const showPromptMock = vi.fn()
vi.mock('./ui/dialog', () => ({
  showConfirm: (...args: unknown[]) => showConfirmMock(...args) as Promise<boolean>,
  showPrompt: (...args: unknown[]) => showPromptMock(...args) as Promise<string | null>,
}))

const DEFAULT_WS = 'workspace:default'
const TAB = '.nocx-tab'
const CHIP = '.nocx-workspace-chip .ui-button'

const tabTitles = (root: HTMLElement): string[] =>
  [...root.querySelectorAll(TAB)].map(
    (el) => el.querySelector('.nocx-tab-title')?.textContent ?? '',
  )

const chip = (root: HTMLElement): HTMLElement | null => root.querySelector(CHIP)

const switcherRows = (root: HTMLElement): HTMLElement[] => {
  chip(root)!.click()
  return [...document.querySelectorAll<HTMLElement>('.ui-context-menu__item')]
}

describe('the window shows one workspace at a time (nocx-isoph.5)', () => {
  beforeEach(() => {
    resetSessionCounter()
    vi.clearAllMocks()
    showPromptMock.mockResolvedValue('refactor-auth')
    showConfirmMock.mockResolvedValue(true)
  })

  /** One tab in the default workspace, and one workspace of its own beside
   *  it — the state every assertion below is about. */
  async function twoWorkspaces() {
    const mounted = await mountPaneManager()
    const { manager, bar } = mounted
    await vi.waitFor(() => expect(bar.querySelectorAll(TAB)).toHaveLength(1))

    await manager.newWorkspace()
    await vi.waitFor(() => expect(manager.currentWorkspaceId()).not.toBe(DEFAULT_WS))
    return mounted
  }

  it('creates a workspace together with its first tab, and shows it', async () => {
    const { manager, bar, backend } = await twoWorkspaces()

    expect(showPromptMock).toHaveBeenCalled()
    const rows = backend.rows()
    const workspace = rows.workspaces.find((w) => w.id !== DEFAULT_WS)!
    expect(workspace.name).toBe('refactor-auth')
    // Creation is always creation-with-content: the workspace arrived with a
    // tab, and that tab with a pane.
    const member = rows.tabs.find((t) => t.workspaceId === workspace.id)!
    expect(rows.panes.some((p) => p.tabId === member.id)).toBe(true)
    expect(manager.currentWorkspaceId()).toBe(workspace.id)
    // THE HORIZONTAL STRIP SHOWS THE CURRENT WORKSPACE AND NOTHING ELSE.
    expect(bar.querySelectorAll(TAB)).toHaveLength(1)
  })

  it('does not create anything when the person cancels the name', async () => {
    showPromptMock.mockResolvedValue(null)
    const { manager, backend } = await mountPaneManager()

    await manager.newWorkspace()

    expect(backend.rows().workspaces.filter((w) => w.id !== DEFAULT_WS)).toEqual([])
    expect(manager.currentWorkspaceId()).toBe(DEFAULT_WS)
  })

  it('switching the chip changes the set of tabs the strip draws', async () => {
    const { manager, bar } = await twoWorkspaces()
    const inWorkspace = tabTitles(bar)

    switcherRows(bar)
      .find((el) => el.textContent === 'Ungrouped tabs')!
      .click()

    await vi.waitFor(() => expect(manager.currentWorkspaceId()).toBe(DEFAULT_WS))
    const inDefault = tabTitles(bar)
    expect(inDefault).toHaveLength(1)
    expect(inDefault).not.toEqual(inWorkspace)
  })

  it('gives the chip no label in the default workspace, whatever else exists', async () => {
    // The bead's second criterion at the seam a person touches: the default's
    // chip is a glyph with no name, and the arrival of another workspace does
    // not give it one.
    const { manager, bar } = await mountPaneManager()
    await vi.waitFor(() => expect(bar.querySelectorAll(TAB)).toHaveLength(1))
    const alone = chip(bar)!.textContent

    await manager.newWorkspace()
    await vi.waitFor(() => expect(manager.currentWorkspaceId()).not.toBe(DEFAULT_WS))
    manager.switchWorkspace(DEFAULT_WS)

    expect(chip(bar)!.textContent).toBe(alone)
    expect(chip(bar)!.textContent).toBe('')
  })

  it('names the current workspace on the chip when it has a name', async () => {
    const { bar } = await twoWorkspaces()

    expect(chip(bar)!.textContent).toContain('refactor-auth')
  })

  it('offers to close a workspace, and never the default', async () => {
    const { manager, bar } = await twoWorkspaces()

    expect(switcherRows(bar).map((el) => el.textContent)).toContain('Close workspace')

    manager.switchWorkspace(DEFAULT_WS)
    expect(switcherRows(bar).map((el) => el.textContent)).not.toContain('Close workspace')
  })

  it('asks before closing a workspace, and then takes the whole container', async () => {
    const { manager, backend } = await twoWorkspaces()
    const id = manager.currentWorkspaceId()

    await manager.closeCurrentWorkspace()

    expect(showConfirmMock).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(backend.rows().workspaces.map((w) => w.id)).not.toContain(id)
    })
    // Back where a window with no workspace of its own is: the default.
    expect(manager.currentWorkspaceId()).toBe(DEFAULT_WS)
  })

  it('leaves the workspace standing when the person says no', async () => {
    showConfirmMock.mockResolvedValue(false)
    const { manager, backend } = await twoWorkspaces()
    const id = manager.currentWorkspaceId()

    await manager.closeCurrentWorkspace()

    expect(backend.rows().workspaces.map((w) => w.id)).toContain(id)
    expect(manager.currentWorkspaceId()).toBe(id)
  })

  it('refuses to close the default workspace without even asking', async () => {
    const { manager } = await mountPaneManager()

    await manager.closeCurrentWorkspace()

    expect(showConfirmMock).not.toHaveBeenCalled()
  })

  it('draws every workspace in the vertical strip, and heads only the named ones', async () => {
    // The vertical strip is the surface you look at coming back from lunch:
    // all workspaces at once. The default's rows are top-level rows with no
    // header — with one workspace beside it, exactly as without.
    const { manager, bar } = await twoWorkspaces()
    manager.replaceStrip(new VerticalTabStrip())

    await vi.waitFor(() => expect(bar.querySelectorAll(TAB)).toHaveLength(2))
    const headings = [...bar.querySelectorAll('.tabstrip-group-heading')].map(
      (el) => el.textContent,
    )
    expect(headings).toEqual(['refactor-auth'])
  })

  it('opens a new tab in the workspace the window is showing', async () => {
    // The + is in the strip of ONE workspace. A tab that landed in the
    // default instead would either vanish the moment it was created or drag
    // the window out of the workspace the person was working in.
    const { manager, bar, backend } = await twoWorkspaces()
    const id = manager.currentWorkspaceId()

    manager.newPane()

    await vi.waitFor(() => {
      expect(bar.querySelectorAll(TAB)).toHaveLength(2)
    })
    expect(backend.rows().tabs.filter((t) => t.workspaceId === id)).toHaveLength(2)
    expect(manager.currentWorkspaceId()).toBe(id)
  })

  it('addresses the tabs the window is showing when a position is activated', async () => {
    // Cmd+1..9 is workspace-scoped now (§4.3): the strip shows one
    // workspace's tabs, so a position in it means a position in THAT set. A
    // key that counted every tab in the application would select a tab the
    // person cannot see.
    const { manager, bar } = await twoWorkspaces()
    const visible = tabTitles(bar)

    manager.activateByIndex(0)

    await vi.waitFor(() => {
      expect(bar.querySelector(`${TAB}[aria-selected="true"] .nocx-tab-title`)?.textContent).toBe(
        visible[0],
      )
    })
  })
})
