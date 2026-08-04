// ── TabManager test fixtures ──────────────────────────────────────────────
//
// Centralised factories, constants and helpers so that adding a field to the
// real SessionHandle (or changing a default title) requires editing exactly
// ONE place in test-support instead of chasing N copies through the suite.
//
// See AD-7: sessionId is server-authoritative, cwd is set once at session
// open. The fake must carry both.

import { vi } from 'vitest'
import type {
  CommandMarkerCallback,
  CwdCallback,
  DataCallback,
  ResizeCallback,
  TitleCallback,
  TerminalRenderer,
} from '../renderers/types'
import { CommandSnapshotStore } from '../command-snapshot'
import type { ClipboardAccess } from '../clipboard'
import type { ClipboardGate } from '../clipboard'
import type { ClipboardBanner } from '../banner'
import type { TabManager } from '../tabs'

// ═══════════════════════════════════════════════════════════════════════════
// Constants — every assertion must derive from these, never repeat the literal.
// ═══════════════════════════════════════════════════════════════════════════

/** The cwd every session reports by default. */
export const FIXTURE_CWD = '~/Documents/repos/nocx'

/** The tab label produced by directoryLabel(FIXTURE_CWD). */
export const FIXTURE_DIRECTORY_LABEL = 'repos/nocx'

// ═══════════════════════════════════════════════════════════════════════════
// Renderer mock — factory called once per tab by createRenderer().
// ═══════════════════════════════════════════════════════════════════════════

export interface RendererMock extends TerminalRenderer {
  /** This tab's OSC 636 store — XtermRenderer owns one, so the mock must too. */
  snapshotStore: CommandSnapshotStore
  _cbs: {
    onData?: DataCallback
    onResize?: ResizeCallback
    onTitle?: TitleCallback
    onCwd?: CwdCallback
    onCommandMarker?: CommandMarkerCallback
    onInBandReady?: () => void
    onBell?: () => void
    onBufferChange?: (type: 'normal' | 'alternate') => void
    onSelectionChange?: (text: string) => void
    onClipboardWrite?: (text: string) => void
  }
  _fireBufferChange(type: 'normal' | 'alternate'): void
  _fireTitle(title: string): void
  _fireCwd(host: string, path: string): void
  _fireCommandMarker(marker: Parameters<CommandMarkerCallback>[0]): void
  /** Fire an OSC 1337 in-band READY (nocx-ynsx). */
  _fireInBandReady(): void
  _fireBell(): void
  /** Fire a selection event — used by clipboard policy tests. */
  _fireSelectionChange(text: string): void
  /** Fire an OSC 52 write event — used by clipboard policy tests. */
  _fireClipboardWrite(text: string): void
}

/**
 * Creates a single renderer mock with stored callbacks.
 * Used as the implementation of the mocked createRenderer() so each Tab
 * gets its own independent mock.
 */
export function createRendererMock(): RendererMock {
  const cbs: RendererMock['_cbs'] = {}
  const mock: Record<string, unknown> = {
    mount: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn((cb: DataCallback) => {
      cbs.onData = cb
    }),
    onResize: vi.fn((cb: ResizeCallback) => {
      cbs.onResize = cb
    }),
    onTitle: vi.fn((cb: TitleCallback) => {
      cbs.onTitle = cb
    }),
    onCwd: vi.fn((cb: CwdCallback) => {
      cbs.onCwd = cb
    }),
    onCommandMarker: vi.fn((cb: CommandMarkerCallback) => {
      cbs.onCommandMarker = cb
    }),
    onInBandReady: vi.fn((cb: () => void) => {
      cbs.onInBandReady = cb
      return () => {
        cbs.onInBandReady = undefined
      }
    }),
    onBell: vi.fn((cb: () => void) => {
      cbs.onBell = cb
    }),
    onBufferChange: vi.fn((cb: (type: 'normal' | 'alternate') => void) => {
      cbs.onBufferChange = cb
    }),
    onSelectionChange: vi.fn((cb: (text: string) => void) => {
      cbs.onSelectionChange = cb
    }),
    onClipboardWrite: vi.fn((cb: (text: string) => void) => {
      cbs.onClipboardWrite = cb
    }),
    paste: vi.fn(),
    setReadOnly: vi.fn(),
    refreshAtlas: vi.fn(),
    focus: vi.fn(),
    fitViewport: vi.fn(),
    registerMarker: vi.fn().mockReturnValue(undefined),
    cellHeight: 16,
    viewportTopLine: 0,
    onScroll: vi.fn(),
    onRender: vi.fn(),
    paneElement: document.createElement('div'),
    getBufferLine: vi.fn().mockReturnValue(undefined),
    clearViewport: vi.fn(),
    // Zero means "cannot measure", which the caller treats as "keep the current
    // height" — so a fixture that does not care about live-region sizing gets
    // the same behaviour as before this method existed.
    liveContentHeight: vi.fn().mockReturnValue(0),
    cols: 80,
    rows: 24,
    // A REAL store, not a stub: the composition point hands
    // renderer.snapshotStore to the editor and to the scrollback's frozen
    // headers, so a mock without one crashes the CM6 plugin at mount. It is
    // per mock, exactly like the per-renderer instance it stands in for —
    // tests that want a snapshot ingest into this one.
    snapshotStore: new CommandSnapshotStore(),
    _cbs: cbs,
    _fireBufferChange(type: 'normal' | 'alternate') {
      cbs.onBufferChange?.(type)
    },
    _fireTitle(title: string) {
      cbs.onTitle?.(title)
    },
    _fireCwd(host: string, path: string) {
      cbs.onCwd?.({ host, path })
    },
    _fireCommandMarker(marker: Parameters<CommandMarkerCallback>[0]) {
      cbs.onCommandMarker?.(marker)
    },
    _fireInBandReady() {
      cbs.onInBandReady?.()
    },
    _fireBell() {
      cbs.onBell?.()
    },
    _fireSelectionChange(text: string) {
      cbs.onSelectionChange?.(text)
    },
    _fireClipboardWrite(text: string) {
      cbs.onClipboardWrite?.(text)
    },
  }
  return mock as unknown as RendererMock
}

// ═══════════════════════════════════════════════════════════════════════════
// SessionHandle fake
// ═══════════════════════════════════════════════════════════════════════════

let sessionCounter = 0

/** Reset the session-id counter between tests. */
export function resetSessionCounter(): void {
  sessionCounter = 0
}

export interface SessionFake {
  sessionId: string
  cwd: string
  /** The resolved launch policy from the open ack (nocx-4t37.2). */
  shellIntegration: 'auto' | 'ask' | 'off'
  /** Why integration did not happen at open; empty = succeeded/never. */
  shellIntegrationReason: '' | 'unsupported-shell' | 'no-secure-temp' | 'remote-command' | 'unknown'
  send: ReturnType<typeof vi.fn>
  sendResize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  onReset: ReturnType<typeof vi.fn>
  /** Fire the registered data callback. */
  fireData(data: string): void
}

/**
 * Create a fake SessionHandle with sensible defaults.
 *
 * Override any property per-test — the default cwd comes from FIXTURE_CWD
 * so a test that just needs a differently-named directory can pass
 * `{ cwd: '~/other' }` without repeating every other field.
 */
export function makeSession(overrides?: Partial<SessionFake>): SessionFake {
  let dataCb: ((data: string) => void) | null = null
  return {
    sessionId: `mock-sid-${++sessionCounter}`,
    cwd: FIXTURE_CWD,
    shellIntegration: 'auto',
    shellIntegrationReason: '',
    send: vi.fn(),
    sendResize: vi.fn(),
    close: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      dataCb = cb
    }),
    onExit: vi.fn(),
    onReset: vi.fn(),
    fireData: (data: string) => {
      dataCb?.(data)
    },
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WSClient fake
// ═══════════════════════════════════════════════════════════════════════════
export interface ClientFake {
  connect: ReturnType<typeof vi.fn>
  openSession: ReturnType<typeof vi.fn>
  openSSHSession: ReturnType<typeof vi.fn>
  openSSHSessionByHost: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  sendToSession: ReturnType<typeof vi.fn>
  sendResize: ReturnType<typeof vi.fn>
  closeSession: ReturnType<typeof vi.fn>
  onSessionData: ReturnType<typeof vi.fn>
  onSessionExit: ReturnType<typeof vi.fn>
  onSessionReset: ReturnType<typeof vi.fn>
  /** Control-plane calls (history.record, history.query, …). Rejects by
   *  default — the no-store state, which the recall overlay labels
   *  source=session. */
  call: ReturnType<typeof vi.fn>
  readonly connected: boolean
  /** Sessions created by openSession calls, in order. */
  _sessions: SessionFake[]
}
/**
 * Create a fake WSClient whose openSession() returns a new makeSession()
 * on every call and records it in _sessions for test inspection.
 */
export function makeClient(overrides?: Partial<ClientFake>): ClientFake {
  const sessions: SessionFake[] = []
  const newSession = (): SessionFake => {
    const s = makeSession()
    sessions.push(s)
    return s
  }
  const client: ClientFake = {
    connect: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn(() => Promise.resolve(newSession())),
    openSSHSession: vi.fn(() => Promise.resolve(newSession())),
    openSSHSessionByHost: vi.fn(() => Promise.resolve(newSession())),
    close: vi.fn(),
    sendToSession: vi.fn(),
    sendResize: vi.fn(),
    closeSession: vi.fn(),
    onSessionData: vi.fn(),
    onSessionExit: vi.fn(),
    onSessionReset: vi.fn(),
    call: vi.fn().mockRejectedValue(new Error('no store wired (fake)')),
    get connected() {
      return true
    },
    _sessions: sessions,
    ...overrides,
  }
  return client
}

// ═══════════════════════════════════════════════════════════════════════════
// Clipboard fake — injectable into TabManager for policy-layer tests.
// ═══════════════════════════════════════════════════════════════════════════

export interface ClipboardFake extends ClipboardAccess {
  readText: ReturnType<typeof vi.fn>
  writeText: ReturnType<typeof vi.fn>
}

/**
 * Create a fake clipboard whose readText / writeText are vitest spies.
 * Used by clipboard policy tests in tabs.test.ts.
 */
export function makeClipboard(overrides?: Partial<ClipboardFake>): ClipboardFake {
  return {
    readText: vi.fn().mockResolvedValue(''),
    writeText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Banner fake — injectable into TabManager for gate-layer tests.
// ═══════════════════════════════════════════════════════════════════════════

export interface BannerFake extends ClipboardBanner {
  shown: boolean
  show: ReturnType<typeof vi.fn>
}

/**
 * Create a fake banner whose show() returns a controllable promise.
 * Override shown / show per-test to drive the gate policy.
 */
export function makeBanner(overrides?: Partial<BannerFake>): BannerFake {
  return {
    shown: false,
    show: vi.fn().mockResolvedValue('dismiss' as const),
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM setup helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Create the bare bar + panes container elements and append them to body. */
export function setupTabBarDOM(): { bar: HTMLElement; panes: HTMLElement } {
  document.body.innerHTML = ''
  const bar = document.createElement('div')
  const panes = document.createElement('div')
  document.body.append(bar, panes)
  return { bar, panes }
}

/**
 * Full setup: create DOM, construct TabManager, and open the initial tab.
 * Callers must await; the returned manager has one terminal tab active.
 */
export async function mountTabManager(
  client?: ClientFake,
  clipboard?: ClipboardFake,
  gate?: ClipboardGate,
  banner?: BannerFake,
): Promise<{
  bar: HTMLElement
  panes: HTMLElement
  manager: TabManager
  client: ClientFake
  clipboard: ClipboardFake
  gate: ClipboardGate
  banner: BannerFake
  tabStrip: import('../tab-strip').TabStrip
}> {
  const { bar, panes } = setupTabBarDOM()
  const c = client ?? makeClient()
  const cb = clipboard ?? makeClipboard()
  const g = gate ?? new (await import('../clipboard')).ClipboardGate()
  const bn = banner ?? makeBanner()
  const pc = {
    listProfiles: vi.fn().mockResolvedValue([]),
    listGroups: vi.fn().mockResolvedValue([]),
  }
  const { TabManager } = await import('../tabs')
  const { HorizontalTabStrip } = await import('../tab-strip')
  const tabStrip = new HorizontalTabStrip()
  const manager = new TabManager(
    bar,
    bar,
    panes,
    c as unknown as import('../ipc').WSClient,
    cb,
    g,
    bn,
    pc as unknown as import('../profiles').ProfileClient,
    tabStrip,
  )
  // Open the initial tab explicitly — the constructor mounts nothing.
  await manager.openInitialTab()
  return { bar, panes, manager, client: c, clipboard: cb, gate: g, banner: bn, tabStrip }
}
