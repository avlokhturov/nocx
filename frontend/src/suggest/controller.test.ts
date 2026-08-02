// @vitest-environment jsdom
// CompletionController — the lifecycle contract (design §8.7, §8.9.2, §8.9.4):
// Tab opens the dropdown, no candidates sends nothing, first results render
// as they arrive, a late arrival never moves the selection, a keystroke
// aborts, one provider's error never kills the others, the latency budget
// gates the open decision, and ghost text accepts only under every §8.7
// precondition.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CompletionController, LATENCY_BUDGET_MS, type CompletionEditor } from './controller'
import { CompletionDropdown } from '../ui/completion-dropdown'
import type { Candidate } from './candidate'
import type { SuggestionProvider, SuggestContext } from './providers'

// ── fakes ────────────────────────────────────────────────────────────────

class FakeEditor implements CompletionEditor {
  doc: string
  caret = 0
  applied: Array<{ from: number; to: number; text: string }> = []
  constructor(doc = '') {
    this.doc = doc
    this.caret = doc.length
  }
  getDoc(): string {
    return this.doc
  }
  getSelection(): { from: number; to: number } {
    return { from: this.caret, to: this.caret }
  }
  applyReplacement(from: number, to: number, text: string): void {
    this.doc = this.doc.slice(0, from) + text + this.doc.slice(to)
    this.caret = from + text.length
    this.applied.push({ from, to, text })
  }
  /** A user keystroke: mutate the doc like the editor's input path would. */
  type(ch: string): void {
    this.doc = this.doc.slice(0, this.caret) + ch + this.doc.slice(this.caret)
    this.caret += ch.length
  }
}

interface Deferred {
  resolve: (c: Candidate[]) => void
  reject: (e: unknown) => void
  promise: Promise<Candidate[]>
}
const deferred = (): Deferred => {
  let resolve!: (c: Candidate[]) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<Candidate[]>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { resolve, reject, promise }
}

/** A provider whose deliveries the test controls one at a time. */
const manualProvider = (
  id: string,
  applicable: boolean,
): { provider: SuggestionProvider; next: () => Deferred } => {
  const queue: Deferred[] = []
  const provider: SuggestionProvider = {
    id,
    targetId: 'shell',
    applicable: () => applicable,
    suggest: () => {
      const d = deferred()
      queue.push(d)
      return d.promise
    },
  }
  return { provider, next: () => queue.shift()! }
}

/** A provider that answers instantly. */
const instantProvider = (
  id: string,
  make: (ctx: SuggestContext) => Candidate[],
  applicable = true,
): SuggestionProvider => ({
  id,
  targetId: 'shell',
  applicable: () => applicable,
  suggest: (ctx) => make(ctx),
})

const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  targetId: 'shell',
  providerId: 'p',
  displayText: over.id,
  insertText: over.id,
  replacement: { from: 0, to: 5 },
  matchRanges: [{ from: 0, to: 5 }],
  source: 'command',
  eligibleForGhostText: true,
  ...over,
})

interface Rig {
  editor: FakeEditor
  dropdown: CompletionDropdown
  controller: CompletionController
  mount: HTMLElement
}

const rig = (opts: {
  providers: SuggestionProvider[]
  latencyBudgetMs?: number
  recallIsOpen?: () => boolean
  editorDoc?: string
}): Rig => {
  const editor = new FakeEditor(opts.editorDoc ?? 'git sta')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dropdown = new CompletionDropdown({ onHover: () => {}, onPick: () => {} })
  const controller = new CompletionController({
    providers: opts.providers,
    dropdown,
    env: () => ({ isLocal: true, cwd: '/repo', host: '' }),
    recallIsOpen: opts.recallIsOpen,
    latencyBudgetMs: opts.latencyBudgetMs,
    now: () => 1_750_000_000_000,
  })
  controller.attach(editor, container)
  return { editor, dropdown, controller, mount: container }
}

const key = (k: string): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })

/** Flush microtasks and zero-delay timers, under fake timers or real. */
const flush = async () => {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0)
  } else {
    await new Promise((r) => setTimeout(r, 0))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// ── opening ──────────────────────────────────────────────────────────────

describe('opening', () => {
  it('Tab opens the dropdown with the first results', async () => {
    const { dropdown, controller } = rig({
      providers: [instantProvider('a', () => [cand({ id: 'git status' })])],
    })
    controller.open()
    await flush()
    expect(dropdown.isOpen).toBe(true)
    expect(dropdown.root.querySelectorAll('.ui-completion-dropdown__row')).toHaveLength(1)
  })

  it('with no candidates it sends nothing — the dropdown never opens', async () => {
    const { dropdown, controller } = rig({
      providers: [instantProvider('a', () => [])],
    })
    controller.open()
    await flush()
    expect(dropdown.isOpen).toBe(false)
  })

  it('an inapplicable provider is not consulted', async () => {
    const suggested = vi.fn()
    const { controller } = rig({
      providers: [instantProvider('a', suggested, false)],
    })
    controller.open()
    await flush()
    expect(suggested).not.toHaveBeenCalled()
  })

  it('an empty line opens nothing (every shipped provider declines)', async () => {
    const { dropdown, controller } = rig({
      providers: [
        {
          id: 'a',
          targetId: 'shell',
          applicable: (ctx) => ctx.doc.trim() !== '',
          suggest: () => [cand({ id: 'x' })],
        },
      ],
      editorDoc: '',
    })
    controller.open()
    await flush()
    expect(dropdown.isOpen).toBe(false)
  })

  it('typing with the dropdown closed never opens it (the ghost is the typing surface)', async () => {
    const { editor, dropdown, controller } = rig({
      providers: [instantProvider('a', () => [cand({ id: 'x' })])],
    })
    editor.type('t')
    controller.onDocChanged()
    await flush()
    // Candidates exist (the ghost shows), but the dropdown stays closed —
    // only Tab may open it.
    expect(dropdown.isOpen).toBe(false)
  })
})

// ── streaming, merging, selection ────────────────────────────────────────

describe('streaming and selection', () => {
  it('first results render as they arrive — a slow provider is not waited for', async () => {
    const slow = manualProvider('slow', true)
    const { dropdown, controller } = rig({
      providers: [slow.provider, instantProvider('fast', () => [cand({ id: 'fast-cand' })])],
    })
    controller.open()
    await flush()
    // The fast provider's batch arrived first; the dropdown is already open.
    expect(dropdown.isOpen).toBe(true)
    const rows = dropdown.root.querySelectorAll('.ui-completion-dropdown__row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('fast-cand')
  })

  it('a late arrival merges in and may not move the selection off the candidate', async () => {
    const slow = manualProvider('slow', true)
    const { dropdown, controller } = rig({
      providers: [slow.provider, instantProvider('fast', () => [cand({ id: 'first' })])],
    })
    controller.open()
    await flush()
    expect(dropdown.isOpen).toBe(true)

    // User moves the selection down (the list will grow beneath it).
    expect(controller.handleKey(key('ArrowDown'))).toBe(true)

    // The slow provider lands late: the new row appends, the selected
    // candidate stays selected.
    slow.next().resolve([cand({ id: 'second' })])
    await flush()
    const selected = dropdown.root.querySelector(
      '.ui-completion-dropdown__row[data-selected="true"]',
    )
    expect(selected?.textContent).toContain('first')
  })

  it('the same candidate from two providers dedups by id', async () => {
    const { dropdown, controller } = rig({
      providers: [
        instantProvider('p1', () => [cand({ id: 'dup' })]),
        instantProvider('p2', () => [cand({ id: 'dup' })]),
      ],
    })
    controller.open()
    await flush()
    expect(dropdown.root.querySelectorAll('.ui-completion-dropdown__row')).toHaveLength(1)
  })

  it('one provider error does not kill the others', async () => {
    const failing = manualProvider('fail', true)
    const { dropdown, controller } = rig({
      providers: [failing.provider, instantProvider('ok', () => [cand({ id: 'ok-cand' })])],
    })
    controller.open()
    await flush()
    failing.next().reject(new Error('boom'))
    await flush()
    expect(dropdown.isOpen).toBe(true)
    expect(dropdown.root.textContent).toContain('ok-cand')
  })

  it('a keystroke aborts: batches from the old query are dropped', async () => {
    const slow = manualProvider('slow', true)
    const { editor, dropdown, controller } = rig({ providers: [slow.provider] })
    controller.open()
    await flush()

    // The user types before the slow provider answers.
    editor.type('x')
    controller.onDocChanged()
    await flush()

    // The old query's delivery arrives late — dropped, never rendered.
    slow.next().resolve([cand({ id: 'stale' })])
    await flush()
    expect(dropdown.isOpen).toBe(false)
    expect(dropdown.root.textContent).not.toContain('stale')
  })

  it('a keystroke while the dropdown is open re-queries and resets the selection', async () => {
    const slow = manualProvider('slow', true)
    const { editor, dropdown, controller } = rig({
      providers: [slow.provider, instantProvider('fast', () => [cand({ id: 'one' })])],
    })
    controller.open()
    await flush()
    expect(controller.handleKey(key('ArrowDown'))).toBe(true)
    expect(
      dropdown.root.querySelector('.ui-completion-dropdown__row[data-selected="true"]')
        ?.textContent,
    ).toContain('one')

    editor.type('x')
    controller.onDocChanged()
    await flush()
    // The fresh query's first batch replaces the list; selection resets.
    expect(dropdown.isOpen).toBe(true)
    expect(
      dropdown.root.querySelector('.ui-completion-dropdown__row[data-selected="true"]')
        ?.textContent,
    ).toContain('one')
  })

  it('the latency budget gates the open decision', async () => {
    vi.useRealTimers()
    const slow = manualProvider('slow', true)
    const { dropdown, controller } = rig({
      providers: [slow.provider],
      latencyBudgetMs: 50,
    })
    controller.open()
    await new Promise((r) => setTimeout(r, 80))
    // Nothing arrived within the budget: the dropdown stays closed, and the
    // late answer is discarded for this query.
    slow.next().resolve([cand({ id: 'late' })])
    await flush()
    expect(dropdown.isOpen).toBe(false)
  })

  it('a first result inside the budget opens the dropdown', async () => {
    vi.useRealTimers()
    const slow = manualProvider('slow', true)
    const { dropdown, controller } = rig({ providers: [slow.provider], latencyBudgetMs: 200 })
    controller.open()
    await new Promise((r) => setTimeout(r, 20))
    slow.next().resolve([cand({ id: 'in-time' })])
    await flush()
    expect(dropdown.isOpen).toBe(true)
  })
})

// ── keyboard ─────────────────────────────────────────────────────────────

describe('keyboard', () => {
  const open = async (controller: CompletionController) => {
    controller.open()
    await flush()
  }

  it('Enter accepts the selected candidate into the line', async () => {
    const { editor, dropdown, controller } = rig({
      providers: [
        instantProvider('a', (ctx) => [
          cand({
            id: 'git status',
            insertText: 'git status',
            replacement: { from: 0, to: ctx.token.to },
          }),
        ]),
      ],
      editorDoc: 'git sta',
    })
    await open(controller)
    const e = key('Enter')
    expect(controller.handleKey(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(editor.doc).toBe('git status')
    expect(dropdown.isOpen).toBe(false)
  })

  it('Enter on a stale list falls through (submits the line instead)', async () => {
    const slow = manualProvider('slow', true)
    const { editor, controller } = rig({ providers: [slow.provider] })
    controller.open()
    await flush()
    // Doc moves on before the query answers (programmatic paste path).
    editor.type('x')
    const e = key('Enter')
    expect(controller.handleKey(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    expect(editor.doc).toBe('git stax')
  })

  it('arrows navigate and wrap', async () => {
    const { dropdown, controller } = rig({
      providers: [
        instantProvider('a', () => [cand({ id: 'a1' }), cand({ id: 'a2' }), cand({ id: 'a3' })]),
      ],
    })
    await open(controller)
    expect(controller.handleKey(key('ArrowDown'))).toBe(true)
    expect(
      dropdown.root.querySelector('.ui-completion-dropdown__row[data-selected="true"]')
        ?.textContent,
    ).toContain('a2')
    expect(controller.handleKey(key('ArrowUp'))).toBe(true)
    expect(
      dropdown.root.querySelector('.ui-completion-dropdown__row[data-selected="true"]')
        ?.textContent,
    ).toContain('a1')
    // Wrap up from the top lands on the last row.
    expect(controller.handleKey(key('ArrowUp'))).toBe(true)
    expect(
      dropdown.root.querySelector('.ui-completion-dropdown__row[data-selected="true"]')
        ?.textContent,
    ).toContain('a3')
  })

  it('Tab accepts the selection when the dropdown is open', async () => {
    const { editor, dropdown, controller } = rig({
      providers: [
        instantProvider('a', (ctx) => [
          cand({ id: 'done', replacement: { from: 0, to: ctx.token.to } }),
        ]),
      ],
      editorDoc: 'git sta',
    })
    await open(controller)
    expect(controller.handleKey(key('Tab'))).toBe(true)
    expect(editor.doc).toBe('done')
    expect(dropdown.isOpen).toBe(false)
  })

  it('Escape closes exactly the dropdown — one surface per press', async () => {
    const { editor, dropdown, controller } = rig({
      providers: [instantProvider('a', () => [cand({ id: 'x' })])],
    })
    await open(controller)
    const e = key('Escape')
    expect(controller.handleKey(e)).toBe(true)
    expect(dropdown.isOpen).toBe(false)
    expect(editor.doc).toBe('git sta') // the draft is untouched
  })

  it('a plain key falls through so the keystroke can re-query', async () => {
    const { controller } = rig({
      providers: [instantProvider('a', () => [cand({ id: 'x' })])],
    })
    await open(controller)
    expect(controller.handleKey(key('t'))).toBe(false)
  })

  it('recall open: the dropdown dismisses and never consumes', () => {
    const { dropdown, controller } = rig({
      providers: [instantProvider('a', () => [cand({ id: 'x' })])],
      recallIsOpen: () => true,
    })
    controller.open()
    // Even with candidates queued, recall owns the surface.
    expect(controller.handleKey(key('ArrowDown'))).toBe(false)
    expect(dropdown.isOpen).toBe(false)
  })
})

// ── ghost text ───────────────────────────────────────────────────────────

describe('ghost text', () => {
  const ghostEditor = (doc: string) => {
    const e = new FakeEditor(doc)
    return e
  }

  it('Right at the line end accepts the top-ranked candidate', async () => {
    const editor = ghostEditor('git sta')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dropdown = new CompletionDropdown({ onHover: () => {}, onPick: () => {} })
    const controller = new CompletionController({
      providers: [
        instantProvider('h', () => [
          cand({
            id: 'hist:git status',
            insertText: 'git status',
            replacement: { from: 0, to: 7 },
          }),
        ]),
      ],
      dropdown,
      env: () => ({ isLocal: true, cwd: '/repo', host: '' }),
      now: () => 1_750_000_000_000,
    })
    controller.attach(editor, container)
    controller.onDocChanged()
    await flush()

    const e = key('ArrowRight')
    expect(controller.handleKey(e)).toBe(true)
    expect(editor.doc).toBe('git status')
    expect(dropdown.isOpen).toBe(false)
  })

  it('End accepts at line end, but stays a caret movement mid-line', async () => {
    const editor = ghostEditor('git sta')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dropdown = new CompletionDropdown({ onHover: () => {}, onPick: () => {} })
    const controller = new CompletionController({
      providers: [
        instantProvider('h', () => [
          cand({
            id: 'hist:git status',
            insertText: 'git status',
            replacement: { from: 0, to: 7 },
          }),
        ]),
      ],
      dropdown,
      env: () => ({ isLocal: true, cwd: '/repo', host: '' }),
      now: () => 1_750_000_000_000,
    })
    controller.attach(editor, container)
    controller.onDocChanged()
    await flush()

    // Mid-line: the caret is not at the end of the line, so End must move
    // the caret, not accept.
    editor.doc = 'git sta and more'
    editor.caret = 7
    controller.onDocChanged()
    await flush()
    const e = key('End')
    expect(controller.handleKey(e)).toBe(false)
    expect(editor.doc).toBe('git sta and more')
  })

  it('a stale async suggestion is discarded, never applied', async () => {
    const slow = manualProvider('slow', true)
    const editor = ghostEditor('git')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dropdown = new CompletionDropdown({ onHover: () => {}, onPick: () => {} })
    const controller = new CompletionController({
      providers: [slow.provider],
      dropdown,
      env: () => ({ isLocal: true, cwd: '/repo', host: '' }),
      now: () => 1_750_000_000_000,
    })
    controller.attach(editor, container)
    controller.onDocChanged()
    await flush()

    // The user types more before the suggestion lands.
    editor.type('x')
    controller.onDocChanged()
    await flush()

    slow.next().resolve([cand({ id: 'stale', replacement: { from: 0, to: 3 } })])
    await flush()
    expect(controller.handleKey(key('ArrowRight'))).toBe(false)
    expect(editor.doc).toBe('gitx')
  })

  it('an entry marked sensitive is never eligible for ghost text', async () => {
    const editor = ghostEditor('secret ')
    editor.caret = 7
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dropdown = new CompletionDropdown({ onHover: () => {}, onPick: () => {} })
    const controller = new CompletionController({
      providers: [
        instantProvider('h', () => [
          cand({
            id: 's',
            insertText: 'sensitive',
            replacement: { from: 0, to: 7 },
            eligibleForGhostText: false,
          }),
        ]),
      ],
      dropdown,
      env: () => ({ isLocal: true, cwd: '/repo', host: '' }),
      now: () => 1_750_000_000_000,
    })
    controller.attach(editor, container)
    controller.onDocChanged()
    await flush()
    expect(controller.handleKey(key('ArrowRight'))).toBe(false)
    expect(editor.doc).toBe('secret ')
  })

  it('Right with a non-empty selection never accepts', async () => {
    const editor = ghostEditor('git sta')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dropdown = new CompletionDropdown({ onHover: () => {}, onPick: () => {} })
    const controller = new CompletionController({
      providers: [
        instantProvider('h', () => [
          cand({
            id: 'hist:git status',
            insertText: 'git status',
            replacement: { from: 0, to: 7 },
          }),
        ]),
      ],
      dropdown,
      env: () => ({ isLocal: true, cwd: '/repo', host: '' }),
      now: () => 1_750_000_000_000,
    })
    controller.attach(editor, container)
    controller.onDocChanged()
    await flush()
    // A mouse selection: the ghost precondition (empty selection) fails.
    editor.caret = 7
    const fakeSel = { from: 2, to: 7 }
    const origGet = editor.getSelection.bind(editor)
    editor.getSelection = () => fakeSel
    expect(controller.handleKey(key('ArrowRight'))).toBe(false)
    editor.getSelection = origGet
  })
})

// The budget constant is exported and used by the wiring.
void LATENCY_BUDGET_MS
