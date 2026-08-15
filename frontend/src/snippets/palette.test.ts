// @vitest-environment jsdom
// The snippet palette (design §10.1, bead nocx-jj77) — the acceptance
// criteria, asserted against the real palette over a real SnippetsStore
// with a fake client:
//
//   - lists the library in stored order; filters by title and body;
//     arrows/Esc/Enter/Cmd-Enter
//   - a snippet with ask spans turns the panel into the field form IN
//     PLACE — one panel, never two
//   - a refusal renders in the panel and stays; it is not a toast
//   - with the store unavailable the panel says so instead of an empty list
//   - an ask value is not remembered between fires and never reaches the
//     real logging seam
//   - a delivered fire closes the palette and returns focus; a refusal does
//     neither
//   - the fire environment is read at fire time, not captured at
//     construction (the palette holds no facts: every fire goes through
//     deps.fire, and the adapter's facts-at-call-time is fire.test.ts's)
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SnippetsStore, type SnippetsClientLike } from './snippets-store'
import type { Snippet } from './snippets-store'
import { SnippetPalette } from './palette'
import type { SnippetFireOutcome, SnippetFireRequest } from './fire'

const SNIP = (over: Partial<Snippet>): Snippet => ({
  id: 's-' + Math.random().toString(36).slice(2, 8),
  title: 'untitled',
  body: '',
  ...over,
})

/** A store whose list() answers with the given library. */
function storeOf(snippets: Snippet[], over: Partial<SnippetsClientLike> = {}): SnippetsStore {
  const client: SnippetsClientLike = {
    list: vi.fn().mockResolvedValue({ snippets }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    ...over,
  }
  return new SnippetsStore(client)
}

interface Mount {
  store: SnippetsStore
  palette: SnippetPalette
  fire: Mock<(req: SnippetFireRequest) => Promise<SnippetFireOutcome>>
  pane: HTMLElement
}

interface MountOpts {
  fire?: Mount['fire']
  /** Overrides for the store's fake client (e.g. a rejecting list). */
  storeOver?: Partial<SnippetsClientLike>
}

function mount(snippets: Snippet[], opts: MountOpts = {}): Mount {
  const store = storeOf(snippets, opts.storeOver)
  const fireMock =
    opts.fire ??
    vi.fn().mockResolvedValue({ kind: 'delivered', where: 'pty' } satisfies SnippetFireOutcome)
  const palette = new SnippetPalette({ store, fire: fireMock })
  const pane = document.createElement('div')
  document.body.appendChild(pane)
  return { store, palette, fire: fireMock, pane }
}

/** Wait until the palette's rows have the given titles. */
async function waitRows(palette: SnippetPalette, count: number): Promise<HTMLElement[]> {
  const root = (palette as unknown as { panel: { root: HTMLElement } }).panel.root
  await vi.waitFor(() => {
    expect(root.querySelectorAll('.ui-floating-panel__row')).toHaveLength(count)
  })
  return [...root.querySelectorAll<HTMLElement>('.ui-floating-panel__row')]
}

const panelRoot = (m: Mount): HTMLElement =>
  (m.palette as unknown as { panel: { root: HTMLElement } }).panel.root

/** A keydown at the panel's focused input — where a user's keystroke lands. */
function keyOn(m: Mount, init: KeyboardEventInit): void {
  const input = panelRoot(m).querySelector<HTMLInputElement>('input')
  expect(input, 'the panel must have a focused input').not.toBeNull()
  input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

function typeFilter(m: Mount, text: string): void {
  const input = panelRoot(m).querySelector<HTMLInputElement>('input')!
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const rowTexts = (m: Mount): string[] =>
  [...panelRoot(m).querySelectorAll<HTMLElement>('.ui-floating-panel__row')].map(
    (r) => r.textContent ?? '',
  )

beforeEach(() => {
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('the snippet palette (nocx-jj77)', () => {
  it('lists the library in stored order', async () => {
    const m = mount([
      SNIP({ id: 'a', title: 'first', body: 'echo 1' }),
      SNIP({ id: 'b', title: 'second', body: 'echo 2' }),
      SNIP({ id: 'c', title: 'third', body: 'echo 3' }),
    ])
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 3)
      expect(rowTexts(m)).toEqual(['first', 'second', 'third'])
    } finally {
      m.palette.close()
    }
  })

  it('filters by title AND body', async () => {
    const m = mount([
      SNIP({ id: 'a', title: 'git push', body: 'git push origin main' }),
      SNIP({ id: 'b', title: 'deploy', body: 'ssh prod deploy' }),
    ])
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 2)
      // A body-only match keeps the row (the filter is honest even when the
      // visible title does not contain the query).
      typeFilter(m, 'origin')
      await waitRows(m.palette, 1)
      expect(rowTexts(m)).toEqual(['git push'])
      // And a title match.
      typeFilter(m, 'deploy')
      await waitRows(m.palette, 1)
      expect(rowTexts(m)).toEqual(['deploy'])
      // No match → the honest zero-candidates row, never silence.
      typeFilter(m, 'zzz')
      await waitRows(m.palette, 0)
    } finally {
      m.palette.close()
    }
  })

  it('arrows move the selection; Enter fires into the input owner; ⌘Enter copies', async () => {
    const m = mount([
      SNIP({ id: 'a', title: 'first', body: 'echo 1' }),
      SNIP({ id: 'b', title: 'second', body: 'echo 2' }),
    ])
    // Open one: ArrowDown picks the second row, Enter fires it into the
    // input owner — and the delivered fire CLOSES the palette.
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 2)
      keyOn(m, { key: 'ArrowDown' })
      keyOn(m, { key: 'Enter' })
      expect(m.fire).toHaveBeenCalledTimes(1)
      expect(m.fire.mock.calls[0][0].snippet.title).toBe('second')
      expect(m.fire.mock.calls[0][0].destination).toBe('input')
      await vi.waitFor(() => expect(m.palette.isOpen).toBe(false))
    } finally {
      m.palette.close()
    }
    // Reopen: ⌘Enter on the selected (first) row copies instead.
    m.fire.mockClear()
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 2)
      keyOn(m, { key: 'Enter', metaKey: true })
      expect(m.fire).toHaveBeenCalledTimes(1)
      expect(m.fire.mock.calls[0][0].snippet.title).toBe('first')
      expect(m.fire.mock.calls[0][0].destination).toBe('clipboard')
      await vi.waitFor(() => expect(m.palette.isOpen).toBe(false))
    } finally {
      m.palette.close()
    }
  })

  it('Esc closes the list', async () => {
    const m = mount([SNIP({ id: 'a', title: 'first', body: 'echo 1' })])
    m.palette.open(m.pane)
    await waitRows(m.palette, 1)
    keyOn(m, { key: 'Escape' })
    expect(m.palette.isOpen).toBe(false)
    m.palette.close()
  })

  it('a snippet with ask spans turns the panel into the field form IN PLACE — one panel, never two', async () => {
    const m = mount([
      SNIP({ id: 'a', title: 'tunnel', body: 'ssh -L {{ask:local=8080}}:localhost:80' }),
    ])
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 1)
      const root = panelRoot(m)
      keyOn(m, { key: 'Enter' })
      // The SAME panel now holds the field form: one ui-floating-panel, its
      // field inputs inside — no second surface anywhere.
      await vi.waitFor(() => {
        expect(root.classList.contains('ui-floating-panel')).toBe(true)
        expect(root.querySelectorAll('.ui-floating-panel__field input')).toHaveLength(1)
      })
      const input = root.querySelector<HTMLInputElement>('.ui-floating-panel__field input')!
      // The default is prefilled (design §8).
      expect(input.value).toBe('8080')
      input.value = '9090'
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => expect(m.fire).toHaveBeenCalledTimes(1))
      const req = m.fire.mock.calls[0][0]
      expect(req.snippet.title).toBe('tunnel')
      expect([...req.answers.entries()]).toEqual([['local', '9090']])
      expect(req.destination).toBe('input')
      // Delivered → closed.
      await vi.waitFor(() => expect(m.palette.isOpen).toBe(false))
    } finally {
      m.palette.close()
    }
  })

  it('Esc in the form cancels the CHOICE, not the palette: back to the list', async () => {
    const m = mount([SNIP({ id: 'a', title: 'asky', body: 'x {{ask:v}}' })])
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 1)
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => {
        expect(panelRoot(m).querySelectorAll('.ui-floating-panel__field input')).toHaveLength(1)
      })
      keyOn(m, { key: 'Escape' })
      expect(m.palette.isOpen).toBe(true)
      expect(panelRoot(m).querySelectorAll('.ui-floating-panel__row')).toHaveLength(1)
      expect(m.fire).not.toHaveBeenCalled()
    } finally {
      m.palette.close()
    }
  })

  it('a refusal renders IN the panel and stays — it is not a toast, and focus does not return', async () => {
    const m = mount([SNIP({ id: 'a', title: 'multi', body: 'line1\nline2' })], {
      fire: vi.fn().mockResolvedValue({
        kind: 'refused',
        reason: { kind: 'multi-line-no-bracketed-paste' },
      } satisfies SnippetFireOutcome),
    })
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 1)
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => {
        expect(panelRoot(m).textContent).toContain('bracketed paste')
      })
      // The panel stays open with the refusal in it.
      expect(m.palette.isOpen).toBe(true)
      // It is not a toast: no toast host element anywhere, and the message
      // lives inside the panel.
      expect(document.querySelector('.ui-toast')).toBeNull()
      expect(panelRoot(m).querySelector('[data-refusal="true"]')).not.toBeNull()
      // The alternative is offered in the footer: ⌘↵ copies instead.
      expect(panelRoot(m).textContent).toContain('⌘↵ to copy instead')
      // Esc dismisses it.
      keyOn(m, { key: 'Escape' })
      expect(m.palette.isOpen).toBe(false)
    } finally {
      m.palette.close()
    }
  })

  it("the multi-line refusal's ⌘↵ alternative copies — a SECOND fire, still one panel", async () => {
    const m = mount([SNIP({ id: 'a', title: 'multi', body: 'line1\nline2' })], {
      fire: vi.fn().mockImplementation((req: SnippetFireRequest): Promise<SnippetFireOutcome> =>
        req.destination === 'clipboard'
          ? Promise.resolve({ kind: 'delivered', where: 'clipboard' })
          : Promise.resolve({
              kind: 'refused',
              reason: { kind: 'multi-line-no-bracketed-paste' },
            }),
      ),
    })
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 1)
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => expect(panelRoot(m).textContent).toContain('bracketed paste'))
      keyOn(m, { key: 'Enter', metaKey: true })
      await vi.waitFor(() => expect(m.palette.isOpen).toBe(false))
      const destinations = m.fire.mock.calls.map((c) => c[0].destination)
      expect(destinations).toEqual(['input', 'clipboard'])
    } finally {
      m.palette.close()
    }
  })

  it('with the store unavailable the panel says so instead of showing an empty list', async () => {
    const m = mount([], {
      storeOver: { list: vi.fn().mockRejectedValue(new Error('backend unreachable')) },
    })
    m.palette.open(m.pane)
    try {
      await vi.waitFor(() => {
        expect(panelRoot(m).textContent).toContain('backend unreachable')
      })
      expect(m.palette.isOpen).toBe(true)
    } finally {
      m.palette.close()
    }
  })

  it('with an empty library the panel says so', async () => {
    const m = mount([])
    m.palette.open(m.pane)
    try {
      await vi.waitFor(() => {
        expect(panelRoot(m).textContent).toContain('no snippets yet')
      })
    } finally {
      m.palette.close()
    }
  })

  it('an ask value is not remembered between fires — the next form prefills the DEFAULTS again', async () => {
    const m = mount([SNIP({ id: 'a', title: 'tunnel', body: 'ssh -L {{ask:local=8080}}' })])
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 1)
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => {
        expect(panelRoot(m).querySelectorAll('.ui-floating-panel__field input')).toHaveLength(1)
      })
      const first = panelRoot(m).querySelector<HTMLInputElement>('.ui-floating-panel__field input')!
      first.value = '9999'
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => expect(m.palette.isOpen).toBe(false))
      expect([...m.fire.mock.calls[0][0].answers.entries()]).toEqual([['local', '9999']])

      // Reopen, choose the same snippet: the form shows the DEFAULT, never
      // the previous fire's answer.
      m.palette.open(m.pane)
      await waitRows(m.palette, 1)
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => {
        expect(panelRoot(m).querySelectorAll('.ui-floating-panel__field input')).toHaveLength(1)
      })
      const second = panelRoot(m).querySelector<HTMLInputElement>(
        '.ui-floating-panel__field input',
      )!
      expect(second.value).toBe('8080')
    } finally {
      m.palette.close()
    }
  })

  it('a delivered fire closes the palette and returns focus; the keyboard goes back to its owner', async () => {
    const owner = document.createElement('button')
    document.body.appendChild(owner)
    owner.focus()
    const m = mount([SNIP({ id: 'a', title: 'single', body: 'echo 1' })])
    m.palette.open(m.pane)
    await waitRows(m.palette, 1)
    // The palette took the keyboard: its input is focused.
    expect(document.activeElement).toBe(panelRoot(m).querySelector('input'))
    keyOn(m, { key: 'Enter' })
    await vi.waitFor(() => expect(m.palette.isOpen).toBe(false))
    expect(document.activeElement).toBe(owner)
    owner.remove()
  })

  it('a refusal does NOT return focus — the panel keeps the keyboard while the refusal stays', async () => {
    const owner = document.createElement('button')
    document.body.appendChild(owner)
    owner.focus()
    const m = mount([SNIP({ id: 'a', title: 'multi', body: 'l1\nl2' })], {
      fire: vi.fn().mockResolvedValue({
        kind: 'refused',
        reason: { kind: 'multi-line-no-bracketed-paste' },
      } satisfies SnippetFireOutcome),
    })
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 1)
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => expect(panelRoot(m).textContent).toContain('bracketed paste'))
      expect(document.activeElement).toBe(panelRoot(m).querySelector('input'))
      expect(document.activeElement).not.toBe(owner)
    } finally {
      m.palette.close()
      owner.remove()
    }
  })

  it("the palette holds no fire-time facts: the fire request carries the answers and the pane is the adapter's read", async () => {
    const m = mount([SNIP({ id: 'a', title: 'asky', body: 'x {{ask:v}} {{env:cwd}}' })])
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 1)
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => {
        expect(panelRoot(m).querySelectorAll('.ui-floating-panel__field input')).toHaveLength(1)
      })
      keyOn(m, { key: 'Enter' })
      await vi.waitFor(() => expect(m.fire).toHaveBeenCalledTimes(1))
      const req = m.fire.mock.calls[0][0]
      // Answers are the form's; the env facts are NOT in the request — the
      // adapter resolves them at fire time (fire.test.ts pins that half).
      expect([...req.answers.entries()]).toEqual([['v', '']])
      expect(req.snippet.body).toContain('{{env:cwd}}')
    } finally {
      m.palette.close()
    }
  })

  it("typing in the filter re-renders without losing the input's focus", async () => {
    const m = mount([
      SNIP({ id: 'a', title: 'alpha', body: 'x' }),
      SNIP({ id: 'b', title: 'beta', body: 'y' }),
    ])
    m.palette.open(m.pane)
    try {
      await waitRows(m.palette, 2)
      typeFilter(m, 'beta')
      await waitRows(m.palette, 1)
      expect(rowTexts(m)).toEqual(['beta'])
      expect(document.activeElement).toBe(panelRoot(m).querySelector('input'))
    } finally {
      m.palette.close()
    }
  })
})
