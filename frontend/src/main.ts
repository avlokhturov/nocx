import './style.css'
import {
  GetWSPort,
  GetWSToken,
  CheckForUpdate,
  ApplyUpdate,
  ReportHealthy,
} from '../wailsjs/go/main/WailsApp'
import { log } from './log'
import { WSClient } from './ipc'
import { TabManager } from './tabs'
import { SidebarImpl } from './sidebar'
import { createClipboardAccess, ClipboardGate } from './clipboard'
import { ClipboardBannerImpl } from './banner'
import { ProfileClient } from './profiles'
import { SettingsViewImpl } from './settings'
import { HorizontalTabStrip } from './tab-strip'
import { ConnectionsContent } from './connections-content'
import { SURFACE_CONNECTIONS, SINGLETON_CONNECTIONS } from './tab-content'
import type { ContentDescriptor } from './tab-content'

/**
 * Renders the auto-update notice in the tab bar. The notice is a small,
 * non-modal element that shows update availability, download progress,
 * and pending-restart state. It renders from state — bound Go calls are
 * idempotent.
 */
class UpdateNotice {
  private readonly el: HTMLDivElement

  constructor(private bar: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'update-notice'
    this.el.style.display = 'none'
    this.bar.append(this.el)
  }

  /** Show an update is available with a link to release notes. */
  showAvailable(version: string, notesUrl: string): void {
    this.el.style.display = 'flex'
    this.el.innerHTML = ''
    const span = document.createElement('span')
    span.textContent = `nocx ${version} available`
    const link = document.createElement('a')
    link.href = notesUrl
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'release notes'
    link.className = 'update-notes-link'
    const btn = document.createElement('button')
    btn.textContent = 'Update'
    btn.className = 'update-apply-btn'
    btn.addEventListener('click', () => {
      void this.apply()
    })
    this.el.append(span, ' · ', link, ' ', btn)
  }

  /** Show the busy/downloading state. */
  showDownloading(): void {
    this.el.style.display = 'flex'
    this.el.innerHTML = ''
    this.el.textContent = 'Downloading update…'
    this.el.className = 'update-notice downloading'
  }

  /** Show pending restart state after a successful apply. */
  showPendingRestart(version: string): void {
    this.el.style.display = 'flex'
    this.el.innerHTML = ''
    this.el.textContent = `nocx ${version} installed — restart to apply`
    this.el.className = 'update-notice pending'
  }

  /** Show an error message. */
  showError(msg: string): void {
    this.el.style.display = 'flex'
    this.el.innerHTML = ''
    this.el.textContent = `Update failed: ${msg}`
    this.el.className = 'update-notice error'
  }

  private async apply(): Promise<void> {
    this.showDownloading()
    try {
      await ApplyUpdate()
      // After a successful apply, show pending restart.
      this.showPendingRestart('') // version unknown here; Go can enrich later
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.showError(msg)
    }
  }
}

async function main() {
  log.info('nocx: main() called')
  const bar = document.getElementById('tabbar')
  const panes = document.getElementById('panes')
  const activityBar = document.getElementById('activitybar')
  const sidebarPanel = document.getElementById('sidebar')
  if (!bar || !panes || !activityBar || !sidebarPanel) {
    throw new Error('#tabbar / #panes / #activitybar / #sidebar not found')
  }

  // Update notice — renders inline in the tab bar, right-aligned.
  const notice = new UpdateNotice(bar)

  const clipboard = createClipboardAccess()
  const gate = new ClipboardGate()
  const banner = new ClipboardBannerImpl()

  // Bound Go method — no startup-event race. Guarded so the renderers still
  // mount without a Wails runtime (plain browser), where GetWSPort throws.
  // In that dev path the backend lives on the page's own host (e.g. a remote
  // dev VM), not necessarily on loopback.
  let port = 9876
  let token = ''
  let host: string | undefined
  try {
    port = await GetWSPort()
    token = await GetWSToken()
  } catch {
    host = location.hostname
    console.warn('nocx: no Wails runtime, using fallback WS port', port)
  }

  const client = new WSClient()
  await client.connect(port, host, token)
  const profileClient = new ProfileClient(client.rawSocket())
  // TabManager opens the first tab and activates it in the constructor.
  const tabStrip = new HorizontalTabStrip()
  const tm = new TabManager(bar, panes, client, clipboard, gate, banner, profileClient, tabStrip)

  // App-shell sidebar (nocx-8yg.9) — VS Code-style activity bar plus a
  // collapsible panel. Two views:
  // - Connections: opens the SSH connection manager as a full-screen tab.
  // - Sessions: placeholder, as on main. It is deliberately empty: the tab
  //   list lives in the tab bar. Making the sidebar a second home for tabs is
  //   the subject of epic nocx-d3q (configurable placement), not of this branch.
  new SidebarImpl(activityBar, sidebarPanel, [
    {
      id: 'connections',
      title: 'Connections',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
      action: 'tab',
      onActivate: () => {
        log.info('nocx: opening Connections tab')
        const content = new ConnectionsContent(profileClient)
        const descriptor: ContentDescriptor = {
          surfaceType: SURFACE_CONNECTIONS,
          singletonKey: SINGLETON_CONNECTIONS,
          restoreDescriptor: null,
          supportsAttention: false,
          defaultTitle: 'Connections',
        }
        content.onConnect = (profile) => {
          log.info('nocx: onConnect called', { profileId: profile.id, profile: profile.name })
          tm.newSSHTab(profile.id, profile.options.host, profile.options.user)
        }
        tm.openTab(content, descriptor)
      },
    },
    {
      id: 'sessions',
      title: 'Sessions',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>',
      action: 'panel',
    },
    {
      id: 'settings',
      title: 'Settings',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
      action: 'panel',
      mount: (panel) => {
        const settingsView = new SettingsViewImpl(panel, profileClient)
        void settingsView.refresh()
      },
    },
  ])

  // --- Auto-update: check on start, then every 24 h ---

  // Report healthy once the initial tab's renderer mounted and PTY opened.
  tm.initialTabReady.then(
    () => {
      ReportHealthy().catch((err) => console.warn('nocx: ReportHealthy failed', err))
    },
    () => {
      console.warn('nocx: initial tab failed — not reporting healthy')
    },
  )

  // Check for updates. Failures are silent (airplane mode, DNS hiccup, etc.).
  try {
    const info = await CheckForUpdate()
    if (info) {
      notice.showAvailable(info.Version, info.NotesURL)
    }
  } catch {
    // Silent — automatic check failures are not surfaced to the user.
  }

  // Re-check every 24 hours.
  const DAY_MS = 24 * 60 * 60 * 1000
  setInterval(() => {
    void (async () => {
      try {
        const info = await CheckForUpdate()
        if (info) {
          notice.showAvailable(info.Version, info.NotesURL)
        }
      } catch {
        // Silent.
      }
    })()
  }, DAY_MS)
}

main().catch((err) => log.error('nocx: main error', { message: (err as Error).message }))
