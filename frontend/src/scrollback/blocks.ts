// DOM scrollback block manager.
// Creates, freezes, and manages DOM command blocks in the scrollback area.
// Flat warp-style design (P0-1): no card borders, dividers between blocks,
// subtle background tint on hover/select.

import { serializeRange, fromITheme } from './serializer'
import { getCurrentTheme } from '../renderers/theme-adapter'
import { highlightShellText, onShellHighlightReady } from '../shell-highlight'
import type { CommandSnapshotStore } from '../command-snapshot'
import type { IBufferLine } from '@xterm/xterm'
import { wordRangeIn } from '../word-selection'
import { createSecretChipUnresolved } from '../ui/secret-chip'
import { findReferences } from '../secret-reference'
import { commandFragment } from '../command-text'
import { KIND_LABELS, type SecretKind } from '../secret-kind'
import type { ExecutionAttempt } from '../lifecycle/state'
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

// ── Render fence rendezvous (ADR-0024 §7 carve-out, bead nocx-u7uh.8) ──
// The lifecycle channel and the pty are independent streams, so an
// authenticated completion can reach nocx before the command's last output
// bytes do. The shell writes a 32-random-byte nonce (64 hex chars) to the
// pty AFTER the output and carries the same nonce in the `complete` event;
// the block's VISUAL freeze waits for both, while the LOGICAL completion
// (exit status, history) lands on the event alone.

/** How long a completed attempt's VISUAL boundary waits for its fence bytes
 *  before the visual freeze settles at the current output end. The LOGICAL
 *  freeze (status, exit code) lands on the event alone; the fence is printed
 *  by the shell immediately after the output on the same pty channel, so it
 *  lands within the same write burst — this window is generous for a slow
 *  link and only bounds how long a finished command keeps its running look
 *  when the fence never arrives. Named: the deferral is a policy, not a
 *  magic number, and the no-fence path is a degrade, never a truncation. */
export const FENCE_DEFER_MS = 500

/** Upper bound on remembered fence sightings (hex → line). Sightings are
 *  kept only so a completion that lands after its fence can match it; a
 *  crypto-random nonce makes collisions impossible, so a small ring is
 *  more than enough and bounds the memory of a hostile stream. */
const MAX_FENCE_SIGHTINGS = 8

/** Deferral-timer handle — named so the pending-fence contract never
 *  couples to setTimeout's implementation type. */
type FenceTimer = ReturnType<typeof setTimeout>

/** A block status that has left `running` — the terminal set the DOM
 *  freeze and the block record share. The LOGICAL freeze produces it and
 *  hands it to the VISUAL freeze, so serialization is typed to follow a
 *  terminalized record. */
export type FrozenStatus = 'success' | 'failure' | 'entered' | 'unknown'
// ── Block model ────────────────────────────────────────────────────────────

export interface BlockRecord {
  id: number
  command: string
  cwd: string
  /** Duration in ms: C marker to D marker. */
  durationMs: number | null
  exitCode: number | null
  /** Presentation state. 'entered' = frozen on environment entry (N6):
   *  neither success nor failure, no exit code — the block the ssh command
   *  froze into when the remote session began. 'unknown' = the bound
   *  attempt was abandoned (ADR-0024 §5): frozen, never successful, no
   *  reported exit code. */
  status: 'running' | 'success' | 'failure' | 'entered' | 'unknown'
  /** The authenticated attempt this block is bound to (ADR-0024 §7
   *  projection): set when the running block binds to the published
   *  attempt, kept when the block freezes. Absent only for a block that
   *  never bound (cleared scrollback, never seen running). */
  attemptId?: string
  /** IMarker line for C boundary. */
  startLine: number
  /** IMarker line for D boundary (approx). */
  endLine: number
  /** Whether OSC 133 C was received for this command. False when the
   *  block was started from the app-owned submit (nocx-atyf.4). */
  cReceived: boolean
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
/** Spans frozen before the grammar loaded, keyed by the tab's snapshot store
 *  so the repaint judges against the right tab's command set. */
const pendingHeaderSpans = new Map<HTMLElement, CommandSnapshotStore>()

function refreshPendingHeaderSpans(): void {
  for (const [el, store] of pendingHeaderSpans) {
    const text = el.textContent ?? ''
    if (text && text !== '(empty)') el.innerHTML = highlightShellText(text, store)
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
  status: 'running' | 'success' | 'failure' | 'entered' | 'unknown',
  store: CommandSnapshotStore,
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

    // An 'entered' block froze on environment entry (N6): it carries no
    // exit code and must never paint success or failure, whatever code the
    // local D later delivers to the ledger.
    if (status !== 'entered' && exitCode !== null) {
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
  const refs = command ? findReferences(command) : []
  if (refs.length > 0) {
    // A vault reference reads as a chip here, exactly as it does in the
    // editor — it is the same fact about the same text, and showing
    // `{{secret:openrouter.ai}}` raw in the block made the block look like
    // a different thing from the line the user typed.
    //
    // Chips and shell highlighting do not compose: the highlighter emits
    // one HTML string for the whole command, and cutting chips into it
    // would mean tokenising the fragments between them, where a quote
    // opened before a reference closes after it. A command carrying a
    // reference therefore renders plain, the way a masked one already does
    // (renderRecordedCommand) — the chip is the emphasis.
    cmdSpan.replaceChildren(commandFragment(command))
  } else if (status === 'running') {
    cmdSpan.textContent = command || '(empty)'
  } else {
    cmdSpan.innerHTML = command ? highlightShellText(command, store) : '(empty)'
    if (!tokenizerLoaded) pendingHeaderSpans.set(cmdSpan, store)
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
      // Once history.record acks, the block shows — and therefore copies —
      // the MASKED command: what you see is what went to the store, and the
      // renderer no longer holds the plaintext for that block (ADR-0021,
      // the receipt round's named trade). The full masked text lives in
      // data-recorded-command; the chips in the header are labels.
      const recorded = btn.closest('.cmd-block')?.getAttribute('data-recorded-command')
      clipboardFallback(recorded ?? command)
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
      const recorded = btn.closest('.cmd-block')?.getAttribute('data-recorded-command')
      clipboardFallback(`${recorded ?? command}\n${outText}`)
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
 * `status` 'entered' (N6) is the block the ssh command froze into when the
 * remote session began: painted as neither success nor failure, no exit code.
 */
export function createCommandBlock(
  id: number,
  command: string,
  cwd: string,
  location: string,
  outputHtml: string,
  durationMs: number | null,
  exitCode: number | null,
  status: 'success' | 'failure' | 'entered' | 'unknown',
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
  store: CommandSnapshotStore,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cmd-block'
  // The entered block's own visual state (N6): frozen on environment entry,
  // neither success nor failure. The hook a stylesheet styles; the header
  // itself already refuses to paint an exit code or a failure for it.
  if (status === 'entered') wrapper.classList.add('cmd-block-entered')
  // A command carrying a vault reference renders its references as chips,
  // so the header's own text no longer spells the command. Copy reads the
  // full text from here — the reference intact, which is what the user
  // typed, what the store keeps, and what pastes usefully onto another
  // machine. renderRecordedCommand overwrites it with the masked text when
  // the ack lands, which is the same rule one step later.
  if (command && findReferences(command).length > 0) wrapper.dataset.recordedCommand = command
  wrapper.setAttribute('data-block-id', String(id))

  const header = createHeader(command, cwd, location, durationMs, exitCode, status, store)

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

  // Double-click selects a whole token the way xterm does it (nocx-w7h.11,
  // spec v9 §2): xterm's SelectionService.handleMouseDown calls
  // preventDefault() FIRST — "Tell the browser not to start a regular
  // selection" — and only then branches on event.detail, computing the word
  // bounds from its own model and applying the selection once. The frozen
  // block mirrors that ordering. The browser's native word selection would
  // otherwise be created on the SECOND MOUSEDOWN (event.detail === 2),
  // before the dblclick event fires — observed by copy-on-select on mouseup
  // and copied, one word, before any later expansion could run. Intercepting
  // the mousedown means exactly one selection state exists, already correct,
  // and there is no race to order. A single mousedown (detail 1) is not
  // intercepted: drag selection and click-to-select keep working.
  wrapper.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.cmd-overflow-btn, .cmd-overflow-menu')) return
    if (e.detail !== 2) return
    e.preventDefault()
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return
    const line = caret.startContainer.parentElement?.closest<HTMLElement>(
      '.term-line, .cmd-header-text',
    )
    if (!line) return
    const range = wordRangeIn(line, caret.startContainer as Text, caret.startOffset)
    if (!range) return
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
  })

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
  store: CommandSnapshotStore,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cmd-block cmd-block-running'
  if (command && findReferences(command).length > 0) wrapper.dataset.recordedCommand = command
  wrapper.setAttribute('data-block-id', String(id))

  const header = createHeader(command, cwd, location, null, null, 'running', store)

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
 *
 * `status` is the presentation, never derived from the exit code: 'entered'
 * (N6) freezes on environment entry — neither success nor failure, no exit
 * code — and the old exitCode === null → 'failure' mapping is exactly the
 * bug this must not inherit. The D path passes 'success'/'failure' from the
 * real code; entry passes 'entered' with a null code.
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
  store: CommandSnapshotStore,
  status: 'success' | 'failure' | 'entered' | 'unknown',
): HTMLElement {
  const newEl = createCommandBlock(
    id,
    command,
    cwd,
    location,
    outputHtml,
    durationMs,
    exitCode,
    status,
    getContainer,
    onSelect,
    store,
  )
  if (el.parentNode) {
    el.parentNode.replaceChild(newEl, el)
  }

  return newEl
}

/**
 * Re-render a frozen block's command line once history.record acks: the
 * MASKED command with an unresolved chip at every redaction span — what
 * you see in the block is what went to the store, and the receipt has
 * something to point at when a row is hovered. The chips carry their
 * redaction span (data-redaction-start/end) so the receipt's hover can
 * emphasise exactly one.
 *
 * Copying the block copies the MASKED text: the full masked command lives
 * in data-recorded-command (the chips in the header are labels, never the
 * stored text), and the overflow menu prefers it over the pre-ack line.
 * This is the round's named trade — after the ack the renderer no longer
 * holds the plaintext for this block, and neither does the clipboard.
 */
export function renderRecordedCommand(
  blockEl: HTMLElement,
  maskedCommand: string,
  redactions: ReadonlyArray<{ kind: SecretKind; start: number; end: number }>,
): void {
  blockEl.dataset.recordedCommand = maskedCommand
  const headerText = blockEl.querySelector<HTMLElement>('.cmd-header-text')
  if (!headerText) return
  // The segments are plain text (no shell highlighting): a mask breaks the
  // token the highlighter would colour anyway, and the chips are the
  // emphasis now. Offsets are UTF-16 units into maskedCommand, clamped so
  const frag = document.createDocumentFragment()
  let pos = 0
  redactions.forEach((r, i) => {
    const from = Math.max(pos, Math.min(r.start, maskedCommand.length))
    const to = Math.max(from, Math.min(r.end, maskedCommand.length))
    if (from > pos) frag.appendChild(document.createTextNode(maskedCommand.slice(pos, from)))
    if (to > from) {
      const chip = createSecretChipUnresolved(KIND_LABELS[r.kind])
      chip.dataset.redactionIndex = String(i)
      chip.dataset.redactionStart = String(r.start)
      chip.dataset.redactionEnd = String(r.end)
      frag.appendChild(chip)
    }
    pos = to
  })
  if (pos < maskedCommand.length) {
    frag.appendChild(document.createTextNode(maskedCommand.slice(pos)))
  }
  headerText.replaceChildren(frag)
}

// ── Block manager ──────────────────────────────────────────────────────────

export interface BlockManagerOpts {
  now?: () => number
  /** The tab's command-existence snapshot store (OSC 636), passed through to
   *  every frozen header this manager creates. */
  snapshotStore: CommandSnapshotStore
  /** Fired when a DEFERRED freeze lands — the fence arrived, or the
   *  FENCE_DEFER_MS window elapsed and the block settled at the current
   *  output end. The freeze originated inside the manager (sightFence /
   *  the deferral timer), so the caller learns to settle the live region. */
  onDeferredFreeze?: () => void
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
  private _snapshotStore: CommandSnapshotStore
  private _onDeferredFreeze?: () => void
  /** The attempt id the running block is bound to (ADR-0024 §7 projection).
   *  Set when the published running fact binds the block; cleared when the
   *  block freezes or the scrollback is cleared. */
  private _attemptId: string | null = null
  /** Recent fence sightings keyed by hex (the buffer line they landed on),
   *  bounded by MAX_FENCE_SIGHTINGS. A sighting already present is a replay
   *  and is ignored; an entry is consumed when a completion's fence matches.
   *  This is the render-only half of the rendezvous — a fence with no
   *  authenticated event behind it changes nothing (ADR-0024 §1). */
  private _fences = new Map<string, number>()
  /** A completion whose LOGICAL freeze has landed but whose output boundary
   *  (the VISUAL freeze) is still waiting on the render fence: the rows are
   *  serialized when the fence bytes are sighted (hex set), or when the
   *  FENCE_DEFER_MS window settles at the current output end. A completion
   *  that carried no fence at all (hex null — unreachable from the kernel,
   *  which requires the nonce on completed attempts) still defers by the
   *  window rather than truncating at the event-time end: the boundary is
   *  never cut on the event alone. Only the settle path fires
   *  onDeferredFreeze, and only while no newer command owns the running
   *  slot. */
  private _pendingFence: {
    hex: string | null
    /** The block whose boundary is pending — already logically frozen,
     *  still in `_blocks`, never the running block. */
    rec: BlockRecord
    /** The output end at completion time — the fallback boundary when a
     *  newer command owns the cursor and `getEndLine` would serialize
     *  the newer command's output into this block. */
    endLine: number
    /** The terminal status the logical freeze already applied — the
     *  visual freeze hands it to the DOM exactly as the event decided. */
    status: FrozenStatus
    getLine: GetLineFn
    getEndLine: () => number
    timer: FenceTimer
  } | null = null
  /** The fence hex consumed by the last freeze — a replay of it (one seen
   *  for an already-frozen block) does nothing. */
  private _consumedFence: string | null = null

  constructor(scrollbackInner: HTMLElement, xtermContainer: HTMLElement, opts: BlockManagerOpts) {
    this._scrollbackInner = scrollbackInner
    this._xtermContainer = xtermContainer
    this._now = opts.now ?? (() => performance.now())
    this._snapshotStore = opts.snapshotStore
    this._onDeferredFreeze = opts.onDeferredFreeze
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
   * Bind the running block to an authenticated attempt (ADR-0024 §7
   *  projection): the block opened at app submit binds when the published
   *  running fact arrives, and the freeze/abandon paths require the match.
   */
  bindAttempt(attemptId: string): void {
    this._attemptId = attemptId
    if (this._runningBlock) this._runningBlock.attemptId = attemptId
  }

  /** The block bound to an attempt id — running or frozen. */
  blockForAttempt(attemptId: string): BlockRecord | null {
    return this._blocks.find((b) => b.attemptId === attemptId) ?? null
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
      this._snapshotStore,
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
      cReceived: false,
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
  freezeBlock(getLine: GetLineFn, endLine: number, exitCode: number | null): BlockRecord | null {
    const rec = this._runningBlock
    if (!rec) return null
    const status = this._logicalFreeze(rec, exitCode, exitCode === 0 ? 'success' : 'failure')
    this._freezeVisual(rec, getLine, endLine, status)
    return rec
  }

  /**
   * Freeze the running block on environment entry (N6): the ssh block freezes
   * with NO exit code, painted as neither success nor failure, and the
   * manager's running slot is freed for the remote commands that follow. The
   * model-level completion (history.record) happens later, at the local D,
   * via the ledger's completeTransition — this only paints the block.
   */
  freezeEntered(getLine: GetLineFn, endLine: number): BlockRecord | null {
    const rec = this._runningBlock
    if (!rec) return null
    const status = this._logicalFreeze(rec, null, 'entered')
    this._freezeVisual(rec, getLine, endLine, status)
    return rec
  }

  /** The LOGICAL freeze (u7uh.8): flip the block's record to its terminal
   *  state — status, exit code and duration land on the authenticated event
   *  alone; the running slot is freed and the ticker stops. The DOM is
   *  untouched: which rows belong to the block is the VISUAL freeze's
   *  question, and it waits for the render fence or the deferral window. */
  private _logicalFreeze(
    rec: BlockRecord,
    exitCode: number | null,
    status: FrozenStatus,
  ): FrozenStatus {
    this._stopTicker()
    rec.durationMs = this._cmdStartTime !== null ? this._now() - this._cmdStartTime : null
    this._cmdStartTime = null
    rec.exitCode = exitCode
    rec.status = status
    this._runningBlock = null
    return status
  }

  /** The VISUAL freeze: serialize the block's output region up to a boundary
   *  line and replace its running element with the frozen one. The boundary
   *  is the render fence's line when it was sighted, or the current output
   *  end when the deferral window settles; until this runs the block's rows
   *  are not yet fixed. */
  private _freezeVisual(
    rec: BlockRecord,
    getLine: GetLineFn,
    endLine: number,
    status: FrozenStatus,
  ): void {
    rec.endLine = endLine
    const snapshot = fromITheme(getCurrentTheme())
    const outputHtml = serializeRange(snapshot, getLine, rec.startLine, endLine)

    const newEl = freezeBlock(
      rec.el,
      rec.id,
      rec.command,
      rec.cwd,
      this._location,
      outputHtml,
      rec.durationMs ?? 0,
      rec.exitCode,
      this._getContainer,
      (bid, sel) => {
        if (sel) this._onBlockSelected(bid)
        else this._onBlockDeselected(bid)
      },
      this._snapshotStore,
      status,
    )

    rec.el = newEl
  }

  /** Freeze the block bound to the attempt, from the attempt's authenticated
   *  completion (ADR-0024 §5, §7). Guards itself: only a COMPLETED attempt
   *  may freeze a block as success/failure, and only the block bound to that
   *  attempt — the kernel derivation freezeBlock() is the authority, and
   *  this keeps the DOM operation honest if a caller bypasses it.
   *
   *  Render fence (u7uh.8): the LOGICAL freeze — status, exit code,
   *  duration, freeing the running slot — lands on the authenticated event
   *  ALONE; the ledger and history have already landed (the projection
   *  order guarantees it). Only the VISUAL freeze — which rows belong to
   *  the block — waits for the fence bytes: when the fence was already
   *  sighted, this serializes at its line and returns the record; otherwise
   *  it defers (returns null) and `sightFence` resolves the boundary, or
   *  the FENCE_DEFER_MS window settles it at the current output end. The
   *  caller keeps the live region up while the boundary is pending, so the
   *  in-flight tail renders live instead of vanishing; `getEndLine`
   *  supplies the fresh output end for the no-fence settle. */
  freezeFromAttempt(
    attempt: ExecutionAttempt,
    getLine: GetLineFn,
    endLine: number,
    getEndLine: () => number,
  ): BlockRecord | null {
    if (attempt.state !== 'completed') return null
    if (this._attemptId !== attempt.id) return null
    const code = attempt.exitCode ?? null
    const status = code === 0 ? 'success' : 'failure'
    const fence = attempt.fence
    const sighted = fence !== undefined ? this._fences.get(fence) : undefined
    const rec = this._runningBlock
    if (!rec) return null

    if (this._pendingFence !== null) {
      // Another completion wants the slot while one is pending. The pty
      // order means the older fence should have landed already; if it has
      // not, settle the older block at its completion-time end (never at
      // the newer command's cursor) rather than stranding it, then defer
      // this completion the same way. The newer block is still running
      // here, so the settle does not touch the live region.
      this._settlePendingFence()
    }

    // LOGICAL freeze — the authenticated event alone flips the block's
    // status, exit code and duration and frees the running slot.
    const terminal = this._logicalFreeze(rec, code, status)
    this._attemptId = null

    if (fence !== undefined && sighted !== undefined) {
      // Rendezvous complete: the fence bytes landed before the completion.
      // Its line IS the output end — serialize now, boundary included.
      this._fences.delete(fence)
      this._consumedFence = fence
      this._freezeVisual(rec, getLine, sighted, terminal)
      return rec
    }

    // The fence bytes are still in flight — or the completion carried no
    // fence at all (hex null; unreachable from the kernel, which requires
    // the nonce on completed attempts). Either way the visual freeze
    // defers: a sighting resolves a non-null fence, and the FENCE_DEFER_MS
    // window settles both at the current output end. The boundary is never
    // cut on the event alone. Null tells the caller the live region stays
    // up until the boundary settles.
    this._pendingFence = {
      hex: fence ?? null,
      rec,
      endLine,
      status: terminal,
      getLine,
      getEndLine,
      timer: setTimeout(() => this._settlePendingFence(), FENCE_DEFER_MS),
    }
    return null
  }

  /** Report where a fence landed. A fence with no authenticated event behind
   *  it changes nothing at all (ADR-0024 §1): the sighting is remembered for
   *  a completion that arrives later, and consumed — never applied — when
   *  it matches. A replay (the same hex twice, or one for an already-frozen
   *  block) does nothing. */
  sightFence(hex: string, line: number): void {
    if (this._consumedFence === hex) return // already-frozen block's fence
    if (this._fences.has(hex)) return // same value seen twice — a replay

    const pending = this._pendingFence
    if (pending !== null && pending.hex === hex) {
      // The deferred boundary's fence landed: serialize the block at the
      // fence's line. The block's STATUS flipped on the completion event —
      // this settles only which rows belong to it. A fence for a block that
      // has since been cleared changes nothing.
      this._pendingFence = null
      clearTimeout(pending.timer)
      if (!this._blocks.includes(pending.rec)) return
      this._freezeVisual(pending.rec, pending.getLine, line, pending.status)
      this._consumedFence = hex
      // Settle the live region only if no newer command owns the running
      // slot — a new command's live region must stay up.
      if (this._runningBlock === null) this._onDeferredFreeze?.()
      return
    }

    this._fences.set(hex, line)
    if (this._fences.size > MAX_FENCE_SIGHTINGS) {
      const oldest = this._fences.keys().next().value
      if (oldest !== undefined) this._fences.delete(oldest)
    }
  }

  /** The FENCE_DEFER_MS window elapsed with no fence: settle the visual
   *  freeze. While no newer command owns the running slot, the boundary is
   *  the CURRENT output end — the tail that was in flight at the completion
   *  has had the window to arrive, so this defers the boundary rather than
   *  truncating it. If a newer command owns the cursor, the current end
   *  would serialize the newer command's output into this block, so the
   *  boundary falls back to the completion-time end. The cost of a fence
   *  that never arrived is that the boundary is approximate. */
  private _settlePendingFence(): void {
    const pending = this._pendingFence
    if (pending === null) return
    this._pendingFence = null
    if (!this._blocks.includes(pending.rec)) return // block moved on (cleared)
    const boundary = this._runningBlock === null ? pending.getEndLine() : pending.endLine
    this._freezeVisual(pending.rec, pending.getLine, boundary, pending.status)
    this._consumedFence = pending.hex
    if (this._runningBlock === null) this._onDeferredFreeze?.()
  }

  private _cancelPendingFence(): void {
    if (this._pendingFence === null) return
    clearTimeout(this._pendingFence.timer)
    this._pendingFence = null
  }

  /** Freeze the running block bound to the attempt as abandoned: the
   *  attempt went `unknown` (loss, closure, native escape) — frozen, never
   *  successful, no reported exit code (ADR-0024 §5). Abandonment carries
   *  no fence and waits for none. */
  abandonAttempt(
    attempt: ExecutionAttempt,
    getLine: GetLineFn,
    endLine: number,
  ): BlockRecord | null {
    if (attempt.state !== 'unknown') return null
    if (this._attemptId !== attempt.id) return null
    const rec = this._runningBlock
    if (!rec) return null
    // No pending-boundary cancel here: a pending fence belongs to an older,
    // already logically frozen block (a lost fence), never to the running
    // block being abandoned — its timer settles it independently.
    const status = this._logicalFreeze(rec, null, 'unknown')
    this._freezeVisual(rec, getLine, endLine, status)
    this._attemptId = null
    return rec
  }

  clearAll(): void {
    this._stopTicker()
    this._cancelPendingFence()
    for (const b of this._blocks) {
      b.el.remove()
    }
    this._blocks = []
    this._runningBlock = null
    this._cmdStartTime = null
    this._selectedBlockId = null
    this._attemptId = null
    this._fences.clear()
    this._consumedFence = null
  }

  private _finalizeRunningUnsafe(): void {
    // Note: a pending render-fence boundary belongs to an ALREADY logically
    // frozen block, never to the running block this finalizes — its timer
    // settles it independently, guarded by the running slot.
    this._stopTicker()
    if (!this._runningBlock) return
    this._runningBlock.status = 'failure'
    this._runningBlock.exitCode = null
    this._runningBlock = null
    this._cmdStartTime = null
    this._attemptId = null
  }

  dispose(): void {
    this.clearAll()
  }
}
