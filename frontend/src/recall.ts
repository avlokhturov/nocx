// Provenance Recall overlay (design §8.10, brief nocx-w7h.4): a Warp-style
// history palette above the prompt. One row per past command, a relative
// timestamp on the right, the ladder rung it was drawn from, and a footer
// with the navigation keys.
//
// The rule that is not negotiable: **Enter in the overlay inserts the
// command into the editor and does not execute it.** A history of
// destructive commands crossed with a changed environment makes running from
// a list unacceptable — the `rm -rf build` you ran in one repo is a
// different command in another. Enter fills the line; the editor's own Enter
// is what executes, and the "↵ to execute" caption says so.
//
// The state machine is a discriminated union on `state`, never flags on the
// editor: `closed → opened (draft captured) → navigating (preview in the
// editor) → accepted | dismissed`. `opened` is what an empty history looks
// like — the panel is up and says so, with nothing to highlight. `accepted`
// leaves the command in the editor; `dismissed` restores the draft, the
// selection and the scroll exactly as they were.
//
// Rows are served behind the generated `history.query` types. Until the
// persistent store lands, the query function maps the in-memory
// CommandLedger with `source: 'session'`, and the panel says so on screen —
// presenting one session as all of history is the same lie as marking every
// command green. When the backend arrives, only the query function changes.

import type { HistoryEntry, HistoryQuery } from './generated/history.query'
import type { CommandLedger } from './command-ledger'

/** The ladder rung a page of history was drawn from. */
export type RecallScope = 'directory' | 'host' | 'everywhere'

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
}

export type RecallQuery = (scope: RecallScope) => HistoryQuery

export type RecallState =
  | { readonly name: 'closed' }
  | {
      readonly name: 'opened'
      readonly draft: DraftSnapshot
      readonly scope: RecallScope
      readonly query: HistoryQuery
    }
  | {
      readonly name: 'navigating'
      readonly draft: DraftSnapshot
      readonly scope: RecallScope
      readonly query: HistoryQuery
      readonly selected: number
    }

/** The explicit shortcut: Ctrl/Cmd+R, the chord every terminal user maps to
 *  history. Opens recall from any caret position (Up only opens at the top of
 *  a draft — see the editor's onUpAtTop). */
export function isRecallShortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey
  return mod && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')
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

/** Relative time from a ledger timestamp (performance.now() units, so the
 *  diff is wall time). `endedAt: null` renders as running — never as the
 *  epoch, which would read as 1970. */
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
): HistoryQuery {
  const records = ledger ? [...ledger.records()].reverse() : []
  const entries: HistoryEntry[] = []
  for (const rec of records) {
    if (scope === 'directory' && (rec.cwd !== cwd || rec.host !== host)) continue
    if (scope === 'host' && rec.host !== host) continue
    entries.push({
      id: String(rec.id),
      command: rec.command,
      cwd: rec.cwd,
      host: rec.host,
      status: rec.status,
      exitCode: rec.exitCode,
      endedAt: rec.endedAt,
    })
  }
  // The ledger has no further pages: this is the whole session.
  return { entries, scope, exhausted: true, source: 'session' }
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

  /** Open the overlay on the given ladder rung. The current draft, selection
   *  and scroll are captured so Esc can restore them exactly. */
  open(scope: RecallScope): void {
    if (this.isOpen) return
    const sel = this.editor.getSelection()
    const draft: DraftSnapshot = {
      text: this.editor.getDoc(),
      from: sel.from,
      to: sel.to,
      scrollTop: this.editor.getScrollTop(),
    }
    const result = this.query(scope)
    this.state = { name: 'opened', draft, scope, query: result }
    this.root.dataset.open = 'true'
    this.render()
    if (result.entries.length > 0) {
      this.enterNavigating(scope, result, 0)
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
          this.open('directory')
          return true
        }
        return false
      case 'opened':
        // Empty history: nothing to accept. Escape dismisses; so does Enter
        // (accepting nothing must not feel like a dead key). Up climbs to a
        // wider rung when this one is exhausted — an empty directory must not
        // hide commands that ran elsewhere on the same host.
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          this.dismiss()
          return true
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          // At the widest rung this is a no-op: the empty overlay stays up —
          // Up must not make an empty history disappear.
          this.climbWider()
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
        return this.passThroughOrDismiss(e)
    }
  }

  /** Widen the ladder rung when the current page is exhausted: Up at the top
   *  row of a navigating page, or Up in an empty rung. Returns true when the
   *  rung changed. Rungs are monotone (directory ⊆ host ⊆ everywhere), so a
   *  wider page can never be shorter than the current one. */
  private climbWider(): boolean {
    const s = this.state
    if (s.name !== 'opened' && s.name !== 'navigating') return false
    if (!s.query.exhausted) return false
    const wider = nextScope(s.scope)
    if (wider === s.scope) return false
    const result = this.query(wider)
    if (result.entries.length > 0) {
      this.enterNavigating(wider, result, 0)
    } else {
      this.state = { name: 'opened', draft: s.draft, scope: wider, query: result }
      this.render()
    }
    return true
  }

  /** Any other key closes recall and passes through, so the keystroke lands
   *  in the restored draft — typing while recalling means "give my draft
   *  back". Ctrl-C is the exception: it dismisses and is CONSUMED, because
   *  recalling must never interrupt the shell. */
  private passThroughOrDismiss(e: KeyboardEvent): boolean {
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      this.dismiss()
      return true
    }
    this.dismiss()
    return false
  }

  private move(dir: -1 | 1): void {
    const s = this.state
    if (s.name !== 'navigating') return
    const total = s.query.entries.length
    let next = s.selected + dir
    if (next < 0) {
      // At the top row of an exhausted rung, Up climbs to the next wider one
      // (schema: exhausted decides "the next Up climbs to a wider rung rather
      // than paging further down this one"). The rung is visible in the
      // header, so a climb is never silent.
      this.climbWider()
      return
    }
    if (next >= total) next = total - 1 // at the bottom: stay
    this.enterNavigating(s.scope, s.query, next)
  }

  private enterNavigating(scope: RecallScope, result: HistoryQuery, selected: number): void {
    const s = this.state
    if (s.name !== 'opened' && s.name !== 'navigating') return
    this.state = { name: 'navigating', draft: s.draft, scope, query: result, selected }
    // Preview the highlighted row in the editor — programmatic, so no input
    // events fire (the alias-hint fetch must not run while recalling).
    const entry = result.entries[selected]
    if (entry) this.editor.replaceDoc(entry.command)
    this.render()
  }

  /** Enter: the previewed command stays in the editor. Nothing is executed —
   *  that is the editor's own Enter, later, with the environment as it is
   *  now. */
  private accept(): void {
    const s = this.state
    if (s.name !== 'navigating') return
    const entry = s.query.entries[s.selected]
    if (entry) {
      this.editor.replaceDoc(entry.command)
      this.editor.focus()
    }
    this.close()
  }

  /** Esc: restore the draft, the selection and the scroll position exactly. */
  private dismiss(): void {
    const s = this.state
    if (s.name === 'closed') return
    if (s.name === 'opened' || s.name === 'navigating') {
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
    rung.textContent = s.scope
    header.appendChild(rung)

    const count = document.createElement('span')
    count.className = 'ui-recall-panel__count'
    count.textContent = `${s.query.entries.length} ${s.query.entries.length === 1 ? 'result' : 'results'}`
    header.appendChild(count)

    if (s.query.source === 'session') {
      const note = document.createElement('span')
      note.className = 'ui-badge ui-recall-panel__source'
      note.dataset.tone = 'warning'
      note.textContent = 'this session only'
      header.appendChild(note)
    }
    this.root.appendChild(header)

    // ── Rows, or the kit's empty state ────────────────────────────────
    const list = document.createElement('div')
    list.className = 'ui-recall-panel__list'
    list.setAttribute('role', 'listbox')

    if (s.query.entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ui-empty-state'
      const emptyTitle = document.createElement('div')
      emptyTitle.className = 'ui-empty-state__title'
      emptyTitle.textContent = 'no history yet'
      const emptyDesc = document.createElement('div')
      emptyDesc.className = 'ui-empty-state__desc'
      emptyDesc.textContent = 'commands you run will appear here'
      empty.appendChild(emptyTitle)
      empty.appendChild(emptyDesc)
      list.appendChild(empty)
    } else {
      const selected = s.name === 'navigating' ? s.selected : -1
      const now = performance.now()
      s.query.entries.forEach((entry, i) => {
        const row = document.createElement('div')
        row.className = 'ui-collection-row'
        row.setAttribute('role', 'option')
        if (i === selected) row.dataset.selected = 'true'
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
      })
    }
    this.root.appendChild(list)

    // ── "↵ to execute": the separate line explaining the two-step flow.
    //    The command is in the editor now; Enter in the editor executes it. ──
    if (s.name === 'navigating') {
      const hint = document.createElement('div')
      hint.className = 'ui-recall-panel__hint'
      hint.textContent = '↵ to execute'
      this.root.appendChild(hint)
    }

    const footer = document.createElement('div')
    footer.className = 'ui-recall-panel__footer'
    footer.textContent = '↑ ↓ to navigate  esc to dismiss'
    this.root.appendChild(footer)
  }
}
