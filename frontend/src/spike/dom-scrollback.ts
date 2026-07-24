// DOM Scrollback Spike — nocx-4ff.17
//
// Validates a new rendering model where xterm is the hidden VT engine,
// scrollback is rendered as DOM blocks, and commands freeze on OSC 133 D.
//
// Run: terminal A: go run ./cmd/devharness  (prints WSPORT=N)
//      terminal B: cd frontend && npx vite
//      playwright: open http://localhost:5173/spike.html

import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

// ── Types ────────────────────────────────────────────────────────────────

interface CommandBlock {
  command: string
  cwd: string
  host: string
  exitCode: number | null
  status: 'running' | 'success' | 'failure' | 'unknown'
  startLine: number // absolute buffer line of OSC 133 C
  endLine: number // absolute buffer line of OSC 133 D (approx)
  el: HTMLElement
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function $(id: string): HTMLElement {
  return document.getElementById(id)!
}

const statusEl = $('status') as HTMLSpanElement
const perfBlocks = $('perf-blocks') as HTMLSpanElement
const perfNodes = $('perf-nodes') as HTMLSpanElement
const perfSerialize = $('perf-serialize') as HTMLSpanElement
const perfScroll = $('perf-scroll') as HTMLSpanElement

// ── Color palette (xterm 256-color) ───────────────────────────────────────

// ANSI 0-15 mapped to common terminal themes (Tokyo Night)
const ANSI_COLORS: string[] = [
  '#1a1b26', // 0  Black
  '#f7768e', // 1  Red
  '#9ece6a', // 2  Green
  '#e0af68', // 3  Yellow
  '#7aa2f7', // 4  Blue
  '#bb9af7', // 5  Magenta
  '#7dcfff', // 6  Cyan
  '#c0caf5', // 7  White
  '#565f89', // 8  Bright Black
  '#f7768e', // 9  Bright Red
  '#9ece6a', // 10 Bright Green
  '#e0af68', // 11 Bright Yellow
  '#7aa2f7', // 12 Bright Blue
  '#bb9af7', // 13 Bright Magenta
  '#7dcfff', // 14 Bright Cyan
  '#c0caf5', // 15 Bright White
]

function paletteToRGB(idx: number): string {
  if (idx < 16) return ANSI_COLORS[idx]
  if (idx < 232) {
    // 6×6×6 color cube
    const i = idx - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    const scale = (v: number) => (v === 0 ? 0 : v * 40 + 55)
    return `rgb(${scale(r)},${scale(g)},${scale(b)})`
  }
  // Grayscale 232-255
  const g = (idx - 232) * 10 + 8
  return `rgb(${g},${g},${g})`
}

function colorToCSS(color: number, mode: number): string | null {
  if (mode === 0) return null // default — inherit
  if (mode === 2) {
    // RGB: bits 0-7=R, 8-15=G, 16-23=B
    const r = color & 0xff
    const g = (color >> 8) & 0xff
    const b = (color >> 16) & 0xff
    return `rgb(${r},${g},${b})`
  }
  // mode === 1: palette index
  if (color >= 0 && color < 256) return paletteToRGB(color)
  return null
}

// ── Serialize a single IBufferLine to HTML ────────────────────────────────

interface CellAttrs {
  fg: string | null
  bg: string | null
  bold: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  blink: boolean
  strikethrough: boolean
  overline: boolean
}

function attrsEqual(a: CellAttrs, b: CellAttrs): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.blink === b.blink &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline
  )
}

function cellAttrs(terminal: Terminal, lineIdx: number, cellIdx: number): CellAttrs {
  const line = terminal.buffer.active.getLine(lineIdx)
  if (!line) return emptyAttrs()

  const cell = line.getCell(cellIdx)
  if (!cell) return emptyAttrs()

  const fgColor = cell.getFgColor()
  const fgMode = cell.getFgColorMode()
  const bgColor = cell.getBgColor()
  const bgMode = cell.getBgColorMode()

  return {
    fg: colorToCSS(fgColor, fgMode),
    bg: colorToCSS(bgColor, bgMode),
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    inverse: cell.isInverse() !== 0,
    blink: cell.isBlink() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
    overline: cell.isOverline() !== 0,
  }
}

function emptyAttrs(): CellAttrs {
  return {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    blink: false,
    strikethrough: false,
    overline: false,
  }
}

function attrsToStyle(a: CellAttrs): string {
  const parts: string[] = []
  if (a.fg) parts.push(`color:${a.fg}`)
  if (a.bg) parts.push(`background:${a.bg}`)
  if (a.bold) parts.push('font-weight:bold')
  if (a.italic) parts.push('font-style:italic')
  if (a.underline) parts.push('text-decoration:underline')
  if (a.blink) parts.push('text-decoration:blink')
  if (a.strikethrough) parts.push('text-decoration:line-through')
  if (a.overline) parts.push('text-decoration:overline')
  if (a.inverse) {
    // Swap fg/bg for inverse
    const fg = a.fg ?? '#c0caf5'
    const bg = a.bg ?? '#1a1b26'
    parts.push(`color:${bg};background:${fg}`)
  }
  return parts.join(';')
}

function serializeLine(terminal: Terminal, lineIdx: number): string {
  const line = terminal.buffer.active.getLine(lineIdx)
  if (!line) return '<span class="term-line"></span>'

  const len = line.length
  if (len === 0) return '<span class="term-line"></span>'

  let html = '<span class="term-line">'
  let i = 0

  while (i < len) {
    const cell = line.getCell(i)
    if (!cell) {
      i++
      continue
    }

    const width = cell.getWidth()
    const chars = cell.getChars()

    if (chars.length === 0) {
      html += ' '
      i += Math.max(1, width)
      continue
    }

    const attrs = cellAttrs(terminal, lineIdx, i)
    const style = attrsToStyle(attrs)

    // Escape HTML entities
    const escaped = chars.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    if (style) {
      html += `<span style="${style}">${escaped}</span>`
    } else {
      html += escaped
    }
    i += Math.max(1, width)
  }

  html += '</span>'
  return html
}

// Serialize a range of buffer lines into a single HTML string.
function serializeRange(terminal: Terminal, startLine: number, endLine: number): string {
  let html = ''
  for (let y = startLine; y <= endLine; y++) {
    html += serializeLine(terminal, y)
  }
  return html
}

// ── Command block management ──────────────────────────────────────────────

const scrollbackInner = $('scrollback-inner')
const scrollbackArea = $('scrollback-area')
const xtermContainer = $('xterm-container')

let blocks: CommandBlock[] = []
let frozenBlockCount = 0

function createBlockHeader(
  command: string,
  cwd: string,
  exitCode: number | null,
  status: CommandBlock['status'],
): HTMLElement {
  const header = document.createElement('div')
  header.className = 'cmd-header'

  if (status === 'running') {
    const spinner = document.createElement('span')
    spinner.className = 'running-indicator'
    header.appendChild(spinner)
  }

  const cmdSpan = document.createElement('span')
  cmdSpan.textContent = command || '(empty)'
  cmdSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'
  header.appendChild(cmdSpan)

  if (cwd) {
    const cwdSpan = document.createElement('span')
    cwdSpan.textContent = cwd
    cwdSpan.style.cssText = 'color:#565f89;font-size:11px;'
    header.appendChild(cwdSpan)
  }

  if (status !== 'running') {
    const exitSpan = document.createElement('span')
    exitSpan.className = `cmd-exit ${exitCode === 0 ? 'ok' : 'fail'}`
    exitSpan.textContent = exitCode !== null ? `exit: ${exitCode}` : status
    header.appendChild(exitSpan)
  }

  return header
}

function createCommandBlock(
  command: string,
  cwd: string,
  outputHtml: string,
  exitCode: number | null,
  status: CommandBlock['status'],
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cmd-block'

  const header = createBlockHeader(command, cwd, exitCode, status)
  wrapper.appendChild(header)

  const output = document.createElement('div')
  output.className = 'cmd-output'
  output.innerHTML = outputHtml
  wrapper.appendChild(output)

  return wrapper
}

function freezeBlock(block: CommandBlock, outputHtml: string, exitCode: number | null): void {
  const oldEl = block.el
  const newEl = createCommandBlock(
    block.command,
    block.cwd,
    outputHtml,
    exitCode,
    exitCode === 0 ? 'success' : exitCode !== null ? 'failure' : 'unknown',
  )
  block.el = newEl
  block.status = exitCode === 0 ? 'success' : exitCode !== null ? 'failure' : 'unknown'
  block.exitCode = exitCode

  // Replace the old (running) block element with the frozen one
  if (oldEl.parentNode) {
    oldEl.parentNode.replaceChild(newEl, oldEl)
  }

  frozenBlockCount++
  updatePerf()
}

// ── Xterm initialization ──────────────────────────────────────────────────

let terminal: Terminal
let isAltScreen = false
let currentBlock: CommandBlock | null = null
let blockStartMarker: number = -1 // xterm marker ID for the C boundary

function initXterm(): void {
  terminal = new Terminal({
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 14,
    lineHeight: 1.5,
    allowProposedApi: true,
    scrollback: 50000, // large — needed to capture full output between C and D markers
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
    },
  })

  terminal.open(xtermContainer)

  // ── OSC 133 handler ──────────────────────────────────────────────────
  terminal.parser.registerOscHandler(133, (data: string) => {
    const kind = data.length > 0 ? data[0] : null
    const buf = terminal.buffer.active

    if (kind === 'A') {
      // Prompt start — no block action
    } else if (kind === 'C') {
      // Command output start — create a running block
      const line = buf.baseY + buf.cursorY
      onCommandStart(line)
    } else if (kind === 'D') {
      // Command finished
      let exitCode: number | undefined
      if (data.length > 1 && data[1] === ';') {
        const codeStr = data.slice(2)
        if (/^\d+$/.test(codeStr)) {
          exitCode = parseInt(codeStr, 10)
        }
      }
      const line = buf.baseY + buf.cursorY
      onCommandEnd(line, exitCode ?? null)
    }
    return false
  })

  // ── Buffer change (alt-screen detection) ────────────────────────────
  terminal.buffer.onBufferChange((buf) => {
    if (buf.type === 'alternate') {
      enterAltScreen()
    } else {
      exitAltScreen()
    }
  })

  // ── Auto-scroll ──────────────────────────────────────────────────────
  let userScrolled = false
  scrollbackArea.addEventListener('scroll', () => {
    const atBottom =
      scrollbackArea.scrollHeight - scrollbackArea.scrollTop - scrollbackArea.clientHeight < 30
    userScrolled = !atBottom
  })

  terminal.onWriteParsed(() => {
    if (!userScrolled && !isAltScreen) {
      // Ensure xterm container is visible in the scrollback area
      xtermContainer.scrollIntoView({ block: 'end', behavior: 'instant' })
    }
  })
}

// ── Alt-screen management ─────────────────────────────────────────────────

function enterAltScreen(): void {
  isAltScreen = true
  xtermContainer.classList.add('fullscreen')
  scrollbackArea.style.display = 'none'
  updateStatus('alt-screen')
  // Resize xterm to fill the viewport
  fitXtermToViewport()
}

function exitAltScreen(): void {
  isAltScreen = false
  xtermContainer.classList.remove('fullscreen')
  scrollbackArea.style.display = ''
  updateStatus('normal')
  // Restore xterm to its inline size
  fitXtermToContainer()
}

function fitXtermToViewport(): void {
  // xterm will auto-fit via CSS in fullscreen mode
  if (terminal.element) {
    terminal.element.style.width = '100%'
    terminal.element.style.height = '100%'
  }
}

function fitXtermToContainer(): void {
  if (terminal.element) {
    terminal.element.style.width = '100%'
    terminal.element.style.height = '120px'
    terminal.element.style.minHeight = '48px'
  }
}

// ── Command lifecycle ─────────────────────────────────────────────────────

function onCommandStart(line: number): void {
  if (currentBlock) {
    // Finalize previous block if still running
    const prevHtml = serializeRange(terminal, currentBlock.startLine, line - 1)
    freezeBlock(currentBlock, prevHtml, null)
    currentBlock = null
  }

  // Register an xterm marker so we can find the line even after scrollback trim
  // (marker kept for potential future use; not needed for spike serialization)
  terminal.registerMarker(0)

  currentBlock = {
    command: '',
    cwd: '',
    host: '',
    exitCode: null,
    status: 'running',
    startLine: line,
    endLine: line,
    el: createCommandBlock('...', '', '', null, 'running'),
  }

  // Insert the running block before the xterm container
  scrollbackInner.insertBefore(currentBlock.el, xtermContainer)

  blocks.push(currentBlock)
  updatePerf()
}

function onCommandEnd(line: number, exitCode: number | null): void {
  if (!currentBlock) return

  currentBlock.endLine = line

  // Serialize the output region between start and end markers
  const t0 = performance.now()
  const outputHtml = serializeRange(terminal, currentBlock.startLine, line)
  const serializeTime = (performance.now() - t0).toFixed(1)

  freezeBlock(currentBlock, outputHtml, exitCode)

  perfSerialize.textContent = `last serialize: ${serializeTime}ms (${line - currentBlock.startLine + 1} lines)`

  // Trim xterm scrollback: clear the viewport to remove frozen lines.
  // We can't selectively delete scrollback lines, but we can clear the viewport
  // since the output is now in DOM.
  //
  // Actually, terminal.clear() clears the viewport. But we need to be careful
  // not to disrupt the prompt. For the spike, we just note that trimming is
  // possible via terminal.reset() + re-rendering the prompt, but leave the
  // xterm as-is for now.

  currentBlock = null
  updatePerf()
}

// ── WebSocket protocol (simplified, self-contained) ───────────────────────

let ws: WebSocket | null = null
let sessionId = ''
let wsPort = 0

const FRAME_VERSION = 0x01
const MSG_TYPE_DATA = 0x01
const FRAME_HEADER_SIZE = 18

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 32; i += 2) {
    bytes[i >> 1] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function encodeFrame(sid: string, payload: Uint8Array): ArrayBuffer {
  const sidBytes = hexToBytes(sid)
  const buf = new ArrayBuffer(FRAME_HEADER_SIZE + payload.byteLength)
  const view = new Uint8Array(buf)
  view[0] = FRAME_VERSION
  view[1] = MSG_TYPE_DATA
  view.set(sidBytes, 2)
  view.set(payload, FRAME_HEADER_SIZE)
  return buf
}

function decodeFrame(data: ArrayBuffer): { sessionId: string; payload: ArrayBuffer } | null {
  if (data.byteLength < FRAME_HEADER_SIZE) return null
  const view = new Uint8Array(data)
  if (view[0] !== FRAME_VERSION || view[1] !== MSG_TYPE_DATA) return null
  const sid = Array.from(view.slice(2, FRAME_HEADER_SIZE))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return { sessionId: sid, payload: data.slice(FRAME_HEADER_SIZE) }
}

let requestId = 0
function nextId(): number {
  return ++requestId
}

async function connectBackend(port: number): Promise<void> {
  wsPort = port
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://${location.hostname}:${port}/session`)
    ws.binaryType = 'arraybuffer'

    // Main message handler: route binary frames to xterm, handle exit notifications
    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = decodeFrame(event.data)
        if (frame && frame.sessionId === sessionId) {
          const text = new TextDecoder().decode(frame.payload)
          terminal.write(text)
        }
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data)
          if (msg.method === 'exit') {
            updateStatus('session exited')
          }
        } catch {
          /* ignore */
        }
      }
    }

    ws.onopen = () => {
      updateStatus('ws open')
      resolve()
    }

    ws.onerror = () => {
      updateStatus('ws error')
      reject(new Error('ws connection failed'))
    }

    ws.onclose = () => {
      updateStatus('disconnected')
    }
  })
}

function openSession(cols: number, rows: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('not connected'))
      return
    }
    const id = nextId()
    const handler = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id === id) {
            ws!.removeEventListener('message', handler)
            if (msg.error) {
              reject(new Error(msg.error.message || 'open failed'))
            } else {
              sessionId = msg.result?.sessionId ?? ''
              updateStatus(`session: ${sessionId.slice(0, 8)}...`)
              resolve()
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    ws.addEventListener('message', handler)
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'open',
        params: { cols, rows, xpixel: 0, ypixel: 0, enhanced: true },
      }),
    )
  })
}

function sendToPTY(data: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) return
  const payload = new TextEncoder().encode(data)
  const frame = encodeFrame(sessionId, payload)
  ws.send(frame)
}

function sendResize(cols: number, rows: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) return
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'resize',
      params: { sessionId, cols, rows, xpixel: 0, ypixel: 0 },
    }),
  )
}

// ── Performance measurement ───────────────────────────────────────────────

function updatePerf(): void {
  perfBlocks.textContent = `blocks: ${blocks.length} (frozen: ${frozenBlockCount})`
  // Count DOM nodes in scrollback-inner (rough)
  const nodeCount = scrollbackInner.querySelectorAll(
    '.cmd-block, .cmd-output span, .term-line, .term-line span',
  ).length
  perfNodes.textContent = `DOM nodes: ${nodeCount}`
}

function updateStatus(s: string): void {
  statusEl.textContent = s
}

// ── 10k line performance test ─────────────────────────────────────────────

async function runPerfTest(): Promise<void> {
  updateStatus('perf test: running seq 1 12000...')
  sendToPTY('seq 1 12000\n')

  // Wait for the output to arrive and the D marker
  // We'll measure after a delay
  setTimeout(() => {
    const t0 = performance.now()
    // Count DOM nodes
    const allNodes = scrollbackInner.querySelectorAll('*')
    const blockNodes = scrollbackInner.querySelectorAll('.cmd-block *')
    const termLines = scrollbackInner.querySelectorAll('.term-line')

    const t1 = performance.now()
    perfNodes.textContent = `DOM nodes: ${allNodes.length} (block: ${blockNodes.length}, lines: ${termLines.length})`
    perfScroll.textContent = `scroll query: ${(t1 - t0).toFixed(1)}ms`

    // Test scroll performance
    const startScroll = performance.now()
    scrollbackArea.scrollTo({ top: 0, behavior: 'instant' })
    requestAnimationFrame(() => {
      scrollbackArea.scrollTo({ top: scrollbackArea.scrollHeight, behavior: 'instant' })
      requestAnimationFrame(() => {
        const scrollTime = (performance.now() - startScroll).toFixed(1)
        perfScroll.textContent = `scroll full: ${scrollTime}ms`
        updateStatus('perf test done')
      })
    })
  }, 5000)
}

// ── Keyboard handling ─────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (!sessionId) return

  // Ctrl+Shift+. → native mode escape
  if (e.key === '.' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault()
    sendToPTY('\x1b[?1049l') // force exit alt screen
    return
  }

  // In alt-screen mode, route everything to PTY
  if (isAltScreen) {
    sendToPTY(e.key.length === 1 ? e.key : keyEventToSequence(e))
    e.preventDefault()
    return
  }

  // At normal prompt, route to PTY (in the spike we don't have the DOM editor)
  sendToPTY(e.key.length === 1 ? e.key : keyEventToSequence(e))
  e.preventDefault()
})

function keyEventToSequence(e: KeyboardEvent): string {
  if (e.key === 'Enter') return '\r'
  if (e.key === 'Backspace') return '\x7f'
  if (e.key === 'Tab') return '\t'
  if (e.key === 'Escape') return '\x1b'
  if (e.key === 'ArrowUp') return '\x1b[A'
  if (e.key === 'ArrowDown') return '\x1b[B'
  if (e.key === 'ArrowRight') return '\x1b[C'
  if (e.key === 'ArrowLeft') return '\x1b[D'
  if (e.ctrlKey && e.key === 'c') return '\x03'
  if (e.ctrlKey && e.key === 'd') return '\x04'
  if (e.ctrlKey && e.key === 'l') return '\x0c' // clear
  return ''
}

// ── Resize handling ───────────────────────────────────────────────────────

let resizeTimer: number | undefined

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    if (isAltScreen) {
      fitXtermToViewport()
    }
    // DOM blocks reflow naturally via CSS
  }, 100)
})

new ResizeObserver(() => {
  if (!isAltScreen && terminal) {
    // Keep xterm at a reasonable live-region size
    const cols = Math.floor((xtermContainer.clientWidth - 16) / 8.4) // rough
    const rows = Math.floor(xtermContainer.clientHeight / 21) // rough
    if (cols > 0 && rows > 0 && sessionId) {
      sendResize(cols, rows)
    }
  }
}).observe(xtermContainer)

// ── Buttons ────────────────────────────────────────────────────────────────

$('btn-connect').addEventListener('click', async () => {
  try {
    // Get WSPORT from the Wails bridge or env
    let port = 0
    const w = window as any
    if (w.go?.main?.WailsApp?.GetWSPort) {
      port = await w.go.main.WailsApp.GetWSPort()
    }
    if (!port) {
      port = parseInt(prompt('Enter WSPORT:', '9876') || '0', 10)
    }
    if (!port || isNaN(port)) {
      updateStatus('invalid port')
      return
    }

    initXterm()
    await connectBackend(port)
    await openSession(80, 24)

    fitXtermToContainer()
    updateStatus('ready — type commands!')

    // Focus the xterm so keyboard works
    xtermContainer.focus()
  } catch (err) {
    updateStatus(`error: ${err}`)
  }
})

$('btn-clear-blocks').addEventListener('click', () => {
  // Remove all DOM blocks
  for (const b of blocks) {
    b.el.remove()
  }
  blocks = []
  frozenBlockCount = 0
  updatePerf()
  updateStatus('blocks cleared')
})

$('btn-perf-test').addEventListener('click', () => {
  void runPerfTest()
})

// ── Startup ────────────────────────────────────────────────────────────────

// On the spike page loaded under wails or with injected WSPort:
const w = window as any
if (w.go?.main?.WailsApp?.GetWSPort) {
  w.go.main.WailsApp.GetWSPort()
    .then(async (port: number) => {
      initXterm()
      await connectBackend(port)
      await openSession(80, 24)
      fitXtermToContainer()
      updateStatus('ready — type commands!')
      xtermContainer.focus()
    })
    .catch((err: any) => {
      updateStatus(`auto-connect error: ${err}`)
    })
}

// Export for test introspection
export { blocks, frozenBlockCount, terminal, currentBlock, isAltScreen }

console.log('nocx: DOM scrollback spike loaded')
