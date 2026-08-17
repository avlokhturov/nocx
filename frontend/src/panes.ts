// ═══════════════════════════════════════════════════════════════════════════
// Pane and PaneManager — chrome and lifecycle over a model the BACKEND owns.
//
// Pane is chrome-only: it owns the pane element, display state, and delegates
// content lifecycle to a PaneContent instance. It implements PaneHost so
// content can push title, tooltip, attention, and close requests upward.
//
// PaneManager USED TO OWN THE ORDERED MODEL, and does not any more
// (nocx-isoph.4, design §4.1). The order, the membership and the decoration
// come from LayoutStore, which holds what the backend answered; this class
// asks for a change, renders the answer, and decides none of them. What is
// left here is chrome: which element is mounted, which pane is focused, and
// the MRU stack behind Cmd-W.
//
// THE MRU IS DELIBERATELY STILL HERE, and it is the one thing in this file
// that looks like state the epic should have moved. It is not: a window is a
// VIEWPORT (§10), so "which tab is in front" is a fact about a viewport and
// not about the chain — two windows on one workspace have two answers, and a
// stored one would be a fact with two owners the moment multi-window lands
// (nocx-mgbjx). §4.5's stored list says the same by omission: colour, name,
// position, pinned, layout, workspace_id, seen-mark, and no "active".
// ═══════════════════════════════════════════════════════════════════════════

import type { WSClient } from './ipc'
import { detectAgentStatus, type AgentStatus } from './agent-status'
import { type ClipboardAccess, type ClipboardGate } from './clipboard'
import type { ClipboardBanner } from './banner'
import type { ProfileClient } from './profiles'
import { adoptAliasProfile } from './profiles'
import { showToast } from './ui/toast'
import { showConfirm, showPrompt } from './ui/dialog'
import { LayoutStore } from './layout/layout-store'
import { tabLabel } from './layout/tab-label'
import { stripOrder } from './layout/strip-order'
import { isTabColour } from './layout/tab-colours'
import { uuidv7 } from './layout/uuid7'
import type { Pane as PaneRow } from './generated/layout.read'
import { leftRunningMessage, liveDescendants, type LineageNode } from './lineage'
import { closingWorkspaceMessage, type WorkspaceMember } from './live-work'
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
  /** THE PANE'S ONE IDENTITY: a UUIDv7 minted once per pane and never reused
   *  (nocx-tsajw, then nocx-isoph.4 §7). It is the id the layout chain stores,
   *  the id history.record scopes its captures to, and the id
   *  secrets.paneClosed names when they die — one identity, not one per seam.
   *  Chrome keeps its own numeric id for the DOM; this one is what crosses the
   *  wire, and it is durable: it must survive a restart, so it cannot come
   *  from a backend instance. */
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
  /** The tab's stored decoration, as the backend last answered. Never
   *  decided here — see setTabDecoration. */
  private _tabName: string | null = null
  private _colour: string | null = null
  private _pinned = false
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

  /**
   * What the strip shows for this tab.
   *
   * THE LABEL IS COMPUTED, NEVER STORED (§4.5): a name the user typed wins,
   * and otherwise the tab is named by its panes — which only works because a
   * pane is named by what is in it (the program's title, else the running
   * command, else the cwd; composed in terminal-content.ts). One pane per tab
   * today, so the list has one member; when a tab can hold several
   * (nocx-8m2x6) the composition moves up to a tab-level view and this getter
   * goes with it.
   *
   * The descriptor's default is the last resort, for a pane one round trip
   * old that has no title yet.
   */
  get displayTitle(): string {
    return tabLabel(this._tabName, [this._title]) || this.descriptor.defaultTitle
  }

  /**
   * The decoration the BACKEND stores for the tab this pane is in.
   *
   * Pushed in rather than read out: the Pane has no client and asks nobody —
   * PaneManager renders what LayoutStore holds, and a Pane that could fetch
   * its own colour would be a second reader of one fact.
   */
  setTabDecoration(d: { name: string | null; colour: string | null; pinned: boolean }): void {
    if (this._disposed) return
    if (d.name === this._tabName && d.colour === this._colour && d.pinned === this._pinned) return
    this._tabName = d.name
    this._colour = d.colour
    this._pinned = d.pinned
    this.onDisplayChange?.()
  }

  get colour(): string | null {
    return this._colour
  }

  get pinned(): boolean {
    return this._pinned
  }

  /** The name the user typed for this pane's tab, or null. Read by the
   *  rename prompt so it opens on what is there. */
  get tabName(): string | null {
    return this._tabName
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
  /** The chain, as the backend last answered. A cache, never an authority. */
  private readonly layout: LayoutStore
  /**
   * Whether the layout store answered at all.
   *
   * False is a real product state: the content store is encrypted and can
   * fail to open, and the transport then refuses every layout method. The
   * degrade is visible — a toast says tabs are not being remembered — because
   * a silent one is a feature that does not exist surviving a release. In
   * that state the renderer opens panes with ids of its own and asks for
   * nothing, which is what it did before this bead.
   */
  private layoutAvailable = false
  /** Panes the chain is KNOWN to hold, which is only ever true once the
   *  backend has answered. It is what tells "this row went away" apart from
   *  "this create has not landed yet" and from a view pane that was never in
   *  the chain at all. */
  private readonly registered = new Set<string>()
  /** ssh panes already reported as not reopened, so a redraw does not raise
   *  the same toast again. */
  private readonly reportedSSH = new Set<string>()
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
    layout: LayoutStore,
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
    this.layout = layout

    // Wire TabStrip intents.
    this.wireStrip(tabStrip)

    // ONE trigger for redrawing the strip: the cache changed. Every path that
    // asks the backend for something ends here rather than each one also
    // remembering to re-render — which is how two of them end up disagreeing
    // about what "after a close" looks like.
    this.layout.onChange(() => this.renderFromLayout())

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
    // The promise is assigned SYNCHRONOUSLY even though the work is not: the
    // composition root reads `initialPaneReady` in the same turn it calls
    // this, and that contract predates the read this now waits on.
    this._initialPaneReady = this.boot()
    return this._initialPaneReady
  }

  /**
   * Mount the strip, read the layout, and put on screen whatever the backend
   * says is there — or open one pane when it says nothing is.
   *
   * THE READ COMES FIRST, and that ordering is the bead: a renderer that
   * opened a pane and then asked would have decided what the window looks
   * like before finding out. Reloading with the backend still up therefore
   * brings back the tabs with their colours, names, order and pinning,
   * because none of it was ever here.
   *
   * What does NOT come back is the shell: a session dies with the backend
   * (D5) and a restored local pane starts a fresh one in its place. Blocks,
   * cwd and reconnecting an ssh pane are restore's (nocx-l21ib), not this.
   */
  private async boot(): Promise<void> {
    this.tabStrip.mount(this.hostFor(this.tabStrip))
    await this.readLayout()
    // readLayout's change notification has already adopted whatever the
    // backend holds; an empty chain means a first pane to open.
    const first = this.panes[0] ?? this.newPane()
    const content = first.content
    if (!(content instanceof TerminalContent)) {
      // `initialPaneReady` is what reports the app healthy, so it may only
      // ever resolve from terminal content.
      throw new Error('initial pane is not a terminal')
    }
    const ok = await content.ready
    if (!ok) throw new Error('initial pane failed to start')
  }

  /** Read the chain, and say so in the product when it cannot be read. */
  private async readLayout(): Promise<void> {
    // Set BEFORE the read, because the read's own change notification is
    // what puts the restored panes on screen: a flag set afterwards would
    // make the first — and most important — redraw the one that is skipped.
    this.layoutAvailable = true
    try {
      await this.layout.load()
    } catch (err) {
      this.layoutAvailable = false
      const message = err instanceof Error ? err.message : String(err)
      log.warn('nocx: the layout store is unavailable', { error: message })
      showToast({
        level: 'warning',
        message: 'Tabs are not being remembered — the layout store is unavailable',
      })
    }
  }
  // ── Tab creation ──────────────────────────────────────────────────────

  /**
   * The pane's one identity, and the row that goes with it.
   *
   * The id is minted HERE and the object is created THERE, which is §7's
   * split: a pane id is durable, so it cannot come from a backend instance,
   * and the row is the backend's to write. The chrome is built in the same
   * turn the user pressed the key; a refusal arrives on `created`, and a pane
   * the backend refused must not stay on screen.
   *
   * With no layout store the id is still a UUIDv7 and still one identity for
   * both history.record and secrets.paneClosed — it is simply not stored.
   */
  private mintPane(kind: 'local' | 'ssh', endpoint: string | null): string {
    if (!this.layoutAvailable) return uuidv7()
    const opened = this.layout.openTab({ kind, endpoint, cwd: '' })
    // ONE handler with both arms, not a .then() and a .catch(): two handlers
    // on the same promise leave the first one's rejection unhandled, which
    // surfaces as a process-level unhandled rejection rather than as the
    // toast below.
    void opened.created.then(
      () => {
        this.registered.add(opened.paneId)
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.error('nocx: the backend refused a new tab', { error: message })
        showToast({ level: 'danger', message: `Could not open a tab: ${message}` })
        const orphan = this.panes.find((p) => p.wireId === opened.paneId)
        if (orphan) this.dropChrome(orphan)
      },
    )
    return opened.paneId
  }

  /** Create a new local terminal pane and activate it: mint the identity,
   *  ask the backend for the tab, and put the chrome up in the same turn. */
  newPane(): Pane {
    return this.buildLocalPane(this.mintPane('local', null))
  }

  /** The chrome and content of a LOCAL terminal pane with a given identity —
   *  one implementation for a pane the user just asked for and a pane the
   *  chain already holds, because "a local pane" must not mean two things. */
  private buildLocalPane(wireId: string): Pane {
    const paneRef = { current: undefined as Pane | undefined }
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
    // The endpoint is the canonical user@host:port the pane applies at, which
    // is what §5 stores on an ssh pane. The profile it was opened from is NOT
    // stored — the chain has no column for it — which is why a restored ssh
    // pane cannot be reconnected yet: see adopt().
    const wireId = this.mintPane('ssh', endpointOf(host, user, port))
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
    // Every pane gets a wire identity — a view pane carries no captures, but
    // the chrome must still be able to announce a close (nocx-tsajw). It is
    // NOT registered in the layout chain: Settings and the file viewer are
    // surfaces the window shows, not durable panes with a cwd and a pipe, and
    // storing one would put a row in the chain that no restore could reopen.
    return this.addPane(content, descriptor, uuidv7())
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
    old.onRename = null
    old.onRecolour = null
    old.onPin = null

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
    strip.onRename = (id) => void this.renameTab(id)
    strip.onRecolour = (id, colour) => void this.recolourTab(id, colour)
    strip.onPin = (id, pinned) => void this.pinTab(id, pinned)
  }

  // ── decoration: asked for here, decided by the backend ────────────────

  /**
   * Rename the tab a pane is in, or clear the name.
   *
   * Cancelling and clearing are DIFFERENT answers and the prompt keeps them
   * apart: null is "I changed my mind" and an empty string is "take the name
   * off", which puts the tab back to the label its panes give it (§4.5) — a
   * real product state and the normal one.
   */
  private async renameTab(paneId: number): Promise<void> {
    const tab = this.tabFor(paneId)
    if (!tab) return
    const typed = await showPrompt('Rename tab', 'Name', tab.name ?? '')
    if (typed === null) return
    const name = typed.trim() === '' ? null : typed.trim()
    await this.ask(() => this.layout.rename(tab.id, name), 'Could not rename the tab')
  }

  private async recolourTab(paneId: number, colour: string | null): Promise<void> {
    const tab = this.tabFor(paneId)
    if (!tab) return
    await this.ask(() => this.layout.recolour(tab.id, colour), 'Could not colour the tab')
  }

  private async pinTab(paneId: number, pinned: boolean): Promise<void> {
    const tab = this.tabFor(paneId)
    if (!tab) return
    await this.ask(() => this.layout.pin(tab.id, pinned), 'Could not pin the tab')
  }

  /** The layout row behind a strip entry, or undefined when there is none —
   *  a Settings pane, or any pane at all while the layout store is down. */
  private tabFor(paneId: number) {
    const pane = this.panes.find((p) => p.id === paneId)
    return pane ? this.layout.tabOf(pane.wireId) : undefined
  }

  /**
   * Run one layout call and report a refusal.
   *
   * Nothing is applied here on success: the store writes the answer into the
   * cache and the cache's change notification redraws. That is what keeps a
   * refused call from moving anything — there is no optimistic step to undo.
   */
  private async ask(call: () => Promise<void>, whatFailed: string): Promise<void> {
    try {
      await call()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('nocx: ' + whatFailed, { error: message })
      showToast({ level: 'danger', message: `${whatFailed}: ${message}` })
    }
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
   * Close a workspace: every tab it holds goes, and the question that
   * precedes them NAMES what is live among them (nocx-isoph.6, design §4.1
   * and D6). "Close 4 tabs?" is a number nobody can weigh; that one of them
   * is a running deploy and another an ssh session into production is what
   * the answer actually turns on.
   *
   * The SAME ask as `closePane`'s, deliberately — one confirm path for
   * closes, one place where the renderer stops and asks. What differs is the
   * sentence, because the rule differs: closing a tab LEAVES its descendants
   * running (D6), and closing a workspace takes its members with it.
   *
   * `members` are the workspace's tabs, resolved by the caller: membership is
   * a fact the BACKEND owns (§4.4 — the session registry is the lifecycle
   * authority) and the renderer's cache of it arrives with nocx-isoph.4. This
   * method owns the ask and the close, and deliberately not the lookup.
   *
   * Returns whether the person said yes — a caller that must also tell the
   * backend (`workspaces.close`) needs to know, and must never send it before
   * the answer.
   *
   * NOTHING IS TORN DOWN BEFORE THE ANSWER. The close begins after the await
   * and not one step of it before, so cancelling leaves every tab, pane and
   * live session exactly as it was.
   */
  async closeWorkspace(name: string, members: readonly Pane[]): Promise<boolean> {
    const open = members.filter((pane) => this.panes.indexOf(pane) !== -1)
    const proceed = await showConfirm(
      closingWorkspaceMessage(
        name,
        open.map((pane) => this.liveWorkOf(pane)),
      ),
      'Close workspace',
      'Cancel',
    )
    if (!proceed) return false
    for (const pane of open) {
      // The world moved while the modal was open: a member may already be
      // gone, and closing it twice would take a pane that has since been
      // recycled under the same index. Re-checked per member, not once for
      // the set — they close one at a time.
      if (this.panes.indexOf(pane) === -1) continue
      // commitClosePane, not closePane: the person has just been asked about
      // this whole set, and asking again per member — once for the workspace
      // and once for every tab in it that opened another — is how a prompt
      // that matters gets dismissed by reflex. The prohibition it enforces is
      // untouched: a descendant OUTSIDE this workspace is not a member and is
      // not closed here.
      this.commitClosePane(pane)
    }
    return true
  }

  /** What one member tab of a workspace is doing, for the sentence that names
   *  it. Composed here for the same reason the lineage node is: live-work.ts
   *  owns the naming, the content answers for itself, and only the pane layer
   *  knows what the strip calls the tab. A content with no such capability —
   *  Settings, a viewer — is a tab that closes and is running nothing. */
  private liveWorkOf(pane: Pane): WorkspaceMember {
    const work = pane.content.liveWork?.() ?? null
    return {
      label: pane.displayTitle,
      command: work?.command ?? null,
      host: work?.host ?? null,
    }
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

  /**
   * The close itself, once it is settled that it happens.
   *
   * TWO MESSAGES, AND THEY ARE DIFFERENT ACTS (nocx-isoph.4). The
   * notification tells the capture registry that a scope is over — it touches
   * no store and needs no answer. panes.close removes the pane from the
   * durable chain, in a transaction that can also take the tab it emptied,
   * that tab's workspace, and mint a replacement tab. The renderer learns
   * what is left by asking, which the store's close does for it: what used to
   * be "if that was the last pane, open a fresh one" is now the backend's
   * replacement, adopted like any other row.
   *
   * Synchronous in signature on purpose. A caller closing several panes — the
   * workspace close asks once about the whole set — must not have to await
   * one before teaching the next, and the chrome teardown is what the user
   * sees; the wire call catches up.
   */
  private commitClosePane(pane: Pane): void {
    const index = this.panes.indexOf(pane)
    if (index === -1) return

    // Sent before the DOM teardown — a dropped notification is covered by the
    // transport-disconnect trigger, which is the same destruction.
    this.client.notifyPaneClosed(pane.wireId)

    const wasActive = pane === this.activePane
    this.removeFromRecent(pane.id)

    pane.close()
    pane.pane.remove()
    this.tabStrip.removePane(pane.id)
    this.panes.splice(index, 1)

    if (this.layoutAvailable && this.layout.tabOf(pane.wireId)) {
      void this.ask(
        () => this.layout.closePane(pane.wireId).then(() => undefined),
        'Could not close the tab',
      )
    } else if (this.panes.length === 0) {
      // No chain to ask, so the old rule stands: the window is never empty.
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

  /**
   * Ask for a new strip order.
   *
   * NOTHING MOVES HERE. The whole order is sent, the backend writes the
   * positions and answers with the tabs as stored, and the strip is redrawn
   * from that — so a refusal leaves the strip exactly where it was, with no
   * optimistic move to snap back from. That property is the bead's fourth
   * criterion and it is a consequence of where the write lands, not of a
   * rollback anybody had to remember to write.
   */
  reorderPane(draggedId: number, targetId: number): void {
    const draggedIndex = this.panes.findIndex((t) => t.id === draggedId)
    const targetIndex = this.panes.findIndex((t) => t.id === targetId)
    if (draggedIndex === -1 || targetIndex === -1) return

    if (!this.layoutAvailable) {
      // Nothing stores the order, so the strip is the only place it exists.
      const [draggedPane] = this.panes.splice(draggedIndex, 1)
      const adjustedTarget = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex
      this.panes.splice(adjustedTarget, 0, draggedPane)
      this.tabStrip.reorder(this.panes)
      return
    }

    const asked = [...this.panes]
    const [moved] = asked.splice(draggedIndex, 1)
    asked.splice(draggedIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, moved)
    // The request names TABS, because a strip entry is a tab: the ids must be
    // a permutation of the workspace's tabs or the backend refuses the whole
    // reorder — reordering a strip never changes membership.
    const tabIds: string[] = []
    for (const pane of asked) {
      const tab = this.layout.tabOf(pane.wireId)
      if (tab && !tabIds.includes(tab.id)) tabIds.push(tab.id)
    }
    if (tabIds.length === 0) return
    void this.ask(
      () => this.layout.reorder(this.layout.defaultWorkspaceId(), tabIds),
      'Could not reorder the tabs',
    )
  }

  // ── rendering what the backend says ──────────────────────────────────

  /**
   * Draw the strip from the cache: adopt rows that have no chrome, drop
   * chrome whose row is gone, apply the decoration, and put the entries in
   * the backend's order.
   *
   * Called from ONE place — the store's change notification — so every path
   * that asks for something ends up here and none of them re-implements what
   * "after that change" looks like.
   */
  private renderFromLayout(): void {
    if (!this.layoutAvailable) return
    const rows = this.layout.panes()
    for (const row of rows) {
      if (this.panes.some((p) => p.wireId === row.id)) continue
      this.adopt(row)
    }
    for (const pane of [...this.panes]) {
      // A pane with no row is either a view pane (Settings, a file viewer),
      // which was never in the chain, or one whose row has just gone. Only
      // the second is dropped, and the strip's own record of which is which
      // is the descriptor's surface type.
      if (rows.some((r) => r.id === pane.wireId)) continue
      // `registered` is what tells the two apart, and it is only ever set
      // once the backend has ANSWERED: a pane whose create is still in flight
      // has no row yet and must not be mistaken for one that has lost it.
      if (this.registered.has(pane.wireId)) this.dropChrome(pane)
    }
    this.applyDecoration()
    this.syncStripOrder()
  }

  /**
   * Put a pane the backend holds on screen.
   *
   * A LOCAL pane starts a fresh shell, which is §8's rule: the process died
   * with the backend and is never resurrected, so what comes back is the
   * pane, not its shell. Its cwd is not restored here — nothing revises a
   * pane's cwd yet, so the stored one is whatever it was opened with, and
   * reopening in it is restore's (nocx-l21ib).
   *
   * AN SSH PANE IS NOT ADOPTED, and the gap is named rather than papered
   * over: reconnecting needs the profile the pane was opened from, the chain
   * stores an endpoint and no profile, and opening a LOCAL shell for a row
   * that says ssh would be a lie about where the user is. Its row is left
   * exactly where it is — nothing is deleted — and the count is reported, so
   * restore finds the rows waiting rather than a chain the renderer tidied.
   */
  private adopt(row: PaneRow): void {
    if (row.kind === 'ssh') {
      if (this.reportedSSH.has(row.id)) return
      this.reportedSSH.add(row.id)
      log.warn('nocx: an ssh pane was not reopened', { pane: row.id, endpoint: row.endpoint })
      showToast({
        level: 'warning',
        message: `A connection to ${row.endpoint ?? 'a host'} was not reopened — open it again to reconnect`,
      })
      return
    }
    this.registered.add(row.id)
    this.buildLocalPane(row.id)
  }

  /** Remove chrome without touching the chain: the row is already gone. */
  private dropChrome(pane: Pane): void {
    const index = this.panes.indexOf(pane)
    if (index === -1) return
    const wasActive = pane === this.activePane
    this.removeFromRecent(pane.id)
    pane.close()
    pane.pane.remove()
    this.tabStrip.removePane(pane.id)
    this.panes.splice(index, 1)
    this.registered.delete(pane.wireId)
    if (wasActive) {
      const next = this.popRecent() ?? this.panes[0]
      if (next) void this.activate(next)
    }
  }

  /** Push each tab's stored decoration into its pane's chrome. */
  private applyDecoration(): void {
    for (const pane of this.panes) {
      const tab = this.layout.tabOf(pane.wireId)
      const colour = tab?.colour ?? null
      pane.setTabDecoration({
        name: tab?.name ?? null,
        // A colour this renderer does not know draws as none rather than as a
        // broken swatch: what is stored is the store's business.
        colour: isTabColour(colour) ? colour : null,
        pinned: tab?.pinned === true,
      })
    }
  }

  /** Order the strip the way the backend's positions and pins say. */
  private syncStripOrder(): void {
    const ordered: Pane[] = []
    for (const tab of stripOrder(this.layout.tabs())) {
      for (const row of this.layout.panesOf(tab.id)) {
        const chrome = this.panes.find((p) => p.wireId === row.id)
        if (chrome && !ordered.includes(chrome)) ordered.push(chrome)
      }
    }
    // Panes the chain does not hold — a Settings pane, a file viewer — keep
    // their relative order after the ones it does. They are chrome the window
    // shows, so nothing in the backend has an opinion about where they sit.
    for (const pane of this.panes) {
      if (!ordered.includes(pane)) ordered.push(pane)
    }
    this.panes.splice(0, this.panes.length, ...ordered)
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

/**
 * The canonical `user@host:port` an ssh pane applies at — what §5 stores as
 * the pane's endpoint.
 *
 * Canonical means every part is written even when it was defaulted, because
 * the stored value is what a restore reconnects to and "the port I did not
 * type" is not a fact anyone can look up later. The user is omitted when the
 * connection did not name one: the remote's default user is the far end's to
 * decide, and inventing one here would store a fact nobody stated.
 */
function endpointOf(host: string, user?: string, port?: number): string {
  return `${user ? `${user}@` : ''}${host}:${port ?? 22}`
}
