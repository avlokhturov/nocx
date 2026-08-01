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

  it('typing while recall is open gives the draft back and lets the key land', () => {
    const { ed, view, recall } = setupRecall({ query: mkQuery(['rm -rf build']) })
    ed.show()
    ed.insertText('git s')
    key(view, { key: 'ArrowUp' })
    expect(recall.isOpen).toBe(true)
    // A stray key dismisses recall and restores the draft; the key itself is
    // not consumed, so a real keystroke lands in the restored draft (jsdom
    // cannot synthesize CM6's input events, so the landing itself is not
    // observable here — the not-consumed contract is).
    const ev = key(view, { key: 't' })
    expect(recall.isOpen).toBe(false)
    expect(ed.getDoc()).toBe('git s')
    expect(ev.defaultPrevented).toBe(false)
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

  it('a rung that can widen says so; the top rung does not', () => {
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
    key(view, { key: 'ArrowUp' }) // climbs: directory 1, host 1 → everywhere
    const text = panelOf(container).textContent ?? ''
    expect(text).toContain('everywhere') // the top rung is named
    expect(text).not.toContain('↑ widens') // nothing wider to promise
  })
})

describe('recall: the footer and the labels say what the keys do', () => {
  it('all hints are one line: three key groups in one footer, real gaps between them', () => {
    const { container, view } = setupRecall({ query: mkQuery(['one', 'two', 'three']) })
    key(view, { key: 'ArrowUp' })
    const footer = container.querySelector<HTMLElement>('.ui-recall-panel__footer')
    expect(footer).not.toBeNull()
    // The key groups are siblings of one footer element — the CSS lays them
    // out on one line with a real gap (white-space: nowrap; display: flex),
    // so no hint gets its own row and none can wrap apart from the others.
    const groups = footer?.querySelectorAll<HTMLElement>(':scope > span') ?? []
    expect(groups.length).toBe(3)
    expect(groups[0]?.textContent).toBe('↵ to execute')
    expect(groups[1]?.textContent).toBe('↑ ↓ to navigate')
    expect(groups[2]?.textContent).toBe('esc to dismiss')
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
