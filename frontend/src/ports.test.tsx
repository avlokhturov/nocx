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
  return render(() => (
    <PortsPanel
      profileId={() => 'ssh:p1:1'}
      services={services}
      visible={() => true}
      pause={createPortsPauseControl(services, () => 'ssh:p1:1')}
      {...over}
    />
  ))
}

// ── Detected → Forwarded in one action ───────────────────────────────────
describe('PortsPanel — detected rows', () => {
  it('renders a permission-denied probe as an explanation, not a blank', async () => {
    const services = fakeServices({
      status: vi
        .fn()
        .mockResolvedValue(
          statusFixture({ listeners: [listenerFixture(22, 'permission-denied')] }),
        ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByText(/run as root to see owners/)).toBeTruthy())
    expect(screen.getByText('0.0.0.0:22')).toBeTruthy()
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

  it('pausing stops the status poll; resuming restarts it', async () => {
    vi.useFakeTimers()
    try {
      const status = vi.fn().mockResolvedValue(statusFixture({ state: 'available' }))
      const pauseSpy = vi.fn().mockResolvedValue({})
      const services = fakeServices({ status, pause: pauseSpy })
      const pause = createPortsPauseControl(services, () => 'ssh:p1:1')
      renderPanel(services, { pause })
      await vi.advanceTimersByTimeAsync(0)
      expect(status).toHaveBeenCalled()

      pause.toggle() // exactly what the header action calls
      await vi.advanceTimersByTimeAsync(0)
      expect(pauseSpy).toHaveBeenCalledWith('ssh:p1:1', true)

      // Two poll intervals in the dark — no further status calls while
      // paused: pausing stops sampling, end to end.
      const callsAfterPause = status.mock.calls.length
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
      expect(status.mock.calls.length).toBe(callsAfterPause)

      pause.toggle() // resume
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1)
      expect(status.mock.calls.length).toBeGreaterThan(callsAfterPause)
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

  it('the sample age is micro-text, never a chip, and pause rides beside it', async () => {
    const services = fakeServices({
      status: vi
        .fn()
        .mockResolvedValue(
          statusFixture({ state: 'available', lastSampleAt: '2026-08-04T12:00:00Z' }),
        ),
    })
    renderPanel(services)
    await waitFor(() => expect(screen.getByTestId('ports-meta')).toBeTruthy())
    const meta = screen.getByTestId('ports-meta')
    expect(meta.textContent).toContain('last sample')
    expect(meta.classList.contains('ui-badge')).toBe(false)
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
  it('a local tab (null profile) shows the no-connection state, never a stale host', async () => {
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
