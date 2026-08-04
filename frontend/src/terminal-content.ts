// ═══════════════════════════════════════════════════════════════════════════
// TerminalContent — all terminal machinery behind the TabContent seam.
// Extracted from Tab so the chrome layer never touches a session or renderer.
// ═══════════════════════════════════════════════════════════════════════════

import { XtermRenderer } from './renderers/xterm'
import type { TerminalRenderer, MarkerAdapter } from './renderers/types'
import { InputStateController } from './input-state'
import { CommandEditor } from './editor'
import { shellExtensions } from './shell-highlight'
import { RecallOverlay, queryLedgerHistory, withSessionText } from './recall'
import { CompletionController } from './suggest/controller'
import { createShellProviders } from './suggest/providers'
import { CompletionDropdown } from './ui/completion-dropdown'
import type { FsComplete } from './generated/fs.complete'
import type { ShellComplete } from './generated/shell.complete'
import { ShellInputTarget } from './input-target'
import {
  submitCommand,
  planSubmit,
  planSubmitSync,
  isSubmitFailure,
  type SubmitPlan,
} from './submit'
import { secretChipExtension } from './secret-chip'
import { secretCandidateExtension } from './secret-candidate'
import { unresolvedRedactionField } from './unresolved-redactions'
import { PromptVaultController } from './prompt-vault'
import { VaultClient } from './vault-client'
import { showToast } from './ui/toast'
import { BlockReceipt } from './ui/block-receipt'
import type { HistoryRecord } from './generated/history.record'
import { renderRecordedCommand } from './scrollback/blocks'
import { KIND_LABELS } from './secret-kind'
import { shouldShowEditor, NATIVE_RESTORE } from './native-mode'
import { environmentEntry, type EnvironmentEntry } from './environment-commands'
import { shouldCopy, type ClipboardAccess, type ClipboardGate } from './clipboard'
import type { ClipboardBanner } from './banner'
import { ScrollbackController } from './scrollback/controller'
import type { BlockRecord } from './scrollback/blocks'
import { CommandLedger } from './command-ledger'
import { queryHistory, recordCommand } from './history-client'
import { log } from './log'
import type { WSClient, SessionHandle } from './ipc'
import { showConfirm } from './ui/dialog'
import { hasOpenOverlays } from './ui/overlay/stack'
import { BaseTabContent, type TabHost, type ContentViewport } from './tab-content'
import { type ProfileClient, type SSHAliasEntry } from './profiles'
import { RpcError } from './dispatcher'
import { FloatingPanel } from './ui/floating-panel'
import { ShellClient } from './shell-client'
import type { ShellIntegrateResult } from './generated/shell.integrate'
import { LOCAL_TARGET_ID } from './ports-client'
import {
  CAPABILITY_LABELS,
  deriveCapability,
  type Capability,
  type CapabilityAction,
  type ShellIntegrationPolicy,
} from './capability'
import { createCapabilityChip } from './ui/capability-chip'
import type { Open } from './generated/open'

// How long the grid must hold still before the PTY is told about it.
const RESIZE_SETTLE_MS = 80

// How long an in-band integration attempt may run before the lease is
// released (spec §4.4). Generous on purpose: a slow shell startup or a busy
// pty must never truncate a stream mid-delivery; the wrapper itself is fast.
const IN_BAND_TIMEOUT_MS = 15_000

/**
 * How long output is treated as the shell's answer to a resize rather than as
 * unread activity.
 *
 * Generous on purpose. Getting it wrong in one direction lights an indicator
 * that lies about a tab; getting it wrong in the other costs one missed
 * indicator on a tab the user resized a moment ago and is therefore watching.
 * Those are not symmetric.
 */
const RESIZE_ECHO_MS = 400

/**
 * Whether a settle call failed because the backend no longer holds the
 * capture — it was destroyed by the tab closing, the vault sealing, the
 * transport dropping, or the record that carried it failing.
 *
 * The distinction matters at the surface: this one can never succeed, so
 * the row goes and the receipt says the offer is gone. Every other failure
 * is worth another press.
 */
function isCaptureGone(err: unknown): boolean {
  return err instanceof RpcError && (err.code === -32010 || err.code === -32011)
}

/**
 * Whether `el` is somewhere the user types on purpose.
 *
 * Used to keep the terminal's document-level key rescue off other people's
 * fields. `isContentEditable` is checked too: a rich-text surface is a text
 * entry even though it is neither an input nor a textarea.
 */
function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** The host callbacks a tab may hand a TerminalContent. Named rather than
 *  positional: they are all optional functions, so any misalignment between
 *  them type-checks cleanly and fails only in front of a user. */
export interface TerminalContentHooks {
  /** Pushes the strip's optional second line — the tab's location, or ''
   *  when the title already says it. Only TerminalContent holds both halves
   *  of that question. */
  onSubtitleChange?: (subtitle: string) => void
  /** The session is an alias (not a saved profile) and can be adopted as a
   *  nocx connection. True = adoptable, false = not. */
  onAdoptabilityChange?: (adoptable: boolean) => void
  /** The environment degraded or became uncertain — integration declined at
   *  open, or markers stopped on an integrated session (nested ssh, docker
   *  exec). Tab chrome renders at most this small warning mark
   *  (nocx-4t37.2); the capability statement itself lives in the rail. */
  onWarningChange?: (warning: boolean) => void
  /** The pane entered or left an environment, so the ports panel's target
   *  changed without the active tab changing (nocx-695k.3). */
  onPortsTargetChange?: () => void
  /** An SSH connection failed because the vault is sealed. */
  onVaultSealed?: () => void
  /** The reference picker's setup offer needs the setup dialog (no OS key):
   *  the vault layer owns it — wired by main.tsx to
   *  vaultController.openSetup. */
  onSetupVault?: () => void
  /** The reference picker's "Add a secret…" row: open the vault's own
   *  create dialog — wired by main.tsx to the Settings tab's Secrets page. */
  onCreateSecret?: (name: string) => void
}

// No placeholder title — see the descriptor in tabs.ts for why. A tab with no
// name yet shows nothing rather than a word that is never the answer.
const FALLBACK_TITLE = ''

/**
 * Names a tab after its directory, the way every other terminal does.
 * Keeps the tail — the CSS ellipsis cuts from the right.
 */
function directoryLabel(cwd: string): string {
  const path = cwd.trim().replace(/\/+$/, '')
  if (!path) return FALLBACK_TITLE
  const parts = path.split('/').filter(Boolean)
  if (path === '~' || parts.length === 0) return path || FALLBACK_TITLE
  return parts.slice(-2).join('/')
}

/**
 * Tooltip for a cwd. When the value comes from session open (no OSC 7 yet)
 * the tooltip surfaces that fact (AD-5 fallback visibility).
 */
function cwdTooltip(cwd: string, fromOSC7: boolean): string {
  if (!cwd) return ''
  return fromOSC7 ? cwd : `${cwd} (initial cwd)`
}

/**
 * TerminalContent owns the renderer, session, editor, scrollback, command
 * ledger, input-state machine, and PTY resize policy. It receives geometry
 * through viewportChanged() — it NEVER interprets container geometry itself.
 */
export class TerminalContent extends BaseTabContent {
  private renderer: TerminalRenderer | null = null
  private session: SessionHandle | null = null
  private editor: CommandEditor | null = null
  private shellTarget: ShellInputTarget | null = null
  private scrollback: ScrollbackController | null = null
  private ledger: CommandLedger | null = null
  /** The vault RPC client, built over this tab's WS client (the shared
   *  dispatcher — the sealed-access seam it carries is already installed at
   *  the app root). */
  private vault: VaultClient | null = null
  /** The after-submit capture receipts, keyed by the frozen block each one
   *  is mounted in. Several can be open at once: an offer lives until it is
   *  answered, and deciding about a key is rarely the next thing anyone
   *  does — you run one more command first, and under the old
   *  one-at-a-time rule that lost the offer for good.
   *
   *  `receipt` is the newest of them: the one ⌘S acts on and the one the
   *  focus-bounce yields to. */
  private readonly receipts = new Map<HTMLElement, BlockReceipt>()
  private receipt: BlockReceipt | null = null
  private receiptBlockEl: HTMLElement | null = null
  /** Capture id → the block its receipt is mounted in, so a hover
   *  emphasises the chip in the RIGHT block when several are open. */
  private readonly receiptChipBlocks = new Map<string, HTMLElement>()
  /** Ledger record id → the block record captured at onComplete time (the
   *  same object freezeBlock mutates in place). The ack is an async round
   *  trip, so by the time it resolves the block is frozen — but the user
   *  may have submitted again or cleared the scrollback; the identity is
   *  checked against the live DOM, never looked up as "the most recent
   *  block". */
  private readonly pendingReceiptBlocks = new Map<number, BlockRecord>()
  /** Capture id → the redaction span of the chip in the block's command
   *  line, for the receipt's hover emphasis (chips carry the span; rows
   *  carry the capture id). */
  private readonly receiptChipSpans = new Map<string, { start: number; end: number }>()
  /** The prompt's vault surfaces: the '@' picker, the composition-time
   *  candidate, and the resolve-at-submit wiring. */
  private promptVault: PromptVaultController | null = null
  private completion: CompletionController | null = null
  private recall: RecallOverlay | null = null
  private inputState = new InputStateController()
  private _markers = new Map<number, MarkerAdapter>()
  private _pendingCommand = ''
  private _globalKeydown: ((e: KeyboardEvent) => void) | null = null
  private _cwd = '~'
  private _host = ''
  private _lastExitCode: number | null = null
  private _bufferType: 'normal' | 'alternate' = 'normal'
  private nativeMode = false
  private _disposed = false
  private mountAbortController: AbortController | null = null
  private resizeTimer: number | undefined
  /** Timestamp until which incoming data is the echo of a resize we sent. */
  private echoUntil = 0
  private host: TabHost | null = null
  /** Whether the editor currently owns DOM keyboard input (owned from input-state). */
  private _editorOwned = false
  /** In-flight alias-fetch counter — generation for stale-request gating. */
  private _aliasFetchId = 0

  // ── Capability rail (nocx-4t37.2) ──────────────────────────────────
  /** The resolved launch policy from the open ack (auto|ask|off): the
   *  connection-scope default the capability control starts from. off
   *  refuses even the explicit in-band path. */
  private _policy: ShellIntegrationPolicy = 'auto'
  /** Why integration did not happen at open; empty means it succeeded or
   *  was never attempted. A non-empty reason on an auto profile is the
   *  soft degrade AGENTS.md demands be visible in the product. */
  private _openReason: Open['shellIntegrationReason'] = ''
  /** The observed capability statement (never the axis): what is true
   *  right now at the pending command. */
  private _capability: Capability = 'native-input'
  /** The environment degraded or became uncertain — integration declined at
   *  open, or markers stopped on an integrated session the user did not
   *  latch native. Tab chrome renders at most this mark. */
  private _degraded = false
  /** The pane-level rail above the pending command: the capability chip,
   *  its action popover, and nothing else. */
  private _rail: HTMLElement | null = null
  private _railChip: HTMLElement | null = null
  private _railPopover: FloatingPanel | null = null
  private _railOpen = false
  private _railOutsideHandler: ((e: MouseEvent) => void) | null = null
  private _railEscapeHandler: ((e: KeyboardEvent) => void) | null = null
  /** Whether OSC 133 markers have arrived for the shell currently on stdin.
   *  Environment-scoped: entering a nested environment (ssh, docker exec, …)
   *  clears it; the D that ends that command restores what was true before.
   *  Set by the marker handler only (AD-6), never by inference. */
  private _shellIntegrated = false
  /** Environments entered by commands we submitted, innermost last. Pushed
   *  on submit, popped on the D that ends that command (nocx-695k.2). */
  private _envStack: EnvironmentEntry[] = []
  /** Stack of _shellIntegrated values saved before entering a nested
   *  environment. Pushed on submit when isEnvironmentEntry() is true;
   *  popped on the D marker that ends the command. */
  private _previousIntegrated: boolean[] = []

  // ── In-band integration (nocx-ynsx, spec §4.4) ─────────────────────
  /** True while an in-band integration lease is held; rejects re-entry. */
  private _integrating = false
  /** The OSC 1337 READY listener of the in-flight attempt. */
  private _inBandReadyUnsub: (() => void) | null = null
  /** The editor draft (text, selection, scroll) captured at lease start;
   *  restored byte-for-byte on completion, cancel, timeout and error. */
  private _inBandDraft: { text: string; from: number; to: number; scrollTop: number } | null = null
  /** Capture-phase keydown that swallows every key except Esc while the
   *  lease is held — no user keystroke may interleave with the bootstrap. */
  private _inBandKeySwallow: ((e: KeyboardEvent) => void) | null = null
  /** The "Integrating this shell…" indicator (kit FloatingPanel). */
  private _inBandPanel: FloatingPanel | null = null
  /** Fires at the next OSC 133 A — the wrapper finished and the shell is
   *  back at a prompt. */
  private _inBandDone: (() => void) | null = null
  /** The plan's terminator, known once the RPC answered. */
  private _inBandTerminator: string | null = null
  /** READY was received: the wrapper is inside sed and only the terminator
   *  can unblock it. */
  private _inBandReadySeen = false
  /** Overall attempt deadline; Esc cancels before it. */
  private _inBandTimer: number | undefined

  // ── Title composition ────────────────────────────────────────────────
  // Title = programTitle || cwdTitle (no placeholder — nocx-83a)
  // Computed here so the host receives the final string.
  private programTitle = ''
  private cwdTitle = ''

  // Grid dimensions computed by the renderer from the last authoritative
  // viewport. Owned here so PTY resize policy lives with the content.
  cols = 0
  rows = 0

  // _readyPromise resolves true when the renderer mounts and the PTY session
  // opens; resolves false when mount() throws. Never rejects.
  private readonly _readyPromise: Promise<boolean>
  private _readyResolve!: (value: boolean) => void

  constructor(
    private readonly client: WSClient,
    private readonly clipboard: ClipboardAccess,
    private readonly gate: ClipboardGate,
    private readonly banner: ClipboardBanner,
    /** Live SSH config alias source for the editor hint (w7-hint). Null when
     *  unavailable (tests, raw-mode-only contexts). */
    private readonly profileClient: ProfileClient | null,
    private readonly onTooltipChange: (tooltip: string) => void,
    private readonly sshOpts?: {
      profileId: string
      host: string
      user?: string
      port?: number
    },
    /** The optional host callbacks, NAMED. They used to be four trailing
     *  positional parameters, and a caller that skipped the middle two put
     *  onSetupVault into the onAdoptabilityChange slot — so on a local tab
     *  the picker's "set up the vault" row answered Enter by calling
     *  nothing, and nothing could have caught it: every one of them is an
     *  optional function, so every misalignment type-checks. */
    private readonly hooks: TerminalContentHooks = {},
  ) {
    super()
    this._readyPromise = new Promise<boolean>((resolve) => {
      this._readyResolve = resolve
    })
  }

  /**
   * Resolves true when the renderer mounts and the PTY session opens;
   * resolves false when mount() throws. Never rejects. The initial-tab
   * health signal reads this — NOT a generic "first tab mounted" signal.
   */
  get ready(): Promise<boolean> {
    return this._readyPromise
  }

  /** The ports.* target this tab's session scopes to (nocx-wzc4.8): the
   *  reserved "local" for a local shell, the saved-profile id for a
   *  saved-profile SSH tab, null for an alias tab — an alias has no
   *  profile until it is adopted, so it has no valid ports scope. */
  get portsTargetId(): string | null {
    // Inside an environment we entered by hand there is nothing we can
    // speak for: remote discovery needs a MANAGED connection (a second exec
    // channel on a connection we own), and a hand-typed `ssh` is a child
    // process of the local shell. Reporting the local target here is what
    // put this machine's listeners under a tab sitting on a Pi.
    if (this.currentEnvironment()) return null
    if (this.sshOpts === undefined) return LOCAL_TARGET_ID
    return this.sshOpts.profileId || null
  }

  /** Why portsTargetId is null, when it is null because the pane went
   *  somewhere we cannot enumerate. '' when there is no such reason. */
  get portsUnavailableReason(): string {
    const env = this.currentEnvironment()
    return env ? env.label : ''
  }

  /** Push the composed title to the host: program title, else the cwd label. */
  private pushTitle(): void {
    if (!this.host) return
    const title = this.programTitle || this.cwdTitle
    this.host.setTitle(title)
    // The location line earns a row only when the title is a name of its own.
    // With no program title the title IS the location, and a second line would
    // print the first one again.
    this.hooks.onSubtitleChange?.(this.programTitle ? this.locationLine() : '')
  }

  /** Where this tab is: the nested environment if we are inside one, else
   *  `user@host` for SSH, else the working directory.
   *
   *  The nested case is the one that was missing and it is the common one:
   *  a user types `ssh pi@192.168.0.93` in a local tab, and every surface
   *  that named a place went on naming the local machine — the tab title
   *  kept whatever the remote shell's OSC 2 last set, the location chip
   *  stayed hidden because a local session grows none, and the cwd chip
   *  went on showing the local directory while the prompt was elsewhere
   *  (owner, 2026-08-04, three times). We know the destination because we
   *  submitted the line (ADR-0004 §2) — no integration, no sniffing. */
  private locationLine(): string {
    const env = this.currentEnvironment()
    if (env) return env.label
    if (this.sshOpts) {
      return this.sshOpts.user ? `${this.sshOpts.user}@${this.sshOpts.host}` : this.sshOpts.host
    }
    return this._cwd
  }

  /** The innermost environment entered by a command we submitted, or null
   *  when the pane is in the environment its session started in. */
  private currentEnvironment(): EnvironmentEntry | null {
    return this._envStack.length > 0 ? this._envStack[this._envStack.length - 1] : null
  }

  /** Push every surface that names a place at the current environment. The
   *  cwd is deliberately BLANK inside a nested environment: we know the
   *  host and we do not know the directory until OSC 7 arrives, and a stale
   *  local directory under a remote prompt is the lie this fixes. */
  private syncLocation(): void {
    const env = this.currentEnvironment()
    const location = env ? env.label : this.sshOpts ? this.locationLine() : ''
    this.scrollback?.blockManager.setLocation(location)
    this.editor?.setLocation(location)
    if (env) {
      this.editor?.setCwd('')
      this.cwdTitle = env.label
      this.programTitle = ''
    }
    this.pushTitle()
  }

  // ── TabContent ──────────────────────────────────────────────────────────

  async mount(target: HTMLElement, host: TabHost, signal: AbortSignal): Promise<void> {
    if (this._disposed) return
    this.host = host

    // Wire the signal: if the tab is disposed during mount, abort.
    if (signal.aborted) {
      this._readyResolve(false)
      return
    }
    this.mountAbortController = new AbortController()
    const onAbort = () => this.mountAbortController!.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      // Wait for pane to become visible and have proper dimensions.
      await new Promise((resolve) => requestAnimationFrame(resolve))

      if (signal.aborted) {
        this._readyResolve(false)
        return
      }

      log.info('nocx: creating renderer')
      const renderer = new XtermRenderer()

      // ── DOM scrollback controller ───────────────────────────────────────
      this.scrollback = new ScrollbackController({
        pane: target,
        renderer,
        now: () => performance.now(),
        // The renderer owns this tab's OSC 636 store; the scrollback's frozen
        // headers and the editor below must judge against the same instance.
        snapshotStore: renderer.snapshotStore,
      })

      log.info('nocx: mounting renderer')
      await renderer.mount(this.scrollback.mountTarget)

      if (signal.aborted) {
        renderer.dispose()
        this.scrollback.dispose()
        this._readyResolve(false)
        return
      }

      log.info('nocx: renderer mounted', { cols: renderer.cols, rows: renderer.rows })
      this.cols = renderer.cols
      this.rows = renderer.rows

      // ── Command ledger (ADR-0008) ────────────────────────────────────────
      // A completed record is shipped to the store over the control plane
      // (nocx-rtg0.13, AD-1 as amended): the renderer derives the facts
      // from the byte stream it already owns, and recordCommand is the one
      // seam that crosses. Best-effort by design — a dropped record is a
      // session-lost entry, never a terminal error.
      this.ledger = new CommandLedger({
        // Wall-clock epoch milliseconds: the ledger's timestamps are
        // persisted, survive a restart, and render as relative wall time
        // (nocx-rtg0.16) — performance.now() would be swept as 1970.
        now: () => Date.now(),
        onComplete: (rec) => {
          // The block identity, captured at onComplete time: at the D
          // marker this runs BEFORE scrollback.onCommandEnd freezes the
          // block, so the running block record IS the object freezeBlock
          // mutates in place. The ack is an async round trip — by the time
          // it resolves the block is frozen, but the user may have
          // submitted again or cleared the scrollback — so the receipt
          // attaches by this captured identity, never "the most recent
          // block", and a block that is gone by then drops the receipt
          // silently.
          const block = this.scrollback?.blockManager.runningBlock
          if (block) this.pendingReceiptBlocks.set(rec.id, block)
          void recordCommand(this.client, rec).then((ack) => {
            this.pendingReceiptBlocks.delete(rec.id)
            if (ack === null || ack.maskedCommand === undefined) return
            this.attachRecordedAck(rec.id, block, ack)
          })
        },
      })

      // ── Wire input ownership BEFORE opening the session ─────────────────
      // Completion (design §8.7–§8.9): the dropdown + ghost text surface,
      // composed here so the editor stays passive. Providers: command names
      // from the OSC 636 snapshot (this renderer's own — correct on a remote
      // host, it is the running shell's answer), history over the control
      // plane (environment-scoped, the directory rung), and local filesystem
      // paths — active only when this tab's session is a local shell, so a
      // local path can never masquerade as a remote one (§8.5).
      this.completion = new CompletionController({
        providers: createShellProviders({
          store: renderer.snapshotStore,
          queryHistory: (cwd, host) => queryHistory(this.client, 'directory', cwd, host),
          completeFs: (text, cwd) => this.client.call<FsComplete>('fs.complete', { text, cwd }),
          // The remote completion adapter (nocx-w7h.15): active only on
          // remote sessions, where it asks the remote shell's own
          // completion machinery — paths from the remote filesystem,
          // command names, and command-specific completions from bash
          // completion functions.
          completeShell: (params) => this.client.call<ShellComplete>('shell.complete', params),
          sessionId: () => this.session?.sessionId ?? '',
          // The host provider is built inside createShellProviders (the
          // assembly it routes is plain code, not the DOM-bound quick-connect
          // module); this tab's ProfileClient is handed through, absent when
          // no connection manager is wired.
          profileClient: this.profileClient ?? undefined,
        }),
        dropdown: new CompletionDropdown({
          onHover: (index) => this.completion?.select(index),
          onPick: (index) => this.completion?.acceptIndex(index),
        }),
        env: () => ({ isLocal: !this.sshOpts, cwd: this._cwd, host: this._host }),
        recallIsOpen: () => this.recall?.isOpen ?? false,
      })
      this.shellTarget = new ShellInputTarget(
        (text: string) => renderer.paste(text),
        (data: string) => this.session!.send(data),
        // The target carries the shell's editor extensions through the §8.8
        // seam: the shell highlighter, the completion surface, the
        // vault-reference chip (a document-level decoration, not a
        // language), the quiet composition-time candidate mark, and the
        // unresolved-redaction field a recalled masked row registers in.
        [
          ...shellExtensions(renderer.snapshotStore),
          ...this.completion.extensions(),
          secretChipExtension(),
          secretCandidateExtension(),
          unresolvedRedactionField,
        ],
      )
      const vault = new VaultClient(this.client)
      this.vault = vault
      this.editor = new CommandEditor(
        {
          // The resolve half of ADR-0021, BEFORE the atomic handoff: a line
          // with references is resolved through vault.resolveLine; the
          // RESOLVED line goes to the PTY, the reference-intact line to the
          // ledger and history.record. A sealed vault or an unresolved name
          // is reported and the draft stays — never a silent send of a
          // broken line (the editor's beforeSubmit seam keeps the draft on
          // false). A plain line resolves SYNCHRONOUSLY (planSubmitSync) —
          // an ordinary Enter keeps its no-gap atomic handoff. A recalled
          // masked row is refused first: the draft stays and resolution
          // opens on the first chip (ADR-0021's consequence).
          beforeSubmit: (doc) => {
            if (this.promptVault?.openResolution()) return false
            const sync = planSubmitSync(doc)
            if (sync) return sync
            return planSubmit(doc, (line) => vault.resolveLine(line)).then((verdict) => {
              if (isSubmitFailure(verdict)) {
                this.reportSubmitFailure(verdict)
                return false
              }
              return verdict
            })
          },
          submit: (doc: string, plan?: SubmitPlan) => {
            const recordLine = plan?.recordLine ?? doc
            this._pendingCommand = recordLine
            // Track environment entry (nocx-695k.1): if the submitted
            // command enters a new shell environment, save the current
            // marker fact and clear it — the pane is now on a different
            // host whose markers we have not seen. The D that ends this
            // command restores the prior value.
            const entered = environmentEntry(recordLine)
            if (entered) {
              this._previousIntegrated.push(this._shellIntegrated)
              this._shellIntegrated = false
              this._envStack.push(entered)
              this._updateCapability()
              this.syncLocation()
              this.hooks.onPortsTargetChange?.()
            }
            // Proactive save for a hand-typed `ssh <target>` is nocx-pu4.4,
            // NOT part of this task — the ad-hoc SSH tab's adopt affordance
            // already covers the quick-connect path.
            // The previous command's receipt is deliberately LEFT alone.
            // Submitting again used to destroy its capture on the backend
            // and retire the receipt here, which meant that running one
            // more command before deciding lost the offer for good.
            if (this.ledger) {
              let markerLine: () => number | undefined = () => undefined
              const rec = this.ledger.open(recordLine, this._cwd, this._host, () => markerLine())
              const m = renderer.registerMarker()
              if (m) {
                markerLine = () => m.line()
                this._markers.set(rec.id, m)
                m.onDispose(() => {
                  this.ledger?.dispose(rec.id)
                  this._markers.delete(rec.id)
                })
              }
            }
            this.scrollback?.maybeClear(recordLine)
            submitCommand(doc, {
              dispatchSubmit: () => this.inputState.dispatch({ type: 'submit' }),
              focusGrid: () => renderer.focus(),
              sendDoc: (d) => void this.shellTarget!.submit(d),
            })
          },
          cancel: () => this.session?.send('\x03'),
          // A taller editor is a shorter scrollback. Keep the bottom of the
          // transcript where it belongs — just above the editor — instead of
          // letting it slide underneath.
          resized: () => this.scrollback?.scrollToBottom(),
          /** Detect `ssh <partial>` pattern and show matching aliases, and
           *  drive the vault surfaces (the candidate's detection, the
           *  picker's passive filter). */
          onInputChange: (text) => {
            this._onEditorInput(text)
            // A keystroke aborts the completion query in flight and starts a
            // fresh one (design §8.9.2); the ghost text re-anchors.
            this.completion?.onDocChanged()
            this.promptVault?.onDocChanged(text)
          },
          /** A programmatic clear (submit, Esc, Ctrl-C): the vault surfaces
           *  hold stale findings over a cleared line. */
          onDocCleared: () => {
            this.promptVault?.reset()
          },
          /** '@' at a word start — the reference picker's passive trigger.
           *  Opening it closes the completion dropdown: the surfaces never
           *  stack (the mutual-exclusion rule). */
          onSecretPicker: (triggerPos) => {
            this.completion?.dismiss()
            this.promptVault?.onSecretPicker(triggerPos)
          },
          /** Hint acceptance — no cache to invalidate. */
          onAcceptHint: () => {},
          /** Up on the first line (or an empty draft): no further caret
           *  movement, so open the recall overlay (design §8.10 v6). */
          onUpAtTop: () => {
            void this.recall?.open('directory')
          },
          /** Tab opens the completion dropdown (§8.7's decided option 1). */
          onTab: () => this.completion?.open(),
          /** The save chord: a live receipt's primary action outranks the
           *  composition-time candidate; ⇧⌘S moves focus into the receipt
           *  for review. Returns whether anything was triggered (the editor
           *  consumes the chord either way). */
          onSave: (shift) => {
            // The chord acts on the NEWEST unanswered receipt; with none
            // open it falls through to the composition-time candidate.
            if (this.receipt) {
              if (shift) this.receipt.enterReview()
              else this.receipt.saveAll()
              return true
            }
            return this.promptVault?.saveCandidate() ?? false
          },
        },
        // The language is chosen HERE, not inside the editor. CommandEditor
        // must stay language-agnostic (ADR-0010 §Decision 3): the agent target
        // will want prose with mentions on this same surface, and an editor
        // that defaults to shell would have to be edited to gain one — exactly
        // what ADR-0004 §3 exists to prevent. The seam (design §8.8) carries
        // the shell layer: the target supplies its extensions, the editor
        // never hard-codes them.
        this.shellTarget.editorExtensions?.() ?? [],
      )
      this.editor.mount(target)
      this.completion.attach(this.editor, this.editor.root)
      this.promptVault = new PromptVaultController({
        editor: this.editor,
        vault,
        report: (level, message) => showToast({ level, message }),
        requestSetupDialog: () => this.hooks.onSetupVault?.(),
        requestCreateSecret: (name) => this.hooks.onCreateSecret?.(name),
      })
      this.promptVault.mount()

      // ── Recall overlay (Provenance Recall, design §8.10) ────────────────
      // The history palette above the prompt. Rows are served by the store
      // over the control plane (history.query, source=store); when the
      // store cannot answer, the overlay falls back to the in-memory ledger
      // with source=session, which the panel labels "this session only" —
      // presenting one session as all history is the same lie as marking
      // every command green. The editor's key arbiter gives the overlay
      // first refusal while it is open; navigating previews into the
      // editor, and Enter executes through the editor's own submit path
      // (nocx-w7h.5).
      this.recall = new RecallOverlay({
        editor: this.editor,
        query: async (scope, text) => {
          try {
            const page = await queryHistory(this.client, scope, this._cwd, this._host, text)
            // A command run in THIS session comes back as it was run, not as
            // the store had to keep it (nocx-xkve.4). Recall only — the
            // completion provider above keeps reading the store, so ghost
            // text and candidates stay masked.
            return withSessionText(page, this.ledger)
          } catch {
            return queryLedgerHistory(this.ledger, scope, this._cwd, this._host, text)
          }
        },
        // A recalled masked row cannot run as written (ADR-0021): the
        // overlay reports the row's redaction spans every time it places
        // text in the editor (preview, insert, draft restore), the editor
        // renders them as unresolved chips, and the beforeSubmit seam
        // refuses to run the command while any remain — opening resolution
        // on the first chip. This is the door people will actually walk
        // through: nobody plans to store a secret in advance, they hit a
        // command that cannot run.
        onDocContent: (doc, redactions) =>
          this.promptVault?.onRecalledRow(
            redactions.map((r) => ({ from: r.start, to: r.end, kind: r.kind })),
          ),
      })
      this.recall.mount(this.editor.root)
      // ONE arbiter chain (design §8.9.4 — three surfaces, one keyboard):
      // recall first, the vault picker second, completion last, the
      // editor's own handling at the tail. Recall is the higher-priority
      // surface and the surfaces never stack: opening any one closes the
      // others — the completion dropdown is dismissed the moment recall or
      // the picker opens, and the picker is dismissed the moment recall
      // opens (a Ctrl/Cmd+R can land while the picker is up). Esc closes
      // exactly one surface per press, in the same order.
      this.editor.setKeyArbiter((e) => {
        const consumed = this.recall!.handleKey(e)
        if (this.recall!.isOpen) {
          this.completion?.dismiss()
          this.promptVault?.closePicker()
        }
        if (consumed) return true
        // The picker outranks completion: while it is open its keys
        // (arrows, Enter, Tab, Esc) belong to it, and a Right/End ghost
        // accept must never insert completion text into the line under the
        // picker.
        if (this.promptVault!.isPickerOpen) this.completion?.dismiss()
        if (this.promptVault!.handleKey(e)) return true
        return this.completion?.handleKey(e) ?? false
      })

      if (signal.aborted) {
        this.recall?.destroy()
        this.recall = null
        this.completion?.destroy()
        this.promptVault?.destroy()
        this.promptVault = null
        this.completion = null
        this.editor.dispose()
        renderer.dispose()
        this.scrollback.dispose()
        this._readyResolve(false)
        return
      }
      // The marker latch (AD-6): any OSC 133 marker means the remote shell
      // speaks our protocol. A markerless session (plain SSH) keeps the
      // terminal visible in the unstructured full-pane mode.
      const shellIntegrated = () => this._shellIntegrated
      this._shellIntegrated = false
      renderer.onCommandMarker((marker) => {
        // Any OSC 133 marker means the remote shell has nocx integration:
        // from here the scrollback-block layout owns the presentation and
        // the unstructured full-pane mode is never used again.
        this._shellIntegrated = true
        this.inputState.dispatch({ type: 'marker', kind: marker.kind })
        // Completion of an in-band integration: the first A after the
        // wrapper ran means the wrapper restored termios, sourced the
        // hooks and returned — the shell is back at a prompt.
        if (marker.kind === 'A' && this._inBandDone) {
          const done = this._inBandDone
          this._inBandDone = null
          done()
        }
        if (marker.kind === 'D' && marker.exitCode !== undefined) {
          this._lastExitCode = marker.exitCode
        }
        this.ledger?.onMarker(marker.kind, marker.exitCode)
        if (marker.kind === 'C') {
          this.scrollback?.onCommandStart(this._pendingCommand, this._cwd, marker.line)
        } else if (marker.kind === 'D') {
          // Leaving the environment the command entered (nocx-695k.1):
          // restore the marker fact from before that command ran.
          if (this._previousIntegrated.length > 0) {
            this._shellIntegrated = this._previousIntegrated.pop()!
            this._envStack.pop()
            this._updateCapability()
            this.syncLocation()
            this.hooks.onPortsTargetChange?.()
          }
          const getLine = (y: number) => renderer.getBufferLine(y)
          this.scrollback?.onCommandEnd(getLine, marker.line, marker.exitCode ?? null)
          renderer.clearViewport()
        }
      })

      renderer.onBufferChange((type) => {
        this._bufferType = type
        this.inputState.dispatch({ type: 'buffer', buffer: type })
        if (type === 'alternate') {
          this.scrollback?.enterFullscreen()
        } else if (!shellIntegrated()) {
          // A markerless session returning from an alt-screen program must
          // not collapse to the hidden idle layout: leave fullscreen first
          // (setUnstructured declines while an alt-screen program owns the
          // pane), then fill the pane again.
          this.scrollback?.exitFullscreen()
          this.scrollback?.setUnstructured()
        } else {
          this.scrollback?.exitFullscreen()
        }
      })
      this.inputState.onChange((m) => {
        console.debug('nocx: input-state', m.state, 'trusted=', m.trusted, 'owned=', m.owned)
        this._editorOwned = m.owned
        // The location chip follows the machine's trust on EVERY transition,
        // including while the editor is hidden: when markers stop, no later
        // render may retain the last trusted host (design §8.2).
        this.editor?.setTrusted(m.trusted)
        // The capability statement is observed state: it follows the machine
        // on every transition (nocx-4t37.2).
        this._updateCapability()
        if (shouldShowEditor(m.owned, this.nativeMode)) {
          this.editor!.setTime(new Date())
          this.editor!.show()
          renderer.setReadOnly(true)
          this.scrollback?.setIdle()
        } else if (m.state === 'RUNNING_RAW') {
          this.editor!.hide()
          renderer.setReadOnly(false)
          renderer.focus()
          this.scrollback?.setRunning()
        } else {
          this.editor!.hide()
          renderer.setReadOnly(false)
          renderer.focus()
          // Markerless session (still no OSC 133): the terminal must stay
          // visible — the scrollback-block model never takes over.
          if (!shellIntegrated()) {
            this.scrollback?.setUnstructured()
          } else {
            this.scrollback?.setIdle()
          }
        }
      })

      // The input-state machine starts RAW and onChange may not fire for the
      // initial state: present an unintegrated session with the terminal
      // visible from the first byte.
      this.scrollback?.setUnstructured()

      // ── Focus bounce (P0-4) ────────────────────────────────────────────
      target.addEventListener('focusin', () => {
        if (!this.editor?.isVisible) return
        const active = document.activeElement
        // The receipt's review mode is the ONE place in this design where
        // focus leaves the editor: ⇧⌘S parks it in the name fields. The
        // bounce must yield to it, or the caret snaps straight back and the
        // receipt cannot be edited at all.
        if (
          active &&
          (this.editor.rootContains(active) ||
            this.scrollback?.xtermLiveContainer.contains(active) ||
            this.receipt?.root.contains(active))
        )
          return
        this.editor.focus()
      })

      // Click anywhere on the editor card and the prompt takes focus — the
      // card's padding and chrome are all "the prompt" as far as a user is
      // concerned. Except a control the user clicked ON PURPOSE: the vault
      // offer's name field and its buttons live inside this root, so an
      // unconditional focus() bounced the caret straight back to the prompt
      // and the field could not be typed into at all. Same guard the keydown
      // path uses — a nested form control owns its own focus and its own
      // keys.
      this.editor.root.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null
        if (target?.closest('input, textarea, select, button')) return
        this.editor?.focus()
      })

      this._globalKeydown = (e: KeyboardEvent) => {
        // Read the flag the chrome set, not the class it rendered (nocx-fttm).
        if (!target.isConnected || !this._active) return
        if (this.scrollback && this.scrollback.selectedBlockId !== null) {
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault()
            this.scrollback.deselectBlocks()
            if (this.editor?.isVisible) {
              this.editor.focus()
              this.editor.insertText(e.key)
            }
            return
          }
          if (e.key === 'Escape') {
            this.scrollback.deselectBlocks()
            e.preventDefault()
            return
          }
        }
        // Paste (Cmd/Ctrl+V) belongs to the same rescue policy: wherever in
        // the pane the user clicked — a frozen block, the scrollback, the
        // running grid — the paste must reach the command editor, and it
        // must never reach the shell as a literal \x16. The same isTextEntry
        // guard keeps other surfaces' paste to themselves (a settings field,
        // quick connect, a dialog). When the overlay is open, its arbiter
        // runs before this document listener on the editor's own keys and
        // decides first; when the editor itself has focus this branch is
        // skipped by the guard and the editor's own paste path runs.
        // Focus-only, deliberately: leave the keydown uncancelled so the
        // browser emits its paste event at the now-focused editor and CM6's
        // own paste inserts at the caret — reading the clipboard here would
        // bypass CM6 and fight the gesture.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') {
          if (isTextEntry(document.activeElement)) return
          if (this.editor?.isVisible) {
            this.scrollback?.deselectBlocks()
            this.editor.focus()
          }
          return
        }
        // Escape with the editor on screen but out of focus: the editor's
        // own capture listener only sees keys that traverse its surface, so
        // after a click elsewhere — a frozen block, the scrollback, the
        // chrome — the key never reaches it and the draft survives an
        // Escape, which reads as "Esc does nothing". The same rescue policy
        // as the typing path below: somebody else's text control keeps its
        // Escape (an input clears itself, a dialog closes itself), the
        // overlay stack owns Escape while a modal is up, and the block
        // action menu closes itself. The editor routes the key through its
        // own decision order — the recall arbiter first, so an open overlay
        // dismisses and restores its captured draft instead of having the
        // draft cleared under it. When the editor itself has focus this
        // branch is skipped by the rootContains guard and the editor's own
        // handling (which stops propagation) decides.
        if (e.key === 'Escape' && this.editor?.isVisible) {
          const active = document.activeElement
          if (active && this.editor.rootContains(active)) return
          // A click on the live grid parks focus in xterm's hidden
          // textarea — the terminal's own surface, not somebody else's
          // field: while the editor is up the grid is read-only dead
          // space, so the rescue runs here too (when the editor is hidden
          // this branch never runs and the key reaches the shell as
          // before).
          const onLiveGrid =
            active !== null && this.scrollback?.xtermLiveContainer.contains(active) === true
          if (!onLiveGrid && isTextEntry(active)) return
          if (hasOpenOverlays()) return
          if (document.querySelector('.cmd-overflow-menu')) return
          if (this.editor.handleExternalEscape(e)) e.preventDefault()
          return
        }
        if (!this.editor?.isVisible) return
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
        const active = document.activeElement
        if (
          active &&
          (this.scrollback?.xtermLiveContainer.contains(active) || this.editor.rootContains(active))
        )
          return
        // Somebody else's text control has the focus — the tab strip's filter, a
        // settings field, a dialog. This handler is on `document`, so it sees
        // every keystroke in the window, and the rescue it performs (pull focus
        // into the prompt so typing "just works" after a click on the pane) is
        // exactly wrong when the user is deliberately typing somewhere else: the
        // first character lands in the field, focus jumps, and the rest goes to
        // the shell. Whitelisting the editor and the grid was not enough, because
        // any control OUTSIDE the terminal is equally not ours.
        if (isTextEntry(active)) return
        // Focus-only, deliberately. The keydown's target was fixed when it was
        // dispatched — this keystroke started outside the editor, so the event
        // never reaches the editor's own keydown listener. The design contract
        // is: move focus synchronously, then leave the browser's native
        // insertion uncancelled, and let the character arrive as the native
        // default action of the keydown that is still in flight — it targets
        // whatever is focused when it runs, which is the contentDOM this
        // focus() just made active. So this path must NOT do what the block
        // path above does: preventDefault() would throw the native insertion
        // away, and insertText() on top of it would risk a second copy of the
        // same character. The asymmetry is the point — the block path's event
        // target is a block, never an editing host, so it has no native
        // insertion to lean on. (How faithfully the native path lands is
        // engine-dependent and is verified in a real browser, not in jsdom,
        // which performs no native insertion at all.)

        this.editor.focus()
      }
      document.addEventListener('keydown', this._globalKeydown)

      this.scrollback?.scrollbackArea.addEventListener('mousedown', (e) => {
        if (!(e.target as HTMLElement).closest('.cmd-block')) {
          this.scrollback?.deselectBlocks()
        }
      })

      // ── DOM block copy-on-select (P0-5) ───────────────────────────────
      // Frozen output only. Copy-on-select is the terminal's convention and it
      // belongs to text you can only read: selecting output is how you take
      // it. In the EDITOR the same gesture means the opposite — you select in
      // order to replace — so copying there overwrites the clipboard with the
      // very text about to be deleted. The owner selected part of a header to
      // paste a key over it and the key was gone. Explicit Ctrl/Cmd+C still
      // copies from the editor; nothing takes the clipboard unasked.
      this.scrollback?.scrollbackArea.addEventListener('mouseup', () => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed) return
        const text = sel.toString()
        if (!text) return
        if (!this.scrollback?.scrollbackArea.contains(sel.anchorNode)) return
        if (shouldCopy(text)) {
          this.clipboard.writeText(text).catch((e) => {
            console.warn('nocx: clipboard write failed (block selection)', e)
          })
        }
      })

      // Alias tab: profileId is empty, open by host so the backend
      // resolves through ~/.ssh/config (ssh -G). Saved-profile tabs
      // use openSSHSession with the real profileId.
      const session = this.sshOpts
        ? this.sshOpts.profileId
          ? await this.client.openSSHSession(this.cols, this.rows, this.sshOpts.profileId)
          : await this.client.openSSHSessionByHost(
              this.cols,
              this.rows,
              this.sshOpts.host,
              this.sshOpts.user,
            )
        : await this.client.openSession(this.cols, this.rows, true)

      if (signal.aborted) {
        session.close()
        this.editor.dispose()
        renderer.dispose()
        this.scrollback.dispose()
        this._readyResolve(false)
        return
      }

      this.session = session
      log.info('nocx: session opened', { sid: session.sessionId, cwd: session.cwd || '' })

      // The open ack carries the resolved launch policy and the refusal
      // reason (nocx-4t37.2): the capability control starts from the
      // backend's own resolution, never from a second fetch that could
      // disagree with it.
      this._policy = session.shellIntegration ?? 'auto'
      this._openReason = session.shellIntegrationReason ?? ''
      if (this._openReason !== '') {
        // A launcher decline on an auto profile is the soft degrade
        // AGENTS.md demands be visible in the product, never log-only.
        showToast({
          level: 'warning',
          message: `Shell integration unavailable: ${this._openReason}`,
          duration: 6000,
        })
      }
      // The statement is OBSERVED: until the first marker arrives, an auto
      // session honestly reads "Native input" — the launcher may be
      // mid-start, and the first prompt flips it to command blocks.
      this._updateCapability()

      this._cwd = session.cwd || ''
      this._host = this.sshOpts?.host || ''
      // The block header's `user@host`. Empty for a local shell, where the
      // machine is implied and printing it on every block would be noise.
      // ONE derivation, routed to both chips — the block header's frozen
      // record and the prompt's live destination must never disagree.
      const location = this.sshOpts ? this.locationLine() : ''
      this.scrollback?.blockManager.setLocation(location)
      this.editor?.setLocation(location)
      // Nothing has been verified yet at session open; the chip renders the
      // machine's trust, which the first clean A→B promotes (design §8.2).
      this.editor?.setTrusted(this.inputState.trusted)
      this.editor?.setCwd(session.cwd || '')

      // Push initial title + tooltip. Title composition lives here.
      if (this.sshOpts) {
        this.programTitle = this.sshOpts.host
        this.onTooltipChange(
          `SSH ${this.sshOpts.user ? this.sshOpts.user + '@' : ''}${this.sshOpts.host}`,
        )
      } else {
        this.cwdTitle = directoryLabel(session.cwd)
        this.onTooltipChange(cwdTooltip(session.cwd, false))
      }

      // Signal adoptability for alias tabs (no saved profile yet).
      // Must come after the session opens so adoption is only offered
      // to sessions that actually connected — a failed connect never
      // reaches this point (it throws to the outer catch).
      if (this.sshOpts && !this.sshOpts.profileId) {
        this.hooks.onAdoptabilityChange?.(true)
      }
      this.pushTitle()

      session.onData((data: string) => {
        log.debug('nocx: session data received', { length: data.length })
        renderer.write(data)
        this.scheduleLiveResize()
        if (this._bufferType === 'normal' && Date.now() >= this.echoUntil) {
          host.requestAttention()
        }
      })

      // Keyboard → PTY: xterm.js fires onData for every keystroke when stdin
      // is enabled (setReadOnly(false)). The editor captures keys while it is
      // visible and the terminal is read-only, so these only arrive in RAW mode.
      renderer.onData((data: string) => {
        this.session?.send(data)
      })
      session.onExit((sid: string) => {
        log.info('nocx: session exited', { sid })
        this.inputState.dispatch({ type: 'exit' })
        this.ledger?.finalizeOpen()
        this._disposeAllMarkers()
        host.requestClose()
      })
      session.onReset(() => {
        renderer.reset()
        this.inputState.dispatch({ type: 'reset' })
        this.ledger?.finalizeOpen()
        this._disposeAllMarkers()
      })

      renderer.onTitle((title: string) => {
        this.programTitle = title.trim()
        this.pushTitle()
      })
      renderer.onCwd(({ path }) => {
        this._cwd = path
        this.editor?.setCwd(path)
        this.cwdTitle = directoryLabel(path)
        this.onTooltipChange(cwdTooltip(path, true))
        this.pushTitle()
      })

      renderer.onBell(() => {
        host.requestAttention()
      })

      // ── Clipboard ────────────────────────────────────────────────────
      renderer.onSelectionChange((text) => {
        if (shouldCopy(text)) {
          this.clipboard.writeText(text).catch((e) => {
            console.warn('nocx: clipboard write failed (selection)', e)
          })
        }
      })

      renderer.onClipboardWrite((text) => {
        if (this.gate.granted) {
          this.clipboard.writeText(text).catch((e) => {
            console.warn('nocx: clipboard write failed (OSC 52)', e)
          })
          return
        }
        if (this.gate.suppressed) return
        if (this.banner.shown) return
        void this.banner.show().then((choice) => {
          if (choice === 'allow') {
            this.gate.allow()
            this.clipboard.writeText(text).catch((e) => {
              console.warn('nocx: clipboard write failed (OSC 52)', e)
            })
          } else if (choice === 'suppress') {
            this.gate.suppress()
          }
        })
      })

      // Paste on right-click AND middle-click.
      const doPaste = async () => {
        try {
          const text = await this.clipboard.readText()
          if (!text) return
          if (this.editor?.isVisible) {
            this.editor.insertText(text)
            return
          }
          if (text.includes('\n') && this._bufferType === 'normal') {
            const confirmed = await showConfirm('Paste multi-line text?', 'Paste', 'Cancel')
            if (!confirmed) return
          }
          renderer.paste(text)
        } catch (e) {
          console.warn('nocx: clipboard read failed (paste)', e)
        }
      }

      target.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault()
        void doPaste()
      })

      target.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button === 1) {
          e.preventDefault()
          void doPaste()
        }
      })

      renderer.onResize((cols: number, rows: number) => {
        if (cols === this.cols && rows === this.rows) return
        this.cols = cols
        this.rows = rows
        clearTimeout(this.resizeTimer)
        this.resizeTimer = window.setTimeout(() => {
          // A resize makes the shell redraw its prompt, and that redraw arrives
          // on `session.onData` looking exactly like output the user has not
          // seen. It is not: we asked for it. Switching the strip from vertical
          // to horizontal resizes every pane at once, so every inactive tab lit
          // its activity indicator for something the user did to the WINDOW
          // rather than to any tab (nocx-6w4z).
          this.echoUntil = Date.now() + RESIZE_ECHO_MS
          session.sendResize(cols, rows)
        }, RESIZE_SETTLE_MS)
      })

      this.renderer = renderer

      // ── Native-mode escape (Ctrl/Cmd+Shift+.) ─────────────────────────
      target.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === '.' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          this.enterNativeMode()
        }
      })

      // The rail mounts above the pending command, BEFORE the editor mounts
      // below it, so a plain shell keeps the capability statement in view.
      this._mountRail(target)

      this._mounted = true
      this._readyResolve(true)
      log.info('nocx: terminal content ready', {
        renderer: 'xterm',
        sid: session.sessionId,
      })

      // B.5: replay the latest viewport after async mount completes.
      // The presentation layer delivers viewports via viewportChanged;
      // if one was buffered during mount, apply it now through the
      // renderer's fitViewport path.
      if (this._latestViewport) {
        this.viewportChanged(this._latestViewport)
      }
    } catch (err) {
      // Vault-sealed errors should surface as Unlock dialog, not generic error.
      if (err instanceof RpcError) {
        const data = err.data as { reason?: string } | undefined
        if (data?.reason === 'vault-sealed') {
          this.hooks.onVaultSealed?.()
          this._readyResolve(false)
          return
        }
      }
      const notice = document.createElement('pre')
      notice.className = 'pane-error'
      notice.textContent = `Terminal failed to start:\n\n${err instanceof Error ? err.message : String(err)}`
      target.replaceChildren(notice)
      this._readyResolve(false)
      log.error('nocx: terminal content failed', { error: String(err) })
    }
  }

  // ── Live-region sizing ────────────────────────────────────────────────

  private liveResizeFrame = 0

  /**
   * Re-measure the live region on the next frame.
   *
   * Coalesced to one animation frame because a busy command delivers dozens of
   * chunks per frame and every one of them would otherwise read the grid and
   * write a style — a layout thrash on the hot path, for a height that can only
   * be painted once per frame anyway.
   */
  private scheduleLiveResize(): void {
    if (this.liveResizeFrame !== 0) return
    this.liveResizeFrame = requestAnimationFrame(() => {
      this.liveResizeFrame = 0
      if (this._disposed || !this.renderer || !this.scrollback) return
      // Height first, refit second, and the order is the whole point. Reaching
      // the ceiling collapses the editor, which grows the scroller — so the
      // usable height is only correct AFTER this call. Refitting first meant
      // the grid stayed at the old size until the next chunk of output arrived,
      // and `top` refreshes every three seconds: the pane visibly re-laid
      // itself several seconds after the program started.
      this.scrollback.setLiveHeight(this.renderer.liveContentHeight())
      this.refitIfResized()
    })
  }

  // ── B.5 viewport delivery ─────────────────────────────────────────────

  private _latestViewport: ContentViewport | null = null
  private _mounted = false

  viewportChanged(viewport: ContentViewport): void {
    if (this._disposed) return
    this._latestViewport = viewport
    // Pass the authoritative viewport to the renderer (B.5).
    // The renderer computes cols/rows from its own cell metrics.
    if (this._mounted && this.renderer) {
      this.renderer.fitViewport(this.usableViewport(viewport))
    }
  }

  /**
   * The delivered viewport, less the chrome the grid can never be shown in.
   *
   * B.5 says this class does not interpret container geometry, and it still
   * does not: the pane's box is handed to it. What it subtracts is its OWN
   * furniture — the editor is a flex sibling inside the pane, so the scroller
   * that displays the grid is shorter than the pane by exactly the editor's
   * height.
   *
   * Measured while `top` ran: the pane was 682px, the editor 76, the scroller
   * 606 — and the grid had been fitted to the full 682, producing a 665px
   * screen. `top` filled all of its rows and the bottom four had nowhere to be
   * drawn. Clamping the live region cannot fix that; it only decides where the
   * clipping happens. The grid has to be the size of the space it is shown in
   * (nocx-6w4z).
   *
   * The width is the same statement one axis over, and it was left unmade until
   * nocx-vydj. The delivered width is `pane.getBoundingClientRect().width`, a
   * BORDER box — it counts the `padding: 0 10px` on `.pane`, which is breathing
   * room around the text and not space the grid may use. `cols` was therefore
   * computed from 20px that do not exist, and the last columns were laid out
   * past the right edge of `.xterm-inner`, whose `overflow: hidden` cut them
   * mid-glyph.
   *
   * That it read as a Wails-only defect is the scrollbar gutter: measured at a
   * 1232px pane, `.scrollback-area` is 1212 wide in both engines, but its
   * clientWidth is 1202 in Chromium and 1212 in WebKit, because
   * `scrollbar-gutter: stable` reserves in one and is ignored by the other. Same
   * build, same grid, two different overhangs — 20px in a browser, 10 in
   * WKWebView. Neither is correct, and subtracting a constant for the padding
   * would have fixed only the browser.
   *
   * `clientWidth` of the scroller answers both at once: it is the content box,
   * so the pane's padding is already gone, and it excludes the scrollbar
   * whether or not the engine reserved one.
   */
  private lastFitHeight = 0

  /**
   * Re-fit the grid when the space it is shown in has changed size.
   *
   * `viewportChanged` only fires when the PANE's geometry changes, and the
   * things that resize the grid's home are inside the pane: the editor
   * appearing, and the editor being taken away again when a program fills the
   * pane. Neither is a change the pane itself ever sees. The very first fit therefore ran while the
   * editor was still `display: none`, took the whole pane, and was never
   * revisited: 682px of grid living in a 606px scroller, four rows permanently
   * below the fold.
   *
   * No loop: fitting changes the row count, which changes the PTY size, which
   * produces output, which lands back here — and the usable height is the same,
   * so nothing refits.
   */
  private refitIfResized(): void {
    const v = this._latestViewport
    if (!v || !this.renderer) return
    const usable = this.usableViewport(v)
    if (usable.height === this.lastFitHeight) return
    this.lastFitHeight = usable.height
    this.renderer.fitViewport(usable)
  }

  private usableViewport(viewport: ContentViewport): ContentViewport {
    const area = this.scrollback?.scrollbackArea
    // Zero before first layout — the delivered box is the better guess then,
    // and the next viewport delivery corrects it. Each axis falls back on its
    // own: jsdom reports 0 for both, a real pane mid-layout can report one.
    const height = area && area.clientHeight > 0 ? area.clientHeight : viewport.height
    const width = area && area.clientWidth > 0 ? area.clientWidth : viewport.width
    return { ...viewport, width, height }
  }

  /**
   * Focus whichever surface owns input right now.
   *
   * At the prompt that is the editor, and the grid is deliberately read-only
   * while the editor is up (`setReadOnly(true)` on the input-state change). So
   * focusing the renderer unconditionally parked the caret in a widget that
   * drops every keystroke — and neither focus-bounce path rescues it, because
   * both stand down when the focus is already inside the live xterm container,
   * which is exactly where `renderer.focus()` puts it.
   *
   * This is why a freshly created tab typed fine and a tab you switched back to
   * did not: the new tab's `editor.show()` focuses its own textarea, while
   * `TabManager.activate()` ends with `tab.focus()` and took that focus away
   * again on every return.
   */
  focus(): void {
    if (this.editor?.isVisible) {
      this.editor.focus()
      return
    }
    this.renderer?.focus()
  }

  refreshAtlas(): void {
    this.renderer?.refreshAtlas()
  }

  // ── Capability rail (nocx-4t37.2) ─────────────────────────────────────
  // The pane-level rail above the pending command: one chip stating what is
  // true right now (native input / command blocks / enhanced input), one
  // popover of actions opened from it. The rail is NOT tab chrome — the
  // capability changes several times INSIDE one tab (ssh from inside ssh,
  // docker exec, sudo, a TUI), and it matters exactly where Enter is about
  // to be pressed.

  /** The capability statement as of now, derived from observed state only
   *  (the input machine + the sticky integrated flag + the user's own
   *  native latch) — never from the byte stream (AD-6). */
  private _updateCapability(): void {
    const next = deriveCapability({
      integrated: this._shellIntegrated,
      state: this.inputState.state,
      trusted: this.inputState.trusted,
      owned: this.inputState.owned,
      native: this.nativeMode,
    })
    // A session whose markers stopped without the user latching native is
    // a degrade (nested ssh, docker exec, a broken hook): the tab's small
    // warning mark is the ONLY tab-chrome signal for it.
    const degraded =
      this._openReason !== '' ||
      (this._shellIntegrated && !this.nativeMode && next === 'native-input')
    if (next === this._capability && degraded === this._degraded) return
    this._capability = next
    this._degraded = degraded
    this.hooks.onWarningChange?.(degraded)
    this._renderRail()
  }

  /** (Re)draw the rail chip for the current capability. The chip is the
   *  statement; it opens the popover unless there is nothing to offer. */
  private _renderRail(): void {
    if (!this._rail) return
    const actions = this._railActions()
    const label = CAPABILITY_LABELS[this._capability]
    const fresh = createCapabilityChip({
      label,
      variant: this._capabilityVariant(),
      disabled: actions.length === 0,
      title: this._railTitle(actions.length === 0),
      onClick: () => this._toggleRailPopover(),
    })
    if (this._railChip) {
      this._railChip.replaceWith(fresh)
    } else {
      this._rail.appendChild(fresh)
    }
    this._railChip = fresh
  }

  private _capabilityVariant(): 'native' | 'blocks' | 'enhanced' | 'degraded' {
    if (this._degraded) return 'degraded'
    switch (this._capability) {
      case 'command-blocks':
        return 'blocks'
      case 'enhanced-input':
        return 'enhanced'
      case 'native-input':
        return 'native'
    }
  }

  /** What the popover may offer right now. Never a picker of modes: the
   *  actions are the two real transitions, offered exactly when valid. */
  private _railActions(): CapabilityAction[] {
    if (this._capability === 'native-input') {
      if (this._policy === 'off') return []
      return [{ kind: 'integrate', label: 'Integrate this shell' }]
    }
    return [{ kind: 'native', label: 'Use native input' }]
  }

  private _railTitle(noActions: boolean): string {
    const base = `Enter goes to the ${this._capability === 'command-blocks' ? 'command editor' : 'shell'}: ${CAPABILITY_LABELS[this._capability]}`
    if (!noActions) return `${base}. Click to change.`
    if (this._policy === 'off') return `${base}. This connection is set to never integrate (off).`
    return base
  }

  /** Build the rail element and mount it above the editor. Called once
   *  from mount() before the editor mounts, so the rail sits between the
   *  scrollback and the pending command. */
  private _mountRail(target: HTMLElement): void {
    if (this._rail || !this.sshOpts) return
    const rail = document.createElement('div')
    rail.className = 'nocx-capability-rail'
    rail.setAttribute('role', 'group')
    rail.setAttribute('aria-label', 'Shell capability')
    this._rail = rail
    this._railPopover = new FloatingPanel({
      variant: 'capability',
      role: 'menu',
      ariaLabel: 'Shell capability actions',
      callbacks: {
        onPick: (index) => this._runRailAction(index),
      },
    })
    this._railPopover.mount(rail)
    target.insertBefore(rail, this.editor?.root ?? null)
    this._renderRail()
  }

  private _toggleRailPopover(): void {
    if (this._railOpen) {
      this._closeRailPopover()
      return
    }
    const actions = this._railActions()
    if (actions.length === 0) return
    this._railOpen = true
    this._railPopover?.show({
      rows: actions.map((a) => ({
        id: a.kind,
        displayText: a.label,
        matchRanges: [],
      })),
      selectedIndex: 0,
    })
    this._railOutsideHandler = (e: MouseEvent) => {
      if (this._rail && !this._rail.contains(e.target as Node)) this._closeRailPopover()
    }
    document.addEventListener('mousedown', this._railOutsideHandler, true)
    this._railEscapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this._closeRailPopover()
      }
    }
    document.addEventListener('keydown', this._railEscapeHandler, true)
  }

  private _closeRailPopover(): void {
    if (!this._railOpen) return
    this._railOpen = false
    this._railPopover?.hide()
    if (this._railOutsideHandler) {
      document.removeEventListener('mousedown', this._railOutsideHandler, true)
      this._railOutsideHandler = null
    }
    if (this._railEscapeHandler) {
      document.removeEventListener('keydown', this._railEscapeHandler, true)
      this._railEscapeHandler = null
    }
  }

  private _runRailAction(index: number): void {
    const actions = this._railActions()
    const action = actions[index]
    this._closeRailPopover()
    if (!action) return
    if (action.kind === 'integrate') this.integrateShell()
    else this.enterNativeMode()
  }

  /** The capability popover's actions, exposed for the e2e and unit seams. */
  get capability(): Capability {
    return this._capability
  }

  get policy(): ShellIntegrationPolicy {
    return this._policy
  }

  /** The native-mode escape (ADR-0004 §1, nocx-4ff.9): latch native input —
   *  the editor never shows again this session, keys route raw, and the
   *  remote prompt is restored to visible (the one-way guarantee that the
   *  user is never trapped). This is the capability popover's "Use native
   *  input" action AND the Ctrl/Cmd+Shift+. chord — one path, not two.
   *
   *  One-way on purpose: the remote marker-only prompt contract stops
   *  emitting markers when it is unset (zsh removes its precmd hook; bash
   *  stops the A marker), so a fresh integration — not a presentation
   *  toggle — is what returns to command blocks. The capability chip still
   *  states "Native input" and the popover offers nothing while latched. */
  private enterNativeMode(): void {
    this.nativeMode = true
    this.editor?.hide()
    this.renderer?.focus()
    this.session?.send(NATIVE_RESTORE)
    this._updateCapability()
  }

  // ── In-band integration (nocx-ynsx, spec §4.4) ─────────────────────────

  /**
   * Integrate the shell currently at the trusted prompt, in-band.
   *
   * Permitted ONLY while nocx holds a trusted A→B prompt from the current
   * integrated shell (PROMPT_READY && trusted && owned): consent changes
   * authorisation, not the identity of the foreground process — if the
   * thing reading stdin is vim, the payload would be typed into the file.
   * Anything else is refused with a stated reason rather than attempted.
   *
   * An input lease is taken before any byte goes out: the editor draft is
   * captured byte-for-byte, the editor hides, every key except Esc is
   * swallowed at document capture phase, and Esc cancels by sending the
   * terminator. The wrapper is typed only once the lease is held.
   */
  integrateShell(): void {
    if (this._integrating) return
    // The connection's launch policy (nocx-4t37.2): off refuses even the
    // explicit path — the user chose "never", and every entry point (the
    // rail, the chord, the palette) funnels through this one gate.
    if (this._policy === 'off') {
      showToast({
        level: 'warning',
        message: 'This connection is set to never integrate (off)',
        duration: 4000,
      })
      log.warn('nocx: shell.integrate refused by off policy')
      return
    }
    const state = this.inputState.state
    // TWO named authorisations (nocx-4t37.2, coordinator decision). The
    // gate for an integrated shell is UNCHANGED: permitted ONLY inside the
    // trusted A→B window (PROMPT_READY && trusted && owned), which is the
    // precondition the path was written for — nocx owns the keyboard, the
    // editor is live, we know where the caret is. A markerless shell can
    // never satisfy that and never will, so it gets its own path: the
    // explicit user gesture IS the consent, ALT_SCREEN is the one negative
    // fact xterm reports positively (vim/less/htop stay refused), and
    // anything else that is not a shell is caught by the READY handshake —
    // only the one-line wrapper is ever typed into an unknown foreground
    // process, and if READY never returns the IN_BAND_TIMEOUT_MS fires and
    // nothing further is sent (ADR-0004 §1 note, 2026-08-04).
    const integratedPath =
      state === 'PROMPT_READY' && this.inputState.trusted && this.inputState.owned
    const markerlessPath = !this._shellIntegrated && state !== 'ALT_SCREEN'
    if (!integratedPath && !markerlessPath) {
      const why =
        state === 'ALT_SCREEN'
          ? 'Integrate this shell is not available while a full-screen program is running'
          : state === 'PROMPT_READY'
            ? 'Integrate this shell is only available from a trusted prompt'
            : `Integrate this shell is only available at a trusted prompt, not while ${state}`
      showToast({ level: 'warning', message: why, duration: 4000 })
      log.warn('nocx: shell.integrate refused', {
        state,
        trusted: this.inputState.trusted,
        owned: this.inputState.owned,
        integrated: this._shellIntegrated,
      })
      return
    }
    void this._runIntegration()
  }

  private async _runIntegration(): Promise<void> {
    const session = this.session
    const renderer = this.renderer
    const editor = this.editor
    if (!session || !renderer || !editor) return

    // The lease, taken BEFORE the plan is fetched: the user cannot type
    // while the RPC is in flight, and the draft is exactly what it was
    // when they asked.
    const sel = editor.getSelection()
    this._inBandDraft = {
      text: editor.getDoc(),
      from: sel.from,
      to: sel.to,
      scrollTop: editor.getScrollTop(),
    }
    this._integrating = true
    editor.hide()
    renderer.setReadOnly(true)
    this._inBandKeySwallow = (e: KeyboardEvent) => {
      // Keys aimed at another tab go to that tab's shell — they cannot
      // reach this pty, so only this tab's keystrokes could interleave.
      if (!this._active) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this._cancelIntegration()
        return
      }
      // Swallow everything else at capture phase: no keystroke may reach
      // the shell while the wrapper runs raw.
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('keydown', this._inBandKeySwallow, true)

    // The indicator floats in the terminal itself — the editor, its usual
    // host, is hidden for the lease.
    const panel = new FloatingPanel({
      variant: 'recall',
      role: 'status',
      ariaLabel: 'shell integration',
    })
    panel.mount(this.scrollback?.xtermLiveContainer ?? editor.root)
    panel.showEmpty('Integrating this shell — Esc to cancel')
    this._inBandPanel = panel

    this._inBandTimer = setTimeout(() => {
      if (this._inBandReadySeen) this._sendTerminator()
      this._finishIntegration('timed out')
    }, IN_BAND_TIMEOUT_MS)

    let plan: ShellIntegrateResult
    try {
      plan = await new ShellClient(this.client).integrate(session.sessionId)
    } catch {
      // Nothing was typed yet — the wrapper never ran. Release the lease
      // and report; the shell is untouched (fail-open).
      this._finishIntegration('plan fetch failed')
      showToast({
        level: 'danger',
        message: 'Could not fetch the integration plan',
        duration: 4000,
      })
      return
    }
    if (!this._integrating) return // cancelled while the plan was in flight

    this._inBandTerminator = plan.terminator
    this._inBandReadyUnsub = renderer.onInBandReady(() => {
      // READY proves `stty raw -echo` is on: the payload can be streamed
      // without being printed to the user.
      this._inBandReadyUnsub?.()
      this._inBandReadyUnsub = null
      this._inBandReadySeen = true
      session.send(plan.payload + plan.terminator + '\n')
      // Completion is the next A marker: the wrapper sourced the hooks
      // and the shell is back at its prompt.
      this._inBandDone = () => this._finishIntegration('done')
    })
    session.send(plan.wrapper + '\r')
  }

  /** The cancel shape the wrapper's sed recognises: a newline, the
   *  terminator LINE and a newline (mirrors the pty-test cancel). */
  private _sendTerminator(): void {
    if (this._inBandTerminator === null) return
    this.session?.send('\n' + this._inBandTerminator + '\n')
  }

  private _cancelIntegration(): void {
    if (!this._integrating) return
    this._inBandReadyUnsub?.()
    this._inBandReadyUnsub = null
    // If READY was seen, the wrapper is inside sed: the terminator is the
    // only way to unblock it, and its own `stty "$saved"` restore then
    // runs. If READY was never seen the wrapper already failed or returned
    // on its own — sending a terminator would only print a stray line at
    // the prompt (fail-open noise).
    if (this._inBandReadySeen) this._sendTerminator()
    this._finishIntegration('cancelled')
  }

  private _finishIntegration(reason: string): void {
    if (!this._integrating) return
    this._integrating = false
    this._inBandReadyUnsub?.()
    this._inBandReadyUnsub = null
    this._inBandDone = null
    if (this._inBandTimer !== undefined) {
      clearTimeout(this._inBandTimer)
      this._inBandTimer = undefined
    }
    if (this._inBandKeySwallow) {
      document.removeEventListener('keydown', this._inBandKeySwallow, true)
      this._inBandKeySwallow = null
    }
    this._inBandPanel?.destroy()
    this._inBandPanel = null
    // Restore the draft byte-for-byte. The machine re-shows the editor at
    // the next B; when no marker followed (early cancel), restore the
    // visibility the machine still declares.
    const draft = this._inBandDraft
    this._inBandDraft = null
    if (draft && this.editor) {
      this.editor.replaceDoc(draft.text, draft.from, draft.to)
      this.editor.setScrollTop(draft.scrollTop)
    }
    this._inBandTerminator = null
    this._inBandReadySeen = false
    if (this.editor && shouldShowEditor(this.inputState.owned, this.nativeMode)) {
      this.editor.show()
      this.renderer?.setReadOnly(true)
    }
    log.info('nocx: in-band integration finished', { reason })
  }

  dispose(): void {
    this._disposed = true
    if (this._integrating) {
      // Release the lease before the editor/renderer are torn down; the
      // wrapper (if any was typed) still restores termios on its own.
      this._finishIntegration('tab disposed')
    }
    this.mountAbortController?.abort()
    if (this._globalKeydown) {
      document.removeEventListener('keydown', this._globalKeydown)
      this._globalKeydown = null
    }
    this.session?.close()
    this.renderer?.dispose()
    this.editor?.dispose()
    this.recall?.destroy()
    this.recall = null
    this.scrollback?.dispose()
    this.destroyReceipt()
    this.promptVault?.destroy()
    this.promptVault = null
    this.completion?.destroy()
    this.completion = null
    this._disposeAllMarkers()
    this.ledger = null
    this.host = null
    this._closeRailPopover()
    this._railPopover?.destroy()
    this._railPopover = null
    this._rail?.remove()
    this._rail = null
    this._railChip = null
  }

  private _disposeAllMarkers(): void {
    for (const m of this._markers.values()) m.dispose()
    this._markers.clear()
  }

  // ── SSH alias hint support (w7-hint) ─────────────────────────────────

  /** Called on every textarea input change. Detects `ssh <partial>` commands
   *  and fetches matching aliases from the live ~/.ssh/config source.
   *  No client-side caching — every activation fetches fresh (coordinator contract). */
  private _onEditorInput(text: string): void {
    // Only when the editor owns keyboard input (PROMPT_READY with owned=true).
    if (!this._editorOwned || !this.profileClient) {
      this.editor?.hideAliasHints()
      return
    }

    // Detect `ssh <partial>` at the start of the line (possibly after whitespace).
    const trimmed = text.trimStart()
    const match = trimmed.match(/^ssh\s+(\S*)/)
    if (!match) {
      this.editor?.hideAliasHints()
      return
    }

    const partial = match[1]
    const fetchId = ++this._aliasFetchId

    // Fetch fresh aliases on every activation. Guard against stale responses
    // with a generation counter: a newer fetch invalidates an older one.
    this.profileClient
      .listSSHAliases()
      .then((resp) => {
        if (fetchId !== this._aliasFetchId) return // stale — newer text superseded this
        if (resp.unavailable) {
          this.editor?.hideAliasHints()
          return
        }
        const filtered = this._filterAliases(resp.aliases, partial)
        this.editor?.showAliasHints(filtered)
      })
      .catch(() => {
        // Fetch failed (network, backend down). Silently hide hints — the
        // feature degrades transparently rather than showing stale/flaky data.
        this.editor?.hideAliasHints()
      })
  }

  /** Filter SSH config aliases by case-insensitive prefix match.
   *  Excludes wildcard patterns (Host * etc. are rules, not targets). */
  private _filterAliases(aliases: SSHAliasEntry[], partial: string): SSHAliasEntry[] {
    const lower = partial.toLowerCase()
    return aliases.filter(
      // No wildcard filter here on purpose. sshConfig.aliases already excludes
      // patterns on the backend (internal/ssh/aliases.go, containsWildcard),
      // and a second copy of that rule in the renderer is a rule that drifts —
      // the two versions of it disagreed on '!' and on brackets before this
      // line was removed.
      (a) => a.alias.toLowerCase().startsWith(lower),
    )
  }

  // ── the after-submit receipt (ADR-0021, the receipt round) ──────────────

  /** The history.record ack crossed: paint the block with what was stored
   *  and, when captures came back, attach the receipt to THAT block. The
   *  block identity was captured at onComplete time; a block that is gone
   *  by now (cleared scrollback, disposed tab, or never frozen) drops the
   *  receipt silently. */
  private attachRecordedAck(
    _recId: number,
    block: BlockRecord | null | undefined,
    ack: HistoryRecord,
  ): void {
    if (!block) return
    const blockEl = block.el
    // The block must be frozen (the D marker froze it) and still in the
    // DOM: a running block means the D never arrived for this record, and
    // a disconnected element means the scrollback was cleared or the tab
    // disposed. Both drop the receipt silently — the capture died with
    // them on the backend anyway.
    if (
      !blockEl.isConnected ||
      blockEl.classList.contains('cmd-block-running') ||
      !blockEl.classList.contains('cmd-block')
    ) {
      return
    }
    if (ack.redactions.length > 0) {
      renderRecordedCommand(blockEl, ack.maskedCommand, ack.redactions)
    }
    if (ack.captures.length === 0) return
    // One receipt per block: a re-recorded block replaces its own, never
    // anybody else's.
    this.receipts.get(blockEl)?.destroy()
    this.receiptBlockEl = blockEl
    for (const c of ack.captures) {
      this.receiptChipSpans.set(c.id, { start: c.redaction.start, end: c.redaction.end })
      this.receiptChipBlocks.set(c.id, blockEl)
    }
    const receipt = new BlockReceipt(
      ack.captures.map((c) => ({
        captureId: c.id,
        kindLabel: KIND_LABELS[c.redaction.kind],
        maskedValue:
          c.redaction.prefix !== '' || c.redaction.suffix !== ''
            ? `${c.redaction.prefix}...${c.redaction.suffix}`
            : '***',
        suggestedName: c.suggestedName,
      })),
      {
        onSaveAll: (rows) => void this.saveReceiptRows(receipt, blockEl, rows),
        onDismiss: (captureId) => void this.dismissReceiptRow(receipt, blockEl, captureId),
        onHover: (captureId) => this.emphasiseChip(captureId),
        onExitReview: () => this.editor?.focus(),
      },
    )
    this.receipts.set(blockEl, receipt)
    this.receipt = receipt
    receipt.mount(blockEl)
  }

  /** A receipt is finished with (every row saved or dismissed): forget it,
   *  and hand `receipt` to whichever one is still open, newest first. */
  private retireReceipt(blockEl: HTMLElement): void {
    this.receipts.delete(blockEl)
    if (this.receiptBlockEl === blockEl) this.receiptBlockEl = null
    let newest: BlockReceipt | null = null
    let newestEl: HTMLElement | null = null
    for (const [el, r] of this.receipts) {
      newest = r
      newestEl = el
    }
    this.receipt = newest
    if (this.receiptBlockEl === null) this.receiptBlockEl = newestEl
  }

  /** Tear every receipt down — the tab is going away, and the backend
   *  destroys its captures on the same event. */
  private destroyReceipt(): void {
    for (const r of this.receipts.values()) r.destroy()
    this.receipts.clear()
    this.receipt = null
    this.receiptBlockEl = null
    this.receiptChipSpans.clear()
    this.receiptChipBlocks.clear()
  }

  /** The receipt's primary action: settle every row still in play. The
   *  capture id is the idempotency key — a partial failure keeps the row
   *  and a retry of the SAME id finishes the owed rewrite without minting
   *  a second secret. The name shown is the RESPONSE's, never the one
   *  sent. */
  private async saveReceiptRows(
    receipt: BlockReceipt,
    blockEl: HTMLElement,
    rows: ReadonlyArray<{ captureId: string; name: string }>,
  ): Promise<void> {
    // Saving into a vault that does not exist yet cannot work, and the
    // receipt is the moment the person actually wants one — sending them to
    // Settings to come back afterwards guarantees they will not, and the
    // capture dies meanwhile. So Save sets the vault up first: silently when
    // the machine has an OS key, otherwise through the vault layer's own
    // setup dialog, which then owns the rest of the flow.
    if (!(await this.ensureVaultForSave())) return
    for (const row of rows) {
      if (!this.vault) continue
      try {
        const res = await this.vault.captureSave({ captureId: row.captureId, name: row.name })
        if (res.partial) {
          showToast({
            level: 'warning',
            message: `"${res.name}" saved, but the history rewrite is still owed — retry to finish it.`,
          })
          receipt.markFailed(
            row.captureId,
            `"${res.name}" is saved — the history rewrite is still owed; retry to finish it`,
          )
          continue
        }
        showToast({ level: 'success', message: `Stored "${res.name}" in the vault.` })
        if (receipt.removeRow(row.captureId)) this.retireReceipt(blockEl)
      } catch (err) {
        // A capture the backend no longer holds cannot be retried, so the
        // row must go rather than sit there offering an action that will
        // fail every time. Anything else is worth another attempt.
        if (isCaptureGone(err)) {
          showToast({
            level: 'warning',
            message: 'This offer is no longer held — the command stays stored masked.',
          })
          if (receipt.removeRow(row.captureId)) this.retireReceipt(blockEl)
          continue
        }
        showToast({
          level: 'danger',
          message: 'Could not save the secret — the command stays stored masked.',
        })
        receipt.markFailed(row.captureId, 'could not save — try again')
      }
    }
  }

  /** Make the vault able to receive a secret, or say why it cannot.
   *
   *  Returns true when the save may proceed. False means the flow moved
   *  somewhere else — the setup dialog is up, or the vault is locked — and
   *  the receipt stays as it is, so the same Save finishes the job once the
   *  person comes back. */
  private async ensureVaultForSave(): Promise<boolean> {
    if (!this.vault) return false
    let status
    try {
      status = await this.vault.status()
    } catch {
      return true // let the save itself report the real failure
    }
    if (status.state === 'unsealed') return true
    if (status.state === 'sealed') {
      showToast({ level: 'warning', message: 'Unlock the vault to save this key.' })
      return false
    }
    if (status.osKeyCapable) {
      try {
        await this.vault.setup({})
        return true
      } catch {
        showToast({
          level: 'danger',
          message: 'Could not set the vault up — the key was not saved.',
        })
        return false
      }
    }
    // No OS key: setting up needs a passphrase, and a passphrase needs a
    // dialog the vault layer owns. The receipt survives it.
    this.hooks.onSetupVault?.()
    return false
  }

  /** A row's drop control: dismiss that capture (and suppress its
   *  fingerprint for the session). A failed dismiss keeps the row. */
  private async dismissReceiptRow(
    receipt: BlockReceipt,
    blockEl: HTMLElement,
    captureId: string,
  ): Promise<void> {
    if (!this.vault) return
    try {
      await this.vault.captureDismiss(captureId)
      if (receipt.removeRow(captureId)) this.retireReceipt(blockEl)
      // Say what the refusal actually means. Dismissing suppresses THIS
      // value for the rest of the application session, so the same key in
      // the same command will not ask again — a consequence worth stating
      // once rather than letting it read as the feature having broken.
      showToast({
        level: 'info',
        message: 'Dismissed — this key will not be offered again in this session.',
      })
    } catch (err) {
      if (isCaptureGone(err)) {
        // Already gone: the user's intent is satisfied either way.
        if (receipt.removeRow(captureId)) this.retireReceipt(blockEl)
        return
      }
      showToast({
        level: 'danger',
        message: 'Could not dismiss the offer — try again.',
      })
    }
  }

  /** Hovering a receipt row emphasises that row's chip in the block's
   *  command line — and only that one. Chips carry their redaction span
   *  (data-redaction-start/end), stamped by renderRecordedCommand; the
   *  receipt row carries the capture id, mapped back here to the span. */
  private emphasiseChip(captureId: string | null): void {
    const blockEl =
      captureId === null ? this.receiptBlockEl : (this.receiptChipBlocks.get(captureId) ?? null)
    if (!blockEl) return
    const span = captureId === null ? undefined : this.receiptChipSpans.get(captureId)
    const chips = blockEl.querySelectorAll<HTMLElement>('.ui-secret-chip[data-redaction-start]')
    for (const chip of chips) {
      const matches =
        span !== undefined &&
        chip.dataset.redactionStart === String(span.start) &&
        chip.dataset.redactionEnd === String(span.end)
      chip.classList.toggle('ui-secret-chip--emphasised', matches)
    }
  }

  /** A submit was refused: an unresolved name or a sealed vault must not
   *  silently send a broken line (ADR-0021). The report lands where the
   *  user is looking; the editor's beforeSubmit seam kept the draft. The
   *  sealed case is rare — the dispatcher's unlock seam normally raises the
   *  prompt and retries; reaching here means it was cancelled or absent. */
  private reportSubmitFailure(failure: {
    reason: 'unresolved' | 'sealed' | 'error'
    names?: ReadonlyArray<string>
    message?: string
  }): void {
    if (failure.reason === 'unresolved') {
      const names = (failure.names ?? []).join(', ')
      showToast({
        level: 'danger',
        message: `Unknown secret${(failure.names ?? []).length === 1 ? '' : 's'}: ${names}. The command was not sent.`,
      })
      return
    }
    if (failure.reason === 'sealed') {
      showToast({
        level: 'danger',
        message: 'The vault is locked. Unlock it and run the command again.',
      })
      return
    }
    showToast({
      level: 'danger',
      message: failure.message ?? 'Could not resolve the command. It was not sent.',
    })
  }
}
