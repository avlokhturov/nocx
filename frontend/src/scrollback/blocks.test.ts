// Block manager tests — DOM creation, freeze lifecycle, clear behaviour.
// Updated for flat design (P0-1) and single-select model (P1-7, P1-8).

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import {
  BlockManager,
  createCommandBlock,
  createRunningBlock,
  freezeBlock,
  deselectAllBlocks,
  getSelectedBlock,
} from './blocks'
import { shellHighlightReady } from '../shell-highlight'
import { BufferLine } from './test-helpers'
import { setCurrentTheme, _resetThemeState } from '../renderers/theme-adapter'
import { CommandSnapshotStore } from '../command-snapshot'

/** Helper: returns a container supplier that references the given element. */
function makeContainer(el: HTMLElement): () => HTMLElement {
  return () => el
}

const noopSelect = (): void => {}

/** A fresh, empty store — verdicts default to "no snapshot" per test. */
const freshStore = (): CommandSnapshotStore => new CommandSnapshotStore()

describe('createRunningBlock', () => {
  it('creates a div with classes cmd-block and cmd-block-running', () => {
    const container = document.createElement('div')
    const el = createRunningBlock(1, 'ls -la', '~', '', () => container, noopSelect, freshStore())
    expect(el.tagName).toBe('DIV')
    expect(el.classList.contains('cmd-block')).toBe(true)
    expect(el.classList.contains('cmd-block-running')).toBe(true)
    expect(el.getAttribute('data-block-id')).toBe('1')
  })

  it('includes command text in header', () => {
    const container = document.createElement('div')
    const el = createRunningBlock(1, 'ls -la', '~', '', () => container, noopSelect, freshStore())
    const text = el.querySelector('.cmd-header-text')
    expect(text?.textContent).toBe('ls -la')
  })

  it('includes cwd chip in the header (standard .nocx-chip component)', () => {
    const container = document.createElement('div')
    const el = createRunningBlock(
      1,
      'echo hi',
      '/home/dev/projects',
      '',
      () => container,
      noopSelect,
      freshStore(),
    )
    const cwd = el.querySelector('.cmd-header-cwd')
    expect(cwd?.textContent).toBe('\u{1F4C1} dev/projects')
    expect(cwd?.classList.contains('nocx-chip')).toBe(true)
  })

  it('shows a spinner for running state', () => {
    const container = document.createElement('div')
    const el = createRunningBlock(1, 'sleep 10', '~', '', () => container, noopSelect, freshStore())
    const spinner = el.querySelector('.cmd-header-spinner')
    expect(spinner).not.toBeNull()
  })

  it('has no output area until freeze (P0-3)', () => {
    const container = document.createElement('div')
    const el = createRunningBlock(1, 'cmd', '~', '', () => container, noopSelect, freshStore())
    const output = el.querySelector('.cmd-output')
    expect(output).toBeNull()
  })

  it('includes overflow menu button (P2-9)', () => {
    const container = document.createElement('div')
    const el = createRunningBlock(1, 'cmd', '~', '', () => container, noopSelect, freshStore())
    const btn = el.querySelector('.cmd-overflow-btn')
    expect(btn).not.toBeNull()
  })
})

describe('createCommandBlock', () => {
  const c = (): HTMLElement => document.createElement('div')

  it('creates a frozen block with success status', () => {
    const el = createCommandBlock(
      1,
      'echo hello',
      '~',
      '',
      'output',
      42,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    expect(el.classList.contains('cmd-block')).toBe(true)
    const exit = el.querySelector('.cmd-header-exit-ok')
    expect(exit?.textContent).toBe('ok')
  })

  it('creates a frozen block with failure status', () => {
    const el = createCommandBlock(
      2,
      'false',
      '~',
      '',
      '',
      5,
      1,
      'failure',
      c,
      noopSelect,
      freshStore(),
    )
    const exit = el.querySelector('.cmd-header-exit-fail')
    expect(exit?.textContent).toBe('exit 1')
  })

  it('includes serialized output', () => {
    const el = createCommandBlock(
      1,
      'ls',
      '~',
      '',
      '<span class="term-line">file.txt</span>',
      10,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    const output = el.querySelector('.cmd-output')
    expect(output?.innerHTML).toContain('file.txt')
  })

  it('a double-click applies the whole-token selection ONCE, at the second mousedown', () => {
    const el = createCommandBlock(
      1,
      'ls',
      '~',
      '',
      '<span class="term-line">profile-usage.json</span>',
      10,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    document.body.appendChild(el)
    const line = el.querySelector<HTMLElement>('.term-line')
    const node = (line?.firstChild as Text | null) ?? null
    expect(node).not.toBeNull()
    // jsdom has no hit-testing; point caretRangeFromPoint inside the token
    // ('usage') so the handler's browser seam resolves like a real click.
    const proto = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const r = document.createRange()
        r.setStart(node!, 8)
        r.collapse(true)
        return r
      },
    })
    try {
      const sel = window.getSelection()
      const addRangeSpy = vi.spyOn(sel!, 'addRange')
      // The browser creates its native word selection on the SECOND mousedown
      // (event.detail === 2), before the dblclick event fires. The handler
      // must prevent that default and apply OUR token range in one operation
      // — exactly one selection state, nothing for copy-on-select to race.
      const ev = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        detail: 2,
        clientX: 10,
        clientY: 10,
      })
      line?.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true) // native word-select stopped
      expect(addRangeSpy).toHaveBeenCalledTimes(1) // ours, and only ours
      expect(sel?.toString()).toBe('profile-usage.json')
      // No dblclick listener remains: the event does nothing further.
      line?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(addRangeSpy).toHaveBeenCalledTimes(1)
      expect(sel?.toString()).toBe('profile-usage.json')
    } finally {
      if (proto) {
        Object.defineProperty(document, 'caretRangeFromPoint', proto)
      } else {
        delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint
      }
      el.remove()
    }
  })

  it('a single mousedown is not intercepted — native selection and click-to-select keep working', () => {
    const el = createCommandBlock(
      1,
      'ls',
      '~',
      '',
      '<span class="term-line">profile-usage.json</span>',
      10,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    document.body.appendChild(el)
    const line = el.querySelector<HTMLElement>('.term-line')
    const ev = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: 10,
      clientY: 10,
    })
    line?.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false) // drag selection must survive
    el.remove()
  })

  it('includes duration', () => {
    const el = createCommandBlock(
      1,
      'sleep 1',
      '~',
      '',
      'some output',
      1234,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    const dur = el.querySelector('.cmd-header-duration')
    expect(dur?.textContent).toBe('1.2s')
  })

  it('omits exit badge when exitCode is null', () => {
    const el = createCommandBlock(
      1,
      'cmd',
      '~',
      '',
      'out',
      null,
      null,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    expect(el.querySelector('.cmd-header-exit')).toBeNull()
  })

  it('omits .cmd-output when outputHtml is empty (P0-3)', () => {
    const el = createCommandBlock(
      1,
      'cd repos',
      '~',
      '',
      '',
      3,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    expect(el.querySelector('.cmd-output')).toBeNull()
  })

  it('omits .cmd-output when outputHtml is only empty term-lines (P0-3)', () => {
    const el = createCommandBlock(
      1,
      'cmd',
      '~',
      '',
      '<span class="term-line"></span>',
      1,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    expect(el.querySelector('.cmd-output')).toBeNull()
  })

  it('includes overflow menu button (P2-9)', () => {
    const el = createCommandBlock(
      1,
      'ls',
      '~',
      '',
      'output',
      10,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    const btn = el.querySelector('.cmd-overflow-btn')
    expect(btn).not.toBeNull()
  })

  it('cwd label uses plain text, no emoji (P0-1 flat pivot)', () => {
    const el = createCommandBlock(
      1,
      'cmd',
      '/home/user/repos',
      '',
      'out',
      10,
      0,
      'success',
      c,
      noopSelect,
      freshStore(),
    )
    const cwdEl = el.querySelector('.cmd-header-cwd')
    expect(cwdEl?.textContent).toBe('\u{1F4C1} user/repos')
  })
})

describe('freezeBlock', () => {
  it('replaces a running block with a frozen one in the DOM', () => {
    const parent = document.createElement('div')
    const container = document.createElement('div')
    const running = createRunningBlock(
      1,
      'sleep 5',
      '~',
      '',
      () => container,
      noopSelect,
      freshStore(),
    )
    parent.appendChild(running)

    const frozen = freezeBlock(
      running,
      1,
      'sleep 5',
      '~',
      '',
      '<span>done</span>',
      5100,
      0,
      () => container,
      noopSelect,
      freshStore(),
    )
    expect(parent.children.length).toBe(1)
    expect(parent.children[0]).toBe(frozen)
    expect(frozen.classList.contains('cmd-block')).toBe(true)
    expect(frozen.querySelector('.cmd-header-exit-ok')).not.toBeNull()
    expect(frozen.querySelector('.cmd-output')?.innerHTML).toContain('done')
  })

  it('adds overflow menu to frozen block (P2-9)', () => {
    const parent = document.createElement('div')
    const container = document.createElement('div')
    const running = createRunningBlock(1, 'ls', '~', '', () => container, noopSelect, freshStore())
    parent.appendChild(running)
    const frozen = freezeBlock(
      running,
      1,
      'ls',
      '~',
      '',
      '<span>ok</span>',
      100,
      0,
      () => container,
      noopSelect,
      freshStore(),
    )
    expect(frozen.querySelector('.cmd-overflow-btn')).not.toBeNull()
  })
})

describe('block selection model (P1-7, P1-8)', () => {
  it('click selects a block', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const el = createCommandBlock(
      1,
      'cmd',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      makeContainer(parent),
      noopSelect,
      freshStore(),
    )

    parent.appendChild(el)

    // Simulate click: mousedown + mouseup without movement
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    expect(el.classList.contains('cmd-block-selected')).toBe(true)
    document.body.removeChild(parent)
  })

  it('clicking a second block deselects the first (P1-8: single-select)', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    const el1 = createCommandBlock(
      1,
      'cmd1',
      '~',
      '',
      'out1',
      10,
      0,
      'success',
      makeContainer(parent),
      noopSelect,
      freshStore(),
    )
    const el2 = createCommandBlock(
      2,
      'cmd2',
      '~',
      '',
      'out2',
      10,
      0,
      'success',
      makeContainer(parent),
      noopSelect,
      freshStore(),
    )
    parent.append(el1, el2)

    // Select first block
    el1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el1.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(el1.classList.contains('cmd-block-selected')).toBe(true)

    // Select second block — should deselect first
    el2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el2.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(el1.classList.contains('cmd-block-selected')).toBe(false)
    expect(el2.classList.contains('cmd-block-selected')).toBe(true)

    document.body.removeChild(parent)
  })

  it('clicking an already-selected block deselects it', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    const el = createCommandBlock(
      1,
      'cmd',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      makeContainer(parent),
      noopSelect,
      freshStore(),
    )
    parent.appendChild(el)

    // First click selects
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(el.classList.contains('cmd-block-selected')).toBe(true)

    // Second click deselects
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(el.classList.contains('cmd-block-selected')).toBe(false)

    document.body.removeChild(parent)
  })

  it('drag (mousedown+mousemove+mouseup) does NOT select block', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    const el = createCommandBlock(
      1,
      'cmd',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      makeContainer(parent),
      noopSelect,
      freshStore(),
    )
    parent.appendChild(el)

    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    expect(el.classList.contains('cmd-block-selected')).toBe(false)

    document.body.removeChild(parent)
  })

  it('deselectAllBlocks removes selection', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    const el = createCommandBlock(
      1,
      'cmd',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      makeContainer(parent),
      noopSelect,
      freshStore(),
    )
    parent.appendChild(el)

    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(el.classList.contains('cmd-block-selected')).toBe(true)

    deselectAllBlocks(parent)
    expect(el.classList.contains('cmd-block-selected')).toBe(false)
    expect(getSelectedBlock(parent)).toBeNull()

    document.body.removeChild(parent)
  })

  it('getSelectedBlock returns the selected element', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)

    const el = createCommandBlock(
      1,
      'cmd',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      makeContainer(parent),
      noopSelect,
      freshStore(),
    )
    parent.appendChild(el)

    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    expect(getSelectedBlock(parent)).toBe(el)

    document.body.removeChild(parent)
  })
})

describe('BlockManager', () => {
  let manager: BlockManager
  let inner: HTMLElement
  let xtermContainer: HTMLElement
  let fixedNow: number

  beforeEach(() => {
    _resetThemeState()
    inner = document.createElement('div')
    xtermContainer = document.createElement('div')
    inner.appendChild(xtermContainer)
    document.body.appendChild(inner)
    fixedNow = 1000
    manager = new BlockManager(inner, xtermContainer, {
      now: () => fixedNow,
      snapshotStore: freshStore(),
    })
  })

  it('starts a running block', () => {
    const rec = manager.startBlock('ls -la', '~', 10)
    expect(rec.command).toBe('ls -la')
    expect(rec.status).toBe('running')
    expect(rec.id).toBe(1)
    expect(inner.children.length).toBe(2) // running block + xterm container
    expect(inner.children[0].classList.contains('cmd-block-running')).toBe(true)
    expect(manager.runningBlock).toBe(rec)
  })

  it('inserts the running block before the xterm container', () => {
    manager.startBlock('cmd', '~', 5)
    expect(inner.children[0]).toBe(manager.blocks[0]?.el)
    expect(inner.children[1]).toBe(xtermContainer)
  })

  it('finalizes orphaned running block on next start', () => {
    const first = manager.startBlock('cmd1', '~', 0)
    const second = manager.startBlock('cmd2', '~', 5)
    expect(first.status).toBe('failure')
    expect(manager.runningBlock).toBe(second)
  })

  it('stores blocks in order', () => {
    manager.startBlock('a', '~', 0)
    manager.startBlock('b', '~', 0)
    expect(manager.blocks.length).toBe(2)
    expect(manager.blocks[0].command).toBe('a')
    expect(manager.blocks[1].command).toBe('b')
  })

  it('clearAll removes all blocks and resets state', () => {
    manager.startBlock('test', '~', 0)
    expect(inner.children.length).toBe(2)
    manager.clearAll()
    expect(inner.children.length).toBe(1) // only xterm container remains
    expect(manager.blocks.length).toBe(0)
    expect(manager.runningBlock).toBeNull()
  })

  it('freezeBlock returns null when no running block', () => {
    const result = manager.freezeBlock(() => undefined, 20, 0)
    expect(result).toBeNull()
  })

  it('dispose clears all', () => {
    manager.startBlock('test', '~', 0)
    manager.dispose()
    expect(manager.blocks.length).toBe(0)
    expect(inner.children.length).toBe(1)
  })

  it('selectedBlockId is null initially', () => {
    expect(manager.selectedBlockId).toBeNull()
  })

  it('deselectAll is safe when nothing is selected', () => {
    manager.startBlock('test', '~', 0)
    expect(() => manager.deselectAll()).not.toThrow()
  })

  it('deselectAll clears selectedBlockId', () => {
    const rec = manager.startBlock('test', '~', 0)
    // Programmatically select: add class + notify manager
    rec.el.classList.add('cmd-block-selected')
    manager._onBlockSelected(rec.id)
    expect(manager.selectedBlockId).toBe(rec.id)
    // Deselect
    manager.deselectAll()
    expect(manager.selectedBlockId).toBeNull()
    expect(rec.el.classList.contains('cmd-block-selected')).toBe(false)
  })

  it('freezeBlock captures theme snapshot at freeze time', () => {
    const themeA = {
      foreground: '#111111',
      background: '#000000',
      black: '#000000',
      red: '#aa0000',
      green: '#00aa00',
      yellow: '#aaaa00',
      blue: '#0000aa',
      magenta: '#aa00aa',
      cyan: '#00aaaa',
      white: '#aaaaaa',
      brightBlack: '#555555',
      brightRed: '#ff5555',
      brightGreen: '#55ff55',
      brightYellow: '#ffff55',
      brightBlue: '#5555ff',
      brightMagenta: '#ff55ff',
      brightCyan: '#55ffff',
      brightWhite: '#ffffff',
      cursor: '#ffffff',
      cursorAccent: '#000000',
      selectionBackground: '#335577',
    }
    const themeB = {
      foreground: '#cccccc',
      background: '#222222',
      black: '#222222',
      red: '#cc0000',
      green: '#00cc00',
      yellow: '#cccc00',
      blue: '#0000cc',
      magenta: '#cc00cc',
      cyan: '#00cccc',
      white: '#cccccc',
      brightBlack: '#666666',
      brightRed: '#ff6666',
      brightGreen: '#66ff66',
      brightYellow: '#ffff66',
      brightBlue: '#6666ff',
      brightMagenta: '#ff66ff',
      brightCyan: '#66ffff',
      brightWhite: '#eeeeee',
      cursor: '#eeeeee',
      cursorAccent: '#222222',
      selectionBackground: '#446688',
    }

    // First block with theme A
    setCurrentTheme(themeA)
    manager.startBlock('cmd1', '~', 0)
    const linesA = [new BufferLine('hello', false)]
    const recA = manager.freezeBlock((y) => linesA[y] ?? undefined, 0, 0)
    expect(recA).not.toBeNull()
    // Defaults are no longer baked in — plain text follows the app's colours —
    // so what this asserts is that the block exists and carries its text, with
    // the palette question moved to serializer.test.ts where a cell actually
    // sets an ANSI colour (nocx-6w4z).
    const outputA = recA!.el.querySelector('.cmd-output')
    expect(outputA?.innerHTML).toContain('hello')
    expect(outputA?.innerHTML).not.toContain('#111111')

    // Second block with theme B
    setCurrentTheme(themeB)
    manager.startBlock('cmd2', '~', 0)
    const linesB = [new BufferLine('world', false)]
    const recB = manager.freezeBlock((y) => linesB[y] ?? undefined, 0, 0)
    expect(recB).not.toBeNull()
    const outputB = recB!.el.querySelector('.cmd-output')
    expect(outputB?.innerHTML).toContain('world')
    expect(outputB?.innerHTML).not.toContain('#cccccc')
    expect(outputB?.innerHTML).not.toContain('#111111')

    // And the first block is still untouched by theme B — which is the property
    // this test is really about. It is asserted by absence now: neither block
    // carries a default colour at all, so a theme change cannot reach into an
    // old block's plain text. Frozen ANSI colours are covered in
    // serializer.test.ts, where a cell actually sets one (nocx-6w4z).
    expect(outputA?.innerHTML).toContain('hello')
    expect(outputA?.innerHTML).not.toContain('#cccccc')
  })
})

describe('overflow menu (P1-6)', () => {
  it('opens menu on ⋮ click', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const el = createCommandBlock(
      1,
      'echo hello',
      '~',
      '',
      'output',
      42,
      0,
      'success',
      () => container,
      noopSelect,
      freshStore(),
    )
    container.appendChild(el)

    const btn = el.querySelector('.cmd-overflow-btn') as HTMLElement
    expect(btn).not.toBeNull()

    // Click the ⋮ button
    btn.click()

    // Menu should now exist in document.body
    const menu = document.body.querySelector('.cmd-overflow-menu')
    expect(menu).not.toBeNull()

    // Clean up
    menu?.remove()
    document.body.removeChild(container)
  })

  it('closes menu on outside click', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const el = createCommandBlock(
      1,
      'echo hello',
      '~',
      '',
      'output',
      42,
      0,
      'success',
      () => container,
      noopSelect,
      freshStore(),
    )
    container.appendChild(el)

    const btn = el.querySelector('.cmd-overflow-btn') as HTMLElement
    btn.click()

    // Menu should exist
    expect(document.body.querySelector('.cmd-overflow-menu')).not.toBeNull()

    // Wait for the setTimeout(0) that registers the close listener
    await new Promise((r) => setTimeout(r, 10))

    // Click outside
    document.body.click()

    // Menu should be removed
    expect(document.body.querySelector('.cmd-overflow-menu')).toBeNull()

    document.body.removeChild(container)
  })

  it('closes menu on Escape key', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const el = createCommandBlock(
      1,
      'echo hello',
      '~',
      '',
      'output',
      42,
      0,
      'success',
      () => container,
      noopSelect,
      freshStore(),
    )
    container.appendChild(el)

    const btn = el.querySelector('.cmd-overflow-btn') as HTMLElement
    btn.click()

    expect(document.body.querySelector('.cmd-overflow-menu')).not.toBeNull()

    // Press Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(document.body.querySelector('.cmd-overflow-menu')).toBeNull()

    document.body.removeChild(container)
  })

  it('toggles menu closed on second ⋮ click', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const el = createCommandBlock(
      1,
      'echo hello',
      '~',
      '',
      'output',
      42,
      0,
      'success',
      () => container,
      noopSelect,
      freshStore(),
    )
    container.appendChild(el)

    const btn = el.querySelector('.cmd-overflow-btn') as HTMLElement

    // First click opens
    btn.click()
    expect(document.body.querySelector('.cmd-overflow-menu')).not.toBeNull()

    // Second click closes
    btn.click()
    expect(document.body.querySelector('.cmd-overflow-menu')).toBeNull()

    document.body.removeChild(container)
  })
})

describe('frozen block header highlighting', () => {
  // The frozen header is highlighted by the same Shiki tokenizer as the live
  // editor; the grammar loads asynchronously at module init, so wait for it.
  beforeAll(async () => {
    await shellHighlightReady
  })

  it('highlights the frozen header with the same token classes as the live editor', () => {
    const container = document.createElement('div')
    const el = createCommandBlock(
      1,
      'ls -la | grep foo > out.txt',
      '~',
      '',
      '<div></div>',
      100,
      0,
      'success',
      () => container,
      noopSelect,
      freshStore(),
    )
    const byClass = new Map<string, string[]>()
    for (const span of el.querySelectorAll<HTMLElement>('.cmd-header-text [class^="tok-"]')) {
      const cls = span.className
      byClass.set(cls, [...(byClass.get(cls) ?? []), span.textContent ?? ''])
    }
    expect(byClass.get('tok-command')).toEqual(['ls', 'grep'])
    expect(byClass.get('tok-flag')).toEqual(['-la'])
    expect(byClass.get('tok-operator')).toEqual(['|', '>'])
    // Bare words after the command are unquoted arguments in the VS Code
    // grammar, so `foo` shares the path role with the redirect target.
    expect(byClass.get('tok-path')).toEqual(['foo', 'out.txt'])
    // The visible text is unchanged by the highlight pass.
    expect(el.querySelector('.cmd-header-text')?.textContent).toBe('ls -la | grep foo > out.txt')
  })

  it('keeps a running header plain (no token spans)', () => {
    const container = document.createElement('div')
    const el = createRunningBlock(
      1,
      'ls -la | grep foo > out.txt',
      '~',
      '',
      () => container,
      noopSelect,
      freshStore(),
    )
    expect(el.querySelector('.cmd-header-text')?.textContent).toBe('ls -la | grep foo > out.txt')
    expect(el.querySelectorAll('.cmd-header-text [class^="tok-"]').length).toBe(0)
  })
})

// ── Frozen headers carry command-existence verdicts (OSC 636) ──────────────
// The verdict is read at freeze time from the session snapshot: a header
// frozen before the snapshot arrives keeps no verdict (the one-shot snapshot
// never changes, so a frozen verdict can never go stale).

describe('frozen headers and the command snapshot', () => {
  beforeAll(async () => {
    await shellHighlightReady
  })

  const c = (): HTMLElement => document.createElement('div')
  const SEED_NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  /** A fresh tab store seeded with the given names (or left empty). */
  const makeStore = (names?: string[]): CommandSnapshotStore => {
    const store = freshStore()
    if (names) {
      store.ingest(`H;${SEED_NONCE}`)
      store.ingest(`S;${SEED_NONCE};${names.join(';')}`)
    }
    return store
  }

  it('a frozen header of an unknown command carries the underline class', () => {
    const el = createCommandBlock(
      1,
      'sdfsdf',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      c,
      noopSelect,
      makeStore(['pwd']),
    )
    const span = el.querySelector<HTMLElement>('.cmd-header-text span')
    expect(span?.className).toBe('tok-command tok-unresolved')
  })

  it('a frozen header of a known builtin keeps the plain command class', () => {
    const el = createCommandBlock(
      2,
      'pwd',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      c,
      noopSelect,
      makeStore(['pwd']),
    )
    const span = el.querySelector<HTMLElement>('.cmd-header-text span')
    expect(span?.className).toBe('tok-command')
  })

  it('with no snapshot a frozen header carries no verdict', () => {
    const el = createCommandBlock(
      3,
      'sdfsdf',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      c,
      noopSelect,
      makeStore(),
    )
    const span = el.querySelector<HTMLElement>('.cmd-header-text span')
    expect(span?.className).toBe('tok-command')
  })

  it("a header frozen against one tab's snapshot never sees another tab's names", () => {
    const other = makeStore(['kubectl']) // the sibling tab's session…
    const mine = makeStore(['pwd']) // …vs this tab's session
    expect(other.has('kubectl')).toBe(true)
    expect(mine.has('kubectl')).toBe(false)
    const el = createCommandBlock(
      4,
      'kubectl',
      '~',
      '',
      'out',
      10,
      0,
      'success',
      c,
      noopSelect,
      mine,
    )
    const span = el.querySelector<HTMLElement>('.cmd-header-text span')
    expect(span?.className).toBe('tok-command tok-unresolved')
  })
})

describe('a vault reference in a block reads as a chip, not as its own syntax', () => {
  // The editor draws {{secret:NAME}} as a chip and the block drew it raw, so
  // the same command looked like two different things depending on whether
  // it had been submitted yet.
  it('renders the reference as the resolved chip and keeps the text for copy', () => {
    const command = 'curl -H "Authorization: Bearer {{secret:openrouter.ai}}" https://api'
    const container = document.createElement('div')
    const running = createRunningBlock(
      1,
      command,
      '~',
      '',
      () => container,
      noopSelect,
      freshStore(),
    )
    const el = freezeBlock(
      running,
      1,
      command,
      '~',
      '',
      '<span>ok</span>',
      100,
      0,
      () => container,
      noopSelect,
      freshStore(),
    )
    const chip = el.querySelector('.ui-secret-chip')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('openrouter.ai')
    expect(el.querySelector('.cmd-header-text')?.textContent).not.toContain('{{secret:')
    // Copy still yields the command as typed — the chip is a label.
    expect(el.dataset.recordedCommand).toBe(command)
  })
})
