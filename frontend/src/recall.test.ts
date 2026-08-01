// @vitest-environment jsdom
// Recall overlay (design §8.10): the history palette above the prompt —
// oldest at the top, newest at the bottom, the newest row selected on open,
// so the first Up gives the command you just ran. Written as a user reaching
// the feature — the editor is real, the keys land on it, and the overlay is
// wired through the same arbiter the terminal uses. The rule (brief
// nocx-w7h.5 reversed the v4 one): navigating previews the selected command
// INTO the editor, and Enter executes what you can see through the editor's
// own submit path — the ordinary "type a command and press Enter", with the
// typing done for you. Esc restores the draft, caret and scroll exactly; Up
// is caret movement first.
import { describe, it, expect, vi } from 'vitest'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { CommandEditor, type EditorActions } from './editor'
import { RecallOverlay, queryLedgerHistory, relativeTime, type RecallScope } from './recall'
import { CommandLedger } from './command-ledger'
import type { HistoryEntry, HistoryQuery } from './generated/history.query'

const viewOf = (ed: CommandEditor): EditorView => (ed as unknown as { view: EditorView }).view

/** Dispatch a keydown exactly where a user's keystroke lands. Returns the
 *  event so tests can observe whether the handler consumed it. */
const key = (view: EditorView, init: KeyboardEventInit) => {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(ev)
  return ev
}

function mkEntry(command: string, endedAt: number | null = 1000): HistoryEntry {
  return {
    id: `${command}-${endedAt}`,
    command,
    cwd: '~',
    host: '',
    status: 'success',
    endedAt,
  }
}

function mkQuery(
  commands: string[],
  source: 'store' | 'session' = 'session',
): (scope: RecallScope) => HistoryQuery {
  return (scope) => ({
    entries: commands.map((c, i) => mkEntry(c, 1000 - i)),
    scope,
    exhausted: true,
    source,
  })
}

function emptyQuery(source: 'store' | 'session' = 'session'): (scope: RecallScope) => HistoryQuery {
  return (scope) => ({ entries: [], scope, exhausted: true, source })
}

function setupRecall(opts: {
  query?: (scope: RecallScope) => HistoryQuery
  actions?: Partial<EditorActions>
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const submit = opts.actions?.submit ?? vi.fn()
  const actions: EditorActions = { submit, cancel: vi.fn(), ...opts.actions }
  const ed = new CommandEditor(actions, [keymap.of([...defaultKeymap])])
  ed.mount(container)
  const view = viewOf(ed)
  const recall = new RecallOverlay({ editor: ed, query: opts.query ?? emptyQuery() })
  recall.mount(ed.root)
  ed.setKeyArbiter((e) => recall.handleKey(e))
  // The terminal-content wiring: Up at the top of a draft opens recall.
  actions.onUpAtTop = () => recall.open('directory')
  return { container, ed, view, recall, submit }
}

const panelOf = (container: HTMLElement): HTMLElement => {
  const p = container.querySelector<HTMLElement>('.ui-recall-panel')
  if (!p) throw new Error('recall panel not mounted')
  return p
}

describe('recall: Enter executes the previewed command', () => {
  it('Enter while navigating submits the previewed command and closes the overlay', () => {
    const { ed, view, recall, submit } = setupRecall({ query: mkQuery(['rm -rf build']) })
    ed.show()

    // Empty draft, caret at top: Up opens recall; the row is previewed.
    key(view, { key: 'ArrowUp' })
    expect(recall.isOpen).toBe(true)
    expect(ed.getDoc()).toBe('rm -rf build')

    key(view, { key: 'Enter' })
    expect(recall.isOpen).toBe(false)
    // The previewed command went out through the editor's own submit action —
    // the same one a typed Enter fires — not through a second route.
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('rm -rf build')
  })

  it('Esc after previewing restores the draft and sends nothing', () => {
    const { ed, view, recall, submit } = setupRecall({ query: mkQuery(['rm -rf build']) })
    ed.show()
    ed.insertText('git s')
    key(view, { key: 'ArrowUp' })
    expect(ed.getDoc()).toBe('rm -rf build') // previewed

    key(view, { key: 'Escape' })
    expect(recall.isOpen).toBe(false)
    expect(ed.getDoc()).toBe('git s') // the draft, not the preview, is back
    expect(submit).not.toHaveBeenCalled() // and nothing was sent
  })

  it('typing while navigating keeps the previewed command as the new draft', () => {
    const { ed, view, recall } = setupRecall({ query: mkQuery(['docker compose up']) })
    ed.show()
    ed.insertText('git s')
    key(view, { key: 'ArrowUp' })
    expect(recall.isOpen).toBe(true)
    expect(ed.getDoc()).toBe('docker compose up') // previewed
    // An insertion hands the line to the editor: the overlay closes and the
    // preview STAYS as the new draft. Restoring the captured draft (dismiss)
    // is what cleared the line; the third exit must not do that. jsdom cannot
    // synthesize CM6's input events, so the 'd' landing is not observable —
    // the not-consumed contract and the kept line are.
    const ev = key(view, { key: 'd' })
    expect(recall.isOpen).toBe(false)
    expect(ed.getDoc()).toBe('docker compose up')
    expect(ev.defaultPrevented).toBe(false)
  })

  it('deleting while navigating keeps the previewed command as the new draft', () => {
    const { ed, view, recall } = setupRecall({ query: mkQuery(['docker compose up']) })
    ed.show()
    key(view, { key: 'ArrowUp' })
    expect(ed.getDoc()).toBe('docker compose up')
    // Backspace lands ON the preview (CM6 runs its deletion on the keydown,
    // unlike text insertion which jsdom cannot synthesize): the overlay is
    // gone and the kept command carries the edit — 'docker compose u'.
    key(view, { key: 'Backspace' })
    expect(recall.isOpen).toBe(false)
    expect(ed.getDoc()).toBe('docker compose u')
  })

  it('a caret move while navigating keeps the previewed command as the new draft', () => {
    const { ed, view, recall } = setupRecall({ query: mkQuery(['docker compose up']) })
    ed.show()
    key(view, { key: 'ArrowUp' })
    expect(ed.getDoc()).toBe('docker compose up')
    // CM6 owns the caret afterwards (it consumes the arrow key for movement),
    // which is exactly the point: the overlay released the line, preview kept.
    key(view, { key: 'ArrowRight' })
    expect(recall.isOpen).toBe(false)
    expect(ed.getDoc()).toBe('docker compose up')
  })

  it('Ctrl-C while recall is open dismisses it and never interrupts the shell', () => {
    const cancel = vi.fn()
    const { ed, view, recall } = setupRecall({ query: mkQuery(['ls']), actions: { cancel } })
    ed.show()
    key(view, { key: 'ArrowUp' })
    expect(recall.isOpen).toBe(true)
    key(view, { key: 'c', ctrlKey: true })
    expect(recall.isOpen).toBe(false)
    expect(ed.getDoc()).toBe('') // the draft (empty) was restored
    expect(cancel).not.toHaveBeenCalled() // no \x03 went to the shell
  })
})
describe('recall: Esc restores the draft, caret and scroll exactly', () => {
  it('restores text, selection and scroll after navigating', () => {
    const { ed, view, recall } = setupRecall({ query: mkQuery(['one', 'two']) })
    ed.show()
    ed.insertText('line one\nline two')
    // The user had a selection and a scroll offset when recall opened.
    view.dispatch({ selection: { anchor: 2, head: 5 } })
    ed.setScrollTop(37)

    // The explicit shortcut opens recall from anywhere — even line 2.
    key(view, { key: 'r', ctrlKey: true })
    expect(recall.isOpen).toBe(true)
    key(view, { key: 'ArrowDown' }) // at the newest (bottom): stays
    key(view, { key: 'ArrowUp' }) // older
    expect(ed.getDoc()).toBe('two') // previewing the older row

    key(view, { key: 'Escape' })
    expect(recall.isOpen).toBe(false)
    expect(ed.getDoc()).toBe('line one\nline two')
    expect(ed.getSelection()).toEqual({ from: 2, to: 5 })
    expect(ed.getScrollTop()).toBe(37)
  })
})

describe("recall: oldest at the top, newest at the bottom (Warp's model)", () => {
  it('renders oldest at the top and selects the newest (bottom) row on open', () => {
    // mkQuery lists commands newest-first — the wire order; the renderer
    // reverses for display.
    const { container, view } = setupRecall({ query: mkQuery(['newest', 'middle', 'oldest']) })
    key(view, { key: 'ArrowUp' })
    const rows = container.querySelectorAll<HTMLElement>('.ui-collection-row')
    expect(rows.length).toBe(3)
    expect(rows[0]?.textContent).toContain('oldest') // oldest at the top
    expect(rows[2]?.textContent).toContain('newest') // newest at the bottom
    const selected = container.querySelector<HTMLElement>(
      '.ui-collection-row[data-selected="true"]',
    )
    expect(selected?.textContent).toContain('newest') // the bottom row
  })

  it('Up from the bottom moves to the previous (older) command', () => {
    const { container, view } = setupRecall({ query: mkQuery(['newest', 'middle', 'oldest']) })
    key(view, { key: 'ArrowUp' }) // opens with the newest (bottom) selected
    key(view, { key: 'ArrowUp' }) // older
    const selected = container.querySelector<HTMLElement>(
      '.ui-collection-row[data-selected="true"]',
    )
    expect(selected?.textContent).toContain('middle')
  })

  it('Down at the bottom stays on the newest command', () => {
    const { container, view } = setupRecall({ query: mkQuery(['newest', 'middle', 'oldest']) })
    key(view, { key: 'ArrowUp' })
    key(view, { key: 'ArrowDown' })
    const selected = container.querySelector<HTMLElement>(
      '.ui-collection-row[data-selected="true"]',
    )
    expect(selected?.textContent).toContain('newest')
  })

  it('a single row is selected and previewed on open', () => {
    const { ed, container, view } = setupRecall({ query: mkQuery(['only']) })
    key(view, { key: 'ArrowUp' })
    const selected = container.querySelector<HTMLElement>(
      '.ui-collection-row[data-selected="true"]',
    )
    expect(selected?.textContent).toContain('only')
    expect(ed.getDoc()).toBe('only')
  })
})

describe('recall: arrows navigate, the list follows, widening is its own key (v8)', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `c${i + 1}`) // c1 newest

  it('Up and Down walk every entry of a twelve-result rung, the scroll following', () => {
    const { ed, view } = setupRecall({ query: mkQuery(twelve) })
    const spy = vi.fn()
    /* eslint-disable @typescript-eslint/unbound-method */
    const proto = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollIntoView = spy
    try {
      key(view, { key: 'ArrowUp' }) // opens on the newest (bottom) row
      expect(ed.getDoc()).toBe('c1')
      // Hold Up past the visible window to the top of the rung.
      for (let i = 0; i < 11; i++) key(view, { key: 'ArrowUp' })
      expect(ed.getDoc()).toBe('c12') // the oldest entry — all 12 reachable
      // Down returns through everything Up passed.
      for (let i = 0; i < 11; i++) key(view, { key: 'ArrowDown' })
      expect(ed.getDoc()).toBe('c1')
      // Every move asked the browser to keep the selected row in view — the
      // mechanism that makes a 12-result rung walkable past an 8-row window.
      expect(spy).toHaveBeenCalledWith({ block: 'nearest' })
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(12)
    } finally {
      Element.prototype.scrollIntoView = proto
    }
  })

  it('Up at the oldest entry stops: no widen, no teleport', () => {
    const { container, ed, view } = setupRecall({ query: mkQuery(['c1', 'c2', 'c3']) })
    key(view, { key: 'ArrowUp' }) // opens on c1 (newest)
    key(view, { key: 'ArrowUp' }) // c2
    key(view, { key: 'ArrowUp' }) // c3 (oldest, display top)
    key(view, { key: 'ArrowUp' }) // must stop
    expect(ed.getDoc()).toBe('c3') // selection unchanged
    expect(panelOf(container).textContent).toContain('this directory') // no widen
  })

  it('the widen key (shift+Up) preserves the selected command across rungs', () => {
    const { container, ed, view } = setupRecall({
      query: (scope) => {
        const entries =
          scope === 'directory'
            ? [mkEntry('c1'), mkEntry('c2'), mkEntry('c3')]
            : [mkEntry('c1'), mkEntry('c2'), mkEntry('c3'), mkEntry('c4')]
        return { entries, scope, exhausted: true, source: 'session' }
      },
    })
    key(view, { key: 'ArrowUp' }) // c1 (newest, bottom)
    key(view, { key: 'ArrowUp' }) // c2
    key(view, { key: 'ArrowUp', shiftKey: true }) // widen
    expect(panelOf(container).textContent).toContain('this host')
    expect(ed.getDoc()).toBe('c2') // the same command, not either end
  })
})

describe('recall: Up is caret movement first (design §8.10 v6)', () => {
  it('Up on line 2 of a two-line draft does not open recall (caret movement first)', () => {
    const onUpAtTop = vi.fn()
    const { ed, view, recall } = setupRecall({ query: mkQuery(['one']), actions: { onUpAtTop } })
    ed.show()
    ed.insertText('line one\nline two')
    const lineOf = (pos: number) => view.state.doc.lineAt(pos).number
    expect(lineOf(ed.getSelection().from)).toBe(2)

    const ev = key(view, { key: 'ArrowUp' })
    // The boundary we own: recall stays closed and onUpAtTop does not fire —
    // the key belongs to the editor's caret movement. (CM6's Up command runs
    // and consumes the key even in jsdom, where no layout exists for it to
    // actually move the caret; the movement itself is not observable here.)
    expect(recall.isOpen).toBe(false)
    expect(onUpAtTop).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true) // CM6's own Up command handled it
  })
  it('Up on an empty draft opens recall', () => {
    const { view, recall } = setupRecall({ query: mkQuery(['one']) })
    key(view, { key: 'ArrowUp' })
    expect(recall.isOpen).toBe(true)
  })

  it('the explicit shortcut (Ctrl-R) opens recall from anywhere', () => {
    const { ed, view, recall } = setupRecall({ query: mkQuery(['one']) })
    ed.show()
    ed.insertText('line one\nline two') // caret on line 2
    key(view, { key: 'r', ctrlKey: true })
    expect(recall.isOpen).toBe(true)
    expect(ed.getDoc()).toBe('one')
  })
})

describe('recall: what the panel says', () => {
  it("with source 'session' the panel says what it is showing", () => {
    const { container, view } = setupRecall({ query: mkQuery(['one'], 'session') })
    key(view, { key: 'ArrowUp' })
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('this session only')
  })

  it('empty history opens an overlay that says it is empty', () => {
    const { container, view, recall } = setupRecall({ query: emptyQuery() })
    key(view, { key: 'ArrowUp' })
    expect(recall.isOpen).toBe(true)
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('no history yet')
    // It can still be dismissed.
    key(view, { key: 'Escape' })
    expect(recall.isOpen).toBe(false)
  })

  it('an empty directory rung opens on the first rung that has rows', () => {
    const { container, view, recall } = setupRecall({
      query: (scope) =>
        scope === 'directory'
          ? { entries: [], scope, exhausted: true, source: 'session' }
          : {
              entries: [mkEntry('ls /tmp'), mkEntry('pwd'), mkEntry('whoami')],
              scope,
              exhausted: true,
              source: 'session',
            },
    })
    key(view, { key: 'ArrowUp' })
    expect(recall.isOpen).toBe(true)
    const text = panelOf(container).textContent ?? ''
    expect(text).not.toContain('no history yet') // never the near-empty rung
    expect(text).toContain('this host') // the rung widened and is named
    expect(text).toContain('ls /tmp') // and the rows appeared with it
  })

  it('a directory with one match opens on a wider rung, not on the near-empty one', () => {
    const { container, view } = setupRecall({
      query: (scope) =>
        scope === 'directory'
          ? { entries: [mkEntry('ls')], scope, exhausted: true, source: 'session' }
          : {
              entries: [mkEntry('ls'), mkEntry('make deploy'), mkEntry('git status')],
              scope,
              exhausted: true,
              source: 'session',
            },
    })
    key(view, { key: 'ArrowUp' })
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('this host') // the rung is named on screen
    expect(text).toContain('make deploy') // and its rows are there
  })

  it('a rung with a useful page stays on that rung', () => {
    const { container, view } = setupRecall({
      query: (scope) => ({
        entries:
          scope === 'directory'
            ? [mkEntry('ls'), mkEntry('git status'), mkEntry('make')]
            : [mkEntry('ls'), mkEntry('git status'), mkEntry('make'), mkEntry('x')],
        scope,
        exhausted: true,
        source: 'session',
      }),
    })
    key(view, { key: 'ArrowUp' })
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('this directory')
  })

  it('the widen key is shown when the rung can widen, and not at the top rung', () => {
    const narrow = {
      entries: [mkEntry('ls')],
      scope: 'directory' as const,
      exhausted: true,
      source: 'session' as const,
    }
    const { container, view } = setupRecall({
      query: (scope) => ({
        entries:
          scope === 'directory'
            ? narrow.entries
            : scope === 'host'
              ? narrow.entries
              : [mkEntry('ls'), mkEntry('make'), mkEntry('git')],
        scope,
        exhausted: true,
        source: 'session',
      }),
    })
    key(view, { key: 'ArrowUp' }) // open-time climb: directory 1, host 1 → everywhere
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('everywhere') // the top rung is named
    expect(text).not.toContain('shift+↑ widen') // nothing wider to promise

    const second = setupRecall({ query: mkQuery(['one', 'two', 'three']) })
    key(second.view, { key: 'ArrowUp' })
    expect(panelOf(second.container).textContent).toContain('shift+↑ widen')
  })
})

describe('recall: the footer and the labels say what the keys do', () => {
  it('all hints are one line: the key groups in one footer, real gaps between them', () => {
    const { container, view } = setupRecall({ query: mkQuery(['one', 'two', 'three']) })
    key(view, { key: 'ArrowUp' })
    const footer = container.querySelector<HTMLElement>('.ui-recall-panel__footer')
    expect(footer).not.toBeNull()
    // The key groups are siblings of one footer element — the CSS lays them
    // out on one line with a real gap (white-space: nowrap; display: flex),
    // so no hint gets its own row and none can wrap apart from the others.
    const groups = footer?.querySelectorAll<HTMLElement>(':scope > span') ?? []
    expect(groups.length).toBe(4)
    expect(groups[0]?.textContent).toBe('↵ to execute')
    expect(groups[1]?.textContent).toBe('↑ ↓ to navigate')
    expect(groups[2]?.textContent).toBe('shift+↑ widen')
    expect(groups[3]?.textContent).toBe('esc to dismiss')
    expect(footer?.querySelector('br')).toBeNull()
  })

  it('Enter is labelled as executing the previewed command', () => {
    const { container, view } = setupRecall({
      query: mkQuery(['rm -rf build', 'ls', 'git status']),
    })
    key(view, { key: 'ArrowUp' })
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('↵ to execute')
    expect(text).not.toContain('fill the line')
  })

  it('the empty panel does not promise execution', () => {
    const { container, view } = setupRecall({ query: emptyQuery() })
    key(view, { key: 'ArrowUp' })
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('no history yet')
    expect(text).not.toContain('↵ to execute') // nothing to execute
  })
})

describe('recall: relative time', () => {
  it('endedAt null renders as running, never as the epoch', () => {
    const { container, view } = setupRecall({
      query: (scope) => ({
        entries: [mkEntry('sleep 5', null)],
        scope,
        exhausted: true,
        source: 'session',
      }),
    })
    key(view, { key: 'ArrowUp' })
    const time = container.querySelector<HTMLElement>('.ui-recall-panel__time')
    expect(time?.textContent).toBe('running')
    expect(time?.textContent).not.toBe('1970')
  })

  it('renders the screenshot cases: just now, 21 hours ago, 1 week ago', () => {
    const now = 1_000_000_000
    expect(relativeTime(now - 30_000, now)).toBe('just now')
    expect(relativeTime(now - 21 * 3_600_000, now)).toBe('21 hours ago')
    expect(relativeTime(now - 7 * 86_400_000, now)).toBe('1 week ago')
  })
})

describe('queryLedgerHistory: the session stopgap behind the generated types', () => {
  it('maps the ledger newest-first, filtered to the ladder rung', () => {
    const now = () => 1000
    const ledger = new CommandLedger({ now })
    ledger.open('first', '/a', 'h1', () => undefined)
    ledger.open('second', '/b', 'h1', () => undefined)
    ledger.open('third', '/a', 'h2', () => undefined)

    const dir = queryLedgerHistory(ledger, 'directory', '/a', 'h1')
    expect(dir.entries.map((e) => e.command)).toEqual(['first'])
    expect(dir.source).toBe('session')

    const host = queryLedgerHistory(ledger, 'host', '/a', 'h1')
    expect(host.entries.map((e) => e.command)).toEqual(['second', 'first'])

    const everywhere = queryLedgerHistory(ledger, 'everywhere', '/a', 'h1')
    expect(everywhere.entries.map((e) => e.command)).toEqual(['third', 'second', 'first'])
  })
})
