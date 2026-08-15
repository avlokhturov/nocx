// The snippet palette — a FloatingPanel variant (data-variant='snippet'),
// the surface that answers when there is NO command editor (design §10.1):
// a TUI owns the pane and the editor is display:none, so the panel mounts
// on the PANE and anchors to its bottom edge (floating-panel.css), never
// inside the editor root.
//
// The palette is a VIEW over two contracts:
//
//   - the store (snippets-store.ts) is the one list — subscribed, so a
//     mutation made anywhere re-renders an open palette;
//   - the fire adapter (fire.ts) is the composition root's half: the
//     palette never resolves or delivers anything itself. It asks the
//     adapter to fire one snippet with the form's answers and renders the
//     outcome — a delivered fire closes the palette and returns focus; a
//     refusal renders IN the panel and stays there (design §11.2, §9.4),
//     never as a toast.
//
// The ask form is the SAME panel (design §8: one form, every destination,
// never a second surface): choosing a snippet with ask: spans turns the
// panel into the field form in place. An ask value lives only in the form's
// state for the duration of one fire — never remembered, never logged
// (design §7.5): the only thing that reaches the logging seam is the
// title, and that is the fire adapter's line, not this module's.
//
// Keys: the panel's own focusable input is the keyboard's anchor (there is
// no editor arbiter when the terminal owns the pane). The chord that opens
// it is snippets/chord.ts, handled at the xterm boundary and in the
// editor's arbiter chain — both delegate to the composition root's one
// opener (AD-8).
import { FloatingPanel, type FloatingPanelRow } from '../ui/floating-panel'
import { createTextFieldInput } from '../ui/text-field'
import { askFields, type AskField } from './resolve'
import type { SnippetFireOutcome, SnippetFireRequest } from './fire'
import type { SnippetRefusalReason, SnippetDestination } from './fire'
import type { Snippet } from './snippets-store'
import type { SnippetsStore, SnippetsState } from './snippets-store'

/** The list phase's snapshot the form keeps, so Esc returns to the exact
 *  list the user left. */
interface ListBack {
  snippets: readonly Snippet[]
  filter: string
  selected: number
}

type PalettePhase =
  | { readonly name: 'closed' }
  | { readonly name: 'loading' }
  | { readonly name: 'unavailable'; readonly message: string }
  | { readonly name: 'empty' }
  | {
      readonly name: 'list'
      readonly snippets: readonly Snippet[]
      readonly filter: string
      readonly selected: number
    }
  | {
      readonly name: 'form'
      readonly snippet: Snippet
      readonly fields: AskField[]
      /** The fields' current values, index-aligned with `fields`. */
      readonly answers: string[]
      readonly active: number
      readonly back: ListBack
    }
  | {
      readonly name: 'refused'
      readonly snippet: Snippet
      readonly answers: ReadonlyMap<string, string>
      readonly destination: SnippetDestination
      readonly refusal: SnippetRefusalReason
      readonly message: string
    }

export interface SnippetPaletteDeps {
  store: SnippetsStore
  fire: (req: SnippetFireRequest) => Promise<SnippetFireOutcome>
}

/** The sentence a refusal renders as — the palette owns the words, the
 *  adapter owns the reasons (one owner per behaviour, AD-8). */
function refusalMessage(r: SnippetRefusalReason): string {
  switch (r.kind) {
    case 'no-owner':
      return 'there is no terminal or editor here to insert into'
    case 'env-unavailable':
      return (
        r.keys.map((k) => `{{env:${k}}}`).join(', ') +
        ' cannot be answered right now — nothing was inserted'
      )
    case 'multi-line-no-bracketed-paste':
      return 'this snippet has more than one line and the running program has not enabled bracketed paste — a newline would be read as Return'
    case 'unresolved-secret':
      return r.name !== undefined
        ? `{{secret:${r.name}}} could not be resolved — unlock the vault or check the name`
        : 'a secret in this snippet could not be resolved — unlock the vault or check the name'
    case 'write-failed':
      return 'the write was refused — nothing was inserted'
    case 'secret-to-clipboard':
      return `{{secret:${r.name}}} cannot be copied — the clipboard outlives this fire and is read by everything on the machine`
  }
}

/** The alternative destination a refusal offers (design §9.4, §11.1): the
 *  multi-line body the terminal cannot honour can be copied; a secret the
 *  clipboard must not hold can be inserted into the pane. Everything else
 *  refuses without an alternative. */
function alternativeFor(r: SnippetRefusalReason): SnippetDestination | null {
  if (r.kind === 'multi-line-no-bracketed-paste') return 'clipboard'
  if (r.kind === 'secret-to-clipboard') return 'input'
  return null
}

export class SnippetPalette {
  private state: PalettePhase = { name: 'closed' }
  private readonly panel: FloatingPanel
  private readonly deps: SnippetPaletteDeps
  private unsubscribe: (() => void) | null = null
  /** The pane the panel floats in, re-read on every open — the panel is
   *  mounted into the ACTIVE pane, so a tab switch while closed needs no
   *  tracking, and the mount() call moves the panel if the pane changed. */
  private container: HTMLElement | null = null
  /** Who owned the keyboard when the palette opened — restored on close
   *  (design §9.5: a delivered fire closes the palette and the next thing
   *  the user does is type). */
  private focusBefore: HTMLElement | null = null
  /** The filter field — the keyboard's anchor in every non-form phase. */
  private filterInput: HTMLInputElement | null = null
  /** The form's field inputs, index-aligned with the form's fields. */
  private fieldInputs: HTMLInputElement[] = []
  /** True while a fire is in flight: Enter twice must not fire twice. */
  private firing = false

  constructor(deps: SnippetPaletteDeps) {
    this.deps = deps
    this.panel = new FloatingPanel({
      variant: 'snippet',
      role: 'dialog',
      ariaLabel: 'snippets',
      callbacks: {
        onHover: (index) => this.hover(index),
        onPick: (index) => this.pick(index),
      },
    })
    this.panel.root.addEventListener('keydown', this.onKeydown)
  }

  get isOpen(): boolean {
    return this.state.name !== 'closed'
  }

  /** Open the palette over the given pane. The list is re-read on every
   *  open (one store, every surface re-reads — design §6); the store
   *  subscription re-renders when the answer lands. */
  open(container: HTMLElement): void {
    if (this.isOpen) return
    this.container = container
    this.focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.panel.mount(container)
    this.unsubscribe = this.deps.store.subscribe((s) => this.onStore(s))
    this.state = { name: 'loading' }
    this.render()
    void this.deps.store.refresh()
  }
  /** Close and give the keyboard back. A refusal does NOT call this — the
   *  panel stays open with the refusal in it (the acceptance criterion). */
  close(): void {
    if (this.state.name === 'closed') return
    this.state = { name: 'closed' }
    this.unsubscribe?.()
    this.unsubscribe = null
    this.panel.hide()
    if (this.focusBefore?.isConnected) this.focusBefore.focus()
    this.focusBefore = null
    this.container = null
    this.filterInput = null
    this.fieldInputs = []
    this.firing = false
  }

  destroy(): void {
    this.close()
    this.panel.destroy()
  }

  // ── store → phase ─────────────────────────────────────────────────────

  /** The store's answer re-renders an open palette. A form or a refusal in
   *  flight owns the surface — a store update cannot clobber it. */
  private onStore(s: SnippetsState): void {
    const phase = this.state
    if (phase.name === 'closed' || phase.name === 'form' || phase.name === 'refused') return
    switch (s.kind) {
      case 'loading':
        return
      case 'ready':
        this.state =
          s.snippets.length === 0
            ? { name: 'empty' }
            : { name: 'list', snippets: s.snippets, filter: '', selected: 0 }
        this.render()
        return
      case 'unavailable':
        this.state = { name: 'unavailable', message: s.message }
        this.render()
        return
    }
  }

  // ── keys ──────────────────────────────────────────────────────────────

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return
    const s = this.state
    if (s.name === 'closed') return

    if (e.key === 'Escape') {
      if (s.name === 'form') {
        // Esc in the form cancels the CHOICE, not the palette: back to the
        // exact list the user left (the drill's walk-back).
        this.state = { name: 'list', ...s.back }
        this.render()
      } else {
        this.close()
      }
      e.preventDefault()
      e.stopPropagation()
      return
    }

    if (s.name === 'list') {
      if (e.key === 'ArrowDown') {
        this.move(1)
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.key === 'ArrowUp') {
        this.move(-1)
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.key === 'Enter') {
        // Enter fires into the input owner; ⌘Enter copies (design §9.2:
        // the clipboard is an explicit modifier, never a derivation).
        this.choose(s.selected, e.metaKey ? 'clipboard' : 'input')
        e.preventDefault()
        e.stopPropagation()
        return
      }
      return
    }

    if (s.name === 'form') {
      if (e.key === 'Enter') {
        this.confirmForm(s, e.metaKey ? 'clipboard' : 'input')
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }

    if (s.name === 'refused') {
      const alt = alternativeFor(s.refusal)
      if (alt !== null) {
        const pressed =
          alt === 'clipboard' ? e.key === 'Enter' && e.metaKey : e.key === 'Enter' && !e.metaKey
        if (pressed) {
          void this.fire(s.snippet, s.answers, alt)
          e.preventDefault()
          e.stopPropagation()
        }
      }
      return
    }
  }

  // ── list interactions ─────────────────────────────────────────────────

  private move(dir: -1 | 1): void {
    const s = this.state
    if (s.name !== 'list') return
    const count = this.matched(s).length
    if (count === 0) return
    this.state = { ...s, selected: (s.selected + dir + count) % count }
    this.render()
  }

  private hover(index: number): void {
    const s = this.state
    if (s.name !== 'list') return
    this.state = { ...s, selected: index }
    this.render()
  }

  private pick(index: number): void {
    const s = this.state
    if (s.name !== 'list') return
    this.choose(index, 'input')
  }

  /** The rows the current filter shows — title AND body match (the
   *  acceptance criterion), in stored order (design §5.1: order is data). */
  private matched(s: { name: 'list'; snippets: readonly Snippet[]; filter: string }): Snippet[] {
    const needle = s.filter.trim().toLowerCase()
    if (needle === '') return [...s.snippets]
    return s.snippets.filter(
      (sn) => sn.title.toLowerCase().includes(needle) || sn.body.toLowerCase().includes(needle),
    )
  }

  /** Enter on a row: a snippet with ask: spans becomes the field form IN
   *  PLACE (one panel, never two); otherwise it fires immediately with no
   *  answers — the common path costs nothing (design §8). */
  private choose(index: number, destination: SnippetDestination): void {
    const s = this.state
    if (s.name !== 'list' || this.firing) return
    const rows = this.matched(s)
    const snippet = rows[index]
    if (snippet === undefined) return
    const fields = askFields(snippet.body)
    if (fields.length > 0) {
      this.state = {
        name: 'form',
        snippet,
        fields,
        answers: fields.map((f) => f.defaultValue),
        active: 0,
        back: { snippets: s.snippets, filter: s.filter, selected: s.selected },
      }
      this.render()
      return
    }
    void this.fire(snippet, new Map(), destination)
  }

  // ── the form ──────────────────────────────────────────────────────────

  private confirmForm(
    s: {
      name: 'form'
      snippet: Snippet
      fields: AskField[]
      answers: string[]
      active: number
      back: ListBack
    },
    destination: SnippetDestination,
  ): void {
    if (this.firing) return
    // The values live only here, for this one call (design §7.5): the map
    // is built fresh and dropped when the fire settles.
    const answers = new Map(
      s.fields.map((f, i) => [f.name, this.fieldInputs[i]?.value ?? s.answers[i]]),
    )
    void this.fire(s.snippet, answers, destination)
  }

  // ── firing ────────────────────────────────────────────────────────────

  private async fire(
    snippet: Snippet,
    answers: ReadonlyMap<string, string>,
    destination: SnippetDestination,
  ): Promise<void> {
    if (this.firing) return
    this.firing = true
    try {
      const outcome = await this.deps.fire({ snippet, answers, destination })
      if (this.state.name === 'closed') return // closed while in flight
      if (outcome.kind === 'delivered') {
        this.close()
        return
      }
      // A refusal renders IN the panel and stays — never a toast (the
      // acceptance criterion), and focus does not return: the user is
      // still deciding what to do about it.
      this.state = {
        name: 'refused',
        snippet,
        answers,
        destination,
        refusal: outcome.reason,
        message: refusalMessage(outcome.reason),
      }
      this.render()
    } finally {
      this.firing = false
    }
  }

  // ── render ────────────────────────────────────────────────────────────

  private render(): void {
    const s = this.state
    switch (s.name) {
      case 'closed':
        return
      case 'loading':
        this.renderMessage('loading snippets…')
        return
      case 'unavailable':
        // The store's reason, in the panel where the user is looking
        // (design §11.5: the soft degrade must be visible in the product).
        this.renderMessage(`the library could not be opened — ${s.message}`, ['esc to dismiss'])
        return
      case 'empty':
        this.renderMessage('no snippets yet — save one from Settings', ['esc to dismiss'])
        return
      case 'refused':
        this.renderRefused(s)
        return
      case 'list':
        this.renderList(s)
        return
      case 'form':
        this.renderForm(s)
        return
    }
  }

  /** The filter field — every non-form phase's keyboard anchor (a real
   *  input: there is no editor arbiter to route keys when the terminal
   *  owns the pane, unlike recall's display form). */
  private makeFilter(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ui-floating-panel__filter'
    this.filterInput = createTextFieldInput({
      placeholder: 'filter snippets',
      ariaLabel: 'filter snippets',
      onInput: (value) => {
        const s = this.state
        if (s.name !== 'list') return
        this.state = { ...s, filter: value, selected: 0 }
        this.render()
        this.focusFilter()
      },
    })
    wrap.appendChild(this.filterInput)
    return wrap
  }

  private focusFilter(): void {
    this.filterInput?.focus()
  }

  private renderMessage(message: string, footer?: string[]): void {
    const row: FloatingPanelRow = {
      id: 'message',
      displayText: message,
      matchRanges: [],
      empty: true,
    }
    this.panel.show({
      rows: [row],
      selectedIndex: 0,
      before: [this.makeFilter()],
      footer,
    })
    this.focusFilter()
  }

  private renderList(s: {
    name: 'list'
    snippets: readonly Snippet[]
    filter: string
    selected: number
  }): void {
    const rows = this.matched(s)
    const selected = Math.min(s.selected, Math.max(0, rows.length - 1))
    this.panel.show({
      rows: rows.map((sn) => ({
        id: sn.id,
        displayText: sn.title,
        matchRanges: this.matchRange(sn.title, s.filter),
      })),
      selectedIndex: selected,
      before: [this.makeFilter()],
      footer: ['↑ ↓ to navigate', '↵ to fire', '⌘↵ to copy', 'esc to dismiss'],
    })
    this.filterInput!.value = s.filter
    this.focusFilter()
  }

  private renderForm(s: {
    name: 'form'
    snippet: Snippet
    fields: AskField[]
    answers: string[]
    active: number
    back: ListBack
  }): void {
    this.fieldInputs = []
    const fields = document.createElement('div')
    fields.className = 'ui-floating-panel__fields'
    for (let i = 0; i < s.fields.length; i++) {
      const f = s.fields[i]
      const item = document.createElement('label')
      item.className = 'ui-floating-panel__field'
      const label = document.createElement('span')
      label.className = 'ui-floating-panel__field-label'
      label.textContent = f.name
      const input = createTextFieldInput({
        value: s.answers[i],
        ariaLabel: f.name,
      })
      this.fieldInputs.push(input)
      item.append(label, input)
      fields.appendChild(item)
    }
    this.panel.show({
      rows: [{ id: s.snippet.id, displayText: s.snippet.title, matchRanges: [] }],
      selectedIndex: 0,
      after: [fields],
      footer: ['⏎ to fire', '⌘↵ to copy', 'esc to cancel'],
    })
    const active = Math.min(s.active, Math.max(0, this.fieldInputs.length - 1))
    this.fieldInputs[active]?.focus()
  }

  private renderRefused(s: {
    name: 'refused'
    message: string
    refusal: SnippetRefusalReason
  }): void {
    const alt = alternativeFor(s.refusal)
    const footer = ['esc to dismiss']
    if (alt === 'clipboard') footer.unshift('⌘↵ to copy instead')
    if (alt === 'input') footer.unshift('↵ to insert instead')
    this.panel.show({
      rows: [{ id: 'refusal', displayText: s.message, matchRanges: [], refusal: true }],
      selectedIndex: 0,
      before: [this.makeFilter()],
      footer,
    })
    this.focusFilter()
  }

  /** The matched substring of the visible title — the same first-occurrence
   *  rule the other panels use, so the highlight is exact, never a
   *  heuristic. A body-only match leaves the title unmarked: the row
   *  cannot highlight text it does not show. */
  private matchRange(title: string, filter: string): Array<{ from: number; to: number }> {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return []
    const at = title.toLowerCase().indexOf(needle)
    return at === -1 ? [] : [{ from: at, to: at + needle.length }]
  }
}
