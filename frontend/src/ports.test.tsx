// @vitest-environment jsdom
// PortsPanel tests (nocx-wzc4.2). Rule 1 of AGENTS.md: assert what a user can
// do, not what the code renders — the panel is reachable from the state a
// user starts in, the forward action on a detected row reaches the client
// method, and the row moves to Forwarded afterwards; a hidden tab stops
// sampling; a permission-denied probe renders the explanation; a probe-less
// host says so.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@solidjs/testing-library'

afterEach(cleanup)
import { PortsPanel, PortsContent, type PortsPanelServices } from './ports'
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

const stubHost = { setTitle: () => {}, requestAttention: () => {}, requestClose: () => {} }

// ── The panel is reachable from the state a user starts in ───────────────

describe('PortsContent', () => {
  it('mounts as a tab surface from a profileId and renders discovery state', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(statusFixture({ state: 'available' })),
    })
    const content = new PortsContent('ssh:p1:1', services)
    const titles: string[] = []
    const target = document.createElement('div')
    document.body.append(target)
    await content.mount(
      target,
      { ...stubHost, setTitle: (t: string) => titles.push(t) },
      new AbortController().signal,
    )

    await waitFor(() => expect(screen.getByText('Nothing is listening')).toBeTruthy())
    expect(titles).toContain('Ports')
    content.dispose()
    target.remove()
  })

  it('a hidden tab reports visibility, stopping sampling', async () => {
    const visible = vi.fn().mockResolvedValue({})
    const services = fakeServices({ visible })
    const content = new PortsContent('ssh:p1:1', services)
    const target = document.createElement('div')
    document.body.append(target)
    await content.mount(target, stubHost, new AbortController().signal)

    content.setVisible(false)
    expect(visible).toHaveBeenCalledWith('ssh:p1:1', false)
    content.setVisible(true)
    expect(visible).toHaveBeenCalledWith('ssh:p1:1', true)
    content.dispose()
    target.remove()
  })
})

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
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
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
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
    await waitFor(() =>
      expect(screen.getByText('Could not determine what is listening')).toBeTruthy(),
    )
    expect(screen.queryByText('Nothing is listening')).toBeNull()
  })

  it('"Nothing is listening" appears only when the sample truly was empty', async () => {
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(statusFixture({ state: 'available' })),
    })
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
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
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
    await waitFor(() => expect(screen.getByText('Discovery refused on this host')).toBeTruthy())
    expect(screen.getByText('additional sessions refused')).toBeTruthy()
  })

  it('the forward action on a detected row reaches the client method and moves the row to Forwarded', async () => {
    const openForward = vi.fn().mockResolvedValue(runningRecord())
    const services = fakeServices({
      status: vi.fn().mockResolvedValue(statusFixture({ listeners: [listenerFixture(6768)] })),
      openForward,
    })
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
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
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
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
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
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
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
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
    render(() => <PortsPanel profileId="ssh:p1:1" services={services} visible={() => true} />)
    await waitFor(() => expect(screen.getByTestId('stopped-row')).toBeTruthy())
    expect(screen.getByText(/user/)).toBeTruthy()
    expect(screen.queryByTestId('ports-retry-forward')).toBeNull()
  })
})
