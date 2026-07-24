// DOM scrollback controller — wires the renderer's OSC 133 markers to block
// creation, manages the live region visibility, alt-screen transitions, and
// `clear` detection. Owns the scrollback DOM structure inside the pane.

import type { TerminalRenderer } from '../renderers/types'
import { BlockManager, type GetLineFn } from './blocks'

export type LiveRegionMode = 'idle' | 'running' | 'fullscreen'

export interface ScrollbackControllerOpts {
  /** The pane this controller owns the scrollback inside. */
  pane: HTMLElement
  /** The renderer for the terminal. */
  renderer: TerminalRenderer
  /** Injectable clock. */
  now?: () => number
}

export class ScrollbackController {
  readonly scrollbackLayout: HTMLElement
  readonly scrollbackArea: HTMLElement
  readonly scrollbackInner: HTMLElement
  /** Outer clipping container — height changes with mode. */
  readonly xtermLiveContainer: HTMLElement
  /** Inner wrapper with stable min-height — xterm mounts here so its grid
   *  stays sane regardless of the clipping container's CSS height. */
  readonly xtermInner: HTMLElement
  readonly separator: HTMLElement

  private _blockManager: BlockManager
  private _renderer: TerminalRenderer
  private _mode: LiveRegionMode = 'idle'
  /** True when the user is scrolled up — auto-scroll is paused. */
  private _userScrolled = false

  constructor(opts: ScrollbackControllerOpts) {
    this._renderer = opts.renderer
    const now = opts.now ?? (() => performance.now())

    // ── Build the scrollback DOM ─────────────────────────────────────────
    this.scrollbackLayout = document.createElement('div')
    this.scrollbackLayout.className = 'scrollback-layout'

    this.scrollbackArea = document.createElement('div')
    this.scrollbackArea.className = 'scrollback-area'

    this.scrollbackInner = document.createElement('div')
    this.scrollbackInner.className = 'scrollback-inner'

    // Blocks live in the inner wrapper.
    this.scrollbackArea.appendChild(this.scrollbackInner)

    // The xterm live container clips the xterm: idle=36px, running=140px,
    // fullscreen fills the viewport. Its child xterm-inner always keeps
    // a minimum height so the xterm grid never collapses to 1 row.
    this.xtermLiveContainer = document.createElement('div')
    this.xtermLiveContainer.className = 'xterm-live-container live-idle'

    this.xtermInner = document.createElement('div')
    this.xtermInner.className = 'xterm-inner'
    this.xtermLiveContainer.appendChild(this.xtermInner)

    // Separator between blocks and live region — inserted before the
    // xterm container so blocks stack above it. Hidden when no blocks.
    this.separator = document.createElement('div')
    this.separator.className = 'scrollback-separator'
    this.separator.style.display = 'none'
    this.scrollbackInner.appendChild(this.separator)
    this.scrollbackInner.appendChild(this.xtermLiveContainer)

    this.scrollbackLayout.appendChild(this.scrollbackArea)

    // Insert the layout as the first child of the pane (before the editor,
    // which is absolute-positioned).
    opts.pane.insertBefore(this.scrollbackLayout, opts.pane.firstChild)

    this._blockManager = new BlockManager(this.scrollbackInner, this.xtermLiveContainer, { now })

    // ── Auto-scroll behaviour ────────────────────────────────────────────
    this.scrollbackArea.addEventListener('scroll', () => {
      const area = this.scrollbackArea
      const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 40
      this._userScrolled = !atBottom
    })
  }

  /** The element the xterm renderer mounts into. Returns the stable
   *  xterm-inner wrapper, NOT the clipping live-container, so the grid
   *  never collapses to 1 row (P0-1 fix). */
  get mountTarget(): HTMLElement {
    return this.xtermInner
  }

  get blockManager(): BlockManager {
    return this._blockManager
  }

  /** The currently selected block id, or null (P1-8). */
  get selectedBlockId(): number | null {
    return this._blockManager.selectedBlockId
  }

  /** Deselect all blocks (P0-4: Escape key, P1-8: click empty space). */
  deselectBlocks(): void {
    this._blockManager.deselectAll()
  }

  get mode(): LiveRegionMode {
    return this._mode
  }

  // ── Live region visibility ────────────────────────────────────────────

  /** Collapse the live region when the prompt is idle. */
  setIdle(): void {
    if (this._mode === 'fullscreen') return
    this._mode = 'idle'
    this.xtermLiveContainer.className = 'xterm-live-container live-idle'
    this.xtermInner.className = 'xterm-inner'
    this._updateSeparator()
  }

  /** Expand the live region while a command runs. */
  setRunning(): void {
    if (this._mode === 'fullscreen') return
    this._mode = 'running'
    this.xtermLiveContainer.className = 'xterm-live-container live-running'
    this.xtermInner.className = 'xterm-inner'
    this._updateSeparator()
    this._scrollToBottom()
  }

  /** Alt-screen: xterm fills the viewport, scrollback hidden.
   *  We must NOT use display:none on scrollbackArea because the
   *  xterm-live-container is a descendant — display:none hides all
   *  descendants even position:fixed ones (P0-2 fix). Instead we
   *  hide only the blocks and separator via a CSS class. */
  enterFullscreen(): void {
    this._mode = 'fullscreen'
    this.xtermLiveContainer.className = 'xterm-live-container live-fullscreen'
    this.xtermInner.className = 'xterm-inner inner-fullscreen'
    this.scrollbackInner.classList.add('inner-fullscreen-mode')
  }

  /** Exit alt-screen: restore normal layout. */
  exitFullscreen(): void {
    this._mode = 'idle'
    this.xtermLiveContainer.className = 'xterm-live-container live-idle'
    this.xtermInner.className = 'xterm-inner'
    this.scrollbackInner.classList.remove('inner-fullscreen-mode')
    this._updateSeparator()
  }

  // ── Command cycle ─────────────────────────────────────────────────────

  /**
   * Called on OSC 133 C: create a running block, expand the live region.
   */
  onCommandStart(command: string, cwd: string, startLine: number): void {
    const cmd = command || '(empty)'
    this._blockManager.startBlock(cmd, cwd, startLine)
    this.setRunning()
  }

  /**
   * Called on OSC 133 D: serialize output, freeze the block.
   * @param getLine Accessor for xterm buffer lines.
   * @param endLine Absolute buffer line of the OSC 133 D marker.
   * @param exitCode Optional exit code from the D payload.
   */
  onCommandEnd(getLine: GetLineFn, endLine: number, exitCode: number | null): void {
    const rec = this._blockManager.freezeBlock(getLine, endLine, exitCode)
    if (rec) {
      this.setIdle()
    }
  }

  // ── clear handling ────────────────────────────────────────────────────

  /**
   * Check if a command was `clear` (or starts with `clear`). If so, clear
   * all DOM blocks. The xterm viewport is already cleared by the escape
   * sequence `clear` emits — we just clean up our blocks.
   */
  maybeClear(command: string): void {
    const trimmed = command.trim()
    const firstWord = trimmed.split(/\s+/)[0] ?? ''
    const isClear = firstWord === 'clear' || firstWord.endsWith('/clear')
    if (isClear) {
      this._blockManager.clearAll()
      this._updateSeparator()
    }
  }

  // ── Auto-scroll ───────────────────────────────────────────────────────

  /** Scroll to the bottom if the user hasn't scrolled up. */
  scrollToBottom(): void {
    if (this._userScrolled) return
    this._scrollToBottom()
  }

  private _scrollToBottom(): void {
    this.scrollbackArea.scrollTo({
      top: this.scrollbackArea.scrollHeight,
      behavior: 'instant',
    })
  }

  private _updateSeparator(): void {
    const hasBlocks = this._blockManager.blocks.length > 0
    this.separator.style.display = hasBlocks && this._mode !== 'fullscreen' ? '' : 'none'
  }

  dispose(): void {
    this._blockManager.dispose()
    this.scrollbackLayout.remove()
  }
}
