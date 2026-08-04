// @vitest-environment jsdom
// The ports panel is REACHABLE from the state a user starts in (AGENTS.md
// rule 1): an SSH tab is open, and either the palette's "Ports" item or the
// Ctrl/Cmd+Shift+O chord puts a 'nocx.ports' tab on screen, scoped to the
// active tab's saved profile. A test that merely mounts PortsContent would
// prove nothing about reachability — these start from a real TabManager.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@solidjs/testing-library'
import {
  createRendererMock,
  makeClient,
  makeSession,
  mountTabManager,
  type ClientFake,
} from './test-support/tabs-fixtures'
import { ActionsQuickConnectProvider } from './quick-connect'
import { PortsContent, type PortsPanelServices } from './ports'
import {
  PORTS_KEYBINDING,
  PORTS_SURFACE_TYPE,
  registerPortsKeybinding,
  registerPortsSurface,
} from './ports-surface'
import type { PortsStatusResult } from './generated/ports.status'
import type { TunnelOpenResult } from './generated/tunnel.open'
import { SurfaceRegistry } from './surface-registry'
import type { Tab } from './tabs'

vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

afterEach(() => {
  cleanup()
})

// ── Fixtures ──────────────────────────────────────────────────────────────

const statusFixture = (profileId: string): PortsStatusResult => ({
  profileId,
  host: 'host.example',
  discovery: {
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
  },
  forwards: [],
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
    status: vi.fn().mockResolvedValue(statusFixture('ssh:p1:1')),
    sample: vi.fn().mockResolvedValue(statusFixture('ssh:p1:1')),
    pause: vi.fn().mockResolvedValue({}),
    visible: vi.fn().mockResolvedValue({}),
    openForward: vi.fn().mockResolvedValue(runningRecord()),
    stopForward: vi
      .fn()
      .mockResolvedValue({ ...runningRecord(), state: 'stopped', stopReason: 'user', error: null }),
    ...over,
  }
}

/** Mount a real TabManager and put a saved-profile SSH tab in front. */
async function mountWithSSHTab(profileId: string) {
  const client = makeClient({
    openSSHSession: vi.fn(() => Promise.resolve(makeSession())),
    openSSHSessionByHost: vi.fn(() => Promise.resolve(makeSession())),
  } as unknown as Partial<ClientFake>)
  const mounted = await mountTabManager(client)
  mounted.manager.newSSHTab(profileId, 'host.example', 'alice')
  return mounted
}

function dispatchChord(): KeyboardEvent {
  // Shift is held, so a real browser reports the UPPERCASE letter.
  const e = new KeyboardEvent('keydown', {
    key: PORTS_KEYBINDING.key.toUpperCase(),
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(e)
  return e
}

describe('ports surface — reachable from an SSH tab', () => {
  it('the palette "Ports" item opens a ports tab scoped to the active profile', async () => {
    const { manager } = await mountWithSSHTab('ssh:p1:1')
    const status = vi.fn().mockResolvedValue(statusFixture('ssh:p1:1'))
    const services = fakeServices({ status })
    const openPorts = registerPortsSurface(new SurfaceRegistry(), services, manager)
    const provider = new ActionsQuickConnectProvider(vi.fn(), vi.fn(), vi.fn(), openPorts)
    const items = await Promise.resolve(provider.getItems())

    items.find((i) => i.id === '__ports__')!.run()

    // The panel is on screen AND scoped: the real PortsContent mounted and
    // asked the backend for THIS connection's ports.
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('ssh:p1:1'))
  })

  it('the Ctrl/Cmd+Shift+O chord opens a ports tab scoped to the active profile', async () => {
    const { manager } = await mountWithSSHTab('ssh:p1:1')
    const status = vi.fn().mockResolvedValue(statusFixture('ssh:p1:1'))
    const services = fakeServices({ status })
    const openPorts = registerPortsSurface(new SurfaceRegistry(), services, manager)
    const dispose = registerPortsKeybinding(openPorts)

    const e = dispatchChord()

    expect(e.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('ssh:p1:1'))
    dispose()
  })

  it('openPorts returns a tab whose descriptor and content are the ports surface', async () => {
    const { manager } = await mountWithSSHTab('ssh:p1:1')
    const services = fakeServices()
    const openPorts = registerPortsSurface(new SurfaceRegistry(), services, manager)

    const tab = openPorts()
    expect(tab).not.toBeNull()
    const opened = tab as Tab
    expect(opened.descriptor.surfaceType).toBe(PORTS_SURFACE_TYPE)
    expect(opened.descriptor.singletonKey).toBeNull()
    expect(opened.descriptor.defaultTitle).toBe('Ports')
    expect(opened.content).toBeInstanceOf(PortsContent)
    // The profileId the content was constructed with is the active tab's.
    // (Read through a structural cast: the field is private, and an
    // intersection with PortsContent collapses to never.)
    expect((opened.content as unknown as { profileId: string }).profileId).toBe('ssh:p1:1')
  })

  it('the chord leaves the event alone when no saved-profile SSH tab is active', async () => {
    const { manager } = await mountTabManager() // local terminal tab only
    const status = vi.fn().mockResolvedValue(statusFixture('ssh:p1:1'))
    const services = fakeServices({ status })
    const openPorts = registerPortsSurface(new SurfaceRegistry(), services, manager)
    const dispose = registerPortsKeybinding(openPorts)

    const e = dispatchChord()

    expect(e.defaultPrevented).toBe(false)
    expect(manager.tabCount).toBe(1)
    expect(status).not.toHaveBeenCalled()
    dispose()
  })

  it('the palette item no-ops on a local tab — there is no profile to scope to', async () => {
    const { manager } = await mountTabManager()
    const status = vi.fn().mockResolvedValue(statusFixture('ssh:p1:1'))
    const services = fakeServices({ status })
    const openPorts = registerPortsSurface(new SurfaceRegistry(), services, manager)
    const provider = new ActionsQuickConnectProvider(vi.fn(), vi.fn(), vi.fn(), openPorts)
    const items = await Promise.resolve(provider.getItems())

    items.find((i) => i.id === '__ports__')!.run()

    expect(manager.tabCount).toBe(1)
    expect(status).not.toHaveBeenCalled()
  })

  it('the active-profile seam refuses an alias tab — an alias has no profile yet', async () => {
    const { manager } = await mountTabManager(
      makeClient({
        openSSHSessionByHost: vi.fn(() => Promise.resolve(makeSession())),
      } as unknown as Partial<ClientFake>),
    )
    manager.newSSHTab('', 'alias-host', 'bob') // alias: empty profileId

    expect(manager.activeProfileId()).toBeNull()
    const status = vi.fn().mockResolvedValue(statusFixture('ssh:p1:1'))
    const services = fakeServices({ status })
    const openPorts = registerPortsSurface(new SurfaceRegistry(), services, manager)
    expect(openPorts()).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })
})
