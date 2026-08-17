// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { cleanup } from '@solidjs/testing-library'
import { HorizontalTabStrip, VerticalTabStrip } from './tab-strip'
import type { PaneView } from './tab-strip'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function makePane(id: number, title: string, tooltip: string): PaneView {
  return {
    id,
    title,
    tooltip,
    // The strip's filter reads the tooltip whether or not a second line is shown,
    // so these fixtures keep it searchable and leave the line itself empty.
    subtitle: '',
    hasActivity: false,
    agentStatus: null,
    paneId: `pane-${id}`,
    onDisplayChange: null,
  }
}

function setupVerticalStrip(): {
  strip: VerticalTabStrip
  container: HTMLElement
} {
  const strip = new VerticalTabStrip()
  const container = document.createElement('div')
  container.id = 'vertical-tabstrip'
  document.body.appendChild(container)
  strip.mount(container)
  return { strip, container }
}

function getSearchInput(): HTMLInputElement | null {
  return document.querySelector('input[type="search"]')
}

function getTabEl(idx: number): HTMLElement | null {
  const tabs = document.querySelectorAll('.nocx-tab')
  return (tabs[idx] as HTMLElement) ?? null
}

function isHidden(el: HTMLElement): boolean {
  return el.getAttribute('data-hidden') === 'true'
}

describe('VerticalTabStrip filtering', () => {
  it('renders search field in vertical mode', () => {
    setupVerticalStrip()
    const input = getSearchInput()
    expect(input).toBeTruthy()
  })

  it('filtering by title substring keeps matching rows and hides the rest', () => {
    const { strip } = setupVerticalStrip()
    strip.addPane(makePane(1, 'local terminal', '~/repos/nocx'))
    strip.addPane(makePane(2, 'SSH: server-01', 'ssh user@server-01'))
    strip.addPane(makePane(3, 'SSH: database', 'ssh dba@db-host'))

    const input = getSearchInput()!
    expect(input).toBeTruthy()

    // Simulate typing 'server' in the search field
    input.value = 'server'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Tab 1 doesn't contain 'server' → hidden
    expect(isHidden(getTabEl(0)!)).toBe(true)
    // Tab 2 title contains 'server' → visible
    expect(isHidden(getTabEl(1)!)).toBe(false)
    // Tab 3 doesn't contain 'server' → hidden
    expect(isHidden(getTabEl(2)!)).toBe(true)
  })

  it('filtering by tooltip (cwd/host) substring matches too', () => {
    const { strip } = setupVerticalStrip()
    strip.addPane(makePane(1, 'local terminal', '~/repos/nocx'))
    strip.addPane(makePane(2, 'SSH: web', 'ssh deploy@web-01.prod'))

    const input = getSearchInput()!
    input.value = 'deploy'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Tab 1 tooltip doesn't contain 'deploy' → hidden
    expect(isHidden(getTabEl(0)!)).toBe(true)
    // Tab 2 tooltip contains 'deploy' → visible
    expect(isHidden(getTabEl(1)!)).toBe(false)
  })

  it('clearing the query restores every row', () => {
    const { strip } = setupVerticalStrip()
    strip.addPane(makePane(1, 'local terminal', '~/repos/nocx'))
    strip.addPane(makePane(2, 'SSH: server', 'ssh user@server'))

    const input = getSearchInput()!

    // Filter to show only 'server'
    input.value = 'server'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(isHidden(getTabEl(0)!)).toBe(true)
    expect(isHidden(getTabEl(1)!)).toBe(false)

    // Clear the field
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Both should be visible again
    expect(isHidden(getTabEl(0)!)).toBe(false)
    expect(isHidden(getTabEl(1)!)).toBe(false)
  })

  it('filtering does not change which tab is active', () => {
    const { strip } = setupVerticalStrip()
    strip.addPane(makePane(1, 'local terminal', '~/repos/nocx'))
    strip.addPane(makePane(2, 'SSH: server', 'ssh user@server'))
    strip.setActive(1)

    // Verify tab 1 is active
    const tab1 = getTabEl(0)!
    expect(tab1.getAttribute('aria-selected')).toBe('true')

    const input = getSearchInput()!
    input.value = 'server'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Tab 1 is hidden by the filter but still active
    expect(isHidden(tab1)).toBe(true)
    expect(tab1.getAttribute('aria-selected')).toBe('true')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Headings, the tree, and the chip (nocx-isoph.5)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_WS = 'workspace:default'
const HEADING = '.tabstrip-group-heading'

function grouped(id: number, groupKey: string, depth = 0): PaneView {
  return { ...makePane(id, `tab ${id}`, ''), groupKey, depth }
}

function headings(): string[] {
  return [...document.querySelectorAll(HEADING)].map((el) => el.textContent ?? '')
}

/** The rendered strip, row by row, as a person reads it down the column:
 *  headings where headings are, tabs where tabs are, indentation included. */
function readStrip(): string[] {
  const container = document.querySelector('.tabs-container')!
  return [...container.children].map((el) =>
    el.classList.contains('nocx-tab')
      ? `${'·'.repeat(Number(el.getAttribute('data-depth') ?? 0))}${el.querySelector('.nocx-tab-title')?.textContent}`
      : `# ${el.textContent}`,
  )
}

describe('the vertical strip draws headings, and the default workspace has none', () => {
  it('draws a heading above each group that has one, in the order the rows arrive', () => {
    const { strip } = setupVerticalStrip()
    strip.setGroupHeadings([
      { key: 'ws-1', heading: 'refactor-auth' },
      { key: DEFAULT_WS, heading: null },
    ])
    strip.addPane(grouped(1, 'ws-1'))
    strip.addPane(grouped(2, 'ws-1'))
    strip.addPane(grouped(3, DEFAULT_WS))

    expect(readStrip()).toEqual(['# refactor-auth', 'tab 1', 'tab 2', 'tab 3'])
  })

  it('leaves the default workspace exactly as it was when a second workspace appears', () => {
    // THE RULE A NAIVE IMPLEMENTATION BREAKS (§4.2). The default's chrome is
    // what it is because it is the default — never because of how many
    // workspaces exist. So this compares the default's rendered rows, byte
    // for byte, across the arrival of another workspace.
    const { strip } = setupVerticalStrip()
    strip.setGroupHeadings([{ key: DEFAULT_WS, heading: null }])
    strip.addPane(grouped(1, DEFAULT_WS))
    strip.addPane(grouped(2, DEFAULT_WS))
    const alone = readStrip()
    const rowHtml = [...document.querySelectorAll('.nocx-tab')].map((el) => el.outerHTML)
    expect(headings()).toEqual([])

    strip.setGroupHeadings([
      { key: DEFAULT_WS, heading: null },
      { key: 'ws-1', heading: 'refactor-auth' },
    ])
    strip.addPane(grouped(3, 'ws-1'))

    // The default's rows: same DOM, same absence of a heading above them.
    expect(
      [...document.querySelectorAll('.nocx-tab')].slice(0, 2).map((el) => el.outerHTML),
    ).toEqual(rowHtml)
    expect(readStrip().slice(0, alone.length)).toEqual(alone)
    // One heading, and it belongs to the workspace that has a name.
    expect(headings()).toEqual(['refactor-auth'])
  })

  it('indents a lineage child under its parent', () => {
    const { strip } = setupVerticalStrip()
    strip.setGroupHeadings([{ key: DEFAULT_WS, heading: null }])
    strip.addPane(grouped(1, DEFAULT_WS))
    strip.addPane(grouped(2, DEFAULT_WS, 1))

    expect(readStrip()).toEqual(['tab 1', '·tab 2'])
    expect(document.querySelectorAll('.nocx-tab')[1].getAttribute('data-depth')).toBe('1')
  })

  it('takes a heading away with the group the filter empties, and brings it back', () => {
    // A heading over a group with nothing under it reads as a broken list.
    // The rows are hidden rather than removed, so the heading has to ask
    // whether any of its own survived the filter.
    const { strip } = setupVerticalStrip()
    strip.setGroupHeadings([{ key: 'ws-1', heading: 'refactor-auth' }])
    strip.addPane({ ...makePane(1, 'deploy', 'ssh deploy@srv-01'), groupKey: 'ws-1' })
    strip.addPane({ ...makePane(2, 'notes', '~/notes'), groupKey: '' })
    expect(headings()).toEqual(['refactor-auth'])

    const input = getSearchInput()!
    input.value = 'notes'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(headings()).toEqual([])

    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(headings()).toEqual(['refactor-auth'])
  })

  it('draws every row it is given even when nothing said which group it is in', () => {
    // A strip with no chain behind it — the layout store refused, or a test —
    // still draws its tabs. Grouping is a way of drawing the list, never a
    // gate on being drawn at all.
    const { strip } = setupVerticalStrip()
    strip.addPane(makePane(1, 'one', ''))
    strip.addPane(makePane(2, 'two', ''))

    expect(readStrip()).toEqual(['one', 'two'])
    expect(headings()).toEqual([])
  })
})

describe('the workspace chip (§4.3)', () => {
  function setupHorizontalStrip(): HorizontalTabStrip {
    const strip = new HorizontalTabStrip()
    const container = document.createElement('div')
    document.body.appendChild(container)
    strip.mount(container)
    return strip
  }

  const chip = () => document.querySelector<HTMLButtonElement>('.nocx-workspace-chip .ui-button')
  const openSwitcher = (): HTMLElement[] => {
    chip()!.click()
    return [...document.querySelectorAll<HTMLElement>('.ui-context-menu__item')]
  }

  it('is a glyph with no label in the default workspace, whatever else exists', () => {
    const strip = setupHorizontalStrip()
    strip.setWorkspaceChip({
      name: null,
      workspaces: [
        { id: DEFAULT_WS, name: null },
        { id: 'ws-1', name: 'refactor-auth' },
      ],
      closable: false,
    })

    expect(chip()).not.toBeNull()
    expect(chip()!.textContent).toBe('')
    expect(chip()!.querySelector('svg')).not.toBeNull()
  })

  it('names the current workspace when it has a name', () => {
    const strip = setupHorizontalStrip()
    strip.setWorkspaceChip({
      name: 'refactor-auth',
      workspaces: [
        { id: DEFAULT_WS, name: null },
        { id: 'ws-1', name: 'refactor-auth' },
      ],
      closable: true,
    })

    expect(chip()!.textContent).toContain('refactor-auth')
  })

  it('switches to the workspace the person picked', () => {
    const strip = setupHorizontalStrip()
    const switched: string[] = []
    strip.onSwitchWorkspace = (id) => switched.push(id)
    strip.setWorkspaceChip({
      name: null,
      workspaces: [
        { id: DEFAULT_WS, name: null },
        { id: 'ws-1', name: 'refactor-auth' },
      ],
      closable: false,
    })

    openSwitcher()
      .find((el) => el.textContent === 'refactor-auth')!
      .click()

    expect(switched).toEqual(['ws-1'])
  })

  it('offers a way back to the default workspace without giving it a name', () => {
    const strip = setupHorizontalStrip()
    const switched: string[] = []
    strip.onSwitchWorkspace = (id) => switched.push(id)
    strip.setWorkspaceChip({
      name: 'refactor-auth',
      workspaces: [
        { id: DEFAULT_WS, name: null },
        { id: 'ws-1', name: 'refactor-auth' },
      ],
      closable: true,
    })

    const rows = openSwitcher()
    const back = rows[0]
    expect(back.textContent).not.toBe('')
    back.click()

    expect(switched).toEqual([DEFAULT_WS])
  })

  it('offers New workspace, and Close workspace only where there is one to close', () => {
    const strip = setupHorizontalStrip()
    let created = 0
    let closed = 0
    strip.onNewWorkspace = () => (created += 1)
    strip.onCloseWorkspace = () => (closed += 1)
    strip.setWorkspaceChip({
      name: null,
      workspaces: [{ id: DEFAULT_WS, name: null }],
      closable: false,
    })

    const inDefault = openSwitcher().map((el) => el.textContent)
    expect(inDefault).toContain('New workspace…')
    expect(inDefault.join(' ')).not.toContain('Close workspace')

    strip.setWorkspaceChip({
      name: 'refactor-auth',
      workspaces: [
        { id: DEFAULT_WS, name: null },
        { id: 'ws-1', name: 'refactor-auth' },
      ],
      closable: true,
    })
    const inWorkspace = openSwitcher()
    inWorkspace.find((el) => el.textContent === 'New workspace…')!.click()
    openSwitcher()
      .find((el) => el.textContent === 'Close workspace')!
      .click()

    expect(created).toBe(1)
    expect(closed).toBe(1)
  })

  it('is absent until something says there is a chain behind it', () => {
    setupHorizontalStrip()
    expect(chip()).toBeNull()
  })

  it('never appears in the vertical strip, which shows every workspace at once', () => {
    const { strip } = setupVerticalStrip()
    strip.setWorkspaceChip({ name: 'refactor-auth', workspaces: [], closable: true })
    expect(chip()).toBeNull()
  })
})

describe('the snippets action (nocx-d346)', () => {
  // The strip is a presentation port: it reports that the button was
  // pressed, nothing more. What opens is the quick-connect palette in its
  // snippets variant — the same surface the caret and the key icon beside
  // it open, which is the correction the owner's review made.
  const pressesOf = (strip: { onSnippets: (() => void) | null }) => {
    let presses = 0
    strip.onSnippets = () => (presses += 1)
    return () => presses
  }

  it('the vertical strip offers it and reports the press', () => {
    const { strip } = setupVerticalStrip()
    const presses = pressesOf(strip)

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Snippets"]')
    expect(button, 'the vertical strip has no snippets action').not.toBeNull()
    button!.click()

    expect(presses()).toBe(1)
  })

  it('the horizontal strip offers it too — a strip replacement must not lose it', () => {
    const strip = new HorizontalTabStrip()
    const container = document.createElement('div')
    document.body.appendChild(container)
    strip.mount(container)
    const presses = pressesOf(strip)

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Snippets"]')
    expect(button, 'the horizontal strip has no snippets action').not.toBeNull()
    button!.click()

    expect(presses()).toBe(1)
  })

  it('with no callback wired the button is inert rather than broken', () => {
    setupVerticalStrip()
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Snippets"]')!
    expect(() => button.click()).not.toThrow()
  })
})
