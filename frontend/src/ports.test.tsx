// @vitest-environment jsdom
// PortsPanel tests (nocx-wzc4.2, nocx-wzc4.9). Rule 1 of AGENTS.md: assert
// what a user can do, not what the code renders — the panel is reachable
// from the state a user starts in, the forward action on a detected row
// reaches the client method, and the row moves to Forwarded afterwards; a
// hidden tab stops sampling; a permission-denied probe renders the
// explanation; a probe-less host says so. Loading (nocx-wzc4.9): the view
// shows it is loading before the first sample lands, a refresh never blanks
// a populated list, a failure state offers exactly one Retry, and the body
// carries no second vocabulary for Pause or Retry.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'

afterEach(cleanup)
import {
  PortsPanel,
  POLL_INTERVAL_MS,
  createPortsPauseControl,
  type PortsPanelProps,
  type PortsPanelServices,
} from './ports'
import type { PortsStatusResult } from './generated/ports.status'
import type { TunnelOpenResult } from './generated/tunnel.open'
import { LOCAL_TARGET_ID } from './ports-client'

// ── Fixtures ──────────────────────────────────────────────────────────────

const discoveryFixture = (
  over: Partial<PortsStatusResult['discovery']> = {},
): PortsStatusResult['discovery'] => ({
  state: 'available',
  listeners: [],
  probe: 'ss',
  probesTried: ['ss'],
  classification: '',
  stderr: '',
  lastSampleAt: null,
  paused: false,
  visible: true,
  connLost: false,
  ...over,
})

const statusFixture = (
  over: Partial<PortsStatusResult['discovery']> = {},
  extra: Partial<PortsStatusResult> = {},
): PortsStatusResult => ({
  profileId: 'ssh:p1:1',
  host: 'host.example',
  discovery: discoveryFixture(over),
  forwards: [],
  ...extra,
})

const listenerFixture = (
  port: number,
  evidence: 'known' | 'permission-denied' | 'unsupported' = 'known',
) => ({
  family: 'ipv4' as const,
  address: '0.0.0.0',
  port,
  process:
    evidence === 'known' ? { evidence, name: 'node', pid: 123 } : { evidence, name: '', pid: 0 },
})

const runningRecord = (over: Partial<TunnelOpenResult> = {}): TunnelOpenResult => ({
  id: 'fwd-1',
  direction: 'local',
  requestedBind: { host: '127.0.0.1', port: 6768 },
  actualBind: { host: '127.0.0.1', port: 6768 },
  destination: 'host.example:6768',
  caveat: '',
  scope: 'ports:ssh:p1:1',
  state: 'running',
  stopReason: null,
  error: null,
  ...over,
})

function fakeServices(over: Partial<PortsPanelServices> = {}): PortsPanelServices {
  return {
    status: vi.fn().mockResolvedValue(statusFixture()),
    sample: vi.fn().mockResolvedValue(statusFixture()),
    pause: vi.fn().mockResolvedValue({}),
    visible: vi.fn().mockResolvedValue({}),
    openForward: vi.fn().mockResolvedValue(runningRecord()),
    stopForward: vi
      .fn()
      .mockResolvedValue({ ...runningRecord(), state: 'stopped', stopReason: 'user', error: null }),
    ...over,
  }
}

/** The panel plus its shared Pause control — the seam the header action and
 *  the panel share in main.tsx (nocx-wzc4.9). */
function renderPanel(services: PortsPanelServices, over: Partial<PortsPanelProps> = {}) {
  // The control is created ONCE, outside the JSX. Solid wraps every prop
  // expression in a getter, so `pause={createPortsPauseControl()}` builds a
  // fresh control on every read — `sync` would write one instance while the
  // view read another, and the panel could never show a pause it did not
  // itself initiate (nocx-wzc4.10).
  const pause = createPortsPauseControl()
  return render(() => (
    <PortsPanel
      profileId={() => 'ssh:p1:1'}
      services={services}
      visible={() => true}
      pause={pause}
      {...over}
    />
  ))
}

// ── Detected → Forwarded in one action ───────────────────────────────────
describe('PortsPanel — detected rows', () => {
  it('explains hidden owners once above the rows, not on every row', async () => {
    const services = fakeServices({
      status: vi
        .fn()
        .mockResolvedValue(
          statusFixture({ listeners: [listenerFixture(22, 'permission-denied')] }),
        ),
    })
    renderPanel(services)
    // The privilege is the probe's, not the row's — one statement above the
    // list, never a banner repeated down a 240px rail (nocx-wzc4.11).
    await waitFor(() => expect(screen.getByTestId('ports-owners-note')).toBeTruthy())
    expect(screen.getByTestId('ports-owners-note').textContent).toMatch(/run as root/)
    expect(screen.getByText('0.0.0.0:22')).toBeTruthy()
    expect(screen.queryAllByText(/run as root/)).toHaveLength(1)
  })

  it('a probe-less host says so — and never claims "nothing is listening"', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture({
          state: 'unavailable',
          classification: 'no probe tool usable on this host',
        }),
      ),
    })
    renderPanel(services)
    await waitFor(() =>
      expect(screen.getByText('Could not determine what is listening')).toBeTruthy(),
    )
    expect(screen.queryByText('Nothing is listening')).toBeNull()
  })

  it('"Nothing is listening" appears only when the sample truly was empty', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(statusFixture({ state: 'available' })),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByText('Nothing is listening')).toBeTruthy())
  })

  it('a refused host renders the refusal and offers Retry', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture({
          state: 'permission-or-policy-refused',
          classification: 'additional sessions refused',
        }),
      ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByText('Discovery refused on this host')).toBeTruthy())
    expect(screen.getByText('additional sessions refused')).toBeTruthy()
  })

  it('the forward action on a detected row reaches the client method and moves the row to Forwarded', async () => {
    const openForward = vi.fn().mockResolvedValue(runningRecord())
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(statusFixture({ listeners: [listenerFixture(6768)] })),
      openForward,
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByText('0.0.0.0:6768')).toBeTruthy())

    fireEvent.click(screen.getByTestId('ports-forward'))

    // The row's one action: the destination dials the REMOTE host for a
    // wildcard bind, with the same numeric port.
    await waitFor(() =>
      expect(openForward).toHaveBeenCalledWith('ssh:p1:1', 'host.example:6768', 6768),
    )
    // The row moves to Forwarded, showing the usable local address.
    await waitFor(() => expect(screen.getByTestId('forwarded-row')).toBeTruthy())
    expect(screen.getByText(/127.0.0.1:6768/)).toBeTruthy()
  })

  it('a busy local port falls back to an allocated loopback port', async () => {
    const openForward = vi
      .fn()
      .mockRejectedValueOnce(new Error('listen tcp 127.0.0.1:6768: bind: address already in use'))
      .mockResolvedValueOnce(
        runningRecord({
          requestedBind: { host: '127.0.0.1', port: 0 },
          actualBind: { host: '127.0.0.1', port: 43210 },
        }),
      )
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(statusFixture({ listeners: [listenerFixture(6768)] })),
      openForward,
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByText('0.0.0.0:6768')).toBeTruthy())

    fireEvent.click(screen.getByTestId('ports-forward'))

    await waitFor(() =>
      expect(openForward).toHaveBeenCalledWith('ssh:p1:1', 'host.example:6768', 6768),
    )
    await waitFor(() =>
      expect(openForward).toHaveBeenCalledWith('ssh:p1:1', 'host.example:6768', 0),
    )
    await waitFor(() => expect(screen.getByTestId('forwarded-row')).toBeTruthy())
    expect(screen.getByText(/127.0.0.1:43210/)).toBeTruthy()
  })
})

// ── Loading and refresh (nocx-wzc4.9) ────────────────────────────────────

describe('PortsPanel — loading and refresh (nocx-wzc4.9)', () => {
  it('shows it is loading before the first sample lands', async () => {
    let resolve!: (st: PortsStatusResult) => void
    const services = fakeServices({
      status: vi.fn(
        () =>
          new Promise<PortsStatusResult>((res) => {
            resolve = res
          }),
      ),
    })
    renderPanel(services)

    // First open, no data yet: the panel says it is working, not blank.
    expect(screen.getByTestId('ports-loading')).toBeTruthy()

    resolve(statusFixture({ state: 'available', listeners: [listenerFixture(22)] }))
    await waitFor(() => expect(screen.getByText('0.0.0.0:22')).toBeTruthy())
    expect(screen.queryByTestId('ports-loading')).toBeNull()
  })

  it('a refresh never blanks a populated list', async () => {
    vi.useFakeTimers()
    try {
      let resolveSecond!: (st: PortsStatusResult) => void
      const status = vi
        .fn()
        .mockResolvedValueOnce(
          statusFixture({ state: 'available', listeners: [listenerFixture(22)] }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<PortsStatusResult>((res) => {
              resolveSecond = res
            }),
        )
      const services = fakeServices({ status })
      renderPanel(services)
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText('0.0.0.0:22')).toBeTruthy()

      // One poll interval later a refresh is in flight but unanswered — the
      // populated list must not blank to a spinner; it is what the user is
      // watching.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      expect(screen.getByText('0.0.0.0:22')).toBeTruthy()
      expect(screen.queryByTestId('ports-loading')).toBeNull()

      // The late answer swaps the row in place.
      resolveSecond(statusFixture({ state: 'available', listeners: [listenerFixture(8080)] }))
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText('0.0.0.0:8080')).toBeTruthy()
      expect(screen.queryByText('0.0.0.0:22')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a backend-reported pause stops the status poll (nocx-wzc4.11)', async () => {
    // The header action is Refresh now, so nothing in the renderer flips this;
    // the control only REFLECTS a pause the backend reports, and the poll must
    // still honour it.
    vi.useFakeTimers()
    try {
      const status = vi.fn().mockResolvedValue(statusFixture({ state: 'available', paused: true }))
      const services = fakeServices({ status })
      renderPanel(services)
      await vi.advanceTimersByTimeAsync(0)
      const callsAfterFirst = status.mock.calls.length
      expect(callsAfterFirst).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
      expect(status.mock.calls.length).toBe(callsAfterFirst)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failure state offers exactly one Retry, and the body offers no toolbar copy', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture({
          state: 'permission-or-policy-refused',
          classification: 'additional sessions refused',
        }),
      ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByText('Discovery refused on this host')).toBeTruthy())

    // Retry exists exactly where it belongs: inside the failure state. The
    // toolbar copy (ports-retry) and the body Pause button are gone.
    expect(screen.getAllByText('Retry')).toHaveLength(1)
    expect(screen.queryByTestId('ports-retry')).toBeNull()
    expect(screen.queryByTestId('ports-pause')).toBeNull()
  })

  it('shows no sample age at all, and says "paused" only while paused (nocx-wzc4.10)', async () => {
    // The timestamp told the user nothing they could act on: the list
    // refreshes itself, and a failed sample shows the failure instead of
    // stale rows, so the rows on screen are never older than they look.
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture({
          state: 'available',
          listeners: [listenerFixture(6768)],
          lastSampleAt: '2026-08-04T12:00:00Z',
        }),
      ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByTestId('detected-row')).toBeTruthy())
    expect(screen.queryByTestId('ports-meta')).toBeNull()
    expect(document.body.textContent).not.toContain('last sample')
  })

  it('names the one state where the rows stop tracking the host', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture({
          state: 'available',
          paused: true,
          listeners: [listenerFixture(6768)],
          lastSampleAt: '2026-08-04T12:00:00Z',
        }),
      ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByTestId('ports-meta')).toBeTruthy())
    const meta = screen.getByTestId('ports-meta')
    expect(meta.textContent).toContain('paused')
    expect(meta.textContent).not.toContain('last sample')
    expect(meta.querySelector('.ui-badge')).toBeNull()
  })
})

// ── Forwarded / Stopped lifecycle ─────────────────────────────────────────

describe('PortsPanel — forwards', () => {
  it('stopping a forwarded row moves it to Stopped with its reason', async () => {
    const stopForward = vi.fn().mockResolvedValue({
      ...runningRecord(),
      state: 'stopped',
      stopReason: 'user',
      error: null,
    })
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(statusFixture({ listeners: [listenerFixture(6768)] })),
      openForward: vi.fn().mockResolvedValue(runningRecord()),
      stopForward,
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByText('0.0.0.0:6768')).toBeTruthy())
    fireEvent.click(screen.getByTestId('ports-forward'))
    await waitFor(() => expect(screen.getByTestId('forwarded-row')).toBeTruthy())

    fireEvent.click(screen.getByTestId('ports-stop'))
    await waitFor(() => expect(stopForward).toHaveBeenCalledWith('fwd-1'))
    await waitFor(() => expect(screen.getByTestId('stopped-row')).toBeTruthy())
  })

  it('a connection-lost forward renders in Stopped with the reason and a Retry', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture(
          {},
          {
            forwards: [
              {
                ...runningRecord({ id: 'fwd-lost', destination: 'host.example:5432' }),
                state: 'stopped' as const,
                stopReason: 'connection lost' as const,
                error: 'connection closed',
              },
            ],
          },
        ),
      ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByTestId('stopped-row')).toBeTruthy())
    expect(screen.getByText(/connection lost/)).toBeTruthy()
    expect(screen.getByText('connection closed')).toBeTruthy()
    expect(screen.getByTestId('ports-retry-forward')).toBeTruthy()
  })

  it('a user stop offers no retry — the reason is the message', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture(
          {},
          {
            forwards: [
              {
                ...runningRecord({ id: 'fwd-user', destination: 'host.example:5432' }),
                state: 'stopped' as const,
                stopReason: 'user' as const,
                error: null,
              },
            ],
          },
        ),
      ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByTestId('stopped-row')).toBeTruthy())
    expect(screen.getByText(/user/)).toBeTruthy()
    expect(screen.queryByTestId('ports-retry-forward')).toBeNull()
  })

  it('a -R forward whose bind sshd replaced shows the caveat as a caution, never as "failed"', async () => {
    const caveat =
      'bind address 0.0.0.0 requested but not verified: the server may have bound a different address (GatewayPorts), so a URL built from this forward may only work on the server'
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(
        statusFixture(
          {},
          {
            forwards: [
              {
                ...runningRecord({
                  id: 'fwd-remote',
                  direction: 'remote',
                  destination: 'host.example:5901',
                }),
                caveat,
              },
            ],
          },
        ),
      ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByTestId('forwarded-row')).toBeTruthy())

    // The caveat is the backend's Caveat() verbatim: the bind was requested and
    // is not verified — a caution, never an error. Nothing failed; the forward
    // is running.
    const note = screen.getByText(/requested but not verified/)
    expect(note.textContent).toContain('not verified')
    expect(note.textContent).not.toMatch(/failed/i)
    expect(note.closest('.ui-marker-list__item')?.getAttribute('data-tone')).toBe('note')
  })

  it('a clean bind renders no caveat chrome', async () => {
    const { container } = renderPanel(
      fakeServices({
        status: vi
          .fn()
          .mockResolvedValue(statusFixture({}, { forwards: [runningRecord({ id: 'fwd-clean' })] })),
      }),
    )
    await waitFor(() => expect(screen.getByTestId('forwarded-row')).toBeTruthy())
    expect(screen.queryByText(/not verified/)).toBeNull()
    expect(container.querySelector('.ui-marker-list')).toBeNull()
  })
})

// ── The panel follows the ACTIVE tab (nocx-wzc4.7) ───────────────────────

describe('PortsPanel — active-tab scope', () => {
  it('a tab with no ports scope (Settings, alias) shows the no-connection state, never a stale host', async () => {
    const status = vi
      .fn()
      .mockResolvedValue(statusFixture({ state: 'available', listeners: [listenerFixture(22)] }))
    const services = fakeServices({ status })
    const [pid, setPid] = createSignal<string | null>('ssh:p1:1')
    renderPanel(services, { profileId: pid })
    await waitFor(() => expect(screen.getByText('0.0.0.0:22')).toBeTruthy())

    setPid(null)
    await waitFor(() => expect(screen.getByText('No active connection')).toBeTruthy())
    expect(screen.queryByText('0.0.0.0:22')).toBeNull()
    // No further backend calls while unscoped — nothing to sample for.
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('switching profile discards the previous connection and re-scopes', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce(
        statusFixture({ state: 'available', listeners: [listenerFixture(22)] }),
      )
      .mockResolvedValue(statusFixture({ state: 'available' }))
    const services = fakeServices({ status })
    const [pid, setPid] = createSignal<string | null>('ssh:p1:1')
    renderPanel(services, { profileId: pid })
    await waitFor(() => expect(screen.getByText('0.0.0.0:22')).toBeTruthy())

    setPid('ssh:p2:2')
    await waitFor(() => expect(status).toHaveBeenCalledWith('ssh:p2:2'))
    // The first profile's listeners are gone; the second profile says nothing
    // is listening — the panel never shows one host under another's scope.
    await waitFor(() => expect(screen.getByText('Nothing is listening')).toBeTruthy())
    expect(screen.queryByText('0.0.0.0:22')).toBeNull()
  })

  it('a late response for a previous profile never paints over the new scope', async () => {
    let resolveP1!: (st: PortsStatusResult) => void
    const status = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PortsStatusResult>((resolve) => {
            resolveP1 = resolve
          }),
      )
      .mockResolvedValue(statusFixture({ state: 'available' }))
    const services = fakeServices({ status })
    const [pid, setPid] = createSignal<string | null>('ssh:p1:1')
    renderPanel(services, { profileId: pid })

    setPid('ssh:p2:2')
    await waitFor(() => expect(status).toHaveBeenCalledWith('ssh:p2:2'))
    // The in-flight p1 request resolves late — with a listener row it must
    // never show under the p2 scope.
    resolveP1(statusFixture({ state: 'available', listeners: [listenerFixture(22)] }))
    await waitFor(() => expect(screen.getByText('Nothing is listening')).toBeTruthy())
    expect(screen.queryByText('0.0.0.0:22')).toBeNull()
  })

  it('reports visibility to the backend, retiring the previous profile on re-scope', async () => {
    const visible = vi.fn().mockResolvedValue({})
    const services = fakeServices({ visible })
    const [pid, setPid] = createSignal<string | null>('ssh:p1:1')
    const [vis, setVis] = createSignal(true)
    renderPanel(services, { profileId: pid, visible: vis })

    await waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p1:1', true))
    setVis(false)
    await waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p1:1', false))

    // Re-scope retires the previous profile's flag, then arms the new one
    // with the CURRENT visibility (false here).
    setPid('ssh:p2:2')
    await waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p1:1', false))
    await waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p2:2', false))
    setVis(true)
    await waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p2:2', true))
  })

  it('a hidden view stops the status poll; re-showing resumes it', async () => {
    vi.useFakeTimers()
    try {
      const status = vi.fn().mockResolvedValue(statusFixture({ state: 'available' }))
      const services = fakeServices({ status })
      const [vis, setVis] = createSignal(true)
      renderPanel(services, { visible: vis })
      await vi.advanceTimersByTimeAsync(0)

      setVis(false)
      await vi.advanceTimersByTimeAsync(0)
      const callsAfterHide = status.mock.calls.length

      // Two poll intervals elapse in the dark — no further status calls.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
      expect(status.mock.calls.length).toBe(callsAfterHide)

      setVis(true)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1)
      expect(status.mock.calls.length).toBeGreaterThan(callsAfterHide)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── The local machine (nocx-wzc4.8) ─────────────────────────────────────

describe('PortsPanel — the local machine (nocx-wzc4.8)', () => {
  it("a local tab scopes ports.* to the reserved 'local' target and shows this machine's listeners", async () => {
    const status = vi
      .fn()
      .mockResolvedValue(
        statusFixture(
          { state: 'available', listeners: [listenerFixture(22)] },
          { profileId: LOCAL_TARGET_ID, host: 'my-machine' },
        ),
      )
    const openForward = vi.fn()
    const services = fakeServices({ status, openForward })
    renderPanel(services, { profileId: () => LOCAL_TARGET_ID })

    await waitFor(() => expect(status).toHaveBeenCalledWith(LOCAL_TARGET_ID))
    await waitFor(() => expect(screen.getByText('0.0.0.0:22')).toBeTruthy())
    // The row offers copy-address; Forward is not offered on this machine.
    expect(screen.queryByTestId('ports-forward')).toBeNull()
    expect(screen.getByTestId('ports-copy')).toBeTruthy()
    // No forwarding vocabulary at all on a local scope — the sections would
    // be an empty offer of an impossible action.
    expect(screen.queryByText('Forwarded')).toBeNull()
    expect(screen.queryByText('No active forwards')).toBeNull()
  })

  it('a local row copies the address and never dials tunnel.open', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const origClipboard = globalThis.navigator.clipboard
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    try {
      const openForward = vi.fn()
      const services = fakeServices({
        status: vi
          .fn()
          .mockResolvedValue(
            statusFixture(
              { state: 'available', listeners: [listenerFixture(22)] },
              { profileId: LOCAL_TARGET_ID, host: 'my-machine' },
            ),
          ),
        openForward,
      })
      renderPanel(services, { profileId: () => LOCAL_TARGET_ID })
      await waitFor(() => expect(screen.getByText('0.0.0.0:22')).toBeTruthy())

      fireEvent.click(screen.getByTestId('ports-copy'))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('my-machine:22'))
      expect(openForward).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: origClipboard,
        configurable: true,
      })
    }
  })

  it('permission-denied evidence renders on a local row exactly as on a remote host', async () => {
    const services = fakeServices({
      status: vi
        .fn()
        .mockResolvedValue(
          statusFixture(
            { state: 'available', listeners: [listenerFixture(22, 'permission-denied')] },
            { profileId: LOCAL_TARGET_ID, host: 'my-machine' },
          ),
        ),
    })
    renderPanel(services, { profileId: () => LOCAL_TARGET_ID })

    // The same explanation as a remote host: a fact about privilege, not an
    // error on the user's own machine.
    await waitFor(() => expect(screen.getByTestId('ports-owners-note')).toBeTruthy())
    expect(screen.getByTestId('ports-owners-note').textContent).toMatch(/run as root/)
    expect(screen.getByText('0.0.0.0:22')).toBeTruthy()
  })

  it("a local tab pending before the first sample never says 'no connection'", async () => {
    const services = fakeServices({
      status: vi
        .fn()
        .mockResolvedValue(
          statusFixture({ state: 'pending' }, { profileId: LOCAL_TARGET_ID, host: '' }),
        ),
    })
    renderPanel(services, { profileId: () => LOCAL_TARGET_ID })

    // Connected-and-waiting is loading, not an empty state: the settle delay
    // plus a round trip is exactly the window a spinner is for (nocx-wzc4.11).
    await waitFor(() => expect(screen.getByTestId('ports-loading')).toBeTruthy())
    expect(screen.queryByText('No active connection')).toBeNull()
  })
})
