// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SidebarImpl, SidebarView } from './sidebar'

// VS Code-style shell sidebar: a permanent narrow activity bar on the far
// left, plus a wide panel that collapses. Clicking the active view's icon
// collapses the panel; clicking any icon while collapsed re-opens it.

const VIEWS: SidebarView[] = [
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

describe('SidebarImpl', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('renders one activity-bar button per view and starts expanded on the first view', () => {
    const { bar, panel } = mount()
    const sidebar = new SidebarImpl(bar, panel, VIEWS)

    expect(bar.querySelectorAll('.activity-bar-btn')).toHaveLength(2)
    expect(sidebar.collapsed).toBe(false)
    expect(sidebar.activeViewId).toBe('sessions')
    expect(panel.classList.contains('collapsed')).toBe(false)
    expect(button(bar, 'sessions').classList.contains('active')).toBe(true)
    expect(button(bar, 'settings').classList.contains('active')).toBe(false)
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('Sessions')
  })

  it('collapses when the active view’s button is clicked, and re-opens on the next click', () => {
    const { bar, panel } = mount()
    const sidebar = new SidebarImpl(bar, panel, VIEWS)

    button(bar, 'sessions').click()
    expect(sidebar.collapsed).toBe(true)
    expect(panel.classList.contains('collapsed')).toBe(true)
    // VS Code drops the active highlight when the panel is closed.
    expect(button(bar, 'sessions').classList.contains('active')).toBe(false)

    button(bar, 'sessions').click()
    expect(sidebar.collapsed).toBe(false)
    expect(panel.classList.contains('collapsed')).toBe(false)
    expect(button(bar, 'sessions').classList.contains('active')).toBe(true)
  })

  it('switches views when another button is clicked, keeping the panel open', () => {
    const { bar, panel } = mount()
    const sidebar = new SidebarImpl(bar, panel, VIEWS)

    button(bar, 'settings').click()
    expect(sidebar.collapsed).toBe(false)
    expect(sidebar.activeViewId).toBe('settings')
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('Settings')
    expect(button(bar, 'settings').classList.contains('active')).toBe(true)
    expect(button(bar, 'sessions').classList.contains('active')).toBe(false)
  })

  it('opens the panel on the clicked view when collapsed', () => {
    const { bar, panel } = mount()
    const sidebar = new SidebarImpl(bar, panel, VIEWS)

    button(bar, 'sessions').click() // collapse
    button(bar, 'settings').click() // re-open on another view

    expect(sidebar.collapsed).toBe(false)
    expect(sidebar.activeViewId).toBe('settings')
    expect(panel.querySelector('.sidebar-title')?.textContent).toBe('Settings')
  })

  it('toggles the panel with Ctrl/Cmd+B', () => {
    const { bar, panel } = mount()
    const sidebar = new SidebarImpl(bar, panel, VIEWS)

    pressToggleKey()
    expect(sidebar.collapsed).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
    expect(sidebar.collapsed).toBe(false)
  })

  it('ignores bare B without a modifier', () => {
    const { bar, panel } = mount()
    const sidebar = new SidebarImpl(bar, panel, VIEWS)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
    expect(sidebar.collapsed).toBe(false)
  })

  it('persists the collapsed state and restores it on the next mount', () => {
    const first = mount()
    new SidebarImpl(first.bar, first.panel, VIEWS)
    button(first.bar, 'sessions').click() // collapse

    document.body.replaceChildren()
    const second = mount()
    const restored = new SidebarImpl(second.bar, second.panel, VIEWS)

    expect(restored.collapsed).toBe(true)
    expect(second.panel.classList.contains('collapsed')).toBe(true)
    expect(button(second.bar, 'sessions').classList.contains('active')).toBe(false)
  })
})
