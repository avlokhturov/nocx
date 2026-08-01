// Passive DOM command editor (ADR-0004 §3, ADR-0010). Holds text + selection
// only; a registered action decides where a submit goes. Keyboard routing
// to/from the PTY is by FOCUS: while shown the editor captures keys; while
// hidden the xterm has focus and keys flow to the PTY as usual.
//
// The input surface is a CodeMirror 6 EditorView mounted inside the
// `.nocx-editor` card (ADR-0010 §1). The public API is the contract and is
// unchanged except that the `textarea` getter is replaced by
// `onSelectionEnd(cb)` (§Decision 2 of the editor-core spec).
//
// Key handling deliberately stays a native capture-phase listener on `root`,
// NOT a CM6 keymap: the listener runs before CM6's own contentDOM handlers
// for whatever extension list the caller installs, so Enter/Escape/Ctrl-C
// decide exactly as they did on the textarea. Binding these keys as a CM6
// keymap at Prec.highest is W2's job; W1 only preserves today's behaviour.

import { EditorState, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const MAX_ROWS = 10

export interface AliasSuggestion {
  alias: string
  hostName: string
  user?: string
  port?: number
}

export interface EditorActions {
  submit: (doc: string) => void
  // cancel discards the composed line the way Ctrl-C does at a shell prompt:
  // the editor clears and the shell is interrupted so a fresh prompt returns.
  // Without it, Ctrl-C in the editor is a no-op and the stale text corrupts
  // the next command.
  cancel: () => void
  /** Fired on every user-driven document change with the current value.
   *  Use to drive external hint/filter logic without coupling the hint
   *  data source to the editor. */
  onInputChange?: (text: string) => void
  /**
   * Fired when the editor's own height changes, because that changes how much
   * room the scrollback has. Optional: an editor with nothing above it — a test,
   * or a future host — has nobody to tell.
   */
  resized?: () => void
  /** Fired when the user accepts a hint suggestion (Enter/click on hint item).
   *  Receives the suggested alias value. The editor replaces the partial `ssh ` line
   *  with `ssh <alias>` before calling this hook. */
  onAcceptHint?: (alias: string) => void
  /** Fired when the user presses Up with the caret already on the first line
   *  (or an empty draft): there is no further upward movement, so the caller
   *  may open recall instead of moving the caret (design §8.10 v6 — Up is
   *  caret movement first). */
  onUpAtTop?: () => void
}

export class CommandEditor {
  readonly root: HTMLElement
  private view: EditorView
  private chrome: HTMLElement
  private cwdChip: HTMLElement
  private timeChip: HTMLElement
  /** Hint dropdown — lives between the chrome and the editor surface. */
  private hintContainer: HTMLElement
  /** Current hint items (empty when hidden). */
  private _hintItems: AliasSuggestion[] = []
  /** Whether the user explicitly dismissed the hint this editor session. */
  private _hintDismissed = false
  /** Index of the currently highlighted item in _hintItems. */
  private _hintSelectedIndex = 0
  /** The row count (capped at MAX_ROWS) the host was last told about. */
  private _lastRowCount = 1
  /** True while a programmatic document edit is in flight: such edits set the
   *  value the way `textarea.value = …` did, which fired no input event, so
   *  they must not fire onInputChange either. */
  private _programmatic = false
  /** Optional keyboard arbiter: called (capture phase) BEFORE the editor's
   *  own key handling. Return true to consume the key. The recall overlay
   *  registers here, so an open overlay owns navigation/accept/dismiss and
   *  nothing the editor handles — submit, clear, interrupt — can fire while
   *  it is up (nocx-w7h.4: the keyboard arbiter is part of the recall task). */
  private keyArbiter: ((e: KeyboardEvent) => boolean) | null = null

  /** Register (or clear) the keyboard arbiter. Cleared on dispose. */
  setKeyArbiter(arbiter: ((e: KeyboardEvent) => boolean) | null): void {
    this.keyArbiter = arbiter
  }
  /** Callback for the onSelectionEnd seam (W3 wires the copy policy to it). */
  private _selectionEndCb: ((text: string) => void) | null = null

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

  /**
   * The editor's own surface styling. Kept as a CM6 theme (not style.css)
   * because a theme extension deterministically overrides the base theme,
   * which is what these two rules must do: kill the base theme's dotted focus
   * outline (the textarea had `outline: none`) and paint the caret in the
   * app's text colour (the base theme uses black/white).
   */
  private static readonly editorTheme = EditorView.theme({
    '&.cm-focused': { outline: 'none' },
    '.cm-content': { caretColor: 'var(--color-text)' },
    '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
  })

  /**
   * Bridge from CM6 transactions to the host's callbacks.
   *
   * - onInputChange mirrors the old textarea `input` event, but only for
   *   user-driven changes: programmatic edits are flagged and must not fire it
   *   (a paste or alias accept never fired `input` on the textarea, and firing
   *   it would re-trigger the async alias fetch after the hints were accepted).
   * - resized is the _grow() port: the host is told when the capped row count
   *   (1..MAX_ROWS) changes. The box's real height is CSS (max-height:
   *   ten lines, overflow-y: auto), so the row count is the trigger, exactly
   *   as rows were before.
   *
   * Both callbacks are wrapped: an exception from a consumer must not corrupt
   * CM6's update cycle (fail-open).
   */
  private readonly onViewUpdate = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    const text = update.state.doc.toString()
    if (!this._programmatic) {
      try {
        this.actions.onInputChange?.(text)
      } catch (err) {
        console.error('nocx: onInputChange failed', err)
      }
    }
    const rows = Math.min(MAX_ROWS, Math.max(1, text.split('\n').length))
    if (rows !== this._lastRowCount) {
      this._lastRowCount = rows
      try {
        this.actions.resized?.()
      } catch (err) {
        console.error('nocx: resized failed', err)
      }
    }
  })

  constructor(
    private readonly actions: EditorActions,
    extensions: Extension[] = [],
  ) {
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

    // ── Hint dropdown popup ─────────────────────────────────────────────
    this.hintContainer = document.createElement('div')
    this.hintContainer.className = 'nocx-editor-hint'
    this.hintContainer.style.display = 'none'
    this.root.appendChild(this.hintContainer)

    // ── CodeMirror 6 surface (ADR-0010) ────────────────────────────────
    // The extension list is a constructor parameter: the editor must not
    // hard-code its language or decoration set (spec §Decision 4). What is
    // hard-coded here is the editor's own identity — line wrapping matches
    // the old pre-wrap textarea, and the surface theme above.
    this.view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorView.lineWrapping,
          CommandEditor.editorTheme,
          this.onViewUpdate,
          ...extensions,
        ],
      }),
      parent: this.root,
    })
    this.view.contentDOM.classList.add('nocx-editor-input')
    this.view.contentDOM.spellcheck = false
    this.view.contentDOM.setAttribute('autocapitalize', 'off')

    // Key handling: capture on the card, so our decisions run before CM6's
    // own contentDOM handlers no matter what keymap the caller installs
    // (verified empirically: a capture-phase listener on an ancestor
    // preempts the defaultKeymap's Enter binding).
    this.root.addEventListener('keydown', this.onKeydown, true)

    // Selection-gesture seam (spec §Decision 2): fires with the selected text
    // when a mouse selection completes. It copies nothing — the policy lives
    // with the consumer (W3).
    this.view.contentDOM.addEventListener('mouseup', () => {
      const sel = this.view.state.selection.main
      if (sel.from === sel.to) return
      this._selectionEndCb?.(this.view.state.sliceDoc(sel.from, sel.to))
    })
  }

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

  /** Register the selection-end callback (replaces the textarea getter). */
  onSelectionEnd(cb: (text: string) => void): void {
    this._selectionEndCb = cb
  }

  /**
   * Replace the whole document without firing onInputChange (the textarea's
   * `value = ''` fired no input event).
   */
  private clearDoc(): void {
    this._programmatic = true
    try {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length },
      })
    } finally {
      this._programmatic = false
    }
    this._lastRowCount = 1
  }

  /** Submit the current document, then hide and clear (ADR-0004 §2). Also
   *  the overlay's execution path: RecallOverlay calls this so Enter in the
   *  palette runs the previewed command through exactly the same path a
   *  typed Enter takes. */
  submit(): void {
    this.hideAliasHints()
    const doc = this.view.state.doc.toString()
    // Atomic handoff (ADR-0004 §2): clear + hide BEFORE sending, so the
    // committed command is painted once by the shell, not echoed twice. The
    // observed order from the textarea implementation — value → rows →
    // hide() → submit() — is preserved.
    this.clearDoc()
    this.hide()
    this.actions.submit(doc)
  }

  /** Accept the currently highlighted hint, replacing `ssh <partial>` with the
   *  chosen alias, then fire onAcceptHint so the caller can track the event. */
  private acceptHint(): void {
    const item = this._hintItems[this._hintSelectedIndex]
    if (!item) return
    const v = this.view.state.doc.toString()
    const sshIdx = v.search(/\bssh\s+/)
    if (sshIdx === -1) return
    const before = v.slice(0, sshIdx + 4) // "ssh "
    const after = v.slice(sshIdx).replace(/^ssh\s+\S*/, '')
    const cmd = `${before}${item.alias}${after}`
    this._programmatic = true
    try {
      this.view.dispatch({
        changes: { from: 0, to: v.length, insert: cmd },
      })
    } finally {
      this._programmatic = false
    }
    this.hideAliasHints()
    this.actions.onAcceptHint?.(item.alias)
  }

  private onKeydown = (e: KeyboardEvent): void => {
    // IME in progress: the composition owns the key stream, and CM6 handles
    // composition itself. Interpreting a composing Enter as submit or a
    // composing Ctrl-C as interrupt would destroy the composition (spec
    // W1 check 3). keyCode 229 is the legacy WebKit composition sentinel.
    if (e.isComposing || e.keyCode === 229) return

    // The keyboard arbiter (recall overlay) gets first refusal: while it is
    // open, Up/Down/Enter/Escape and the open shortcut belong to it, and
    // nothing the editor handles — submit, clear, interrupt — may fire.
    if (this.keyArbiter?.(e)) return

    if (this._hintItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        this._hintSelectedIndex = (this._hintSelectedIndex + 1) % this._hintItems.length
        this._renderHints()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        this._hintSelectedIndex =
          (this._hintSelectedIndex - 1 + this._hintItems.length) % this._hintItems.length
        this._renderHints()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        this.acceptHint()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this._hintDismissed = true
        this.hideAliasHints()
        return
      }
    }

    // Up is caret movement first (design §8.10 v6): recall opens only when
    // there is no further upward movement — caret on the first line or an
    // empty draft. Otherwise the key falls through to CM6's caret handling.
    // Hint navigation above has already had its turn with ArrowUp.
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.caretAtTop()) {
        e.preventDefault()
        e.stopPropagation()
        this.actions.onUpAtTop?.()
      }
      return
    }

    // Standard editor keys when no hint is active.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      this.submit()
      return
    }
    // Escape clears the draft without interrupting the shell (Ctrl-C).
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.clearDoc()
      return
    }
    // Ctrl-C cancels the composed line like a shell prompt. A real selection is
    // left alone so Ctrl-C still copies; with nothing selected, interrupt.
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      const sel = this.view.state.selection.main
      if (sel.from !== sel.to) return
      e.preventDefault()
      e.stopPropagation()
      this.clearDoc()
      this.actions.cancel()
    }
  }

  /** True when the caret is on the first line (or the doc is empty): Up has
   *  no further upward movement, so recall may open (design §8.10 v6). */
  private caretAtTop(): boolean {
    const head = this.view.state.selection.main.head
    return this.view.state.doc.lineAt(head).number <= 1
  }

  // ── hint management ───────────────────────────────────────────────────

  /** Populate and show the alias hint dropdown with matching items.
   *  Caller is responsible for filtering by the current partial text. */
  showAliasHints(items: AliasSuggestion[]): void {
    if (items.length === 0 || this._hintDismissed) {
      this.hideAliasHints()
      return
    }
    this._hintItems = items
    this._hintSelectedIndex = 0
    this._renderHints()
    this.hintContainer.style.display = ''
  }

  /** Hide the hint dropdown and clear its items. */
  hideAliasHints(): void {
    this._hintItems = []
    this._hintSelectedIndex = 0
    this.hintContainer.style.display = 'none'
    this.hintContainer.innerHTML = ''
  }

  /** Rebuild the hint dropdown DOM from _hintItems. */
  private _renderHints(): void {
    this.hintContainer.innerHTML = ''
    for (let i = 0; i < this._hintItems.length; i++) {
      const item = this._hintItems[i]
      const el = document.createElement('div')
      el.className = 'nocx-editor-hint__item'
      if (i === this._hintSelectedIndex) {
        el.classList.add('nocx-editor-hint__item--selected')
      }
      // Primary label: alias
      const aliasSpan = document.createElement('span')
      aliasSpan.className = 'nocx-editor-hint__alias'
      aliasSpan.textContent = item.alias
      el.appendChild(aliasSpan)
      // Secondary label: resolved host + optional user
      const detailParts: string[] = [item.hostName]
      if (item.user) detailParts.unshift(`${item.user}@`)
      if (item.port && item.port !== 22) detailParts.push(`:${item.port}`)
      const detailSpan = document.createElement('span')
      detailSpan.className = 'nocx-editor-hint__detail'
      detailSpan.textContent = detailParts.join('')
      el.appendChild(detailSpan)
      // Click handler on the item (not on the label spans).
      el.addEventListener('mouseenter', () => {
        this._hintSelectedIndex = i
        this._renderHints()
      })
      el.addEventListener('mousedown', (me) => {
        me.preventDefault()
        this._hintSelectedIndex = i
        this.acceptHint()
      })
      this.hintContainer.appendChild(el)
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
    this._hintDismissed = false
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
    // A view that was display:none can cache zero or stale geometry; ask CM6
    // to re-measure before it is painted and focused (spec W1 check 5).
    this.view.requestMeasure()
    this.view.focus()
  }

  /** Focus the editor if it is visible. Safe to call when hidden. */
  focus(): void {
    if (this.isVisible) this.view.focus()
  }

  /** The current document text. */
  getDoc(): string {
    return this.view.state.doc.toString()
  }

  /** The current selection. */
  getSelection(): { from: number; to: number } {
    const sel = this.view.state.selection.main
    return { from: sel.from, to: sel.to }
  }

  /** Replace the whole document programmatically (fires no input events),
   *  placing the caret at `from` (default: the end of the text). The recall
   *  overlay uses this to preview a history row and to restore the draft. */
  replaceDoc(text: string, from?: number, to?: number): void {
    this._programmatic = true
    try {
      const anchor = from ?? text.length
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: text },
        selection: { anchor, head: to ?? anchor },
      })
    } finally {
      this._programmatic = false
    }
  }

  /** The editor's vertical scroll offset — for exact draft restoration. */
  getScrollTop(): number {
    return this.view.scrollDOM.scrollTop
  }

  setScrollTop(top: number): void {
    this.view.scrollDOM.scrollTop = top
  }
  /**
   * Insert text at the caret, replacing any selection, then focus.
   * Used by right-click/middle-click paste while the editor owns input: at the
   * prompt the terminal is read-only (setReadOnly), so a paste must land in the
   * composed command, not the (disabled) grid.
   */
  insertText(text: string): void {
    const sel = this.view.state.selection.main
    this._programmatic = true
    try {
      this.view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      })
    } finally {
      this._programmatic = false
    }
    this.view.focus()
  }
  hide(): void {
    // Stopped, not left running. Every tab owns an editor, so a timer that
    // outlives visibility is one wakeup per second per tab for a chip nobody can
    // see — and they accumulate for the life of the window.
    this.stopClock()
    this.view.contentDOM.blur()
    this.root.style.display = 'none'
    this.hideAliasHints()
  }

  get isVisible(): boolean {
    return this.root.style.display !== 'none' && this.root.style.visibility !== 'hidden'
  }

  /** Whether the editor's root element contains `el`. Used to scope the
   *  focus-bounce so clicks on the editor surface / cwd chip
   *  are not swallowed. CM6's contentDOM lives inside root, so the contract
   *  the focus-bounce tests against holds unchanged. */
  rootContains(el: Node | null): boolean {
    return this.root.contains(el)
  }

  dispose(): void {
    // A tab can be closed while its editor is on screen, which is the common
    // case rather than the edge one — hide() would never run and the interval
    // would outlive everything it refers to.
    this.stopClock()
    // The arbiter outlives the overlay it points at otherwise; a closed tab
    // must not keep consuming keys through a dead closure.
    this.keyArbiter = null
    this.root.removeEventListener('keydown', this.onKeydown, true)
    this.view.destroy()
    this.root.remove()
  }
}
