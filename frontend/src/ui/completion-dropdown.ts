// Completion dropdown — kit component (ui/README table). Vanilla-emitted,
// like RecallPanel: it floats over the CM6 editor surface (a DOM surface,
// not a React tree), so it renders through plain DOM. The completion
// controller owns the state machine and the keyboard; this component is a
// pure view — it renders candidates and reports hover/pick, nothing else.
//
// Identity family: `ui-completion-dropdown` + `__*` parts, one CSS file in
// styles/components/ (ADR-0013 §1). Rows reuse the kit's `ui-collection-row`
// identity for the selected variance; the source caption is a kit
// `ui-badge`. The evidence column (design §8.10) is rendered but never
// inserted — `displayText` is what a row shows, `insertText` is what the
// controller applies.

/** One row the kit draws. Deliberately a display subset of the domain
 *  Candidate (design §8.9): the kit must not depend back on the app, so the
 *  controller maps candidates to rows before showing them — `insertText`
 *  and the replacement range never cross into the kit. */
export interface CompletionRow {
  readonly id: string
  readonly displayText: string
  readonly matchRanges: Array<{ from: number; to: number }>
  readonly source: string
  /** The filesystem kind of a path row — rendered as its type word
   *  (`Directory` / `File`), the answer to "how do I tell a file from a
   *  folder". Absent rows render no kind badge. */
  readonly kind?: 'directory' | 'file'
}

export interface CompletionDropdownCallbacks {
  /** A row was hovered (mouse) — the controller moves the selection. */
  onHover(index: number): void
  /** A row was clicked — the controller accepts it. */
  onPick(index: number): void
}

const SOURCE_LABEL: Record<string, string> = {
  command: 'command',
  history: 'history',
  path: 'path',
}

/** The type word for a path row — `Directory` / `File` (the owner's ask:
 *  "how do I tell a file from a folder"). A kit badge, never a repaint. */
const KIND_LABEL: Record<string, string> = {
  directory: 'Directory',
  file: 'File',
}

/** How wide a row may make the panel, in px — the panel hugs its longest
 *  row and never spans the pane (the owner's "why full width?"). */
export const MAX_DROPDOWN_WIDTH_PX = 640

/** Floor: a single short row must not leave a sliver of a panel. */
export const MIN_DROPDOWN_WIDTH_PX = 320

export class CompletionDropdown {
  readonly root: HTMLElement
  private callbacks: CompletionDropdownCallbacks
  private list: HTMLElement | null = null
  private _open = false

  constructor(callbacks: CompletionDropdownCallbacks) {
    this.callbacks = callbacks
    this.root = document.createElement('div')
    this.root.className = 'ui-completion-dropdown'
    this.root.setAttribute('role', 'listbox')
    this.root.setAttribute('aria-label', 'completions')
    this.root.dataset.open = 'false'
  }

  get isOpen(): boolean {
    return this._open
  }

  /** Mount the panel as a child of the editor's root, so it floats above
   *  the editor (the root is position: relative) — the RecallPanel shape. */
  mount(container: HTMLElement): void {
    container.appendChild(this.root)
  }

  /**
   * Render the current candidate list. Selected index is the controller's
   * decision (it owns the state machine); the view only draws it.
   * `anchorLeft` is the caret's x, in px relative to the panel's offset
   * parent (the editor root) — the panel opens at the caret, not at the
   * pane's edge; null keeps the kit's left-edge default.
   */
  show(rows: CompletionRow[], selectedIndex: number, anchorLeft?: number | null): void {
    this._open = true
    this.root.dataset.open = 'true'
    this.root.replaceChildren()

    const list = document.createElement('div')
    list.className = 'ui-completion-dropdown__list'

    for (let i = 0; i < rows.length; i++) {
      const rowData = rows[i]
      const row = document.createElement('div')
      row.className = 'ui-collection-row ui-completion-dropdown__row'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === selectedIndex))
      if (i === selectedIndex) row.dataset.selected = 'true'

      // Display column: displayText with the matched ranges highlighted.
      const info = document.createElement('div')
      info.className = 'ui-collection-row__info'
      info.appendChild(this.renderDisplay(rowData))
      row.appendChild(info)

      // Evidence column: the type word for a path row, then the source
      // badge. Displayed, never inserted.
      const actions = document.createElement('div')
      actions.className = 'ui-collection-row__actions'
      if (rowData.kind) {
        const kind = document.createElement('span')
        kind.className = 'ui-badge ui-completion-dropdown__kind'
        kind.dataset.tone = 'neutral'
        kind.textContent = KIND_LABEL[rowData.kind] ?? rowData.kind
        actions.appendChild(kind)
      }
      const badge = document.createElement('span')
      badge.className = 'ui-badge ui-completion-dropdown__source'
      badge.dataset.tone = 'neutral'
      badge.textContent = SOURCE_LABEL[rowData.source] ?? rowData.source
      actions.appendChild(badge)
      row.appendChild(actions)

      row.addEventListener('mouseenter', () => this.callbacks.onHover(i))
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.callbacks.onPick(i)
      })
      list.appendChild(row)
    }

    this.root.appendChild(list)
    this.list = list

    const footer = document.createElement('div')
    footer.className = 'ui-completion-dropdown__footer'
    const accept = document.createElement('span')
    accept.textContent = '↵ to insert'
    footer.appendChild(accept)
    const cycle = document.createElement('span')
    cycle.textContent = 'tab ↹ to cycle'
    footer.appendChild(cycle)
    const navigate = document.createElement('span')
    navigate.textContent = '↑ ↓ to navigate'
    footer.appendChild(navigate)
    const ghost = document.createElement('span')
    ghost.textContent = '→ to accept'
    footer.appendChild(ghost)
    const dismiss = document.createElement('span')
    dismiss.textContent = 'esc to dismiss'
    footer.appendChild(dismiss)
    this.root.appendChild(footer)

    this.applyGeometry(anchorLeft)
  }

  /**
   * The honest "nothing to choose" state: one non-selectable row naming why
   * (zero candidates is a state the product shows, never silence). No
   * footer — the hints describe a selectable list, and this row has nothing
   * to insert, cycle or navigate.
   */
  showEmpty(message: string, anchorLeft?: number | null): void {
    this._open = true
    this.root.dataset.open = 'true'
    this.root.replaceChildren()

    const list = document.createElement('div')
    list.className = 'ui-completion-dropdown__list'
    const row = document.createElement('div')
    row.className = 'ui-collection-row ui-completion-dropdown__row'
    row.dataset.empty = 'true'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', 'false')
    row.setAttribute('aria-disabled', 'true')
    const info = document.createElement('div')
    info.className = 'ui-collection-row__info'
    info.textContent = message
    row.appendChild(info)
    list.appendChild(row)
    this.root.appendChild(list)
    this.list = list

    this.applyGeometry(anchorLeft)
  }

  /** Close the panel and drop its rows. */
  hide(): void {
    this._open = false
    this.root.dataset.open = 'false'
    this.root.replaceChildren()
    this.list = null
  }

  destroy(): void {
    this.hide()
    this.root.remove()
  }

  /**
   * The panel is as wide as its longest row, capped — content-sized, never
   * the editor's width. The footer wraps within that width and contributes
   * nothing to it (the list's scrollWidth is the widest nowrap row). The
   * left edge is the caret anchor, clamped so the panel never runs off the
   * editor's right edge.
   */
  private applyGeometry(anchorLeft: number | null | undefined): void {
    const cap = Math.min(MAX_DROPDOWN_WIDTH_PX, window.innerWidth * 0.9)
    const widest = Math.max(this.list?.scrollWidth ?? 0, MIN_DROPDOWN_WIDTH_PX)
    this.root.style.width = `${Math.min(widest, cap)}px`

    if (anchorLeft === null || anchorLeft === undefined) {
      this.root.style.left = ''
      return
    }
    const parent = this.root.parentElement
    const parentWidth = parent?.clientWidth ?? window.innerWidth
    const width = this.root.offsetWidth
    const left = Math.max(0, Math.min(anchorLeft, Math.max(0, parentWidth - width)))
    this.root.style.left = `${left}px`
  }

  /** The display column: displayText with the matched ranges as <mark>. */
  private renderDisplay(c: CompletionRow): DocumentFragment {
    const frag = document.createDocumentFragment()
    let pos = 0
    const ranges = [...c.matchRanges].sort((a, b) => a.from - b.from)
    for (const r of ranges) {
      const from = Math.max(pos, Math.min(r.from, c.displayText.length))
      const to = Math.max(from, Math.min(r.to, c.displayText.length))
      if (from > pos) frag.appendChild(document.createTextNode(c.displayText.slice(pos, from)))
      const mark = document.createElement('mark')
      mark.className = 'ui-completion-dropdown__match'
      mark.textContent = c.displayText.slice(from, to)
      frag.appendChild(mark)
      pos = to
    }
    if (pos < c.displayText.length) {
      frag.appendChild(document.createTextNode(c.displayText.slice(pos)))
    }
    return frag
  }
}
