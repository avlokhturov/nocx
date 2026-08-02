// Provenance Recall overlay (design §8.10): a Warp-style history palette
// above the prompt — oldest at the top, newest at the bottom, the newest
// row selected on open, so the first Up gives the command you just ran.
// One row per past command, a relative timestamp on the right, the ladder
// rung it was drawn from, and a footer with the navigation keys.
//
// The rule (brief nocx-w7h.5 reversed the v4 one): navigating previews the
// selected command INTO the editor, and Enter executes what you can see —
// through the editor's own submit path, exactly as if the user had typed it
// and pressed Enter. The v4 argument ("running from a list is unsafe when
// the environment changed") applied to running blind; it does not apply to
// a command sitting in the input line, visible, with its existence check
// applied. The preview is the safety, so the label says "↵ to execute".
//
// The state machine is a discriminated union on `state`, never flags on the
// editor: `closed → opened (draft captured) → navigating (preview in the
// editor) → accepted | dismissed | abandoned-to-edit`. `opened` is what an
// empty history looks like — the panel is up and says so, with nothing to
// highlight. `accepted` submits the previewed command through the editor;
// `dismissed` restores the draft, the selection and the scroll exactly as
// they were; the third exit (v8 §1) closes the overlay and KEEPS the
// previewed command as the new draft when an insertion, a deletion or a
// caret move arrives while navigating — editing what you recalled is the
// ordinary way shell history is used.
//
// Arrows navigate and nothing else: at either end of the rung they stop,
// and the list scrolls to keep the selected row in view so every entry is
// reachable. Widening the ladder rung is its own key (shift+Up, shown in
// the footer) and preserves the selected command (v8 §4).
//
// Rows are served behind the generated `history.query` types. Until the
// persistent store lands, the query function maps the in-memory
// CommandLedger with `source: 'session'`, and the panel says so on screen —
// presenting one session as all of history is the same lie as marking every
// command green. When the backend arrives, only the query function changes.

import type { HistoryEntry, HistoryQuery } from './generated/history.query'
import type { CommandLedger } from './command-ledger'

/**
 * The scrollTop that puts `row` FULLY inside `list`'s visible box — its top
 * at or below the list's top and its bottom at or above the list's bottom.
 * Computed from live rects against the LIST only: the panel floats over the
 * scrollback, so scrollIntoView's ancestor walk can resolve the row against
 * the wrong scroller (spec v9 §1 — measured in a real browser: the selected row
 * straddled the list's bottom edge because 'nearest' never un-straddles a
 * partially visible row). Returns the current scrollTop when already fully
 * visible, so moving within the window never nudges the list.
 */
export function scrollTopToReveal(list: HTMLElement, row: HTMLElement): number {
  const listRect = list.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const above = listRect.top - rowRect.top
  const below = rowRect.bottom - listRect.bottom
  if (above > 0) return list.scrollTop - above
  if (below > 0) return list.scrollTop + below
  return list.scrollTop
}

/** The ladder rung a page of history was drawn from. */
export type RecallScope = 'directory' | 'host' | 'everywhere'

/** The smallest page a rung may show before opening on the next rung up.
 *  A directory holding one match is honest and useless: it reads as results
 *  appearing at random, and the user climbs anyway (§8.10 v7 — the owner
 *  amended v6's "never an automatic widening" after using the feature: the
 *  widening happens at OPEN, once, to the first rung with a useful page; Up
 *  still widens on demand after that). */
export const MIN_USEFUL_ROWS = 3

/** What each ladder rung means, in the user's words — the raw scope names
 *  (`directory`, `host`) are the schema's jargon and explain nothing. */
export const SCOPE_LABELS: Record<RecallScope, string> = {
  directory: 'this directory',
  host: 'this host',
  everywhere: 'everywhere',
}

/** What the user was composing when recall opened — captured so Esc can
 *  restore it exactly, not approximately. */
export interface DraftSnapshot {
  readonly text: string
  readonly from: number
  readonly to: number
  readonly scrollTop: number
}

/** The minimal editor surface the overlay drives. CommandEditor satisfies it;
 *  tests may substitute a fake. */
export interface RecallEditor {
  getDoc(): string
  getSelection(): { from: number; to: number }
  getScrollTop(): number
  /** Replace the whole doc programmatically (fires no input events), with the
   *  caret at `from` (default: the end of the text). */
  replaceDoc(text: string, from?: number, to?: number): void
  setScrollTop(top: number): void
  focus(): void
  /** Submit the current document through the editor's normal submit path —
   *  the same one a typed Enter fires. The overlay calls this to execute the
   *  previewed command; nothing is bypassed, no second route exists. */
  submit(): void
}

/** `text` is the search filter (nocx-ms7v): absent or empty means "the rung as
 *  it stands", which is what Up and Ctrl+R ask for. The seam carries it so the
 *  overlay can grow a filter without the composition root changing again. */
export type RecallQuery = (scope: RecallScope, text?: string) => Promise<HistoryQuery>
export type RecallState =
  | { readonly name: 'closed' }
  | {
      // The panel is up and the first rung's answer is in flight. The
      // query is served by the store over the control plane, so opening is
      // async; Escape dismisses from here, everything else passes through
      // exactly as it does in `opened`.
      readonly name: 'loading'
      readonly draft: DraftSnapshot
      readonly scope: RecallScope
    }
  | {
      readonly name: 'opened'
      readonly draft: DraftSnapshot
      readonly scope: RecallScope
      readonly query: HistoryQuery
      // The search filter (nocx-ms7v): typing narrows the rung. Empty is
      // the no-filter state — what Up and Ctrl+R open with.
      readonly filter: string
    }
  | {
      readonly name: 'navigating'
      readonly draft: DraftSnapshot
      readonly scope: RecallScope
      readonly query: HistoryQuery
      readonly selected: number
      readonly filter: string
    }

/** The explicit shortcut: Ctrl/Cmd+R, the chord every terminal user maps to
 *  history. Opens recall from any caret position (Up only opens at the top of
 *  a draft — see the editor's onUpAtTop). */
export function isRecallShortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey
  return mod && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')
}

/** A key that narrows the filter: one printable code point, unmodified.
 *  Space counts (a filter may contain it); Tab and chorded keys do not —
 *  they fall through to the editor's own handling. */
function isFilterKey(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** The next wider rung, or the same rung at the top of the ladder. */
export function nextScope(scope: RecallScope): RecallScope {
  switch (scope) {
    case 'directory':
      return 'host'
    case 'host':
      return 'everywhere'
    case 'everywhere':
      return 'everywhere'
  }
}

/** Relative time from a stored timestamp (wall-clock epoch milliseconds,
 *  `Date.now()` units — the same clock the ledger stamps and the store
 *  persists). `endedAt: null` renders as running — never as the epoch,
 *  which would read as 1970. */
export function relativeTime(endedAt: number | null, now: number): string {
  if (endedAt === null) return 'running'
  const diff = Math.max(0, now - endedAt)
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  return `${months} month${months === 1 ? '' : 's'} ago`
}

/** Human duration from a millisecond span (the detail pane's "duration").
 *  Sub-second shows milliseconds, seconds carry one decimal under 10,
 *  then minutes and hours. Rounds, never floors, so a 61.6 s run reads
 *  "1m 2s" rather than "1m 1s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 60) {
    const tenths = Math.round(s * 10)
    return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The detail pane's duration fact: running while open, unknown when the
 *  start was never observed, else the span between the two timestamps. */
function detailDuration(entry: HistoryEntry): string {
  if (entry.endedAt === null) return 'running'
  if (entry.startedAt === null || entry.startedAt === undefined) return '—'
  return formatDuration(entry.endedAt - entry.startedAt)
}
/**
 * Serve a history page from the in-memory ledger, newest first, filtered to
 * the requested rung. `source` is always 'session': this is the stopgap
 * behind the generated types until the persistent store answers. Only the
 * fetch changes when the backend lands.
 */
export function queryLedgerHistory(
  ledger: CommandLedger | null,
  scope: RecallScope,
  cwd: string,
  host: string,
  text?: string,
): HistoryQuery {
  const records = ledger ? [...ledger.records()].reverse() : []
  // Coverage: the session's own horizon — the oldest completed entry's
  // endedAt, session-wide. The rung narrows rows, never the horizon; the
  // store's coverage is store-wide for the same reason.
  let coverage: number | null = null
  for (const rec of records) {
    if (rec.endedAt !== null && (coverage === null || rec.endedAt < coverage)) {
      coverage = rec.endedAt
    }
  }
  const entries: HistoryEntry[] = []
  // The fallback filters the same way the store does, or the same keystroke
  // returns a different set depending on whether the store answered.
  const needle = text === undefined ? '' : text.toLowerCase()
  for (const rec of records) {
    if (scope === 'directory' && (rec.cwd !== cwd || rec.host !== host)) continue
    if (scope === 'host' && rec.host !== host) continue
    if (needle !== '' && !rec.command.toLowerCase().includes(needle)) continue
    entries.push({
      id: String(rec.id),
      command: rec.command,
      cwd: rec.cwd,
      host: rec.host,
      status: rec.status,
      exitCode: rec.exitCode,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
    })
  }
  // The ledger has no further pages: this is the whole session.
  return { entries, scope, exhausted: true, source: 'session', coverage }
}

export class RecallOverlay {
  private state: RecallState = { name: 'closed' }
  private readonly root: HTMLElement
  private readonly editor: RecallEditor
  private readonly query: RecallQuery

  constructor(opts: { editor: RecallEditor; query: RecallQuery }) {
    this.editor = opts.editor
    this.query = opts.query
    this.root = document.createElement('div')
    this.root.className = 'ui-recall-panel'
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'command history')
    this.root.dataset.open = 'false'
  }

  get isOpen(): boolean {
    return this.state.name !== 'closed'
  }

  /** Mount the panel as a child of the editor's root, so it floats above the
   *  editor (the root is position: relative). */
  mount(container: HTMLElement): void {
    container.appendChild(this.root)
  }
  /**
   * Open the overlay on the given ladder rung. The current draft, selection
   * and scroll are captured so Esc can restore them exactly. The panel is
   * shown immediately (loading) and the first rung is fetched from the
   * store; opening is async because the query crosses the control plane.
   * The rung-climb happens after each answer: a directory holding one
   * match is honest and useless — the next Up would climb anyway, and
   * opening there reads as results appearing at random (§8.10 v7). Rungs
   * are monotone (directory ⊆ host ⊆ everywhere), so climbing never hides
   * a row the narrower rung showed; the climb stops at the top of the
   * ladder even when the widest rung is thin.
   */
  async open(scope: RecallScope): Promise<void> {
    if (this.isOpen) return
    const sel = this.editor.getSelection()
    const draft: DraftSnapshot = {
      text: this.editor.getDoc(),
      from: sel.from,
      to: sel.to,
      scrollTop: this.editor.getScrollTop(),
    }
    this.state = { name: 'loading', draft, scope }
    this.root.dataset.open = 'true'
    this.render()

    let rung = scope
    let result = await this.query(rung)
    while (result.entries.length < MIN_USEFUL_ROWS && rung !== 'everywhere') {
      rung = nextScope(rung)
      result = await this.query(rung)
    }
    // Dismissed (or re-opened) while the answers were in flight: the
    // captured draft is gone; drop the result.
    if (this.state.name !== 'loading') return

    this.state = { name: 'opened', draft, scope: rung, query: result, filter: '' }
    this.render()
    if (result.entries.length > 0) {
      // Display order is oldest at the top, newest at the bottom (Warp's
      // model — the first Up gives the command you just ran), so the row
      // selected on open is the LAST one; render() scrolls it into view.
      this.enterNavigating(rung, result, result.entries.length - 1, '')
    }
  }
  /**
   * Keyboard arbiter — the editor calls this BEFORE its own handling, so an
   * open overlay owns navigation, accept and dismiss and nothing the editor
   * handles (submit, clear, interrupt) can fire while it is up. Returns true
   * when the key was consumed.
   */
  handleKey(e: KeyboardEvent): boolean {
    const s = this.state
    switch (s.name) {
      case 'closed':
        if (isRecallShortcut(e)) {
          e.preventDefault()
          e.stopPropagation()
          void this.open('directory')
          return true
        }
        return false
      case 'loading':
        // The first rung is still in flight. Escape dismisses; so does
        // Enter (accepting nothing must not feel like a dead key). Arrows
        // do nothing — there are no rows to walk — and everything else
        // passes through exactly as it does in `opened`.
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          this.dismiss()
          return true
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          return true // stop: no rows to navigate
        }
        return this.passThroughOrDismiss(e)
      case 'opened':
        // Empty history: nothing to accept. Escape dismisses; so does Enter
        // (accepting nothing must not feel like a dead key). Arrows do
        // nothing here — there are no rows to walk — and widening is its own
        // key (shift+Up), not an arrow. Typing starts (or narrows) the
        // filter: the panel owns printable keys while it is up, so they
        // never land in the editor under it.
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          this.dismiss()
          return true
        }
        if (e.key === 'ArrowUp' && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          this.climbWider()
          return true
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          return true // stop: no rows to navigate
        }
        if (isFilterKey(e)) {
          e.preventDefault()
          e.stopPropagation()
          this.appendFilter(e.key)
          return true
        }
        if (e.key === 'Backspace' && s.filter !== '') {
          e.preventDefault()
          e.stopPropagation()
          this.trimFilter()
          return true
        }
        return this.passThroughOrDismiss(e)
      case 'navigating':
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          this.dismiss()
          return true
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          this.accept()
          return true
        }
        if (e.key === 'ArrowUp' && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          this.climbWider()
          return true
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          this.move(-1)
          return true
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          this.move(1)
          return true
        }
        if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
          e.preventDefault()
          e.stopPropagation()
          this.dismiss()
          return true
        }
        // Typing narrows: printable keys are the filter, never the editor.
        if (isFilterKey(e)) {
          e.preventDefault()
          e.stopPropagation()
          this.appendFilter(e.key)
          return true
        }
        // Backspace clears the filter when there is one; with an empty
        // filter it falls through to the third exit — a deletion hands the
        // line to the editor, the ordinary way shell history is edited.
        if (e.key === 'Backspace' && s.filter !== '') {
          e.preventDefault()
          e.stopPropagation()
          this.trimFilter()
          return true
        }
        // Everything else — an insertion, a deletion, a caret move — hands
        // the line to the editor: close the overlay KEEPING the previewed
        // command as the new draft (the third exit, brief nocx-w7h.8 §1).
        this.abandonToEdit()
        return false
    }
  }

  /** Widen the ladder rung (shift+Up — the explicit widen key, never an
   *  arrow). The narrower rung's entries are a subset of the wider one's, so
   *  the selected command still exists: the selection stays on that same
   *  command instead of jumping to either end. If it genuinely cannot be
   *  located, the selection keeps the same distance from the newest entry.
   *  The wider rung is fetched over the control plane; the transition is
   *  applied when the answer lands, and dropped if the panel closed first.
   *  Returns true when a wider rung exists. */
  private climbWider(): boolean {
    const s = this.state
    if (s.name !== 'opened' && s.name !== 'navigating') return false
    if (!s.query.exhausted) return false
    const wider = nextScope(s.scope)
    if (wider === s.scope) return false

    const draft = s.draft
    const filter = s.filter
    const wasNavigating = s.name === 'navigating'
    const previous = s
    // The filter rides the climb: a search that narrows on this rung must
    // keep narrowing on the wider one, or the climb silently widens the
    // search too.
    void this.query(wider, filter).then((result) => {
      // The panel moved on (dismissed, re-opened, or climbing again) while
      // the answer was in flight: apply nothing.
      if (this.state.name !== 'opened' && this.state.name !== 'navigating') return
      if (this.state.draft !== draft) return
      if (this.state.filter !== filter) return
      if (result.entries.length === 0) {
        this.state = { name: 'opened', draft, scope: wider, query: result, filter }
        this.render()
        return
      }
      // Preserve the selected command when navigating; widening from an
      // empty rung opens on the newest entry, like open() does.
      let selected = result.entries.length - 1
      if (wasNavigating && previous.name === 'navigating') {
        const wireIndex = previous.query.entries.length - 1 - previous.selected
        const id = previous.query.entries[wireIndex]?.id
        const at = id !== undefined ? result.entries.findIndex((e) => e.id === id) : -1
        if (at >= 0) {
          selected = result.entries.length - 1 - at
        } else {
          const distance = previous.query.entries.length - 1 - previous.selected
          selected = Math.max(0, result.entries.length - 1 - distance)
        }
      }
      this.enterNavigating(wider, result, selected, filter)
    })
    return true
  }

  /** Any other key in the OPENED (empty) panel closes recall and passes
   *  through, so the keystroke lands in the restored draft — there is no
   *  preview to keep. Ctrl-C is the exception: it dismisses and is CONSUMED,
   *  because recalling must never interrupt the shell. */
  private passThroughOrDismiss(e: KeyboardEvent): boolean {
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      this.dismiss()
      return true
    }
    this.dismiss()
    return false
  }

  /** The third exit (brief nocx-w7h.8 §1): an insertion, a deletion or a
   *  caret move while navigating hands the line to the editor. The overlay
   *  closes, the previewed command STAYS as the new draft, and the key that
   *  triggered this lands on it. Neither `dismiss` (restores the captured
   *  draft — that is what cleared the line) nor `accept` (submits) applies. */
  private abandonToEdit(): void {
    if (this.state.name !== 'navigating') return
    this.close()
  }

  /** Arrows navigate and nothing else: at either end of the rung they
   *  stop. Widening is the explicit shift+Up key, never an arrow (v8). */
  private move(dir: -1 | 1): void {
    const s = this.state
    if (s.name !== 'navigating') return
    const next = s.selected + dir
    if (next < 0 || next >= s.query.entries.length) return
    this.enterNavigating(s.scope, s.query, next, s.filter)
  }

  private enterNavigating(
    scope: RecallScope,
    result: HistoryQuery,
    selected: number,
    filter: string,
  ): void {
    const s = this.state
    if (s.name !== 'opened' && s.name !== 'navigating') return
    this.state = { name: 'navigating', draft: s.draft, scope, query: result, selected, filter }
    // Preview the highlighted row in the editor — programmatic, so no input
    // events fire (the alias-hint fetch must not run while recalling).
    // `selected` is a DISPLAY index (0 = top = oldest); the wire is newest
    // first, so the wire index is the mirror of the display index.
    const wireIndex = result.entries.length - 1 - selected
    const entry = result.entries[wireIndex]
    if (entry) this.editor.replaceDoc(entry.command)
    this.render()
  }

  /** Append a printable key to the filter and re-query the rung. */
  private appendFilter(ch: string): void {
    this.setFilter((f) => f + ch)
  }

  /** Drop the last code point of the filter and re-query the rung. */
  private trimFilter(): void {
    this.setFilter((f) => Array.from(f).slice(0, -1).join(''))
  }

  /** Change the filter and fetch the narrowed page. The new filter text is
   *  shown immediately; the answer lands async, and a later keystroke's
   *  answer supersedes an earlier one (each landing compares the filter it
   *  was asked with against the state's current filter). */
  private setFilter(update: (f: string) => string): void {
    const s = this.state
    if (s.name !== 'opened' && s.name !== 'navigating') return
    const filter = update(s.filter)
    if (filter === s.filter) return
    const wasNavigating = s.name === 'navigating'
    const previous = s
    this.state = { ...s, filter }
    this.render()
    void this.query(s.scope, filter).then((result) => {
      // The panel moved on, or a newer keystroke superseded this answer:
      // apply nothing.
      if (this.state.name !== 'opened' && this.state.name !== 'navigating') return
      if (this.state.filter !== filter) return
      if (this.state.draft !== s.draft) return
      if (result.entries.length === 0) {
        // Nothing matches: back to the empty rung state. `opened` means
        // "the editor holds the draft", so the stale preview must go.
        this.state = { name: 'opened', draft: s.draft, scope: s.scope, query: result, filter }
        const d = s.draft
        this.editor.replaceDoc(d.text, d.from, d.to)
        this.render()
        return
      }
      // Preserve the selected command when it survives the narrowing; a
      // fresh filter opens on the newest match, like open() does.
      let selected = result.entries.length - 1
      if (wasNavigating && previous.name === 'navigating') {
        const wireIndex = previous.query.entries.length - 1 - previous.selected
        const id = previous.query.entries[wireIndex]?.id
        const at = id !== undefined ? result.entries.findIndex((e) => e.id === id) : -1
        if (at >= 0) selected = result.entries.length - 1 - at
      }
      this.enterNavigating(s.scope, result, selected, filter)
    })
  }

  /** Enter: the previewed command is already in the editor (navigating
   *  previewed it); submit it through the editor's own submit path — the
   *  same one a typed Enter fires, with the command visible in the line.
   *  Nothing is bypassed, no second route exists. */
  private accept(): void {
    const s = this.state
    if (s.name !== 'navigating') return
    this.close()
    this.editor.submit()
  }
  /** Esc: restore the draft, the selection and the scroll position exactly. */
  private dismiss(): void {
    const s = this.state
    if (s.name === 'closed') return
    if (s.name === 'loading' || s.name === 'opened' || s.name === 'navigating') {
      const d = s.draft
      this.editor.replaceDoc(d.text, d.from, d.to)
      this.editor.setScrollTop(d.scrollTop)
      this.editor.focus()
    }
    this.close()
  }

  private close(): void {
    this.state = { name: 'closed' }
    this.root.dataset.open = 'false'
    this.root.replaceChildren()
  }

  destroy(): void {
    this.close()
    this.root.remove()
  }

  /** Rebuild the panel DOM from the current state. */
  private render(): void {
    const s = this.state
    if (s.name === 'closed') return
    this.root.replaceChildren()
    // ── Header: title, rung, count, source note ──────────────────────
    const header = document.createElement('div')
    header.className = 'ui-recall-panel__header'

    const title = document.createElement('span')
    title.className = 'ui-recall-panel__title'
    title.textContent = 'history'
    header.appendChild(title)

    const rung = document.createElement('span')
    rung.className = 'ui-badge ui-recall-panel__rung'
    rung.dataset.tone = 'neutral'
    rung.textContent = SCOPE_LABELS[s.scope]
    header.appendChild(rung)

    const count = document.createElement('span')
    count.className = 'ui-recall-panel__count'
    if (s.name === 'loading') {
      count.textContent = '…'
    } else {
      count.textContent = `${s.query.entries.length} ${s.query.entries.length === 1 ? 'result' : 'results'}`
    }
    header.appendChild(count)

    if (s.name !== 'loading' && s.query.source === 'session') {
      const note = document.createElement('span')
      note.className = 'ui-badge ui-recall-panel__source'
      note.dataset.tone = 'warning'
      note.textContent = 'this session only'
      header.appendChild(note)
    }
    this.root.appendChild(header)

    // ── Filter + coverage bar: what narrows the page (left) and how far
    //    back the answer can see (right). The filter is a display of the
    //    captured text — keys land on the editor's arbiter, never on an
    //    input — so the empty state is the affordance ("type to filter")
    //    and the active state names the needle. The coverage line is the
    //    honesty seam (nocx-ms7v): with retention set, a search can only
    //    see part of history, and the panel says how far back instead of
    //    presenting a partial answer as the whole one. ──
    const bar = document.createElement('div')
    bar.className = 'ui-recall-panel__bar'
    const filterEl = document.createElement('span')
    filterEl.className = 'ui-recall-panel__filter'
    if (s.name !== 'loading') {
      if (s.filter !== '') {
        filterEl.dataset.active = 'true'
        filterEl.textContent = `filter: ${s.filter}`
      } else {
        filterEl.textContent = 'type to filter'
      }
    } else {
      filterEl.textContent = 'type to filter'
    }
    bar.appendChild(filterEl)
    if (s.name !== 'loading' && s.query.coverage !== null) {
      const coverage = document.createElement('span')
      coverage.className = 'ui-recall-panel__coverage'
      coverage.textContent = `oldest entry ${relativeTime(s.query.coverage, Date.now())}`
      bar.appendChild(coverage)
    }
    this.root.appendChild(bar)

    // ── Rows, or the kit's empty state ────────────────────────────────
    const list = document.createElement('div')
    list.className = 'ui-recall-panel__list'
    list.setAttribute('role', 'listbox')

    if (s.name === 'loading') {
      // The first rung is still in flight — a brief state on a local
      // socket, but it must not read as "no history yet".
      const empty = document.createElement('div')
      empty.className = 'ui-empty-state'
      const emptyTitle = document.createElement('div')
      emptyTitle.className = 'ui-empty-state__title'
      emptyTitle.textContent = '…'
      empty.appendChild(emptyTitle)
      list.appendChild(empty)
    } else if (s.query.entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ui-empty-state'
      const emptyTitle = document.createElement('div')
      emptyTitle.className = 'ui-empty-state__title'
      const emptyDesc = document.createElement('div')
      emptyDesc.className = 'ui-empty-state__desc'
      // The empty state must tell the truth about WHY it is empty: no
      // history and no matches are different facts, and a filter that
      // found nothing must not read as a terminal that forgot.
      if (s.filter !== '') {
        emptyTitle.textContent = `no matches for "${s.filter}"`
        emptyDesc.textContent = 'backspace to clear the filter'
      } else {
        emptyTitle.textContent = 'no history yet'
        emptyDesc.textContent = 'commands you run will appear here'
      }
      empty.appendChild(emptyTitle)
      empty.appendChild(emptyDesc)
      list.appendChild(empty)
    } else {
      const selected = s.name === 'navigating' ? s.selected : -1
      const now = Date.now()
      // Display order is oldest at the top, newest at the bottom — the
      // reverse of the wire (the contract belongs to neither side, and the
      // schema says `entries` is newest first, so the renderer mirrors).
      for (let d = 0; d < s.query.entries.length; d++) {
        const entry = s.query.entries[s.query.entries.length - 1 - d]
        const row = document.createElement('div')
        row.className = 'ui-collection-row'
        row.setAttribute('role', 'option')
        if (d === selected) row.dataset.selected = 'true'
        const info = document.createElement('div')
        info.className = 'ui-collection-row__info'
        info.textContent = entry.command
        const actions = document.createElement('div')
        actions.className = 'ui-collection-row__actions'
        const time = document.createElement('span')
        time.className = 'ui-recall-panel__time'
        time.textContent = relativeTime(entry.endedAt, now)
        actions.appendChild(time)
        row.appendChild(info)
        row.appendChild(actions)
        list.appendChild(row)
      }
    }
    this.root.appendChild(list)

    // ── Detail pane: the four facts about the selected row — exit code,
    //    cwd, duration, when it last ran. The data is in the entry; nothing
    //    here is fetched on selection. Unknowns render as unknown (—), never
    //    as zero or as the epoch (design §8.10). ──
    if (s.name === 'navigating') {
      const wireIndex = s.query.entries.length - 1 - s.selected
      const entry = s.query.entries[wireIndex]
      if (entry) {
        const detail = document.createElement('div')
        detail.className = 'ui-recall-panel__detail'
        const facts: ReadonlyArray<readonly [string, string]> = [
          [
            'exit code',
            entry.exitCode === null || entry.exitCode === undefined ? '—' : String(entry.exitCode),
          ],
          ['cwd', entry.cwd === '' ? '—' : entry.cwd],
          ['duration', detailDuration(entry)],
          ['last ran', relativeTime(entry.endedAt, Date.now())],
        ]
        for (const [term, value] of facts) {
          const item = document.createElement('div')
          item.className = 'ui-recall-panel__detail-item'
          const termEl = document.createElement('span')
          termEl.className = 'ui-recall-panel__detail-term'
          termEl.textContent = term
          const valueEl = document.createElement('span')
          valueEl.className = 'ui-recall-panel__detail-value'
          valueEl.textContent = value
          item.appendChild(termEl)
          item.appendChild(valueEl)
          detail.appendChild(item)
        }
        this.root.appendChild(detail)
      }
    }

    // ── One footer, one line, every hint in it: what Enter does, how to
    //    move, how to widen, how to get out — key groups separated by a real
    //    gap. The execute group only appears when there IS something to
    //    execute; the widen group only when the rung can widen (the empty
    //    panel must not promise what a key cannot do there). ──
    const footer = document.createElement('div')
    footer.className = 'ui-recall-panel__footer'
    if (s.name === 'navigating') {
      const execute = document.createElement('span')
      execute.textContent = '↵ to execute'
      footer.appendChild(execute)
    }
    const navigate = document.createElement('span')
    navigate.textContent = '↑ ↓ to navigate'
    footer.appendChild(navigate)
    if (s.name !== 'loading' && s.query.exhausted && s.scope !== 'everywhere') {
      const widen = document.createElement('span')
      widen.textContent = 'shift+↑ widen'
      footer.appendChild(widen)
    }
    const dismiss = document.createElement('span')
    dismiss.textContent = 'esc to dismiss'
    footer.appendChild(dismiss)
    this.root.appendChild(footer)

    // Keep the selected row FULLY in view — on open (it is the bottom row)
    // and on every move — so a rung taller than the panel is walkable: the
    // list scrolls with the selection instead of stranding rows past the
    // visible window (v8 §3). Measured AFTER the footer is in place, because
    // the list's visible height is only final once the whole panel is laid
    // out. scrollIntoView({block:'nearest'}) was not doing this job: in a
    // real browser the selected row straddled the list's bottom edge on
    // open (2px visible of a 32px row) — so the reveal is computed from
    // live rects against the list itself (nocx-w7h.10, spec v9 §1).
    if (s.name === 'navigating') {
      const selectedEl = list.querySelector<HTMLElement>('.ui-collection-row[data-selected="true"]')
      if (selectedEl) list.scrollTop = scrollTopToReveal(list, selectedEl)
    }
  }
}
