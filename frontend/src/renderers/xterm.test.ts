// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  parseOsc7,
  parseOsc133,
  parseRecoveryFence,
  parseRenderFence,
  XtermRenderer,
} from './xterm'
import { WORD_SEPARATORS } from '../word-selection'
import type { CommandMarkerEvent } from './types'
import { CommandSnapshotStore } from '../command-snapshot'

const stubBrowser = () => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

describe('XtermRenderer setReadOnly', () => {
  it('toggles disableStdin on the underlying terminal', async () => {
    stubBrowser()
    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)

    // Access the private term via a cast — the test owns both sides.
    const term = (r as unknown as Record<string, unknown>).term as
      { options: { disableStdin: boolean } } | undefined
    expect(term).toBeDefined()

    r.setReadOnly(true)
    expect(term!.options.disableStdin).toBe(true)

    r.setReadOnly(false)
    expect(term!.options.disableStdin).toBe(false)
  })

  it('paste delivers the document even while the grid is read-only (nocx-u7uh.23)', async () => {
    stubBrowser()
    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)

    const term = (r as unknown as Record<string, unknown>).term as
      { options: { disableStdin: boolean } } | undefined
    expect(term).toBeDefined()

    const received: string[] = []
    r.onData((text) => received.push(text))

    // The editor owns input, so the grid is read-only — exactly the state a
    // submit is in. The submitted document must still reach the program: a
    // paste dropped here is the editor vanishing after every command.
    r.setReadOnly(true)
    r.paste('echo hi')
    expect(received).toEqual(['echo hi'])
    // The read-only guard is restored: user input stays blocked afterwards.
    expect(term!.options.disableStdin).toBe(true)

    r.setReadOnly(false)
    r.paste('echo again')
    expect(received).toEqual(['echo hi', 'echo again'])
  })

  it('uses the same word separator policy as the frozen block (parity by construction)', async () => {
    stubBrowser()
    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)
    const term = (r as unknown as Record<string, unknown>).term as
      { options: { wordSeparator?: string } } | undefined
    // The live terminal and the frozen block share ONE separator set, so a
    // double-click selects the same token on both surfaces.
    expect(term?.options.wordSeparator).toBe(WORD_SEPARATORS)
    r.dispose()
  })
})

describe('parseOsc7', () => {
  it('parses a local file:/// path (empty host)', () => {
    const result = parseOsc7('file:///Users/shady/projects')
    expect(result).toEqual({ host: '', path: '/Users/shady/projects' })
  })

  it('parses a file://host/path with hostname', () => {
    const result = parseOsc7('file://macbook.local/Users/shady')
    expect(result).toEqual({ host: 'macbook.local', path: '/Users/shady' })
  })

  it('parses file://localhost/path', () => {
    const result = parseOsc7('file://localhost/tmp')
    expect(result).toEqual({ host: 'localhost', path: '/tmp' })
  })

  it('percent-decodes the host', () => {
    const result = parseOsc7('file://my%20host.local/path')
    expect(result).toEqual({ host: 'my host.local', path: '/path' })
  })

  it('percent-decodes the path', () => {
    const result = parseOsc7('file://host/Users/shady/My%20Documents')
    expect(result).toEqual({ host: 'host', path: '/Users/shady/My Documents' })
  })

  it('percent-decodes both host and path', () => {
    const result = parseOsc7('file://my%20mac/Users/shady/project%20name')
    expect(result).toEqual({ host: 'my mac', path: '/Users/shady/project name' })
  })

  it('returns null for non-file:// payloads', () => {
    expect(parseOsc7('not-a-file-uri')).toBeNull()
    expect(parseOsc7('')).toBeNull()
    expect(parseOsc7('http://example.com/path')).toBeNull()
  })

  it('returns null for file:// with no path separator', () => {
    expect(parseOsc7('file://justhost')).toBeNull()
  })

  it('returns null for malformed percent-encoding', () => {
    // '%ZZ' is not valid percent-encoding
    expect(parseOsc7('file:///tmp/%ZZ')).toBeNull()
    // incomplete percent sequence
    expect(parseOsc7('file:///tmp/%')).toBeNull()
  })

  it('handles deeply nested paths', () => {
    const result = parseOsc7('file:///a/b/c/d/e/f/g')
    expect(result).toEqual({ host: '', path: '/a/b/c/d/e/f/g' })
  })

  it('handles root path', () => {
    const result = parseOsc7('file:///')
    expect(result).toEqual({ host: '', path: '/' })
  })
})

describe('parseOsc133', () => {
  it('parses A (prompt start)', () => {
    expect(parseOsc133('A')).toEqual({ kind: 'A' })
  })

  it('parses B (prompt end)', () => {
    expect(parseOsc133('B')).toEqual({ kind: 'B' })
  })

  it('parses C (command output start)', () => {
    expect(parseOsc133('C')).toEqual({ kind: 'C' })
  })

  it('parses D without exit code', () => {
    expect(parseOsc133('D')).toEqual({ kind: 'D' })
  })

  it('parses D with exit code 0', () => {
    expect(parseOsc133('D;0')).toEqual({ kind: 'D', exitCode: 0 })
  })

  it('parses D with exit code 127', () => {
    expect(parseOsc133('D;127')).toEqual({ kind: 'D', exitCode: 127 })
  })

  it('parses D with exit code 1', () => {
    expect(parseOsc133('D;1')).toEqual({ kind: 'D', exitCode: 1 })
  })

  it('returns D without exitCode for invalid exit code', () => {
    expect(parseOsc133('D;abc')).toEqual({ kind: 'D' })
  })

  it('returns D without exitCode for negative exit code', () => {
    expect(parseOsc133('D;-1')).toEqual({ kind: 'D' })
  })

  it('returns D without exitCode for trailing junk', () => {
    expect(parseOsc133('D;1extra')).toEqual({ kind: 'D' })
  })

  it('returns D without exitCode for out-of-range exit code', () => {
    expect(parseOsc133('D;256')).toEqual({ kind: 'D' })
  })

  it('parses D with exit code 255', () => {
    expect(parseOsc133('D;255')).toEqual({ kind: 'D', exitCode: 255 })
  })

  it('returns null for empty payload', () => {
    expect(parseOsc133('')).toBeNull()
  })

  it('returns null for unknown marker', () => {
    expect(parseOsc133('X')).toBeNull()
  })

  it('returns null for lowercase marker', () => {
    expect(parseOsc133('a')).toBeNull()
  })
})

describe('parseOsc133 nocx_env tags', () => {
  it('parses a tagged A marker exposing nocx_env', () => {
    expect(parseOsc133('A;nocx_env=env-ab12')).toEqual({ kind: 'A', nocxEnv: 'env-ab12' })
  })

  it('parses tagged B and C markers', () => {
    expect(parseOsc133('B;nocx_env=env-ab12')).toEqual({ kind: 'B', nocxEnv: 'env-ab12' })
    expect(parseOsc133('C;nocx_env=env-ab12')).toEqual({ kind: 'C', nocxEnv: 'env-ab12' })
  })

  it('parses a tagged D with exit code and nocx_env', () => {
    expect(parseOsc133('D;0;nocx_env=env-ab12')).toEqual({
      kind: 'D',
      exitCode: 0,
      nocxEnv: 'env-ab12',
    })
  })

  it('parses a tagged D without an exit code', () => {
    // The first parameter is a key=value property, not a positional exit
    // code, so it must not be swallowed.
    expect(parseOsc133('D;nocx_env=env-ab12')).toEqual({ kind: 'D', nocxEnv: 'env-ab12' })
  })

  it('leaves unknown well-formed parameters untagged', () => {
    expect(parseOsc133('A;Prompt=1')).toEqual({ kind: 'A' })
    expect(parseOsc133('A;Prompt=1;nocx_env=env-ab12')).toEqual({ kind: 'A', nocxEnv: 'env-ab12' })
  })

  it('tolerates an empty parameter as today', () => {
    expect(parseOsc133('A;')).toEqual({ kind: 'A' })
  })

  it('a marker whose tag is present but malformed is ignored entirely', () => {
    // Present-but-malformed ≠ absent: an absent tag keeps the legacy
    // untagged boundary, a malformed one must never be read as a marker.
    expect(parseOsc133('A;nocx_env=')).toBeNull()
    expect(parseOsc133('A;nocx_env=bad id')).toBeNull()
    expect(parseOsc133('A;nocx_env')).toBeNull()
    expect(parseOsc133('B;nocx_env=' + 'a'.repeat(65))).toBeNull()
    expect(parseOsc133('D;0;nocx_env=')).toBeNull()
    expect(parseOsc133('D;nocx_env=bad id')).toBeNull()
  })
})

describe('onCommandMarker fan-out', () => {
  it('exposes a tagged marker through the real parser into the enriched event', async () => {
    // jsdom lacks matchMedia and ResizeObserver, which xterm.js / our mount
    // code uses during init. Stub them so the terminal can initialise.
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)

    let resolveDone: () => void
    const done = new Promise<void>((res) => {
      resolveDone = res
    })
    let ev: CommandMarkerEvent | undefined
    r.onCommandMarker((e) => {
      ev = e
      resolveDone()
    })
    r.write('\x1b]133;A;nocx_env=env-ab12\x07')
    await done
    expect(ev?.kind).toBe('A')
    expect(ev?.nocxEnv).toBe('env-ab12')
    r.dispose()
  })
  it('fans out one enriched event per marker to every subscriber', async () => {
    // jsdom lacks matchMedia and ResizeObserver, which xterm.js / our mount
    // code uses during init. Stub them so the terminal can initialise.
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)

    const a = vi.fn()
    let resolveDone: () => void
    const done = new Promise<void>((res) => {
      resolveDone = res
    })
    const b = vi.fn(() => resolveDone())
    r.onCommandMarker(a)
    r.onCommandMarker(b)

    // Drive an OSC 133;D;0 through the real parser; write() is async.
    r.write('\x1b]133;D;0\x07')
    await done

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    const ev = a.mock.calls[0][0] as CommandMarkerEvent
    expect(ev.kind).toBe('D')
    expect(ev.exitCode).toBe(0)
    expect(ev.buffer).toBe('normal')
    expect(typeof ev.line).toBe('number')
    expect(typeof ev.col).toBe('number')
    r.dispose()
  })
})

describe('OSC 636 command-existence snapshot', () => {
  const stubBrowser = () => {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }

  const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

  async function mountRenderer(): Promise<XtermRenderer> {
    stubBrowser()
    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)
    return r
  }

  it('forwards a hello + snapshot through the real parser into the store', async () => {
    const r = await mountRenderer()

    const applied = new Promise<void>((resolve) => {
      const un = r.snapshotStore.subscribe(() => {
        un()
        resolve()
      })
    })
    r.write(`\x1b]636;H;${NONCE}\x07`)
    r.write(`\x1b]636;S;${NONCE};pwd;ls;café\x07`)
    await applied

    expect(r.snapshotStore.status).toBe('ready')
    expect(r.snapshotStore.has('pwd')).toBe(true)
    expect(r.snapshotStore.has('ls')).toBe(true)
    expect(r.snapshotStore.has('café')).toBe(true)
    r.dispose()
  })

  it('a snapshot carrying the wrong nonce is discarded', async () => {
    const r = await mountRenderer()

    // The 133 marker after the 636 bytes is a stream-order sync point: writes
    // are async, and a discarded snapshot notifies nobody.
    let markerDone: () => void
    const marker = new Promise<void>((resolve) => {
      markerDone = resolve
    })
    r.onCommandMarker(() => markerDone())

    r.write(`\x1b]636;H;${NONCE}\x07`)
    r.write('\x1b]636;S;deadbeefdeadbeefdeadbeefdeadbeef;pwd\nls\x07')
    r.write('\x1b]133;D;0\x07')
    await marker

    expect(r.snapshotStore.status).toBe('unavailable')
    r.dispose()
  })

  it('two renderers keep their snapshots separate (per-tab stores)', async () => {
    const r1 = await mountRenderer()
    const r2 = await mountRenderer()
    const NONCE_B = 'deadbeefdeadbeefdeadbeefdeadbeef'

    const applied1 = new Promise<void>((resolve) => {
      const un = r1.snapshotStore.subscribe(() => {
        un()
        resolve()
      })
    })
    r1.write(`\x1b]636;H;${NONCE}\x07`)
    r1.write(`\x1b]636;S;${NONCE};pwd;ls\x07`)
    await applied1

    const applied2 = new Promise<void>((resolve) => {
      const un = r2.snapshotStore.subscribe(() => {
        un()
        resolve()
      })
    })
    r2.write(`\x1b]636;H;${NONCE_B}\x07`)
    r2.write(`\x1b]636;S;${NONCE_B};kubectl\x07`)
    await applied2

    // Tab 1 resolves only its own names; tab 2 resolves only its own. Under
    // the old module singleton, r2's hello would have been discarded (nonce
    // already anchored by r1) and its snapshot rejected, leaving r2 judged
    // against r1's command set — this is the defect this test pins.
    expect(r1.snapshotStore.status).toBe('ready')
    expect(r1.snapshotStore.has('pwd')).toBe(true)
    expect(r1.snapshotStore.has('ls')).toBe(true)
    expect(r1.snapshotStore.has('kubectl')).toBe(false)
    expect(r2.snapshotStore.status).toBe('ready')
    expect(r2.snapshotStore.has('kubectl')).toBe(true)
    expect(r2.snapshotStore.has('pwd')).toBe(false)
    r1.dispose()
    r2.dispose()
  })

  it('a renderer whose session never sent a snapshot reports unavailable even when another tab has one', async () => {
    const r1 = await mountRenderer()
    const r2 = await mountRenderer()

    const applied1 = new Promise<void>((resolve) => {
      const un = r1.snapshotStore.subscribe(() => {
        un()
        resolve()
      })
    })
    r1.write(`\x1b]636;H;${NONCE}\x07`)
    r1.write(`\x1b]636;S;${NONCE};pwd;ls\x07`)
    await applied1

    // r2 never received a hello or snapshot — it must not inherit r1's.
    expect(r1.snapshotStore.status).toBe('ready')
    expect(r2.snapshotStore.status).toBe('unavailable')
    expect(r2.snapshotStore.has('pwd')).toBe(false)
    r1.dispose()
    r2.dispose()
  })

  it('a fresh renderer carries a fresh store (CommandSnapshotStore instance)', () => {
    const r = new XtermRenderer()
    expect(r.snapshotStore).toBeInstanceOf(CommandSnapshotStore)
    expect(r.snapshotStore.status).toBe('unavailable')
  })
})

describe('parseRenderFence (OSC 1337 NOCX_FENCE — ADR-0024 §7 carve-out)', () => {
  const FENCE = 'ab'.repeat(32) // 64 hex chars, what the shell generates

  it('parses a well-formed fence payload', () => {
    expect(parseRenderFence(`NOCX_FENCE;${FENCE}`)).toEqual({ hex: FENCE })
  })

  it('rejects payloads without the NOCX_FENCE; prefix (foreign OSC 1337)', () => {
    expect(parseRenderFence(`File=name;size=42`)).toBeNull() // iTerm2 file transfer
    expect(parseRenderFence(`NOCX_IB_READY`)).toBeNull()
    expect(parseRenderFence('')).toBeNull()
  })

  it('rejects a non-hex, short, long or empty nonce — only exactly 64 lowercase hex', () => {
    expect(parseRenderFence(`NOCX_FENCE;deadbeef`)).toBeNull() // 8 chars, not 64
    expect(parseRenderFence(`NOCX_FENCE;${'g'.repeat(64)}`)).toBeNull()
    expect(parseRenderFence(`NOCX_FENCE;${'A'.repeat(64)}`)).toBeNull() // uppercase
    expect(parseRenderFence(`NOCX_FENCE;${FENCE}x`)).toBeNull() // 65 chars
    expect(parseRenderFence(`NOCX_FENCE;`)).toBeNull()
  })
})

describe('parseRecoveryFence (OSC 1337 NOCX_RECOVERY — ADR-0024 decision 8)', () => {
  const NONCE = 'ab'.repeat(32)

  it('parses a well-formed recovery fence payload', () => {
    expect(parseRecoveryFence(`NOCX_RECOVERY;${NONCE}`)).toEqual({ hex: NONCE })
  })

  it('rejects foreign OSC 1337 payloads and non-conforming nonces', () => {
    expect(parseRecoveryFence(`File=name;size=42`)).toBeNull()
    expect(parseRecoveryFence(`NOCX_FENCE;${NONCE}`)).toBeNull() // the completion fence is not a recovery
    expect(parseRecoveryFence(`NOCX_RECOVERY;deadbeef`)).toBeNull()
    expect(parseRecoveryFence(`NOCX_RECOVERY;${'g'.repeat(64)}`)).toBeNull()
    expect(parseRecoveryFence(`NOCX_RECOVERY;${'A'.repeat(64)}`)).toBeNull()
    expect(parseRecoveryFence('')).toBeNull()
  })
})

describe('XtermRenderer fence delivery through the real parser', () => {
  const stubBrowser = () => {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }

  async function mountRenderer(): Promise<XtermRenderer> {
    stubBrowser()
    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)
    return r
  }

  const FENCE = 'cd'.repeat(32)

  it('reports the fence and the line it landed on', async () => {
    const r = await mountRenderer()
    let seen: { hex: string; line: number } | null = null
    r.onRenderFence((ev) => {
      seen = { hex: ev.hex, line: ev.line }
    })

    // The 133 marker after the 1337 bytes is a stream-order sync point:
    // writes are async, and the fence callback has no other completion
    // signal. When the marker lands, the fence before it has been parsed.
    let markerDone: () => void
    const marker = new Promise<void>((resolve) => {
      markerDone = resolve
    })
    r.onCommandMarker(() => markerDone())

    r.write(`\x1b]1337;NOCX_FENCE;${FENCE}\x07`)
    r.write('\x1b]133;A\x07')
    await marker

    expect(seen).toEqual({ hex: FENCE, line: 0 })
    r.dispose()
  })

  it('a malformed or foreign OSC 1337 never fires the callback', async () => {
    const r = await mountRenderer()
    const cb = vi.fn()
    r.onRenderFence(cb)

    let markerDone: () => void
    const marker = new Promise<void>((resolve) => {
      markerDone = resolve
    })
    r.onCommandMarker(() => markerDone())

    r.write(`\x1b]1337;NOCX_FENCE;deadbeef\x07`) // not 64 hex
    r.write('\x1b]1337;File=name;size=42\x07') // iTerm2's 1337, not ours
    r.write('\x1b]133;A\x07')
    await marker

    expect(cb).not.toHaveBeenCalled()
    r.dispose()
  })

  it('delivers a recovery fence through the OSC path — the same handler as the render fence (nocx-u7uh.24)', async () => {
    const r = await mountRenderer()
    const NONCE = 'ef'.repeat(32)
    const seen: string[] = []
    r.onRecoveryFence((hex) => seen.push(hex))

    let markerDone: () => void
    const marker = new Promise<void>((resolve) => {
      markerDone = resolve
    })
    r.onCommandMarker(() => markerDone())

    r.write(`\x1b]1337;NOCX_RECOVERY;${NONCE}\x07`)
    r.write('\x1b]133;A\x07')
    await marker

    // The shell's one-shot recovery nonce reached the subscribers — the
    // production path that previously parsed NOCX_RECOVERY nowhere.
    expect(seen).toEqual([NONCE])

    // The completion fence is a different payload kind on the same ident:
    // it must NOT fan out to recovery subscribers.
    seen.length = 0
    r.onRenderFence(() => {})
    let fenceMarkerDone: () => void
    const fenceMarker = new Promise<void>((resolve) => {
      fenceMarkerDone = resolve
    })
    r.onCommandMarker(() => fenceMarkerDone())
    r.write(`\x1b]1337;NOCX_FENCE;${'ab'.repeat(32)}\x07`)
    r.write('\x1b]133;A\x07')
    await fenceMarker
    expect(seen).toEqual([])
    r.dispose()
  })
})

// ── Shift+Enter as its own chord (nocx-nt70) ──────────────────────────────
// A program that owns the keyboard receives Enter as a bare CR and cannot
// tell Shift+Enter apart — xterm drops the modifier. The renderer re-encodes
// the plain chord as ESC CR (the decision and the named alternative live at
// SHIFT_ENTER_SEQUENCE in xterm.ts). These tests pin the exact bytes that
// leave the renderer for each chord, driven through xterm's real keydown
// path — the same DOM events a user's keystrokes produce.
describe('Shift+Enter as its own chord (nocx-nt70)', () => {
  async function mountKeyRenderer(): Promise<{ r: XtermRenderer; received: string[] }> {
    stubBrowser()
    const r = new XtermRenderer()
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    await r.mount(container)
    const received: string[] = []
    r.onData((text) => received.push(text))
    return { r, received }
  }

  /** Dispatch a real keydown at xterm's hidden textarea — the production
   *  path (xterm binds its key handling to the textarea with capture). */
  function pressKey(r: XtermRenderer, init: KeyboardEventInit & { keyCode: number }): void {
    const term = (r as unknown as Record<string, unknown>).term as { element: HTMLElement }
    const textarea = term.element.querySelector('textarea')
    expect(textarea).not.toBeNull()
    const event = new KeyboardEvent('keydown', { ...init, bubbles: true })
    // jsdom does not compute keyCode from `key`; xterm's encoder reads it.
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
    textarea!.dispatchEvent(event)
  }

  it('sends ESC CR for Shift+Enter and CR for Enter — the exact bytes a program sees', async () => {
    const { r, received } = await mountKeyRenderer()
    pressKey(r, { key: 'Enter', keyCode: 13 })
    pressKey(r, { key: 'Enter', keyCode: 13, shiftKey: true })
    expect(received).toEqual(['\r', '\x1b\r'])
    r.dispose()
  })

  it('leaves every neighbouring chord byte-identical to xterm\u2019s own encoding', async () => {
    const { r, received } = await mountKeyRenderer()
    // Ctrl+Enter, Alt+Enter, Ctrl+Shift+Enter, Shift+Tab, then a bare Enter.
    // Only the plain Shift+Enter chord is re-encoded; everything else must
    // stay exactly what xterm produced before the hook existed (the
    // "nothing negotiated, nothing changed" property, pinned per chord).
    // Alt+Enter = ESC CR is the collision the decision names: a program
    // still cannot tell it from Shift+Enter under the legacy encoding.
    pressKey(r, { key: 'Enter', keyCode: 13, ctrlKey: true })
    pressKey(r, { key: 'Enter', keyCode: 13, altKey: true })
    pressKey(r, { key: 'Enter', keyCode: 13, shiftKey: true, ctrlKey: true })
    pressKey(r, { key: 'Tab', keyCode: 9, shiftKey: true })
    pressKey(r, { key: 'Enter', keyCode: 13 })
    expect(received).toEqual(['\r', '\x1b\r', '\r', '\x1b[Z', '\r'])
    r.dispose()
  })

  it('never re-encodes a Ctrl-modified Enter into the Shift+Enter bytes', async () => {
    const { r, received } = await mountKeyRenderer()
    // Ctrl+Shift+Enter is not the plain chord: the hook must not fire for it.
    // If the hook condition ever widened past Enter+Shift alone, this key
    // would come back as ESC CR — the bytes this test pins it against.
    pressKey(r, { key: 'Enter', keyCode: 13, shiftKey: true, ctrlKey: true })
    expect(received).toEqual(['\r'])
    r.dispose()
  })
})
