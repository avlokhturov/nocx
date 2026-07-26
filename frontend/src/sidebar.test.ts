// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountSidebar, type PanelView } from './sidebar'

// VS Code-style shell sidebar: a permanent narrow activity bar on the far
// left, plus a wide panel that collapses. Clicking the active view's icon
// collapses the panel; clicking any icon while collapsed re-opens it.

const PANEL_VIEWS: PanelView[] = [
  { id: 'sessions', title: 'Sessions', icon: '<svg id="icon-sessions" />' },
  { id: 'settings', title: 'Settings', icon: '<svg id="icon-settings" />' },
]

function mount(): { bar: HTMLElement; panel: HTMLElement } {
  const bar = document.createElement('div')
  bar.id = 'activitybar'
  const panel = document.createElement('div')
  panel.id = 'sidebar'
  document.body.append(bar, panel)
  return { bar, panel }
}

function button(bar: HTMLElement, viewId: string): HTMLElement {
  const el = bar.querySelector<HTMLElement>(`.activity-bar-btn[data-view="${viewId}"]`)
  if (!el) throw new Error(`no button for view ${viewId}`)
  return el
}

function pressToggleKey(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
}

describe('sidebar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('renders one activity-bar button per view and starts expanded on the first view', () => {
    const { bar, panel } = mount()
    mountSidebar(bar, panel, PANEL_VIEWS, [])

    expect(bar.querySelectorAll('.activity-bar-btn')).toHaveLength(2)
    expect(panel.classList.contains('collapsed')).toBe(false)
    expect(button(bar, 'sessions').classList.contains('active')).toBe(true)
    expect(button(bar, 'settings').classList.contains('active')).toBe(false)
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('Sessions')
  })

  it("collapses when the active view's button is clicked, and re-opens on the next click", () => {
    const { bar, panel } = mount()
    mountSidebar(bar, panel, PANEL_VIEWS, [])

    button(bar, 'sessions').click()
    expect(panel.classList.contains('collapsed')).toBe(true)
    // VS Code drops the active highlight when the panel is closed.
    expect(button(bar, 'sessions').classList.contains('active')).toBe(false)

    button(bar, 'sessions').click()
    expect(panel.classList.contains('collapsed')).toBe(false)
    expect(button(bar, 'sessions').classList.contains('active')).toBe(true)
  })

  it('switches views when another button is clicked, keeping the panel open', () => {
    const { bar, panel } = mount()
    mountSidebar(bar, panel, PANEL_VIEWS, [])

    button(bar, 'settings').click()
    expect(panel.classList.contains('collapsed')).toBe(false)
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('Settings')
    expect(button(bar, 'settings').classList.contains('active')).toBe(true)
    expect(button(bar, 'sessions').classList.contains('active')).toBe(false)
  })

  it('opens the panel on the clicked view when collapsed', () => {
    const { bar, panel } = mount()
    mountSidebar(bar, panel, PANEL_VIEWS, [])

    button(bar, 'sessions').click() // collapse
    button(bar, 'settings').click() // re-open on another view

    expect(panel.classList.contains('collapsed')).toBe(false)
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('Settings')
  })

  it('toggles the panel with Ctrl/Cmd+B', () => {
    const { bar, panel } = mount()
    mountSidebar(bar, panel, PANEL_VIEWS, [])

    pressToggleKey()
    expect(panel.classList.contains('collapsed')).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
    expect(panel.classList.contains('collapsed')).toBe(false)
  })

  it('ignores bare B without a modifier', () => {
    const { bar, panel } = mount()
    mountSidebar(bar, panel, PANEL_VIEWS, [])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
    expect(panel.classList.contains('collapsed')).toBe(false)
  })

  it('persists the collapsed state and restores it on the next mount', () => {
    const first = mount()
    mountSidebar(first.bar, first.panel, PANEL_VIEWS, [])
    button(first.bar, 'sessions').click() // collapse

    document.body.replaceChildren()
    const second = mount()
    mountSidebar(second.bar, second.panel, PANEL_VIEWS, [])

    expect(second.panel.classList.contains('collapsed')).toBe(true)
    expect(button(second.bar, 'sessions').classList.contains('active')).toBe(false)
  })

  it('clicking a tab-action button triggers onActivate and collapses the panel', () => {
    const onActivate = vi.fn()
    const { bar, panel } = mount()
    mountSidebar(bar, panel, PANEL_VIEWS, [{ id: 'link', title: 'Open Tab', icon: '', onActivate }])

    button(bar, 'link').click()

    expect(onActivate).toHaveBeenCalledOnce()
    expect(panel.classList.contains('collapsed')).toBe(true)
    // no active highlight when collapsed
    expect(button(bar, 'link').classList.contains('active')).toBe(false)
  })

  it('collapses the panel on cold start when only tab actions are registered (nocx-rp2j)', () => {
    const { bar, panel } = mount()
    mountSidebar(
      bar,
      panel,
      [],
      [{ id: 'link', title: 'Open Tab', icon: '', onActivate: () => {} }],
    )

    // No panel views — the panel must start collapsed, not showing an empty
    // content area.
    expect(panel.classList.contains('collapsed')).toBe(true)
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('')
  })

  it('starts expanded on the first panel view when a tab action precedes it (nocx-rp2j)', () => {
    // Panel views and tab actions are separate arguments; mountSidebar
    // determines the initial active view from the first panel view only.
    const { bar, panel } = mount()
    mountSidebar(
      bar,
      panel,
      [{ id: 'sessions', title: 'Sessions', icon: '' }],
      [{ id: 'link', title: 'Link', icon: '', onActivate: () => {} }],
    )

    expect(panel.classList.contains('collapsed')).toBe(false)
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('Sessions')
  })
})
