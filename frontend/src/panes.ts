// ═══════════════════════════════════════════════════════════════════════════
// Pane and PaneManager — chrome, lifecycle, and pane-model management.
//
// Pane is chrome-only: it owns the pane, display state, and delegates content
// lifecycle to a PaneContent instance. It implements PaneHost so content can
// push title, tooltip, attention, and close requests upward.
//
// PaneManager owns the ordered pane model, activation rules, and MRU stack.
// It constructs content, creates panes, and wires pane-chrome intents.
// ═══════════════════════════════════════════════════════════════════════════

import type { WSClient } from './ipc'
import { detectAgentStatus, type AgentStatus } from './agent-status'
import { type ClipboardAccess, type ClipboardGate } from './clipboard'
import type { ClipboardBanner } from './banner'
import type { ProfileClient } from './profiles'
import { adoptAliasProfile } from './profiles'
import { showToast } from './ui/toast'
import { showConfirm } from './ui/dialog'
import { leftRunningMessage, liveDescendants, type LineageNode } from './lineage'
import { log } from './log'
import type { TabStrip } from './tab-strip'
import type {
  PaneHost,
  PaneContent,
  ContentDescriptor,
  ContentViewport,
  ActiveOrigin,
  SurfaceType,
} from './pane-content'
import { SURFACE_TERMINAL } from './pane-content'
import type { SnippetProviderDeps } from './snippets/snippet-provider'
import { TerminalContent, type HostKeyErrorEvidence } from './terminal-content'

// ═══════════════════════════════════════════════════════════════════════════
// Pane — chrome and lifecycle, delegates content to PaneContent
// ═══════════════════════════════════════════════════════════════════════════

export class Pane implements PaneHost {
  readonly id: number
  /** The renderer-minted wire identity (nocx-tsajw): a UUID minted once per
   *  pane, never reused, and shared with the content so history.record and
   *  pane.close address the same backend-scoped captures. Chrome keeps its
   *  own numeric id; this one is what crosses the wire. */
  readonly wireId: string
  readonly pane = document.createElement('div')

  /** Model-level descriptor: surface type, singleton key, restore info. */
  readonly descriptor: ContentDescriptor

  readonly content: PaneContent

  // ── Display state (read by TabStrip via PaneView) ─────────────────────

  private _active = false
  onDisplayChange: (() => void) | null = null

  private _title = ''
  /** The last COMPOSED title the content pushed (`programTitle ||
   *  runningCommandTitle || cwdTitle`), before the default-title
   *  fallback. Deliberately not called `_programTitle`: that name was a
   *  lie — the field holds whatever the content composed, which is
   *  usually a filesystem path. The program's own title arrives
   *  separately, through updateProgramTitle. */
  private _pushedTitle = ''
  private _hasActivity = false
  private _agentStatus: AgentStatus | null = null
  private _tooltip = ''
  private _subtitle = ''
  private _adoptable = false
  private _onAdopt: (() => void) | null = null
  private _warning = false
  private _warningLabel = ''
  private _disposed = false
  private _mountAbort = new AbortController()
  // ── B.5 geometry authority ──────────────────────────────────────────
  private _viewportObserver: ResizeObserver | null = null
  private _latestViewport: ContentViewport | null = null
  private _mountStarted = false

  constructor(content: PaneContent, descriptor: ContentDescriptor, id: number, wireId: string) {
    this.id = id
    this.wireId = wireId
    this.content = content
    this.descriptor = descriptor

    this.pane.className = 'pane'
    this.pane.id = `pane-${id}`
    this.pane.setAttribute('role', 'tabpanel')

    // ── Pre-mount target ──────────────────────────────────────────────
    // Hand the pane to the content before mount, so setVisible is
    // meaningful from the first setActive(true) call. setTarget is on the
    // PaneContent interface — every implementation must accept or no-op it.
    content.setTarget(this.pane)
  }

  // ── PaneView conformance ───────────────────────────────────────────────

  get title(): string {
    return this._title
  }

  /** Display title: falls back to descriptor.defaultTitle when empty. */
  get displayTitle(): string {
    return this._title || this.descriptor.defaultTitle
  }

  get hasActivity(): boolean {
    return this._hasActivity
  }

  get agentStatus(): AgentStatus | null {
    return this._agentStatus
  }

  get tooltip(): string {
    return this._tooltip
  }

  /**
   * The pane's location, for the strip's optional second line — empty when the first
   * line already says it.
   *
   * The decision cannot be made here. TerminalContent composes the title as
   * `programTitle || runningCommandTitle || cwdTitle` and hands the RESULT to
   * setTitle, so from the pane's side every title looks equally like a name.
   * Only the content knows whether a program (or a command) supplied one, so
   * the content decides and pushes the answer.
   */
  get subtitle(): string {
    return this._subtitle
  }

  get paneId(): string {
    return this.pane.id
  }

  get adoptable(): boolean {
    return this._adoptable
  }

  get onAdopt(): (() => void) | null {
    return this._onAdopt
  }

  /** Mark the pane as saveable or not, with the save action. */
  setAdoptState(adoptable: boolean, onAdopt: () => void): void {
    if (this._disposed) return
    this._adoptable = adoptable
    this._onAdopt = adoptable ? onAdopt : null
    this.onDisplayChange?.()
  }

  /** Mark the pane's environment degraded/uncertain (nocx-4t37.2): the one
   *  signal pane chrome may carry. It persists for as long as the session
   *  stays degraded (nocx-5uu5) — the card is the once-per-(shell, reason)
   *  event, and this is the state that outlives it. The capability
   *  statement itself lives in the rail.
   *
   *  The label is what the mark is ABOUT. A mark that cannot say what it
   *  means is a mark people learn to ignore, so the integration status
   *  supplies its own wording rather than the chrome inventing one. */
  setWarningState(warning: boolean, label = ''): void {
    if (this._disposed) return
    if (warning === this._warning && label === this._warningLabel) return
    this._warning = warning
    this._warningLabel = label
    this.onDisplayChange?.()
  }

  get warning(): boolean {
    return this._warning
  }

  get warningLabel(): string {
    return this._warningLabel
  }

  setActive(active: boolean): void {
    this._active = active
    // Visibility crosses the seam through setVisible — the content
    // toggles the 'active' class on its mount target (AD-6 corollary).
    this.content.setVisible(active)
    if (active) {
      this._hasActivity = false
    }
    this.onDisplayChange?.()
  }

  // ── PaneHost ───────────────────────────────────────────────────────────

  setTitle(title: string): void {
    if (this._disposed) return

    this._pushedTitle = title.trim()
    const next = this._pushedTitle || this.descriptor.defaultTitle
    if (next !== this._title) {
      this._title = next
      this.onDisplayChange?.()
    }
  }

  /** Terminal-content-only: update tooltip from cwd or SSH info.
   *  Not on PaneHost — wired through TerminalContent's constructor. */
  updateTooltip(tooltip: string): void {
    if (this._disposed) return
    this._tooltip = tooltip
    this.onDisplayChange?.()
  }

  /** Terminal-content-only, like updateTooltip: the location line, or '' when the
   *  title already carries it. See the `subtitle` getter. */
  updateSubtitle(subtitle: string): void {
    if (this._disposed) return
    if (subtitle === this._subtitle) return
    this._subtitle = subtitle
    this.onDisplayChange?.()
  }

  requestAttention(): void {
    if (this._disposed) return
    this.markActivity()
  }

  requestClose(): void {
    if (this._disposed) return
    this.onCloseRequested?.()
  }

  /** Terminal-content-only, like updateTooltip: the program's own OSC 0/2
   *  title, delivered separately from the composed display title — the
   *  agent-state classifier keys on THIS, never on the composed title
   *  (which is usually a filesystem path or a command line). A TUI
   *  clearing its title on the way out emits OSC 0/2 with an EMPTY
   *  string; that empty delivery reaches here too and resets the status,
   *  the way an empty title always did.
   *  Wired through TerminalContent's constructor. */
  updateProgramTitle(programTitle: string): void {
    if (this._disposed) return
    this.updateAgentStatus(programTitle)
  }

  /** Called when the content (terminal session) wants the pane closed. */
  onCloseRequested?: () => void

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Mount the content into this pane. Called by PaneManager on first
   *  activation, and suppressed after that: mount-once is enforced here at
   *  the seam, not by a private flag inside one implementation (nocx-njrx.2).
   *  The pane is already visible by now — the content received it through
   *  setTarget() in the constructor — so mount and the first viewport
   *  delivery both measure a laid-out element. */
  async start(): Promise<void> {
    if (this._mountStarted) return
    this._mountStarted = true
    log.info('nocx: Pane.start() called', { id: this.id })
    await this.content.mount(this.pane, this, this._mountAbort.signal)
    // B.5: replay the latest buffered viewport, or measure now if none yet.
    if (this._latestViewport) {
      this.content.viewportChanged(this._latestViewport)
    } else {
      this._deliverViewport()
    }
  }

  focus(): void {
    this.content.focus()
  }

  close(): void {
    this._disposed = true
    this._mountAbort.abort()
    this._viewportObserver?.disconnect()
    this._viewportObserver = null
    this.content.dispose()
  }
  // ── Internals ─────────────────────────────────────────────────────────

  private markActivity(): void {
    if (this._disposed) return
    // Only a tab the user is not looking at can hold unread output. Without this
    // guard the flag was set by output arriving in the ACTIVE tab, where nothing
    // renders it — and it survived the switch away, because setActive() clears
    // the flag on activation and not on deactivation. The result: the tab you
    // just left lit up its indicator with nothing having happened in it since.
    if (this._active) return
    if (!this._hasActivity) {
      this._hasActivity = true
      this.onDisplayChange?.()
    }
  }

  private updateAgentStatus(programTitle: string): void {
    if (this._disposed) return
    const next = detectAgentStatus(programTitle)
    if (next === this._agentStatus) return
    this._agentStatus = next
    if (next === 'idle' && !this._active) {
      this.markActivity()
    }
  }

  // ── B.5 geometry authority ──────────────────────────────────────────

  /**
   * Start observing the pane element for resize. Called when the pane enters
   * the DOM (PaneManager.addPane). Delivery is synchronous — the browser already
   * batches ResizeObserver entries once per frame — and suppressed after
   * disposal. See the callback for why an extra frame was the bug, not the fix.
   */
  setupViewportObserver(): void {
    if (this._viewportObserver) return
    const observer = new ResizeObserver((entries) => {
      if (this._disposed) return
      const entry = entries[entries.length - 1]
      if (!entry) return
      const { width, height } = entry.contentRect
      // Never send a misleading zero rectangle for hidden/inactive panes (B.5).
      if (width === 0 && height === 0) return
      // Deliver synchronously. ResizeObserver already fires once per frame,
      // after layout and before paint, with pending entries batched — so
      // wrapping this in requestAnimationFrame coalesced nothing the browser
      // had not coalesced already, it only deferred delivery to the NEXT
      // frame. That extra frame IS the one-frame squeeze in nocx-dau: the grid
      // stayed sized for the old rectangle while the pane had already been
      // painted at the new one.
      //
      // Synchronous delivery inside a ResizeObserver callback risks a resize
      // loop when delivery changes the observed element's own box. It does not
      // here: the observer watches this.pane, sized by the flex layout, while
      // delivery ends in the renderer resizing the terminal INSIDE the pane.
      // The pane's contentRect is unaffected, so the callback cannot re-arm
      // itself.
      this._deliverViewport()
    })
    observer.observe(this.pane)
    this._viewportObserver = observer
  }

  /**
   * Measure the pane and deliver the viewport to content, but only after
   * mount has started and before disposal (B.5 delivery rules).
   */
  private _deliverViewport(): void {
    if (this._disposed || !this._mountStarted) return
    const rect = this.pane.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const dpr = window.devicePixelRatio || 1
    const vp: ContentViewport = { width: rect.width, height: rect.height, devicePixelRatio: dpr }
    // Suppress equal consecutive rectangles (B.5).
    const prev = this._latestViewport
    if (
      prev &&
      prev.width === vp.width &&
      prev.height === vp.height &&
      prev.devicePixelRatio === vp.devicePixelRatio
    ) {
      return
    }
    this._latestViewport = vp
    this.content.viewportChanged(vp)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PaneManager — ordered pane model, activation rules, MRU
// ═══════════════════════════════════════════════════════════════════════════

export class PaneManager {
  private readonly panes: Pane[] = []
  private nextPaneId = 1
  private activePane: Pane | null = null
  private readonly panesContainer: HTMLElement
  private readonly client: WSClient
  private readonly clipboard: ClipboardAccess
  private readonly gate: ClipboardGate
  private readonly banner: ClipboardBanner
  private readonly profileClient: ProfileClient
  private _initialPaneReady: Promise<void> | undefined
  private tabStrip: TabStrip
  private readonly bar: HTMLElement
  private readonly verticalHost: HTMLElement
  /** MRU stack: most-recently-activated pane ids. */
  private readonly recentPaneIds: number[] = []
  /** Called when an SSH connection fails because the vault is sealed. */
  onVaultSealed?: () => void
  /** Called when an SSH connection fails because the host key is unknown
   *  or changed. Resolves true only after explicit trust; the content then
   *  retries the same open. */
  onHostKeyError?: (evidence: HostKeyErrorEvidence, signal: AbortSignal) => Promise<boolean>
  /** Called when the reference picker's setup offer is activated and the
   *  machine has no OS key: the vault layer owns the setup dialog, so the
   *  hook raises it (wired by main.tsx to vaultController.openSetup). */
  onSetupVault?: () => void

  /** The prompt picker's "Add a secret…" row — opens Settings → Secrets
   *  with the add dialog up. */
  onCreateSecret?: (name: string) => void
  /** A question refused for want of an endpoint — opens Settings →
   *  Endpoints with the editor up on a blank one, so the refusal carries
   *  its repair. */
  onCreateEndpoint?: () => void
  /** Called when the user performs a UI action that should reset the
   *  vault idle timer. Wired by main.tsx to vaultClient.activity(). */
  onActivity?: () => void
  /** Called when the active pane changes — the seam for chrome that must
   *  re-scope to the tab in front. The sidebar's ports view follows the
   *  active pane through this (nocx-wzc4.7); wired by main.tsx to a Solid
   *  signal. */
  onActivePaneChange?: () => void
  /** The snippet palette chord (⌥⌘P) was pressed in the active pane —
   *  forwarded from the pane's TerminalContent, whose xterm boundary and
   *  editor arbiter both land here. The composition root opens the
   *  palette (design §10.1). */
  onSnippetChord?: () => void
  /** The snippet library the completion provider in every pane reads, and
   *  the acceptance it delegates (design §10.2). Set once by the
   *  composition root; handed to each TerminalContent as it is built. */
  snippets?: SnippetProviderDeps
  onSnippetAccepted?: (snippetId: string) => void

  constructor(
    bar: HTMLElement,
    verticalHost: HTMLElement,
    panes: HTMLElement,
    client: WSClient,
    clipboard: ClipboardAccess,
    gate: ClipboardGate,
    banner: ClipboardBanner,
    profileClient: ProfileClient,
    tabStrip: TabStrip,
  ) {
    this.panesContainer = panes
    this.client = client
    this.clipboard = clipboard
    this.gate = gate
    this.banner = banner
    this.profileClient = profileClient
    this.tabStrip = tabStrip
    this.bar = bar
    this.verticalHost = verticalHost

    // Wire TabStrip intents.
    this.wireStrip(tabStrip)

    window.addEventListener('keydown', this.onKeydown, true)
  }

  /** Return the mount host for the given strip based on orientation. */
  private hostFor(strip: TabStrip): HTMLElement {
    return strip.orientation === 'vertical' ? this.verticalHost : this.bar
  }

  get paneCount(): number {
    return this.panes.length
  }

  get initialPaneReady(): Promise<void> {
    if (!this._initialPaneReady) {
      throw new Error('initialPaneReady accessed before openInitialPane')
    }
    return this._initialPaneReady
  }

  /** Mount the tab strip and open the initial terminal pane.
   *
   *  Callable exactly once, and that is enforced here rather than documented:
   *  a second call would mount the strip again and open a second "initial"
   *  pane. This epic has already removed one contract that held by coincidence
   *  (mount-once, which lived in a private flag inside one PaneContent
   *  implementation instead of at the seam), so a comment is not enough.
   *
   *  `initialPaneReady` resolves only from terminal content — a non-terminal
   *  first tab must not be able to report the app healthy. */
  openInitialPane(): Promise<void> {
    if (this._initialPaneReady) {
      throw new Error('openInitialPane called twice; the composition root calls it exactly once')
    }
    this.tabStrip.mount(this.hostFor(this.tabStrip))
    const initialPane = this.newPane()
    const initialContent = initialPane.content as TerminalContent
    this._initialPaneReady = initialContent.ready.then((ok) => {
      if (!ok) throw new Error('initial pane failed to start')
    })
    return this._initialPaneReady
  }
  // ── Tab creation ──────────────────────────────────────────────────────

  /** Create a new local terminal pane and activate it. */
  newPane(): Pane {
    const paneRef = { current: undefined as Pane | undefined }
    const wireId = crypto.randomUUID()
    const content = new TerminalContent(
      this.client,
      wireId,
      this.clipboard,
      this.gate,
      this.banner,
      this.profileClient,
      (tooltip) => paneRef.current?.updateTooltip(tooltip),
      // The alt-screen callback that used to sit here is gone with the
      // parameter. It toggled `#app.alt-screen`, which emptied the tab strip so
      // a viewport-sized fullscreen xterm would not paint through it; the
      // fullscreen region lives inside its pane now (nocx-6w4z).
      undefined,
      {
        onSubtitleChange: (subtitle) => paneRef.current?.updateSubtitle(subtitle),
        onWarningChange: (warning, label) => paneRef.current?.setWarningState(warning, label),
        onPortsTargetChange: () => this.onActivePaneChange?.(),
        onActiveOriginChange: () => this.onActivePaneChange?.(),
        onSetupVault: this.onSetupVault,
        onCreateSecret: this.onCreateSecret,
        onSnippetChord: this.onSnippetChord,
        snippets: this.snippets,
        onSnippetAccepted: this.onSnippetAccepted,
        onCreateEndpoint: this.onCreateEndpoint,
        onProgramTitleChange: (programTitle) => paneRef.current?.updateProgramTitle(programTitle),
      },
    )
    const descriptor: ContentDescriptor = {
      surfaceType: SURFACE_TERMINAL,
      singletonKey: null,
      restoreDescriptor: { type: 'local' },
      supportsAttention: true,
      // No placeholder. A terminal pane is named after where it is, and that
      // arrives one WebSocket round-trip after the pane appears; printing
      // 'Terminal' in the meantime showed a word that is never the answer and
      // then replaced it, which reads as a flicker rather than as loading
      // (nocx-83a). An empty title is honest and the strip's width is fixed, so
      // nothing moves when the real one lands.
      defaultTitle: '',
    }
    const pane = this.addPane(content, descriptor, wireId)
    paneRef.current = pane
    return pane
  }

  newSSHPane(profileId: string, host: string, user?: string, port?: number, title?: string): Pane {
    log.info('nocx: newSSHPane called', { profileId, host, user, port, title })
    const sshOpts = { profileId, host, user, port } as const
    const paneRef = { current: undefined as Pane | undefined }
    const wireId = crypto.randomUUID()
    const content = new TerminalContent(
      this.client,
      wireId,
      this.clipboard,
      this.gate,
      this.banner,
      this.profileClient,
      (tooltip) => paneRef.current?.updateTooltip(tooltip),
      sshOpts,
      {
        onSubtitleChange: (subtitle) => paneRef.current?.updateSubtitle(subtitle),
        onAdoptabilityChange: (adoptable: boolean) => {
          const pane = paneRef.current
          if (!pane) return
          if (adoptable) {
            pane.setAdoptState(true, () => this._adoptAlias(host, user, port, pane))
          } else {
            pane.setAdoptState(false, () => {})
          }
        },
        onWarningChange: (warning, label) => paneRef.current?.setWarningState(warning, label),
        onProgramTitleChange: (programTitle) => paneRef.current?.updateProgramTitle(programTitle),
        onActiveOriginChange: () => this.onActivePaneChange?.(),
        onPortsTargetChange: () => this.onActivePaneChange?.(),
        onVaultSealed: this.onVaultSealed,
        onHostKeyError: this.onHostKeyError,
        onSetupVault: this.onSetupVault,
        onCreateSecret: this.onCreateSecret,
        onSnippetChord: this.onSnippetChord,
        snippets: this.snippets,
        onSnippetAccepted: this.onSnippetAccepted,
        onCreateEndpoint: this.onCreateEndpoint,
      },
    )
    const descriptor: ContentDescriptor = {
      surfaceType: SURFACE_TERMINAL,
      singletonKey: null,
      restoreDescriptor: { type: 'ssh', profileId, host, user },
      supportsAttention: true,
      defaultTitle: title || host,
    }
    const pane = this.addPane(content, descriptor, wireId)
    paneRef.current = pane
    return pane
  }

  /** Adopt an SSH alias as a saved nocx profile. Creates the profile and switches
   *  the tab to track the saved profile. */
  private _adoptAlias(
    host: string,
    user: string | undefined,
    port: number | undefined,
    tab: Pane,
  ): void {
    const profile = adoptAliasProfile(host, user, port)

    void this.profileClient
      .createProfile(profile)
      .then((saved) => {
        // Use what the backend returned: the id is minted there, so `profile.id`
        // is still empty here.
        tab.setAdoptState(false, () => {})
        log.info('nocx: alias adopted', { host, profileId: saved.id })
        showToast({ level: 'success', message: `Saved "${host}" as a connection` })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.error('nocx: alias adoption failed', { host, error: message })
        showToast({ level: 'danger', message: `Could not save: ${message}` })
      })
  }

  /** Open a hand-typed ssh target as a saved nocx connection: build the
   *  profile from the host the pane walked into (adoptAliasProfile — the
   *  backend mints the id, so createProfile's record is the id source) and
   *  open a NEW tab on the saved profile. A new tab is deliberate: the
   *  current tab's ssh is a child of the local shell, nocx owns no channel
   *  on it, and re-scoping that tab to a profile with no session would land
   *  the Ports panel on "open a session first" — the tab on the saved
   *  profile connects immediately, so Ports works and Forward exists there
   *  (W2). */
  openAsConnection(host: string, user: string | undefined): void {
    const profile = adoptAliasProfile(host, user, undefined)
    void this.profileClient
      .createProfile(profile)
      .then((saved) => {
        log.info('nocx: opened host as a connection', { host, profileId: saved.id })
        this.newSSHPane(saved.id, host, user)
        showToast({ level: 'success', message: `Opened "${host}" as a connection` })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.error('nocx: open-as-connection failed', { host, error: message })
        showToast({ level: 'danger', message: `Could not connect to ${host}: ${message}` })
      })
  }

  /**
   * Open a tab with the given content, deduplicating by singletonKey.
   * If a tab with the same singletonKey already exists, activates it.
   */
  openPane(content: PaneContent, descriptor: ContentDescriptor): Pane {
    if (descriptor.singletonKey) {
      const existing = this.panes.find((t) => t.descriptor.singletonKey === descriptor.singletonKey)
      if (existing) {
        void this.activate(existing)
        return existing
      }
    }
    // Every tab gets a wire identity — view tabs carry no captures, but the
    // chrome must still be able to announce a close (nocx-tsajw).
    return this.addPane(content, descriptor, crypto.randomUUID())
  }

  /** Internal: create a Tab, wire lifecycle, add to model, activate. */
  private addPane(content: PaneContent, descriptor: ContentDescriptor, wireId: string): Pane {
    const pane = new Pane(content, descriptor, this.nextPaneId++, wireId)

    this.panes.push(pane)
    this.panesContainer.append(pane.pane)
    // B.5: start observing pane geometry once it's in the DOM.
    pane.setupViewportObserver()

    pane.onCloseRequested = () => void this.closePane(pane)
    this.tabStrip.addPane(pane)
    void this.activate(pane)
    return pane
  }

  /** Swap the TabStrip at runtime without restarting.  Transfers all
   *  existing tabs to the new strip, wires intents, and preserves the
   *  active-tab state.  The old strip's DOM is removed. */
  replaceStrip(newStrip: TabStrip): void {
    // Detach the old strip: clear intents so late callbacks are no-ops.
    const old = this.tabStrip
    old.onActivate = null
    old.onClose = null
    old.onNewPane = null
    old.onReorder = null

    // Determine the old and new mount hosts based on orientation.
    // This handles both horizontal→vertical and vertical→horizontal transitions.
    const oldHost = this.hostFor(old)
    const newHost = this.hostFor(newStrip)

    // Clear the old host and strip everything setupContainer put on it.
    // The class matters for layout: when switching vertical→horizontal,
    // #vertical-tabstrip must not keep .tabstrip-vertical or it leaves a 240px
    // empty column. The ARIA attributes matter for the accessibility tree:
    // an emptied host that keeps role="tablist" is a second, empty tablist
    // sitting beside the real one, which is worse than no tablist at all.
    while (oldHost.firstChild) {
      oldHost.removeChild(oldHost.firstChild)
    }
    oldHost.classList.remove('tabstrip-vertical')
    oldHost.removeAttribute('role')
    oldHost.removeAttribute('aria-label')
    oldHost.removeAttribute('aria-orientation')

    // Mount the new strip on the correct host.
    newStrip.mount(newHost)

    // Transfer every existing pane into the new strip.
    for (const pane of this.panes) {
      newStrip.addPane(pane)
    }

    // Wire new strip intents.
    this.wireStrip(newStrip)

    // Restore active-pane state.
    if (this.activePane) {
      newStrip.setActive(this.activePane.id)
    }

    this.tabStrip = newStrip
  }

  private wireStrip(strip: TabStrip): void {
    strip.onActivate = (id) => {
      const pane = this.panes.find((t) => t.id === id)
      if (pane) void this.activate(pane)
    }
    strip.onClose = (id) => {
      const pane = this.panes.find((t) => t.id === id)
      if (pane) void this.closePane(pane)
    }
    strip.onNewPane = () => this.newPane()
    strip.onReorder = (fromId, toId) => this.reorderPane(fromId, toId)
  }

  /**
   * Close a pane. If it was the active pane, activates the MRU pane.
   * Closing the last pane opens a fresh terminal — view panes have no
   * restoreDescriptor and are never the automatic replacement.
   *
   * A pane with LIVE DESCENDANTS asks first (nocx-wtv3p, design D6): the
   * prompt names the tabs this one opened that are still running, and says
   * that closing leaves them running. It asks rather than decides because a
   * parent's end carries no information about whether its children's work is
   * still wanted — and it never offers to close them, because that would make
   * the parent's end decide theirs, which is the rule itself.
   *
   * Async, and synchronous where it matters: with no descendants nothing is
   * awaited, so the ordinary close still completes within the caller's turn.
   * The ask is the ONE gap, and the pane is re-checked across it — a tab can
   * be closed by something else while a modal is open.
   */
  async closePane(pane: Pane): Promise<void> {
    if (this.panes.indexOf(pane) === -1) return

    const descendants = this.liveDescendantsOf(pane)
    if (descendants.length > 0) {
      const proceed = await showConfirm(leftRunningMessage(descendants), 'Close tab', 'Cancel')
      if (!proceed) return
      // The world moved while the modal was open: this pane may already be
      // gone, and closing it twice would take a tab that has since been
      // recycled under the same index.
      if (this.panes.indexOf(pane) === -1) return
    }
    this.commitClosePane(pane)
  }

  /**
   * The live tabs this pane opened, at any depth, as the BACKEND admitted the
   * edges (nocx-9hu9d). Composed here because lineage.ts owns the walk and
   * the pane layer owns the labels: a content knows its session, never what
   * the strip calls its tab.
   *
   * Provenance only (ADR-0020 §5). It is read to describe what a close leaves
   * behind and for nothing else — never to decide that one tab may act on
   * another, which the backend refuses in any case
   * (internal/transport/ws_lineage_prohibitions_test.go).
   */
  private liveDescendantsOf(pane: Pane): LineageNode[] {
    const nodes: LineageNode[] = []
    let root: string | null = null
    for (const p of this.panes) {
      const edge = p.content.lineage?.()
      if (!edge) continue
      nodes.push({ ...edge, label: p.displayTitle })
      if (p === pane) root = edge.sessionId
    }
    if (root === null) return []
    return liveDescendants(root, nodes)
  }

  /** The close itself, once it is settled that it happens. */
  private commitClosePane(pane: Pane): void {
    const index = this.panes.indexOf(pane)
    if (index === -1) return

    // The pane's pending captures die with it: announce the close so the
    // backend destroys them (nocx-tsajw). Sent before the DOM teardown —
    // a dropped notification is covered by the transport-disconnect
    // trigger, which is the same destruction.
    this.client.notifyPaneClosed(pane.wireId)

    const wasActive = pane === this.activePane
    this.removeFromRecent(pane.id)

    pane.close()
    pane.pane.remove()
    this.tabStrip.removePane(pane.id)
    this.panes.splice(index, 1)

    if (this.panes.length === 0) {
      this.newPane()
      return
    }

    if (wasActive) {
      const mruPane = this.popRecent()
      if (mruPane) {
        void this.activate(mruPane)
      }
    }
  }

  /** Activate a pane: show its pane, mount content, focus. */
  async activate(pane: Pane): Promise<void> {
    log.info('nocx: PaneManager.activate() called', {
      paneId: pane.id,
      isActive: pane === this.activePane,
    })
    if (pane === this.activePane) {
      pane.focus()
      return
    }

    if (this.activePane) {
      this.pushRecent(this.activePane.id)
    }

    this.activePane?.setActive(false)
    this.activePane = pane
    pane.setActive(true)

    this.removeFromRecent(pane.id)
    this.tabStrip.setActive(pane.id)

    log.info('nocx: pane.setActive(true) called', {
      paneClasses: pane.pane.className,
    })
    await pane.start()
    pane.focus()
    this.onActivePaneChange?.()
  }

  activateByIndex(index: number): void {
    const pane = this.panes[index]
    if (pane) void this.activate(pane)
  }

  closeActivePane(): void {
    if (this.activePane) void this.closePane(this.activePane)
  }

  /** The active pane's terminal content, when the active pane is a terminal.
   *  Global actions (the quick-connect "Integrate this shell" item,
   *  the secret picker's insert) target it because the pane's own input
   *  presentation is the only place that knows where text should go;
   *  content itself owns the PROMPT_READY && trusted && owned gate. */
  activeTerminalContent(): TerminalContent | null {
    const content = this.activePane?.content
    return content instanceof TerminalContent ? content : null
  }

  /** The active pane's PANE element — the always-visible mount the snippet
   *  palette floats in (design §10.1: it must answer when the editor is
   *  hidden, so it cannot live inside the editor root). Null when no tab
   *  is active. */
  activePaneElement(): HTMLElement | null {
    return this.activePane?.pane ?? null
  }

  /** The ports.* target the ACTIVE tab scopes to (nocx-wzc4.8): the
   *  reserved "local" for a local shell, the saved-profile id for a
   *  saved-profile SSH tab, null otherwise (alias tab, Settings, …): the
   *  ports entry points are no-ops then. */
  portsTargetId(): string | null {
    return this.activeTerminalContent()?.portsTargetId ?? null
  }

  /** When portsTargetId is null because the pane walked into an environment
   *  we cannot enumerate, this names it. '' otherwise (nocx-695k.3). */
  portsUnavailableReason(): string {
    return this.activeTerminalContent()?.portsUnavailableReason ?? ''
  }

  /** The ACTIVE tab's origin for origin-following surfaces (the Files
   *  panel, design §5.4): the tab id from the Tab, the session and kind
   *  from the content's optional capability — never an instanceof branch,
   *  because the seam exists so PaneManager never learns which content
   *  class replied (terminal content answers from its session; viewer
   *  content answers from the binding it was opened with). Null when the
   *  active pane has no origin or its content does not implement the
   *  capability. */
  activeOrigin(): ActiveOrigin | null {
    const pane = this.activePane
    const origin = pane?.content.activeOrigin?.()
    return pane && origin ? { paneId: pane.id, ...origin } : null
  }

  /** The ACTIVE pane's surface type (B.8) — the seam chrome reads to answer
   *  "what kind of pane is in front" without instanceof tests. The sidebar's
   *  Settings collapse (nocx-3e3b) reads this through the composition root:
   *  the descriptor is the single owner of what a tab is, and neither
   *  activeTerminalContent() (null for viewer tabs too) nor activeOrigin()
   *  (null transiently while a session opens) can tell Settings apart.
   *  Null when no tab is active yet. */
  activeSurfaceType(): SurfaceType | null {
    return this.activePane?.descriptor.surfaceType ?? null
  }

  reorderPane(draggedId: number, targetId: number): void {
    const draggedIndex = this.panes.findIndex((t) => t.id === draggedId)
    const targetIndex = this.panes.findIndex((t) => t.id === targetId)
    if (draggedIndex === -1 || targetIndex === -1) return

    const [draggedPane] = this.panes.splice(draggedIndex, 1)
    const adjustedTarget = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex
    this.panes.splice(adjustedTarget, 0, draggedPane)

    this.tabStrip.reorder(this.panes)
  }

  // ── MRU helpers ──────────────────────────────────────────────────────

  private pushRecent(id: number): void {
    this.removeFromRecent(id)
    this.recentPaneIds.push(id)
  }

  private popRecent(): Pane | undefined {
    while (this.recentPaneIds.length > 0) {
      const id = this.recentPaneIds.pop()!
      const pane = this.panes.find((t) => t.id === id)
      if (pane) return pane
    }
    return undefined
  }

  private removeFromRecent(id: number): void {
    const idx = this.recentPaneIds.indexOf(id)
    if (idx !== -1) this.recentPaneIds.splice(idx, 1)
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────

  private readonly onKeydown = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || e.altKey) return

    if (e.key === 't') {
      e.preventDefault()
      e.stopPropagation()
      this.onActivity?.()
      this.newPane()
      return
    }

    if (e.key === 'w') {
      e.preventDefault()
      e.stopPropagation()
      this.onActivity?.()
      this.closeActivePane()
      return
    }

    // Cmd/Ctrl+1..9 — switch to tab by visual index (all tabs).
    const keyNum = Number(e.key)
    if (Number.isInteger(keyNum) && keyNum >= 1 && keyNum <= 9 && keyNum <= this.panes.length) {
      e.preventDefault()
      e.stopPropagation()
      this.onActivity?.()
      this.activateByIndex(keyNum - 1)
    }
  }
}
