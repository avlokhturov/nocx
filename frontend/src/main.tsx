import './style.css'
import { GetWSPort, GetWSToken, CheckForUpdate, ReportHealthy } from '../wailsjs/go/main/WailsApp'
import { render } from 'solid-js/web'
import App from './App'
import { log } from './log'
import { WSClient } from './ipc'
import { TabManager } from './tabs'
import { mountSidebar } from './sidebar'
import { createClipboardAccess, ClipboardGate } from './clipboard'
import { ClipboardBannerImpl } from './banner'
import { ProfileClient } from './profiles'
import { Dispatcher } from './dispatcher'
import { SettingsContent, SURFACE_SETTINGS, SINGLETON_SETTINGS } from './settings-content'
import { HorizontalTabStrip, VerticalTabStrip } from './tab-strip'
import { ConnectionsContent } from './connections-content'
import { SURFACE_CONNECTIONS, SINGLETON_CONNECTIONS } from './tab-content'
import { SurfaceRegistry, SURFACE_ID_SETTINGS, SURFACE_ID_CONNECTIONS } from './surface-registry'
import { mountUpdateNotice } from './update-notice'
import { SettingsIcon } from './ui/icons'
import { SettingsObserver } from './settings-observer'
import { bootstrapTheme } from './renderers/theme-bootstrap'

async function main() {
  log.info('nocx: main() called')

  // Single Solid root owns the shell. App renders the skeleton with empty
  // hosts (#tabbar, #activitybar, #sidebar, #panes) that imperative code
  // mounts into. Everything below is the composition root — no more DOM
  // construction, no hand-wired layout.
  // Bootstrap the theme before any render. Applies data-theme, validates
  // terminal tokens, and sets the module-level current theme so every
  // XtermRenderer mount() reads the correct palette from the first frame.
  // ADR-0013 §8, §8.1; design spec §5.4.
  const appliedThemeId = bootstrapTheme()
  void appliedThemeId // available for future Go theme reconciliation
  render(() => <App />, document.getElementById('app')!)
  const bar = document.getElementById('tabbar')!
  const verticalStripHost = document.getElementById('vertical-tabstrip')!
  const panes = document.getElementById('panes')!
  const activityBar = document.getElementById('activitybar')!
  const sidebarPanel = document.getElementById('sidebar')!

  // Update notice — renders inline in the tab bar, right-aligned.
  const notice = mountUpdateNotice(bar)

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
  const dispatcher = new Dispatcher()
  const client = new WSClient(dispatcher)
  await client.connect(port, host, token)
  const profileClient = new ProfileClient(dispatcher)

  // The generated-screen invariant says no setting key appears in the frontend,
  // and it is about the SCREEN: settings.ts and settings-content.ts render from
  // declarations so a new setting costs one MustRegister* call in Go and zero
  // frontend changes. The composition root is a different thing — a CONSUMER
  // that acts on one specific setting — and a consumer has to name what it
  // consumes. So the key is named here, deliberately, and only here.
  //
  // The alternative was tried and rejected: identifying the declaration by
  // section "Interface" plus control "select" reads as key-free but is a latent
  // bug, because it silently resolves to whichever select comes first in
  // declaration order. nocx-8yg.6 (colour schemes) is already filed and would
  // add exactly such a select to Interface, at which point tab placement would
  // stop working with nothing on screen to say why.
  const PLACEMENT_KEY = 'tab.placement'

  let placement: unknown = 'horizontal'
  try {
    const snap = await profileClient.getSnapshot()
    placement = snap.values[PLACEMENT_KEY] ?? 'horizontal'
  } catch {
    // Backend may not be ready yet — safe fallback.
  }
  const tabStrip = placement === 'vertical' ? new VerticalTabStrip() : new HorizontalTabStrip()

  const tm = new TabManager(
    bar,
    verticalStripHost,
    panes,
    client,
    clipboard,
    gate,
    banner,
    profileClient,
    tabStrip,
  )

  // Surface registry — surfaces declared once, every entry point resolves
  // through the registry rather than rebuilding the descriptor. (AD-8)
  const registry = new SurfaceRegistry()
  registry.register(SURFACE_ID_SETTINGS, {
    surfaceType: SURFACE_SETTINGS,
    singletonKey: SINGLETON_SETTINGS,
    factory: () => new SettingsContent(profileClient),
    descriptor: {
      restoreDescriptor: null,
      supportsAttention: false,
      defaultTitle: 'Settings',
    },
  })
  registry.register(SURFACE_ID_CONNECTIONS, {
    surfaceType: SURFACE_CONNECTIONS,
    singletonKey: SINGLETON_CONNECTIONS,
    factory: () => {
      const content = new ConnectionsContent(profileClient)
      content.onConnect = (profile) => {
        log.info('nocx: onConnect called', { profileId: profile.id, profile: profile.name })
        tm.newSSHTab(profile.id, profile.options.host, profile.options.user)
      }
      return content
    },
    descriptor: {
      restoreDescriptor: null,
      supportsAttention: false,
      defaultTitle: 'Connections',
    },
  })

  // Live application through SettingsObserver: when the placement setting
  // changes, refetch the snapshot and swap the strip in place.
  const observer = new SettingsObserver(dispatcher)
  observer.setRevision(0)
  observer.start(() => {
    void (async () => {
      try {
        const snap = await profileClient.getSnapshot()
        observer.setRevision(snap.revision)
        const next = snap.values[PLACEMENT_KEY] ?? 'horizontal'
        if (next !== placement) {
          placement = next
          tm.replaceStrip(next === 'vertical' ? new VerticalTabStrip() : new HorizontalTabStrip())
        }
      } catch {
        // Silently ignore — a settings fetch failure is not actionable here.
      }
    })()
  })
  // App-shell sidebar (nocx-82l9.6) — VS Code-style activity bar plus a
  // collapsible panel.  Views and actions are two separate zones:
  //
  // - Top zone: views from the registry (currently empty; Explorer, Git,
  //   and Servers are future beads).
  // - Bottom zone: global actions (currently only the Settings gear).
  //
  // Connections has been removed from the activity bar — it is not a view
  // and not an action (see .internal/specs §2.4).  The surface is still
  // reachable through the Cmd/Ctrl+, registry entry point until nocx-imkb.3
  // lands and Connections becomes a Settings sub-page.
  mountSidebar(
    activityBar,
    sidebarPanel,
    /* views — empty until nocx-708q */ [],
    /* actions */ [
      {
        id: 'settings',
        title: 'Settings',
        icon: SettingsIcon,
        onActivate: () => {
          log.info('nocx: opening Settings tab')
          const { content, descriptor } = registry.build(SURFACE_ID_SETTINGS)
          tm.openTab(content, descriptor)
        },
      },
    ],
  )

  // Cmd/Ctrl+, opens or focuses the Settings tab.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault()
      const { content, descriptor } = registry.build(SURFACE_ID_SETTINGS)
      tm.openTab(content, descriptor)
    }
  })

  void tm.openInitialTab()

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
