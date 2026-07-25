import './style.css'
import { GetWSPort, CheckForUpdate, ApplyUpdate, ReportHealthy, Log } from '../wailsjs/go/main/WailsApp'
import { WSClient } from './ipc'
import { TabManager } from './tabs'
import { SidebarImpl } from './sidebar'
import { createClipboardAccess, ClipboardGate } from './clipboard'
import { ClipboardBannerImpl } from './banner'
import { ProfileClient } from './profiles'

async function main() {
  Log('nocx: main() called')
  const panes = document.getElementById('panes')
  const activityBar = document.getElementById('activitybar')
  const sidebarPanel = document.getElementById('sidebar')
  if (!panes || !activityBar || !sidebarPanel) {
    throw new Error('#panes / #activitybar / #sidebar not found')
  }

  // Update notice — renders in sidebar panel
  const notice = document.createElement('div')
  notice.className = 'update-notice-sidebar'
  notice.style.display = 'none'
  sidebarPanel.prepend(notice)

  const clipboard = createClipboardAccess()
  const gate = new ClipboardGate()
  const banner = new ClipboardBannerImpl()

  // Bound Go method — no startup-event race. Guarded so the renderers still
  // mount without a Wails runtime (plain browser), where GetWSPort throws.
  // In that dev path the backend lives on the page's own host (e.g. a remote
  // dev VM), not necessarily on loopback.
  let port = 9876
  let host: string | undefined
  try {
    port = await GetWSPort()
  } catch {
    host = location.hostname
    console.warn('nocx: no Wails runtime, using fallback WS port', port)
  }

  const client = new WSClient()
  await client.connect(port, host)

  const profileClient = new ProfileClient(client.rawSocket())
  // TabManager manages tabs logic (no UI — tabs are shown in sidebar)
  // Create a hidden container for TabManager internal UI
  const hiddenBar = document.createElement('div')
  hiddenBar.style.display = 'none'
  document.body.append(hiddenBar)
  const tm = new TabManager(hiddenBar, panes, client, clipboard, gate, banner, profileClient)

  // App-shell sidebar (nocx-8yg.9) — VS Code-style activity bar plus a
  // collapsible panel. Two views:
  // - Connections: opens a full-screen tab with connection manager
  // - Sessions: shows sidebar panel with saved sessions list
  new SidebarImpl(activityBar, sidebarPanel, [
    {
      id: 'connections',
      title: 'Connections',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
      action: 'tab',
      onActivate: () => {
        Log('nocx: opening Connections tab')
        tm.newManagerTab()
      },
    },
    {
      id: 'sessions',
      title: 'Sessions',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>',
      action: 'panel',
      mount: (panel: HTMLElement) => {
        // Sessions panel shows open tabs from TabManager
        const header = document.createElement('div')
        header.className = 'sidebar-sessions-header'
        
        const title = document.createElement('div')
        title.className = 'sidebar-section-title'
        title.textContent = 'Open Sessions'
        header.append(title)

        const addBtn = document.createElement('button')
        addBtn.className = 'sidebar-add-btn'
        addBtn.textContent = '+'
        addBtn.title = 'New tab'
        addBtn.addEventListener('click', () => {
          tm.newTab()
        })
        header.append(addBtn)

        panel.append(header)

        const list = document.createElement('div')
        list.className = 'sidebar-sessions-list'
        panel.append(list)

        const renderSessions = () => {
          const tabs = tm.getTabs()
          list.innerHTML = ''
          if (tabs.length === 0) {
            list.textContent = 'No open sessions'
            return
          }
          for (const tab of tabs) {
            const item = document.createElement('div')
            item.className = 'sidebar-session-item'
            if (tab.isActive) item.classList.add('active')
            
            const titleSpan = document.createElement('span')
            titleSpan.className = 'sidebar-session-title'
            titleSpan.textContent = tab.title
            item.append(titleSpan)

            const closeBtn = document.createElement('button')
            closeBtn.className = 'sidebar-session-close'
            closeBtn.textContent = '×'
            closeBtn.title = 'Close'
            closeBtn.addEventListener('click', (e) => {
              e.stopPropagation()
              // Find the actual Tab object and close it
              const allTabs = (tm as any).tabs
              const actualTab = allTabs.find((t: any) => t.id === tab.id)
              if (actualTab) {
                tm.closeTab(actualTab)
              }
            })
            item.append(closeBtn)

            item.addEventListener('click', () => {
              // Find the actual Tab object and activate it
              const allTabs = (tm as any).tabs
              const actualTab = allTabs.find((t: any) => t.id === tab.id)
              if (actualTab) {
                void tm.activate(actualTab)
              }
            })
            list.append(item)
          }
        }

        // Initial render
        renderSessions()

        // Subscribe to tab changes
        tm.onTabsChanged = renderSessions
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

  // Update notice functions
  const showUpdateAvailable = (version: string, notesUrl: string) => {
    notice.style.display = 'flex'
    notice.innerHTML = ''
    const span = document.createElement('span')
    span.textContent = `nocx ${version} available`
    const link = document.createElement('a')
    link.href = notesUrl
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'release notes'
    const btn = document.createElement('button')
    btn.textContent = 'Update'
    btn.addEventListener('click', async () => {
      notice.textContent = 'Downloading update…'
      try {
        await ApplyUpdate()
        notice.textContent = 'Restart to apply'
      } catch (err) {
        notice.textContent = `Update failed: ${err instanceof Error ? err.message : String(err)}`
      }
    })
    notice.append(span, ' ', link, ' ', btn)
  }

  // Check for updates. Failures are silent (airplane mode, DNS hiccup, etc.).
  try {
    const info = await CheckForUpdate()
    if (info) {
      showUpdateAvailable(info.Version, info.NotesURL)
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
          showUpdateAvailable(info.Version, info.NotesURL)
        }
      } catch {
        // Silent.
      }
    })()
  }, DAY_MS)
}

main().catch((err) => Log(`nocx: main error: ${(err as Error).message}`))
