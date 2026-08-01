// DOM scrollback block manager.
// Creates, freezes, and manages DOM command blocks in the scrollback area.
// Flat warp-style design (P0-1): no card borders, dividers between blocks,
// subtle background tint on hover/select.

import { serializeRange, fromITheme } from './serializer'
import { getCurrentTheme } from '../renderers/theme-adapter'
import { highlightShellText, onShellHighlightReady } from '../shell-highlight'
import type { IBufferLine } from '@xterm/xterm'

// ── Clipboard helper ────────────────────────────────────────────────────────

function clipboardFallback(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* silent */
      }
      document.body.removeChild(ta)
    })
  }
}

// ── Block model ────────────────────────────────────────────────────────────

export interface BlockRecord {
  id: number
  command: string
  cwd: string
  /** Duration in ms: C marker to D marker. */
  durationMs: number | null
  exitCode: number | null
  status: 'running' | 'success' | 'failure'
  /** IMarker line for C boundary. */
  startLine: number
  /** IMarker line for D boundary (approx). */
  endLine: number
  el: HTMLElement
}

/** Line accessor function — matches xterm's IBufferLine.getLine(). */
export type GetLineFn = (y: number) => IBufferLine | undefined

// ── DOM helpers ────────────────────────────────────────────────────────────

function div(className: string, ...children: (string | HTMLElement)[]): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  for (const c of children) {
    if (typeof c === 'string') {
      el.appendChild(document.createTextNode(c))
    } else {
      el.appendChild(c)
    }
  }
  return el
}

// ── Duration formatters ────────────────────────────────────────────────────

/**
 * The elapsed time of a command that is still running.
 *
 * Whole seconds, unlike the finished-command format. The ticker fires once a
 * second, so a tenths digit could only ever read `.0` — a decimal place that
 * never varies is not precision, it is noise that makes the number wider and
 * harder to read at a glance.
 */
function formatRunningDuration(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = ((ms % 60000) / 1000).toFixed(0)
  return `${min}m ${sec}s`
}

// ── CWD display ────────────────────────────────────────────────────────────

function cwdLabel(cwd: string): string {
  const path = cwd.trim().replace(/\/+$/, '') || '~'
  const parts = path.split('/').filter(Boolean)
  if (path === '~' || parts.length === 0) return path
  return parts.slice(-2).join('/')
}

// ── Frozen-header highlight readiness ────────────────────────────────────────
//
// The Shiki grammar loads asynchronously at module init. A header frozen in
// the few milliseconds before that resolves would stay plain forever, so
// spans rendered pre-ready are registered here and repainted by
// `highlightShellText` once the tokenizer exists. After that the registration
// is a no-op: the grammar is loaded and every later header is coloured at
// freeze time.

let tokenizerLoaded = false
const pendingHeaderSpans = new Set<HTMLElement>()

function refreshPendingHeaderSpans(): void {
  for (const span of pendingHeaderSpans) {
    const text = span.textContent ?? ''
    if (text && text !== '(empty)') span.innerHTML = highlightShellText(text)
  }
  pendingHeaderSpans.clear()
}

onShellHighlightReady(() => {
  tokenizerLoaded = true
  refreshPendingHeaderSpans()
})

// ── Block DOM factory ───────────────────────────────────────────────────────

/**
 * Create the header row for a command block — flat, warp-style (P0-1).
 * No card background, no pill/chip styling. Plain muted small text.
 */
function createHeader(
  command: string,
  cwd: string,
  location: string,
  durationMs: number | null,
  exitCode: number | null,
  status: 'running' | 'success' | 'failure',
): HTMLElement {
  const header = div('cmd-header')

  // ── Chips row (above command text): cwd left, duration+exit right ──
  const chipsRow = div('cmd-header-chips')

  // Where the command ran, when it is somewhere other than this machine. Warp
  // puts `user@host` at the head of every block header and it is the attribute
  // ours was missing: a scrollback full of blocks with no host in them reads
  // the same whether you were on your laptop or three hops away (nocx-6w4z).
  if (location) {
    const loc = document.createElement('span')
    loc.className = 'nocx-chip nocx-chip-muted cmd-header-location'
    loc.textContent = location
    chipsRow.appendChild(loc)
  }

  // CWD — standard chip component
  if (cwd) {
    const cwdEl = document.createElement('span')
    cwdEl.className = 'nocx-chip cmd-header-cwd'
    cwdEl.textContent = `📁 ${cwdLabel(cwd)}`
    chipsRow.appendChild(cwdEl)
  }

  // Right: duration + exit status (or spinner while running)
  const right = div('cmd-header-right')

  if (status === 'running') {
    // The elapsed time, ticking. It used to appear only once the command had
    // finished, which is the one moment you no longer need it — the question
    // "how long has this been going" is asked WHILE it is going. Warp shows it
    // live and so does this (nocx-6w4z).
    const spinner = document.createElement('span')
    spinner.className = 'cmd-header-spinner'
    right.appendChild(spinner)

    const dur = document.createElement('span')
    dur.className = 'nocx-chip nocx-chip-muted cmd-header-duration'
    dur.textContent = formatRunningDuration(0)
    right.appendChild(dur)
  } else {
    if (durationMs !== null) {
      const dur = document.createElement('span')
      dur.className = 'nocx-chip nocx-chip-muted cmd-header-duration'
      dur.textContent = formatDuration(durationMs)
      right.appendChild(dur)
    }

    if (exitCode !== null) {
      const exit = document.createElement('span')
      exit.className =
        exitCode === 0
          ? 'nocx-chip nocx-chip-ok cmd-header-exit cmd-header-exit-ok'
          : 'nocx-chip nocx-chip-fail cmd-header-exit cmd-header-exit-fail'
      exit.textContent = exitCode === 0 ? 'ok' : `exit ${exitCode}`
      right.appendChild(exit)
    }
  }

  chipsRow.appendChild(right)
  header.appendChild(chipsRow)

  // ── Command text (below chips) ─────────────────────────────────────
  // A frozen header carries the same syntactic highlight pass as the live
  // editor (same lexer, same classes — see shell-highlight.ts). A running
  // header stays plain: the command is still being executed, and the static
  // pass is for reading a finished command back. The frozen branch is
  // innerHTML by design, but the pass escapes every byte of the text, so
  // command content can never inject markup.
  const cmdSpan = document.createElement('span')
  cmdSpan.className = 'cmd-header-text'
  if (status === 'running') {
    cmdSpan.textContent = command || '(empty)'
  } else {
    cmdSpan.innerHTML = command ? highlightShellText(command) : '(empty)'
    if (!tokenizerLoaded) pendingHeaderSpans.add(cmdSpan)
  }
  header.appendChild(cmdSpan)

  return header
}

/**
 * Returns true when the serialized output HTML is effectively empty.
 */
function isOutputEmpty(html: string): boolean {
  const stripped = html.replace(/<[^>]*>/g, '').replace(/\s/g, '')
  return stripped.length === 0
}

/**
 * A block's output as text, with the line breaks put back.
 *
 * The serializer emits one `<span class="term-line">` per logical line and
 * nothing between them — the line breaks you see are `display: block` in CSS,
 * not characters in the DOM. So `outputEl.textContent` returned the whole block
 * as a single run, and "Copy output" pasted a hundred rows of `top` onto one
 * line (nocx-6w4z).
 *
 * Falls back to `textContent` when there are no line spans, which is what a
 * block with plain text content would give.
 */
export function blockOutputText(outputEl: HTMLElement | null): string {
  if (!outputEl) return ''
  const lines = outputEl.querySelectorAll('.term-line')
  if (lines.length === 0) return outputEl.textContent ?? ''
  return Array.from(lines)
    .map((line) => line.textContent ?? '')
    .join('\n')
}

/**
 * Build the "⋮" overflow menu button + dropdown (P2-9, P1-6 fix).
 * The menu is rendered as a child of document.body with position:fixed
 * so it floats above ALL blocks and scroll containers. Position is
 * calculated from the button's bounding rect. Closes on outside click
 * and Escape key.
 */
function buildOverflowMenu(command: string, outputEl: HTMLElement | null): HTMLElement {
  const btn = document.createElement('button')
  btn.className = 'cmd-overflow-btn'
  btn.textContent = '\u22EE' // ⋮ vertical ellipsis
  btn.setAttribute('aria-label', 'Block actions')

  let menu: HTMLElement | null = null
  let closeOnEscape: ((e: KeyboardEvent) => void) | null = null
  let closeOnClick: ((ev: MouseEvent) => void) | null = null

  const closeMenu = () => {
    if (menu) {
      menu.remove()
      menu = null
    }
    if (closeOnEscape) {
      document.removeEventListener('keydown', closeOnEscape)
      closeOnEscape = null
    }
    if (closeOnClick) {
      document.removeEventListener('click', closeOnClick)
      closeOnClick = null
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()

    // If menu is already open, close it.
    if (menu) {
      closeMenu()
      return
    }

    // Build the dropdown.
    menu = document.createElement('div')
    menu.className = 'cmd-overflow-menu'

    const copyCmd = document.createElement('button')
    copyCmd.className = 'cmd-overflow-menu-item'
    copyCmd.textContent = 'Copy command'
    copyCmd.addEventListener('click', (ev) => {
      ev.stopPropagation()
      clipboardFallback(command)
      closeMenu()
    })

    const copyOut = document.createElement('button')
    copyOut.className = 'cmd-overflow-menu-item'
    copyOut.textContent = 'Copy output'
    copyOut.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const text = blockOutputText(outputEl)
      clipboardFallback(text)
      closeMenu()
    })

    const copyAll = document.createElement('button')
    copyAll.className = 'cmd-overflow-menu-item'
    copyAll.textContent = 'Copy all'
    copyAll.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const outText = blockOutputText(outputEl)
      clipboardFallback(`${command}\n${outText}`)
      closeMenu()
    })

    menu.append(copyCmd, copyOut, copyAll)

    // Render at body level so it floats above all scroll containers (P1-6).
    document.body.appendChild(menu)

    // Position relative to the button using fixed coordinates.
    const btnRect = btn.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.top = `${btnRect.bottom + 2}px`
    menu.style.right = `${window.innerWidth - btnRect.right}px`

    // Close on outside click (after this event finishes).
    closeOnClick = (ev: MouseEvent) => {
      if (!menu?.contains(ev.target as Node) && ev.target !== btn) {
        closeMenu()
      }
    }
    setTimeout(() => document.addEventListener('click', closeOnClick!), 0)

    // Close on Escape.
    closeOnEscape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        closeMenu()
      }
    }
    document.addEventListener('keydown', closeOnEscape)
  })

  return btn
}

// ── Selection helpers ──────────────────────────────────────────────────────

const SELECTED_CLASS = 'cmd-block-selected'

/**
 * Get the currently selected block's DOM element, if any.
 */
export function getSelectedBlock(container: HTMLElement): HTMLElement | null {
  return container.querySelector(`.${SELECTED_CLASS}`)
}

/**
 * Deselect all blocks inside the container. Returns true if a block was deselected.
 */
export function deselectAllBlocks(container: HTMLElement): boolean {
  const sel = getSelectedBlock(container)
  if (sel) {
    sel.classList.remove(SELECTED_CLASS)
    return true
  }
  return false
}

/**
 * Wire full-block click-to-select (P1-7).
 * Click (mousedown+up without significant movement) selects the block.
 * Drag (mousedown+move) starts text selection and does NOT select the block.
 * @param onSelect callback(id, selected) — notifies the manager of selection changes.
 */
function wireBlockSelection(
  blockEl: HTMLElement,
  container: HTMLElement,
  overflowBtn: HTMLElement,
  blockId: number,
  onSelect: (id: number, selected: boolean) => void,
): void {
  let mouseMoved = false

  blockEl.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.cmd-overflow-btn, .cmd-overflow-menu')) return
    mouseMoved = false
  })

  blockEl.addEventListener('mousemove', () => {
    mouseMoved = true
  })

  blockEl.addEventListener('mouseup', (e) => {
    if ((e.target as HTMLElement).closest('.cmd-overflow-btn, .cmd-overflow-menu')) return
    if (mouseMoved) return

    // Toggle selection: if already selected, deselect; otherwise select
    const currentlySelected = blockEl.classList.contains(SELECTED_CLASS)
    if (currentlySelected) {
      blockEl.classList.remove(SELECTED_CLASS)
      onSelect(blockId, false)
    } else {
      // Deselect others first (single-select P1-8)
      const prev = getSelectedBlock(container)
      if (prev) prev.classList.remove(SELECTED_CLASS)
      blockEl.classList.add(SELECTED_CLASS)
      onSelect(blockId, true)
    }
    mouseMoved = false
  })
}

// ── Block builders ─────────────────────────────────────────────────────────

/**
 * Create a frozen command block DOM element with header + serialized output.
 */
export function createCommandBlock(
  id: number,
  command: string,
  cwd: string,
  location: string,
  outputHtml: string,
  durationMs: number | null,
  exitCode: number | null,
  status: 'success' | 'failure',
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cmd-block'
  wrapper.setAttribute('data-block-id', String(id))

  const header = createHeader(command, cwd, location, durationMs, exitCode, status)

  let outputEl: HTMLElement | null = null
  if (outputHtml && !isOutputEmpty(outputHtml)) {
    outputEl = document.createElement('div')
    outputEl.className = 'cmd-output'
    outputEl.innerHTML = outputHtml
  }

  // Overflow menu (P2-9) — always the LAST element of the header-right
  // group (owner directive: ⋮ never shifts position).
  const overflow = buildOverflowMenu(command, outputEl)
  const right = header.querySelector('.cmd-header-right')
  if (right) right.appendChild(overflow)

  wrapper.appendChild(header)
  if (outputEl) wrapper.appendChild(outputEl)

  // Full-block click-to-select with drag distinction (P1-7, P1-8).
  wireBlockSelection(wrapper, getContainer(), overflow, id, onSelect)

  return wrapper
}

/**
 * Create a "running" block element — shows a spinner, no output area.
 */
export function createRunningBlock(
  id: number,
  command: string,
  cwd: string,
  location: string,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cmd-block cmd-block-running'
  wrapper.setAttribute('data-block-id', String(id))

  const header = createHeader(command, cwd, location, null, null, 'running')

  // Overflow menu — minimal: copy command only while running.
  // Always the LAST element of header-right (owner directive).
  const overflow = buildOverflowMenu(command, null)
  const right = header.querySelector('.cmd-header-right')
  if (right) right.appendChild(overflow)

  wrapper.appendChild(header)
  wireBlockSelection(wrapper, getContainer(), overflow, id, onSelect)

  return wrapper
}

/**
 * Freeze a running block: replace it with a frozen version.
 */
export function freezeBlock(
  el: HTMLElement,
  id: number,
  command: string,
  cwd: string,
  location: string,
  outputHtml: string,
  durationMs: number,
  exitCode: number | null,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
): HTMLElement {
  const newEl = createCommandBlock(
    id,
    command,
    cwd,
    location,
    outputHtml,
    durationMs,
    exitCode,
    exitCode === 0 ? 'success' : 'failure',
    getContainer,
    onSelect,
  )

  if (el.parentNode) {
    el.parentNode.replaceChild(newEl, el)
  }

  return newEl
}

// ── Block manager ──────────────────────────────────────────────────────────

export interface BlockManagerOpts {
  now?: () => number
}

export class BlockManager {
  private _blocks: BlockRecord[] = []
  private _nextId = 1
  private _now: () => number
  private _scrollbackInner: HTMLElement
  private _xtermContainer: HTMLElement
  private _runningBlock: BlockRecord | null = null
  private _cmdStartTime: number | null = null
  /** Currently selected block id, or null if none selected (P1-8). */
  private _selectedBlockId: number | null = null

  constructor(
    scrollbackInner: HTMLElement,
    xtermContainer: HTMLElement,
    opts: BlockManagerOpts = {},
  ) {
    this._scrollbackInner = scrollbackInner
    this._xtermContainer = xtermContainer
    this._now = opts.now ?? (() => performance.now())
  }

  get blocks(): readonly BlockRecord[] {
    return this._blocks
  }

  get runningBlock(): BlockRecord | null {
    return this._runningBlock
  }

  get cmdStartTime(): number | null {
    return this._cmdStartTime
  }

  /** The currently selected block id, or null (P1-8). */
  get selectedBlockId(): number | null {
    return this._selectedBlockId
  }

  /** Lazy container supplier bound to this manager's scrollback inner. */
  private _getContainer = (): HTMLElement => this._scrollbackInner

  /**
   * Deselect the currently selected block without clearing the block list.
   * Safe to call from keyboard handlers (P0-4: Escape deselects).
   */
  deselectAll(): void {
    if (this._selectedBlockId !== null) {
      const el = this._scrollbackInner.querySelector('.cmd-block-selected')
      if (el) el.classList.remove('cmd-block-selected')
      this._selectedBlockId = null
    }
  }

  /**
   * Called by wireBlockSelection when a block's selection state changes.
   * Keeps _selectedBlockId in sync with single-select semantics (P1-8).
   */
  _onBlockSelected(blockId: number): void {
    if (this._selectedBlockId === blockId) {
      // Clicking the already-selected block deselects it
      this._selectedBlockId = null
      return
    }
    // Deselect previous
    if (this._selectedBlockId !== null) {
      for (const b of this._blocks) {
        if (b.id === this._selectedBlockId) {
          b.el.classList.remove('cmd-block-selected')
        }
      }
    }
    this._selectedBlockId = blockId
  }

  /**
   * Called by wireBlockSelection when a block is deselected.
   */
  _onBlockDeselected(blockId: number): void {
    if (this._selectedBlockId === blockId) {
      this._selectedBlockId = null
    }
  }

  /**
   * Start a new running block. Called on OSC 133 C.
   */
  /** Where this session is — `user@host`, or empty for a local shell. */
  private _location = ''

  setLocation(location: string): void {
    this._location = location
  }

  startBlock(command: string, cwd: string, startLine: number): BlockRecord {
    if (this._runningBlock) {
      this._finalizeRunningUnsafe()
    }

    const id = this._nextId++
    this._cmdStartTime = this._now()

    const el = createRunningBlock(
      id,
      command,
      cwd,
      this._location,
      this._getContainer,
      (bid, sel) => {
        if (sel) this._onBlockSelected(bid)
        else this._onBlockDeselected(bid)
      },
    )
    this._scrollbackInner.insertBefore(el, this._xtermContainer)

    const rec: BlockRecord = {
      id,
      command,
      cwd,
      durationMs: null,
      exitCode: null,
      status: 'running',
      startLine,
      endLine: startLine,
      el,
    }
    this._blocks.push(rec)
    this._runningBlock = rec
    this._startTicker(el)

    return rec
  }

  /**
   * Tick the running block's duration chip once a second.
   *
   * One timer for the one running block, cleared the moment it stops running —
   * there is never more than one, so this cannot accumulate the way a per-block
   * timer would.
   */
  private _ticker: ReturnType<typeof setInterval> | null = null

  private _startTicker(el: HTMLElement): void {
    this._stopTicker()
    const chip = el.querySelector('.cmd-header-duration')
    const started = this._cmdStartTime
    if (!chip || started === null) return
    this._ticker = setInterval(() => {
      chip.textContent = formatRunningDuration(this._now() - started)
    }, 1000)
  }

  private _stopTicker(): void {
    if (this._ticker === null) return
    clearInterval(this._ticker)
    this._ticker = null
  }

  /**
   * Freeze the running block on OSC 133 D.
   */
  freezeBlock(getLine: GetLineFn, endLine: number, exitCode: number | null): BlockRecord | null {
    const rec = this._runningBlock
    if (!rec) return null

    rec.endLine = endLine
    const durationMs = this._cmdStartTime !== null ? this._now() - this._cmdStartTime : null
    this._cmdStartTime = null

    const snapshot = fromITheme(getCurrentTheme())
    const outputHtml = serializeRange(snapshot, getLine, rec.startLine, endLine)

    const newEl = freezeBlock(
      rec.el,
      rec.id,
      rec.command,
      rec.cwd,
      this._location,
      outputHtml,
      durationMs ?? 0,
      exitCode,
      this._getContainer,
      (bid, sel) => {
        if (sel) this._onBlockSelected(bid)
        else this._onBlockDeselected(bid)
      },
    )

    this._stopTicker()
    rec.el = newEl
    rec.durationMs = durationMs
    rec.exitCode = exitCode
    rec.status = exitCode === 0 ? 'success' : 'failure'
    this._runningBlock = null

    return rec
  }

  clearAll(): void {
    this._stopTicker()
    for (const b of this._blocks) {
      b.el.remove()
    }
    this._blocks = []
    this._runningBlock = null
    this._cmdStartTime = null
    this._selectedBlockId = null
  }

  private _finalizeRunningUnsafe(): void {
    this._stopTicker()
    if (!this._runningBlock) return
    this._runningBlock.status = 'failure'
    this._runningBlock.exitCode = null
    this._runningBlock = null
    this._cmdStartTime = null
  }

  dispose(): void {
    this.clearAll()
  }
}
