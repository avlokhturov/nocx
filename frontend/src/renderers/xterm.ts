import { Terminal, type ITheme } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { FONT_FAMILY, FONT_SIZE, LINE_HEIGHT } from './font'
import type {
  CommandMarker,
  CommandMarkerCallback,
  CommandMarkerEvent,
  CwdCallback,
  DataCallback,
  MarkerAdapter,
  ResizeCallback,
  TitleCallback,
  TerminalRenderer,
} from './types'
import { getCurrentTheme, subscribeThemeChanges } from './theme-adapter'
import { WORD_SEPARATORS } from '../word-selection'
import { decodeOsc52 } from '../clipboard'
import { CommandSnapshotStore } from '../command-snapshot'
import { EnvironmentPassportTracker, type PassportDisposition } from '../environment-passport'
type BellCallback = () => void
type SelectionCallback = (text: string) => void
type ClipboardWriteCallback = (text: string) => void

// xterm.js (VS Code's engine, stable 5.x) with the WebGL (GPU) renderer,
// hardened the way Tabby runs it: recover from a lost GPU context and clear the
// glyph atlas on every reflow. WebGL → Canvas → built-in DOM as fallbacks.

const MAX_WEBGL_RECOVERY_ATTEMPTS = 3

// On WebKitGTK (Linux/Wails) the compositor may not present a frame until the
// window receives a user interaction, so xterm.js's rAF-scheduled repaint of
// the just-written data never runs — the initial shell prompt stays invisible
// until a click, and each typed character renders one frame behind (the last
// one never painted). A periodic timer that re-marks every row dirty forces a
// render attempt on each tick, keeping the buffer visible without any click.
// ~24 fps is smooth enough for terminal output and cheap (a no-op refresh when
// nothing changed costs little). Only active on Linux/WebKitGTK — on macOS
// (WKWebView) and in browsers the compositor is healthy and the pump is a
// waste of CPU.
const FORCED_REFRESH_MS = 42

function isLinuxWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  // Wails on Linux embeds a WebKitGTK webview. The platform is Linux and the
  // user agent carries "WebKit". macOS uses WKWebView (platform is not Linux).
  return /linux/i.test(navigator.platform) && /webkit/i.test(navigator.userAgent)
}

// ── OSC 7 parser (AD-6: frontend parses OSC, backend never sniffs) ──────

// OSC 7 format: ESC ] 7 ; file://host/path ST
// xterm.js parser.registerOscHandler(7, handler) gives us the string
// after the ';', i.e. 'file://host/path'. Percent-decode per RFC 3986.
const OSC7_PREFIX = 'file://'

/**
 * Parses an OSC 7 payload into {host, path}. Returns null when the payload
 * does not start with 'file://' or percent-decoding fails.
 */
export function parseOsc7(payload: string): { host: string; path: string } | null {
  if (!payload.startsWith(OSC7_PREFIX)) return null
  const uri = payload.slice(OSC7_PREFIX.length)

  // Split at the first '/' after the authority section.
  // file://host/path  → host, /path
  // file:///path      → '',  /path
  const slashIdx = uri.indexOf('/')
  if (slashIdx === -1) return null

  const rawHost = uri.slice(0, slashIdx)
  const rawPath = uri.slice(slashIdx)

  try {
    const host = decodeURIComponent(rawHost)
    const path = decodeURIComponent(rawPath)
    return { host, path }
  } catch {
    // decodeURIComponent throws on malformed percent-encoding (e.g. '%ZZ').
    return null
  }
}

/**
 * Parses an OSC 133 payload into a CommandMarker. Returns null for invalid
 * or unrecognized payloads.
 *
 * Format: 'A' | 'B' | 'C' | 'D' | 'D;<exitcode>', optionally followed by
 * `;key=value` parameters — the parameter form OSC 133 already permits. A
 * `nocx_env=<id>` parameter tags the marker (spec §5.2); an untagged marker
 * keeps driving block boundaries exactly as before. A tag that is present
 * but malformed makes the whole marker invalid (never guessed at), while an
 * absent tag and unknown well-formed keys are tolerated.
 */
const OSC133_TAG_KEY = 'nocx_env'
const OSC133_TAG_VALUE_RE = /^[A-Za-z0-9._-]{1,64}$/

export function parseOsc133(payload: string): CommandMarker | null {
  if (payload.length === 0) return null
  const kind = payload[0] as CommandMarker['kind']
  if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return null

  const marker: CommandMarker = { kind }
  if (payload.length === 1) return marker
  if (payload[1] !== ';') return marker // bare kind with trailing junk: unchanged

  // Everything after the kind is `;`-separated parameters. D's first
  // parameter is the positional exit code UNLESS it is itself a key=value
  // property (`D;nocx_env=id` has no exit code).
  const params = payload.slice(2).split(';')
  let i = 0
  if (kind === 'D' && params.length > 0 && params[0] !== '' && params[0].indexOf('=') === -1) {
    const codeStr = params[0]
    i = 1
    // Strict: reject negatives or out-of-range exit codes, keeping the
    // marker itself.
    if (/^\d+$/.test(codeStr)) {
      const code = parseInt(codeStr, 10)
      if (code >= 0 && code <= 255) marker.exitCode = code
    }
  }
  for (; i < params.length; i++) {
    const param = params[i]
    if (param === '') continue // empty parameter: tolerated (legacy `A;`)
    const eq = param.indexOf('=')
    if (eq === -1) return null // not key=value: malformed
    const key = param.slice(0, eq)
    const value = param.slice(eq + 1)
    if (key === OSC133_TAG_KEY) {
      if (!OSC133_TAG_VALUE_RE.test(value)) return null
      marker.nocxEnv = value
    }
    // Well-formed unknown keys are ignored: foreign parameter forms must
    // not break block boundaries.
  }
  return marker
}

export class XtermRenderer implements TerminalRenderer {
  private term: Terminal | null = null
  private webgl?: WebglAddon
  private canvas?: CanvasAddon
  private container: HTMLElement | null = null
  private recoveryAttempts = 0
  // Periodic forced refresh — Linux/WebKitGTK only. See FORCED_REFRESH_MS.
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private commandMarkerSubs: CommandMarkerCallback[] = []
  private osc133Disposable?: { dispose(): void }
  private scrollSubs: Array<(viewportY: number) => void> = []
  private renderSubs: Array<(range: { start: number; end: number }) => void> = []
  private snapshotOscDisposable?: { dispose(): void }
  private scrollDisposable?: { dispose(): void }
  private renderDisposable?: { dispose(): void }
  private _cachedCellHeight: number | null = null
  /** This tab's readiness-passport tracker (OSC 636 P). Per-renderer, like
   *  the snapshot store — tab 2 is never judged against tab 1's expected id.
   *  Parse-and-report only; the consumer decides what acceptance means. */
  readonly passportTracker = new EnvironmentPassportTracker()
  private passportSubs: Array<(d: PassportDisposition) => void> = []
  /** This tab's command-existence store (OSC 636). Created per renderer so
   *  two tabs never share a snapshot; the editor and frozen headers of this
   *  tab read the same instance this OSC handler feeds. */
  readonly snapshotStore = new CommandSnapshotStore()
  /** Unsubscribe from the module-level theme watcher. */
  private _themeUnsub: (() => void) | null = null

  async mount(container: HTMLElement): Promise<void> {
    this.container = container

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      allowProposedApi: true,
      smoothScrollDuration: 120,
      scrollback: 10000,
      // When the DOM editor owns input at a prompt, focus is on the editor's
      // textarea and xterm is blurred — its default 'outline' inactive cursor
      // then paints a hollow box at the marker-only prompt, a second cursor
      // competing with the editor's caret (item 9). 'none' hides the terminal
      // cursor whenever xterm is not focused; a running program that takes
      // focus back still shows its active cursor.
      cursorInactiveStyle: 'none',
      // Holding Option (macOS) or Shift (elsewhere) forces selection in
      // mouse-tracking programs — the engine's own escape hatch for CAP-4.
      macOptionClickForcesSelection: true,
      // On macOS xterm.js defaults rightClickSelectsWord to true, which
      // word-selects, then with copy-on-select that overwrites the clipboard
      // and pastes the word under the pointer. Neither Warp nor Tabby ships
      // that combination; disable it so right-click pastes what the user
      // expects.
      rightClickSelectsWord: false,
      // The word-selection policy is shared with the frozen command blocks
      // (word-selection.ts): xterm's default separator set, made explicit so
      // double-click selects the same token on both surfaces (nocx-w7h.8).
      wordSeparator: WORD_SEPARATORS,
      theme: getCurrentTheme(),
    })
    this.term = term

    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'

    term.open(container)

    await document.fonts?.ready
    this.attachWebGL()

    // Linux/WebKitGTK: re-mark every row dirty on a timer so a render is
    // always pending. No-op on macOS/browsers where the compositor is healthy.
    if (isLinuxWebKit()) {
      this.refreshTimer = setInterval(() => {
        const t = this.term
        if (t) t.refresh(0, (t.rows ?? 24) - 1)
      }, FORCED_REFRESH_MS)
    }

    // Invalidate cellHeight cache on resize (M1).
    this.term?.onResize(() => {
      this._cachedCellHeight = null
    })

    // Subscribe to theme changes BEFORE construction completes. Re-apply the
    // current theme immediately to close any fetch/subscribe race (a notification
    // published between the resolve above and this registration would otherwise
    // be missed). ADR-0013 §8, design spec §5.4.
    this._themeUnsub = subscribeThemeChanges((t: ITheme) => this.applyTheme(t))

    // OSC 636 — command-existence snapshot (command-snapshot.ts) and the
    // readiness passport (environment-passport.ts). The stores own parse +
    // policy; the renderer is just the wire, exactly like OSC 7/52/133. One
    // handler feeds both: the snapshot store sees H/S, the passport tracker
    // only P payloads. Each renderer owns its own stores, so tab 2 is never
    // judged against tab 1's command set or expected id — the editor and
    // frozen headers receive this same instance at the composition point
    // (terminal-content.ts).
    this.snapshotOscDisposable = term.parser.registerOscHandler(636, (data: string) => {
      this.snapshotStore.ingest(data)
      if (data.startsWith('P;')) {
        const disposition = this.passportTracker.ingest(data)
        for (const sub of this.passportSubs) sub(disposition)
      }
      return false
    })
    this.applyTheme(getCurrentTheme())
  }

  /**
   * Fit the terminal grid to an explicit viewport from the presentation layer
   * (B.5). Computes cols/rows from real cell metrics and the given CSS-pixel
   * dimensions. Does NOT independently measure container geometry.
   */
  fitViewport(viewport: { width: number; height: number }): void {
    const t = this.term
    if (!t || viewport.width <= 0 || viewport.height <= 0) return
    const cell = this._getCellDims()
    if (!cell) return
    const cols = Math.max(1, Math.floor(viewport.width / cell.width))
    const rows = Math.max(1, Math.floor(viewport.height / cell.height))
    if (cols !== t.cols || rows !== t.rows) {
      t.resize(cols, rows)
    }
  }

  /**
   * Real cell dimensions from the xterm render service (same source as FitAddon).
   * Accesses internal xterm.js API not present on the public Terminal type.
   */
  private _getCellDims(): { width: number; height: number } | null {
    const t = this.term
    if (!t) return null
    // xterm.js stores cell dimensions internally — unreachable via public API.
    // Single unchecked cast to narrow local, then structural access only.
    const internal = t as unknown as { _core: unknown }
    const core = internal._core as
      | { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
      | undefined
    const cell = core?._renderService?.dimensions?.css?.cell
    if (cell && cell.width > 0 && cell.height > 0) return cell
    // Fallback: measure the char-measure-element xterm creates for font metrics.
    const el = t.element?.querySelector('.xterm-char-measure-element') as HTMLElement | null
    if (el) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height }
    }
    return null
  }

  private attachWebGL(): void {
    if (!this.term) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => this.onContextLoss())
      this.term.loadAddon(addon)
      this.webgl = addon
    } catch {
      this.attachCanvas()
    }
  }

  private attachCanvas(): void {
    if (!this.term || this.canvas) return
    try {
      const addon = new CanvasAddon()
      this.term.loadAddon(addon)
      this.canvas = addon
    } catch {
      /* fall through to xterm's built-in DOM renderer */
    }
  }

  private onContextLoss(): void {
    this.webgl?.dispose()
    this.webgl = undefined
    const recoverable =
      !!this.container && this.container.offsetParent !== null && document.hasFocus()
    if (this.recoveryAttempts < MAX_WEBGL_RECOVERY_ATTEMPTS && recoverable) {
      this.recoveryAttempts++
      this.attachWebGL()
    } else {
      this.attachCanvas()
    }
  }

  write(data: string): void {
    this.term?.write(data)
  }

  reset(): void {
    this.term?.reset()
  }

  onData(cb: DataCallback): void {
    this.term?.onData(cb)
  }

  onResize(cb: ResizeCallback): void {
    this.term?.onResize(({ cols, rows }) => cb(cols, rows))
  }

  onTitle(cb: TitleCallback): void {
    this.term?.onTitleChange(cb)
  }

  onBufferChange(cb: (type: 'normal' | 'alternate') => void): void {
    this.term?.buffer.onBufferChange((buf) => cb(buf.type))
  }

  onCwd(cb: CwdCallback): void {
    this.term?.parser.registerOscHandler(7, (data: string) => {
      const parsed = parseOsc7(data)
      if (parsed) {
        cb({ host: parsed.host, path: parsed.path })
      }
      return false // let xterm.js also handle it (default render is no-op)
    })
  }

  onCommandMarker(cb: CommandMarkerCallback): void {
    this.commandMarkerSubs.push(cb)
    if (this.osc133Disposable || !this.term) return
    this.osc133Disposable = this.term.parser.registerOscHandler(133, (data: string) => {
      const marker = parseOsc133(data)
      if (marker && this.term) {
        const buf = this.term.buffer.active
        const event: CommandMarkerEvent = {
          ...marker,
          line: buf.baseY + buf.cursorY,
          col: buf.cursorX,
          buffer: buf.type,
        }
        for (const sub of this.commandMarkerSubs) sub(event)
      }
      return false
    })
  }

  onEnvironmentPassport(cb: (disposition: PassportDisposition) => void): void {
    this.passportSubs.push(cb)
  }

  setExpectedEnvironmentId(id: string | null): void {
    this.passportTracker.setExpectedEnvironmentId(id)
  }

  onBell(cb: BellCallback): void {
    this.term?.onBell(cb)
  }

  onSelectionChange(cb: SelectionCallback): void {
    this.term?.onSelectionChange(() => {
      cb(this.term?.getSelection() ?? '')
    })
  }

  onClipboardWrite(cb: ClipboardWriteCallback): void {
    this.term?.parser.registerOscHandler(52, (data: string) => {
      // decodeOsc52 is a pure parser imported from the clipboard module
      // and does not touch the clipboard — the callback fires the decoded
      // text upward, the policy layer writes it (AD-6).
      const decoded = decodeOsc52(data)
      if (decoded !== null) {
        cb(decoded)
      }
      return false
    })
  }

  paste(text: string): void {
    // term.paste() owns bracketed-paste wrapping: when the running program
    // has enabled mode 2004, it wraps the payload in the escape sequences.
    this.term?.paste(text)
  }

  refreshAtlas(): void {
    // nocx-q18: clearing the texture atlas and then repainting races with
    // the atlas repopulation during _updateModel. After clearTextureAtlas(),
    // the atlas pages are blank and the glyph cache is empty. xterm.js's
    // default rendering path (renderRows → _updateModel → getRasterizedGlyph)
    // draws glyphs to the atlas on demand, so clearing first buys nothing.
    //
    // The resize path (fitViewport → resize) already refreshes the char atlas
    // char atlas via _refreshCharAtlas() which acquires a correctly-sized
    // atlas. The tab-activation path needs a viewport refresh because
    // terminal content may have changed while the tab was in the background.
    if (this.term) {
      this.term.refresh(0, this.term.rows - 1)
    }
  }

  applyTheme(theme: ITheme): void {
    // Deliverable 3: setting the option alone may leave a stale render,
    // especially on the WebKitGTK compositor (ADR-0005). The full viewport
    // refresh forces a repaint in the new palette. The 42 ms pump (when
    // active) continues alongside; this is the one-shot push, not a second
    // loop.
    if (!this.term) return
    this.term.options.theme = theme
    this.term.refresh(0, this.term.rows - 1)
  }

  setReadOnly(readOnly: boolean): void {
    if (this.term) this.term.options.disableStdin = readOnly
  }

  focus(): void {
    this.term?.focus()
  }

  dispose(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.snapshotOscDisposable?.dispose()
    this.snapshotOscDisposable = undefined
    this.osc133Disposable?.dispose()
    this.osc133Disposable = undefined
    this.commandMarkerSubs = []
    this.passportSubs = []
    this.scrollDisposable?.dispose()
    this.scrollDisposable = undefined
    this.scrollSubs = []
    this.renderDisposable?.dispose()
    this.renderDisposable = undefined
    this.renderSubs = []
    if (this._themeUnsub !== null) {
      this._themeUnsub()
      this._themeUnsub = null
    }
  }

  get cols(): number {
    return this.term?.cols ?? 80
  }

  get rows(): number {
    return this.term?.rows ?? 24
  }

  /**
   * Height in CSS pixels of the rows that have actually been written to.
   *
   * Scans the viewport upward for the last non-blank line rather than
   * multiplying `rows` by the cell height. The two differ by the whole point of
   * this method: the grid is as tall as the pane, so `rows * cell` would give a
   * full-pane live region to a command that printed one line.
   *
   * The cursor is included on purpose. A program that clears the screen and
   * parks the cursor at row 30 is using thirty rows even though twenty-nine of
   * them are blank; sizing to the text alone would clip it.
   *
   * Bounded by `rows`, so the cost is one pass over the visible grid — this runs
   * per animation frame while a command produces output.
   */
  liveContentHeight(): number {
    const t = this.term
    if (!t) return 0
    const cell = this._getCellDims()
    if (!cell) return 0
    const buf = t.buffer.active
    let last = buf.cursorY
    for (let y = t.rows - 1; y > last; y--) {
      const line = buf.getLine(buf.baseY + y)
      if (line && line.translateToString(true).length > 0) {
        last = y
        break
      }
    }
    return (last + 1) * cell.height
  }

  // ── Marker/geometry API (ADR-0008 command-ledger gutter) ──────────────

  registerMarker(): MarkerAdapter | undefined {
    const t = this.term
    if (!t) return undefined
    const m = t.registerMarker(0)
    if (!m) return undefined
    return {
      line: () => {
        // m.line returns -1 when disposed, so map to undefined.
        const l = m.line
        return l >= 0 ? l : undefined
      },
      onDispose: (cb: () => void) => {
        m.onDispose(cb)
      },
      dispose: () => {
        m.dispose()
      },
    }
  }

  get cellHeight(): number {
    // M1: cache cellHeight — getBoundingClientRect is expensive per paint.
    if (this._cachedCellHeight !== null) return this._cachedCellHeight
    const t = this.term
    if (!t) return Math.ceil(FONT_SIZE * LINE_HEIGHT)
    const measureEl = t.element?.querySelector('.xterm-char-measure-element') as HTMLElement | null
    if (measureEl) {
      const rect = measureEl.getBoundingClientRect()
      if (rect.height > 0) {
        this._cachedCellHeight = rect.height
        return rect.height
      }
    }
    const fallback = Math.ceil(FONT_SIZE * LINE_HEIGHT)
    this._cachedCellHeight = fallback
    return fallback
  }

  get viewportTopLine(): number {
    const t = this.term
    if (!t) return 0
    // viewportY is already the absolute buffer line at the top of the viewport
    // (xterm.d.ts). Adding baseY double-counts scrollback (B1).
    return t.buffer.active.viewportY
  }

  onScroll(cb: (viewportY: number) => void): void {
    this.scrollSubs.push(cb)
    if (this.scrollDisposable || !this.term) return
    this.scrollDisposable = this.term.onScroll((y: number) => {
      for (const sub of this.scrollSubs) sub(y)
    })
  }

  onRender(cb: (range: { start: number; end: number }) => void): void {
    this.renderSubs.push(cb)
    if (this.renderDisposable || !this.term) return
    this.renderDisposable = this.term.onRender((r: { start: number; end: number }) => {
      for (const sub of this.renderSubs) sub(r)
    })
  }

  getBufferLine(line: number): import('@xterm/xterm').IBufferLine | undefined {
    return this.term?.buffer.active.getLine(line)
  }

  /** Absolute buffer line of the cursor — the line the next write lands on. */
  cursorLine(): number {
    if (!this.term) return 0
    const buf = this.term.buffer.active
    return buf.baseY + buf.cursorY
  }

  clearViewport(): void {
    this.term?.clear()
  }

  get paneElement(): HTMLElement {
    return this.container ?? document.createElement('div')
  }
}
