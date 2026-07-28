// Passive DOM command editor (ADR-0004 §3). Holds text + selection only; a
// registered action decides where a submit goes. Keyboard routing to/from the
// PTY is by FOCUS: while shown the textarea captures keys; while hidden the
// xterm has focus and keys flow to the PTY as usual.

const MAX_ROWS = 10

export interface EditorActions {
  submit: (doc: string) => void
  // cancel discards the composed line the way Ctrl-C does at a shell prompt:
  // the editor clears and the shell is interrupted so a fresh prompt returns.
  // Without it, Ctrl-C in the textarea is a no-op and the stale text corrupts
  // the next command.
  cancel: () => void
  /**
   * Fired when the editor's own height changes, because that changes how much
   * room the scrollback has. Optional: an editor with nothing above it — a test,
   * or a future host — has nobody to tell.
   */
  resized?: () => void
}

export class CommandEditor {
  readonly root: HTMLElement
  private ta: HTMLTextAreaElement
  private chrome: HTMLElement
  private cwdChip: HTMLElement
  private timeChip: HTMLElement

  constructor(private readonly actions: EditorActions) {
    this.root = document.createElement('div')
    this.root.className = 'nocx-editor'
    this.root.style.display = 'none'

    // ── Editor chrome (header row) ──────────────────────────────────────
    this.chrome = document.createElement('div')
    this.chrome.className = 'nocx-editor-chrome'

    this.cwdChip = document.createElement('span')
    this.cwdChip.className = 'nocx-chip nocx-editor-cwd'
    this.cwdChip.textContent = '📁 ~'

    this.timeChip = document.createElement('span')
    this.timeChip.className = 'nocx-chip nocx-editor-time'
    this.chrome.append(this.cwdChip, this.timeChip)
    this.root.appendChild(this.chrome)

    // ── Textarea ────────────────────────────────────────────────────────
    this.ta = document.createElement('textarea')
    this.ta.className = 'nocx-editor-input'
    this.ta.rows = 1
    this.ta.spellcheck = false
    this.ta.autocapitalize = 'off'
    this.ta.addEventListener('keydown', this.onKeydown)
    // Auto-grow: resize rows to fit content (1..MAX_ROWS).
    this.ta.addEventListener('input', this.onInput)
    this.root.appendChild(this.ta)
  }

  /**
   * The clock ticks only while the editor is on screen.
   *
   * It used to be stamped once, by the input-state transition that revealed the
   * editor, and then left alone — so the chip showed the second the prompt
   * appeared and stayed there. Sit at a prompt for ten minutes and it is ten
   * minutes wrong, which is worse than showing nothing: a wrong clock is still
   * read as a clock.
   *
   * A block in the scrollback is the opposite case and keeps its frozen stamp:
   * it records when that command ran. This chip is not a record, it is the
   * present, and the editor is where the present is (nocx-6w4z).
   */
  private clock: ReturnType<typeof setInterval> | null = null

  private startClock(): void {
    this.setTime(new Date())
    if (this.clock !== null) return
    this.clock = setInterval(() => this.setTime(new Date()), 1000)
  }

  private stopClock(): void {
    if (this.clock === null) return
    clearInterval(this.clock)
    this.clock = null
  }

  /** Update the time chip with date, weekday and time. */
  setTime(ts: Date): void {
    const datePart = ts.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    const timePart = ts.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    this.timeChip.textContent = `${datePart} ${timePart}`
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.root)
  }

  /** Update the cwd chip text. Uses the same short directoryLabel shape. */
  setCwd(cwd: string): void {
    const path = cwd.trim().replace(/\/+$/, '') || '~'
    const parts = path.split('/').filter(Boolean)
    const label = path === '~' || parts.length === 0 ? path : parts.slice(-2).join('/')
    this.cwdChip.textContent = `📁 ${label}`
  }

  // ── keyboard ──────────────────────────────────────────────────────────

  private onInput = (): void => {
    this._grow()
  }

  /** Submit the current textarea value, then hide and clear (ADR-0004 §2). */
  private submit(): void {
    const doc = this.ta.value
    // Atomic handoff (ADR-0004 §2): hide + clear BEFORE sending, so the
    // committed command is painted once by the shell, not echoed twice.
    this.ta.value = ''
    this.ta.rows = 1
    this.hide()
    this.actions.submit(doc)
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      this.submit()
      return
    }
    // Escape clears the draft without interrupting the shell (Ctrl-C).
    if (e.key === 'Escape') {
      e.preventDefault()
      this.ta.value = ''
      this.ta.rows = 1
      return
    }
    // Ctrl-C cancels the composed line like a shell prompt. A real selection is
    // left alone so Ctrl-C still copies; with nothing selected, interrupt.
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (this.ta.selectionStart !== this.ta.selectionEnd) return
      e.preventDefault()
      this.ta.value = ''
      this.ta.rows = 1
      this.actions.cancel()
    }
  }

  // ── visibility ────────────────────────────────────────────────────────

  /**
   * Hiding gives the space back.
   *
   * `hide()` used `visibility: hidden` once the editor had been shown, so its
   * box stayed in the flex layout — deliberately, to stop the pane jumping on
   * every command start and end. What that bought in stability it paid for in a
   * strip of dead canvas below every running command, which the owner reported
   * twice as "space reserved for an editor that is not there". The reservation
   * goes; the jump comes back and is the smaller of the two problems now that
   * the live region grows with its content rather than snapping to a constant
   * (nocx-6w4z).
   */
  show(): void {
    this.root.style.display = ''
    // CLEARED, not set to 'visible'. An inactive pane is hidden with
    // `visibility: hidden` on purpose (base.css) so its renderer keeps measuring
    // a real size — and `visibility`, unlike `display`, is overridable by a
    // descendant. An inline `visible` here therefore re-painted the editor of a
    // tab the user had switched away from, on top of the active tab's editor at
    // the very same coordinates: you typed into the one below and watched the
    // empty one above. Clearing the property lets the pane decide, which is
    // where that decision belongs.
    this.root.style.visibility = ''
    this.startClock()
    this.ta.focus()
  }

  /** Focus the textarea if the editor is visible. Safe to call when hidden. */
  focus(): void {
    if (this.isVisible) this.ta.focus()
  }

  /**
   * Insert text at the caret, replacing any selection, then grow + focus.
   * Used by right-click/middle-click paste while the editor owns input: at the
   * prompt the terminal is read-only (setReadOnly), so a paste must land in the
   * composed command, not the (disabled) grid.
   */
  insertText(text: string): void {
    const start = this.ta.selectionStart
    const end = this.ta.selectionEnd
    const v = this.ta.value
    this.ta.value = v.slice(0, start) + text + v.slice(end)
    const caret = start + text.length
    this.ta.selectionStart = this.ta.selectionEnd = caret
    this._grow()
    this.ta.focus()
  }

  hide(): void {
    // Stopped, not left running. Every tab owns an editor, so a timer that
    // outlives visibility is one wakeup per second per tab for a chip nobody can
    // see — and they accumulate for the life of the window.
    this.stopClock()
    this.ta.blur()
    this.root.style.display = 'none'
  }

  get isVisible(): boolean {
    return this.root.style.display !== 'none' && this.root.style.visibility !== 'hidden'
  }

  /** Whether the editor's root element contains `el`. Used to scope the
   *  focus-bounce so clicks on the textarea / cwd chip
   *  are not swallowed. */
  rootContains(el: Node | null): boolean {
    return this.root.contains(el)
  }

  /** The raw textarea element — exposed so the Tab can wire copy-on-select. */
  get textarea(): HTMLTextAreaElement {
    return this.ta
  }

  dispose(): void {
    // A tab can be closed while its editor is on screen, which is the common
    // case rather than the edge one — hide() would never run and the interval
    // would outlive everything it refers to.
    this.stopClock()
    this.ta.removeEventListener('keydown', this.onKeydown)
    this.ta.removeEventListener('input', this.onInput)
    this.root.remove()
  }

  // ── internal ──────────────────────────────────────────────────────────

  private _grow(): void {
    const lines = this.ta.value.split('\n').length
    const rows = Math.min(MAX_ROWS, Math.max(1, lines))
    if (rows === this.ta.rows) return
    this.ta.rows = rows
    // Typing a second line makes this box taller, which makes the scrollback
    // area shorter — and nothing was recomputing the view for that, so the
    // bottom of the transcript slid underneath the editor instead of moving up
    // out of its way (nocx-6w4z).
    this.actions.resized?.()
  }
}
