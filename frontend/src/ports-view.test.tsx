// @vitest-environment jsdom
// Ports is a SIDEBAR VIEW (nocx-wzc4.7) — the deliverable is the
// activity-bar icon, not a palette item and not a tab. AGENTS.md rule 1:
// a user opens the view from the activity bar and sees the ports of the
// tab they are looking at; switching SSH tabs re-scopes the view; a local
// tab never shows a stale host; collapsing the sidebar pauses sampling;
// Ctrl/Cmd+Shift+O reveals-or-focuses instead of opening another tab.
//
// These start from a real TabManager and the real mountSidebar — the panel
// never mounts in a vacuum.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { PortsPanel, type PortsPanelServices } from './ports'
import { mountSidebar, type SidebarHandle, type SidebarViewDescriptor } from './sidebar'
import { PlugIcon } from './ui/icons'
import {
  createRendererMock,
  makeClient,
  makeSession,
  mountTabManager,
  type ClientFake,
} from './test-support/tabs-fixtures'
import type { PortsStatusResult } from './generated/ports.status'
import type { TunnelOpenResult } from './generated/tunnel.open'

vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

const PORTS_VIEW_ID = 'ports'

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

const listenerFixture = (port: number): PortsStatusResult['discovery']['listeners'][number] => ({
  family: 'ipv4' as const,
  address: '0.0.0.0',
  port,
  process: { evidence: 'known', name: 'sshd', pid: 123 },
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

/** The view descriptor main.tsx builds — the sidebar's first real view. */
function portsView(services: PortsPanelServices): SidebarViewDescriptor {
  return {
    id: PORTS_VIEW_ID,
    title: 'Ports',
    icon: PlugIcon,
    view: (props) => (
      <PortsPanel profileId={props.activeProfileId} services={services} visible={props.visible} />
    ),
    order: 0,
  }
}

const liveHandles: SidebarHandle[] = []

/** Full composition: a real TabManager (with or without an SSH tab in
 *  front), the reactive active-profile signal main.tsx wires, and the
 *  real sidebar mounting the ports view. */
async function mountApp(services: PortsPanelServices, profileId: string | null = 'ssh:p1:1') {
  const client = makeClient({
    openSSHSession: vi.fn(() => Promise.resolve(makeSession())),
    openSSHSessionByHost: vi.fn(() => Promise.resolve(makeSession())),
  } as unknown as Partial<ClientFake>)
  const { manager } = await mountTabManager(client)
  if (profileId !== null) manager.newSSHTab(profileId, 'host.example', 'alice')

  const [activeProfileId, setActiveProfileId] = createSignal<string | null>(
    manager.activeProfileId(),
  )
  manager.onActiveTabChange = () => setActiveProfileId(manager.activeProfileId())

  const bar = document.createElement('div')
  bar.id = 'activitybar'
  const panel = document.createElement('div')
  panel.id = 'sidebar'
  document.body.append(bar, panel)
  const handle = mountSidebar(
    bar,
    panel,
    [portsView(services)],
    [],
    undefined,
    /* eslint-disable solid/reactivity -- same contract as main.tsx: the
       sidebar reads this accessor inside tracked view scopes. */
    () => activeProfileId(),
  )
  liveHandles.push(handle)
  return { manager, bar, panel, handle }
}

function portsIcon(bar: HTMLElement): HTMLElement {
  const el = bar.querySelector<HTMLElement>(`button[data-view="${PORTS_VIEW_ID}"]`)
  if (!el) throw new Error('no ports activity-bar button')
  return el
}

afterEach(() => {
  for (const h of liveHandles) h.destroy()
  liveHandles.length = 0
  cleanup()
  document.body.replaceChildren()
})

// ── The acceptance: reachable from the activity bar, scoped to the tab ────

describe('ports sidebar view', () => {
  it("a user opens Ports from the activity bar and sees the ACTIVE tab's ports", async () => {
    const status = vi.fn().mockResolvedValue({
      ...statusFixture('ssh:p1:1'),
      discovery: {
        ...statusFixture('ssh:p1:1').discovery,
        listeners: [listenerFixture(22)],
      },
    })
    const services = fakeServices({ status })
    const { bar, panel } = await mountApp(services)

    // mountSidebar auto-selects the first view and starts expanded
    // (nocx-rp2j) — the panel is on screen and asked the backend for THIS
    // connection's ports.
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('ssh:p1:1'))
    await vi.waitFor(() => expect(panel.textContent).toContain('0.0.0.0:22'))

    // The user path: click the activity-bar icon to close the view, then
    // click it again — the view comes back showing the same tab's ports.
    const icon = portsIcon(bar)
    icon.click()
    await vi.waitFor(() => expect(panel.classList.contains('collapsed')).toBe(true))
    icon.click()
    await vi.waitFor(() => expect(panel.classList.contains('collapsed')).toBe(false))
    await vi.waitFor(() => expect(panel.textContent).toContain('0.0.0.0:22'))
  })

  it('switching SSH tabs re-scopes the view to the tab in front', async () => {
    const status = vi.fn().mockResolvedValue(statusFixture('ssh:p1:1'))
    const services = fakeServices({ status })
    const { manager } = await mountApp(services)
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('ssh:p1:1'))

    manager.newSSHTab('ssh:p2:2', 'other.example', 'bob')
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('ssh:p2:2'))
  })
  it("a local tab shows the no-connection state, never a stale host's ports", async () => {
    const status = vi.fn().mockResolvedValue(statusFixture('ssh:p1:1'))
    const services = fakeServices({ status })
    const { panel } = await mountApp(services, null)

    await vi.waitFor(() => expect(panel.textContent).toContain('No active connection'))
    expect(panel.textContent).not.toContain('host.example')
    expect(status).not.toHaveBeenCalled()
  })

  it('collapsing the sidebar pauses sampling; expanding resumes it', async () => {
    const visible = vi.fn().mockResolvedValue({})
    const services = fakeServices({ visible })
    const { bar } = await mountApp(services)
    await vi.waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p1:1', true))

    const icon = portsIcon(bar)
    icon.click() // collapse — counts as not visible
    await vi.waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p1:1', false))

    icon.click() // expand
    await vi.waitFor(() => expect(visible).toHaveBeenCalledWith('ssh:p1:1', true))
  })

  it('Ctrl/Cmd+Shift+O reveals the collapsed view and focuses it when open', async () => {
    const services = fakeServices()
    const { bar, panel, handle } = await mountApp(services)
    const icon = portsIcon(bar)

    // The chord main.tsx registers: reveal-or-focus, never "open another".
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        handle.revealView(PORTS_VIEW_ID)
      }
    }
    document.addEventListener('keydown', handler)
    const chord = (): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', {
        key: 'O', // Shift held — the browser reports the uppercase letter
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
      document.dispatchEvent(e)
      return e
    }

    icon.click() // collapse
    expect(panel.classList.contains('collapsed')).toBe(true)

    const reveal = chord()
    expect(reveal.defaultPrevented).toBe(true)
    expect(panel.classList.contains('collapsed')).toBe(false)

    // Already on screen — the chord focuses the view's icon.
    icon.blur()
    const focus = chord()
    expect(focus.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(icon)

    document.removeEventListener('keydown', handler)
  })
})
