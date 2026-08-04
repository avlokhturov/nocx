// ═══════════════════════════════════════════════════════════════════════════
// PortsPanel — the Detected / Forwarded / Stopped surface (spec §9,
// nocx-wzc4.2), now a SIDEBAR VIEW (nocx-wzc4.7): the owner's reference
// (Orca's PORTS panel) sits beside the terminal so a port can be watched
// while the command that opens it is being typed. The panel follows the
// ACTIVE tab — profileId is a reactive accessor, never a capture — and
// pauses when the view is not visible (collapsed sidebar counts as hidden).
// Discovery's own state — unavailable, limited, last sample, Retry — lives
// in this same surface, because a degrade that is only in a log is the
// failure AGENTS.md names. Pause is a HEADER action (the view's
// SidebarViewDescriptor.actions slot), shared with the panel through the
// pause controller — the body offers no second vocabulary for it, and Retry
// exists only inside the failure states that need it (nocx-wzc4.9).
//
// The ledger labels, it never claims causation (spec D6): a row says what the
// remote listens on and why we know it, never "opened by <command>".
// ═══════════════════════════════════════════════════════════════════════════

import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import type { Dispatcher } from './dispatcher'
import type { PortsStatusResult } from './generated/ports.status'
import type { TunnelOpenResult } from './generated/tunnel.open'
import type { TunnelStopResult } from './generated/tunnel.stop'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { EmptyState } from './ui/empty-state'
import { IconButton } from './ui/icon-button'
import { ArrowRightIcon, CopyIcon, ExternalLinkIcon, SquareIcon } from './ui/icons'
import { MarkerList } from './ui/marker-list'
import { Section } from './ui/section'
import { Spinner } from './ui/spinner'
import { Stack } from './ui/stack'
import { showToast } from './ui/toast'
import { LOCAL_TARGET_ID } from './ports-client'

// ── Services seam ─────────────────────────────────────────────────────────

/** The panel's entire backend surface, so a test can substitute a fake. */
export interface PortsPanelServices {
  status(profileId: string): Promise<PortsStatusResult>
  sample(profileId: string): Promise<PortsStatusResult>
  pause(profileId: string, paused: boolean): Promise<unknown>
  visible(profileId: string, visible: boolean): Promise<unknown>
  openForward(profileId: string, destination: string, port: number): Promise<TunnelOpenResult>
  stopForward(id: string): Promise<TunnelStopResult>
}

/** Real implementation over the dispatcher. The forward scope names the
 *  panel as owner, so closing the panel tab stops exactly its forwards. */
export function createPortsPanelServices(dispatcher: Dispatcher): PortsPanelServices {
  const call = <T,>(method: string, params: unknown): Promise<T> =>
    dispatcher.call<T>(method, params)
  return {
    status: (profileId) => call('ports.status', { profileId }),
    sample: (profileId) => call('ports.sample', { profileId }),
    pause: (profileId, paused) => call('ports.pause', { profileId, paused }),
    visible: (profileId, visible) => call('ports.visible', { profileId, visible }),
    openForward: (profileId, destination, port) =>
      call('tunnel.open', { profileId, port, destination, scope: `ports:${profileId}` }),
    stopForward: (id) => call('tunnel.stop', { id }),
  }
}

// ── Pause controller ─────────────────────────────────────────────────────

/** The Pause state, shared between the view's HEADER action and the panel
 *  body: one signal, one backend call site. The header toggles it, the panel
 *  feeds it the backend's truth on every status merge and forgets it on
 *  re-scope. The controller closes over the reactive profile accessor, so
 *  the header never carries a stale profile id. */
export interface PortsPauseControl {
  paused: () => boolean
  /** Backend truth from a status merge. */
  sync(paused: boolean): void
  /** A profile switch forgets the previous connection's pause. */
  reset(): void
}

// nocx-wzc4.11 replaced the Pause header action with Refresh, so nothing in
// the renderer flips this any more: the control now only REFLECTS a pause the
// backend reports. `ports.pause` consequently has no caller — nocx-wzc4.12
// decides whether it gets one or goes.
export function createPortsPauseControl(): PortsPauseControl {
  const [paused, setPaused] = createSignal(false)
  return {
    paused,
    sync: (p) => setPaused(p),
    reset: () => setPaused(false),
  }
}

// ── Panel ─────────────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = 5_000

export interface PortsPanelProps {
  /** Reactive scope — the ACTIVE tab's ports target id, never a capture: a
   *  saved-profile id, or the reserved "local" for a local shell
   *  (nocx-wzc4.8). Null when the active tab has no ports scope (alias tab,
   *  Settings): the panel then shows the no-connection state instead of a
   *  stale host's ports. */
  profileId: () => string | null
  services: PortsPanelServices
  /** Reactive visibility; false stops the status poll and tells the
   *  backend to pause sampling. A collapsed sidebar is not visible. */
  visible: () => boolean
  /** The shared Pause control — the header action toggles it, the panel
   *  reflects and syncs it (nocx-wzc4.9). */
  pause: PortsPauseControl
}

type ForwardRecord = TunnelOpenResult | TunnelStopResult

export function PortsPanel(props: PortsPanelProps) {
  const [status, setStatus] = createSignal<PortsStatusResult | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [forwards, setForwards] = createSignal<Map<string, ForwardRecord>>(new Map())

  /** The panel's view of the shared pause state. */
  const paused = () => props.pause.paused()

  /** The panel's current scope — an alias for the reactive prop, read at
   *  call sites so every fetch and mutation targets the ACTIVE tab. */
  const profileId = () => props.profileId()

  /** True while the panel is scoped to the machine nocx itself runs on —
   *  the reserved "local" target (nocx-wzc4.8). Nothing can be forwarded
   *  from the machine you are on, so local rows offer copy-address instead
   *  of a Forward action. */
  const isLocal = () => profileId() === LOCAL_TARGET_ID

  /** Merge a fresh status: discovery state, cadence flags, and the backend's
   *  tracked forwards (which include connection-loss stops) on top of the
   *  panel's own records (which include user stops). */
  const applyStatus = (st: PortsStatusResult): void => {
    setStatus(st)
    setError(null)
    props.pause.sync(st.discovery.paused)
    setForwards((prev) => {
      const next = new Map(prev)
      for (const f of st.forwards) next.set(f.id, f)
      return next
    })
  }

  // Non-reactive by intent: reads signals, writes state, but must never
  // re-run when a signal it reads changes — it is a plain fetch. The pid is
  // captured per call and a response applies only while the panel is still
  // scoped to it: a late answer for a previous tab must never paint over the
  // current one (nocx-wzc4.7).
  const refresh = async (): Promise<void> => {
    const pid = profileId()
    if (pid === null) return
    try {
      const st = await props.services.status(pid)
      if (profileId() !== pid) return
      applyStatus(st)
    } catch (e) {
      if (profileId() !== pid) return
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Re-scope: the panel follows the ACTIVE tab. A profile switch discards
  // the previous connection's entire state — a local tab must not keep
  // showing a stale host's ports.
  createEffect(
    on(profileId, () => {
      setStatus(null)
      setError(null)
      props.pause.reset()
      setForwards(new Map())
    }),
  )

  // The backend's per-profile visible flag — the scheduler pauses discovery
  // sampling while nothing is watching. Re-scope retires the previous
  // profile's flag before arming the current one.
  createEffect(
    on([profileId, () => props.visible()], ([pid, vis], prev) => {
      const prevPid = prev?.[0] ?? null
      if (prevPid !== null && prevPid !== pid) {
        void props.services.visible(prevPid, false).catch(() => {})
      }
      if (pid !== null) {
        void props.services.visible(pid, vis).catch(() => {})
      }
    }),
  )

  // Initial load (a tracked scope, so solid/reactivity accepts the call)
  // plus a visibility-gated poll: hidden views stop fetching.
  let poll: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    const pid = profileId()
    if (pid === null) return
    void refresh()
    if (!props.visible()) return
    // The interval survives pause; the refresh is what skips. Resuming reuses
    // the same interval, and the optimistic toggle flips the flag the moment
    // the header action is pressed (nocx-wzc4.9).
    poll = setInterval(() => {
      if (!props.pause.paused()) void refresh()
    }, POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(poll))
  })

  const destinationFor = (l: PortsStatusResult['discovery']['listeners'][number]): string => {
    const host = status()?.host ?? ''
    const wildcard = l.address === '0.0.0.0' || l.address === '::' || l.address === ''
    return wildcard && host ? `${host}:${l.port}` : `${l.address}:${l.port}`
  }

  const recordForward = (rec: ForwardRecord): void => {
    setForwards((prev) => new Map(prev).set(rec.id, rec))
    showToast({
      level: 'success',
      message: `Forwarding ${rec.destination} on ${rec.actualBind.host}:${rec.actualBind.port}`,
    })
  }

  /** One action from the row (spec §9). When the same numeric port is busy
   *  locally, default to an allocated loopback port. */
  const forward = async (destination: string, port: number): Promise<void> => {
    const pid = profileId()
    // Nothing to forward from the machine you are on: local rows offer
    // copy-address, never Forward (nocx-wzc4.8). The guard makes the
    // invariant structural — the row button is already swapped, but a
    // stray call must never dial tunnel.open with the "local" target.
    if (pid === null || pid === LOCAL_TARGET_ID) return
    try {
      const rec = await props.services.openForward(pid, destination, port)
      if (profileId() !== pid) return
      recordForward(rec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/address already in use|EADDRINUSE/i.test(msg)) {
        if (profileId() === pid) showToast({ level: 'danger', message: msg })
        return
      }
      try {
        const rec = await props.services.openForward(pid, destination, 0)
        if (profileId() !== pid) return
        recordForward(rec)
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2)
        if (profileId() === pid) showToast({ level: 'danger', message: msg2 })
      }
    }
    if (profileId() === pid) await refresh()
  }

  const stop = async (id: string): Promise<void> => {
    const pid = profileId()
    if (pid === null) return
    try {
      const rec = await props.services.stopForward(id)
      if (profileId() !== pid) return
      setForwards((prev) => new Map(prev).set(rec.id, rec))
      await refresh()
    } catch (e) {
      if (profileId() === pid) {
        showToast({ level: 'danger', message: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  const retry = (rec: ForwardRecord): void => {
    void forward(rec.destination, rec.requestedBind.port)
  }

  /** The Retry action inside failure states: force a fresh sample. */
  const sampleNow = async (): Promise<void> => {
    const pid = profileId()
    if (pid === null) return
    try {
      const st = await props.services.sample(pid)
      if (profileId() !== pid) return
      applyStatus(st)
    } catch (e) {
      if (profileId() !== pid) return
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const copyAddress = (addr: string): void => {
    void navigator.clipboard
      .writeText(addr)
      .then(() => showToast({ level: 'success', message: `Copied ${addr}` }))
      .catch(() => showToast({ level: 'warning', message: 'Could not copy' }))
  }

  const openAddress = (addr: string): void => {
    window.open(`http://${addr}`, '_blank')
  }

  const st = () => status()?.discovery
  const host = () => status()?.host ?? ''
  const listeners = () => st()?.listeners ?? []
  /** Reading, as opposed to having nothing to read. No status yet is always
   *  loading; a connected target whose first sample has not landed is too —
   *  that window is the settle delay plus a round trip, and showing nothing
   *  through it reads as broken (nocx-wzc4.11). A profile with no session is
   *  NOT loading: there is nothing to wait for. */
  /** True when any listener's owner could not be named. The reason is the
   *  probe's privilege, not the row's. */
  const hiddenOwners = (): boolean => listeners().some((l) => l.process.evidence !== 'known')

  const loading = (): boolean => {
    if (st() === undefined) return true
    if (st()?.state !== 'pending') return false
    return isLocal() || !!host()
  }

  /** Every discovery state the Detected section has an arm for. The section
   *  renders exactly one thing, and this is what makes "exactly one" a fact
   *  rather than a hope: a heading with a hairline and nothing under it is
   *  the shape a user reads as broken, and it is what the owner saw on
   *  2026-08-04. A state we do not know must NAME ITSELF rather than render
   *  as absence — an unhandled case is information, and losing it is the
   *  soft degrade AGENTS.md forbids. */
  const DETECTED_ARMS = new Set([
    'unavailable',
    'failed-transiently',
    'permission-or-policy-refused',
    'pending',
    'available',
    'available-limited',
  ])

  /** The state string when no arm claims it — '' when one does. */
  const unhandledState = (): string => {
    const s = st()
    if (!s || s.connLost) return ''
    return DETECTED_ARMS.has(s.state) ? '' : s.state || '(empty)'
  }

  const runningForwards = () => [...forwards().values()].filter((f) => f.state === 'running')
  const stoppedForwards = () => [...forwards().values()].filter((f) => f.state === 'stopped')

  const processLabel = (p: { evidence: string; name: string; pid: number }): string => {
    switch (p.evidence) {
      case 'known':
        return `${p.name} (pid ${p.pid})`
      case 'permission-denied':
        return 'owners hidden — run as root to see owners'
      default:
        return 'process not provided by this probe'
    }
  }

  return (
    <Show
      when={profileId() !== null}
      fallback={
        <EmptyState
          title="No active connection"
          description="Switch to an SSH tab — the ports it listens on will appear here."
        />
      }
    >
      <Stack gap="loose">
        <Show when={error()}>
          <Badge tone="danger">{error() ?? ''}</Badge>
        </Show>

        {/* ── Discovery state ─────────────────────────────────────── */}
        <Show
          when={!loading()}
          fallback={
            <div class="ports-loading" data-testid="ports-loading">
              <Spinner label="Reading ports" />
              <span>Reading ports…</span>
            </div>
          }
        >
          {/* A profile with no session yet is not loading — there is nothing
              to wait for until the user opens one. */}
          <Show when={!host() && st()?.state === 'pending' && !isLocal()}>
            <EmptyState
              title="No active connection"
              description="Open an SSH session to this profile first — the ports it listens on will appear here."
            />
          </Show>
          <Show when={host() || (st()?.state ?? '') !== 'pending'}>
            <Show when={st()?.connLost}>
              <EmptyState
                title="Connection lost"
                description="Discovery stopped with the connection. It resumes automatically after you reconnect."
                action={<Button onClick={() => void sampleNow()}>Retry</Button>}
              />
            </Show>
            <Show when={!st()?.connLost}>
              <Section title="Detected" divided dense>
                <Show when={unhandledState()}>
                  <EmptyState
                    title="Discovery is in a state this panel does not know"
                    description={`The backend reported "${unhandledState()}". This is a bug in nocx, not on the host.`}
                    action={<Button onClick={() => void sampleNow()}>Retry</Button>}
                  />
                </Show>
                <Show when={st()?.state === 'unavailable'}>
                  <EmptyState
                    title="Could not determine what is listening"
                    description={st()?.classification || 'No probe tool is usable on this host.'}
                  />
                </Show>
                <Show when={st()?.state === 'failed-transiently'}>
                  <EmptyState
                    title="Discovery failed transiently"
                    description={`${st()?.classification ?? 'The probe failed.'} Retrying automatically with backoff.`}
                  />
                </Show>
                <Show when={st()?.state === 'permission-or-policy-refused'}>
                  <EmptyState
                    title="Discovery refused on this host"
                    description={
                      st()?.classification ?? 'The server refused the additional session.'
                    }
                    action={<Button onClick={() => void sampleNow()}>Retry</Button>}
                  />
                </Show>
                <Show when={st()?.state === 'pending' && host()}>
                  <EmptyState
                    title="Waiting for the first sample"
                    description="The settle sample runs shortly after the connection comes up."
                  />
                </Show>
                <Show when={st()?.state === 'available' || st()?.state === 'available-limited'}>
                  {/* Stated once, above the rows it applies to. */}
                  <Show when={hiddenOwners()}>
                    <p class="ports-note" data-testid="ports-owners-note">
                      Some owners are hidden — run as root to see them.
                    </p>
                  </Show>
                  <Show
                    when={listeners().length > 0}
                    fallback={
                      <EmptyState
                        title="Nothing is listening"
                        description={`No listeners observed on ${host()}.`}
                      />
                    }
                  >
                    <For each={listeners()}>
                      {(l) => (
                        <div class="ports-row" data-testid="detected-row">
                          <div class="ports-row__main">
                            <div class="ports-row__text">
                              <span class="ports-row__addr">
                                {l.address}:{l.port}
                              </span>
                              {/* A name and a pid are a label and read as
                                  quiet text; the states that are a caution
                                  keep the chip, because there the tone IS the
                                  information (nocx-wzc4.10). */}
                              {/* Only a known owner earns a line. "Owners
                                  hidden" is one fact about the probe, not a
                                  banner repeated down every row where it does
                                  not fit — it is stated once above the list
                                  (nocx-wzc4.11). */}
                              <Show when={l.process.evidence === 'known'}>
                                <span class="ports-row__proc">{processLabel(l.process)}</span>
                              </Show>
                            </div>
                            <Show
                              when={isLocal()}
                              fallback={
                                <IconButton
                                  data-testid="ports-forward"
                                  size="xs"
                                  ariaLabel={`Forward ${destinationFor(l)}`}
                                  title={`Forward ${destinationFor(l)}`}
                                  onClick={() => void forward(destinationFor(l), l.port)}
                                >
                                  <ArrowRightIcon />
                                </IconButton>
                              }
                            >
                              <IconButton
                                data-testid="ports-copy"
                                size="xs"
                                ariaLabel={`Copy ${destinationFor(l)}`}
                                title={`Copy ${destinationFor(l)}`}
                                onClick={() => copyAddress(destinationFor(l))}
                              >
                                <CopyIcon />
                              </IconButton>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
              </Section>

              {/* The forwarding vocabulary exists only off this machine:
                  local rows offer copy-address, and the Forwarded / Stopped
                  sections would be an empty offer of an impossible action
                  (nothing to forward from the machine you are on,
                  nocx-wzc4.8). */}
              <Show when={!isLocal()}>
                {/* ── Forwarded ─────────────────────────────────────── */}
                <Section title="Forwarded" divided dense>
                  <Show
                    when={runningForwards().length > 0}
                    fallback={
                      <EmptyState
                        title="No active forwards"
                        description="Forward a detected port to make it reachable locally."
                      />
                    }
                  >
                    <For each={runningForwards()}>
                      {(f) => (
                        <div class="ports-row" data-testid="forwarded-row">
                          <div class="ports-row__main">
                            <div class="ports-row__text">
                              <span class="ports-row__addr">
                                {f.actualBind.host}:{f.actualBind.port}
                              </span>
                              <span class="ports-row__dest">
                                <span class="ports-row__arrow" aria-hidden="true">
                                  →{' '}
                                </span>
                                {f.destination}
                              </span>
                            </div>
                            <IconButton
                              data-testid="ports-copy"
                              size="xs"
                              ariaLabel={`Copy ${f.actualBind.host}:${f.actualBind.port}`}
                              title={`Copy ${f.actualBind.host}:${f.actualBind.port}`}
                              onClick={() =>
                                copyAddress(`${f.actualBind.host}:${f.actualBind.port}`)
                              }
                            >
                              <CopyIcon />
                            </IconButton>
                            <IconButton
                              data-testid="ports-open"
                              size="xs"
                              ariaLabel={`Open ${f.actualBind.host}:${f.actualBind.port}`}
                              title={`Open ${f.actualBind.host}:${f.actualBind.port}`}
                              onClick={() =>
                                openAddress(`${f.actualBind.host}:${f.actualBind.port}`)
                              }
                            >
                              <ExternalLinkIcon />
                            </IconButton>
                            <IconButton
                              data-testid="ports-stop"
                              size="xs"
                              ariaLabel={`Stop forward ${f.destination}`}
                              title={`Stop forward ${f.destination}`}
                              onClick={() => void stop(f.id)}
                            >
                              <SquareIcon />
                            </IconButton>
                          </div>
                          {/* A -R forward whose bind sshd silently replaced carries
                              Caveat() — render it as the kit's note (a caveat about
                              the item above it), never as an error: the forward is
                              running. Empty caveat renders nothing. */}
                          <Show when={f.caveat}>
                            <MarkerList items={[{ text: f.caveat, tone: 'note' }]} />
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </Section>

                {/* ── Stopped (only when non-empty) ─────────────────── */}
                <Show when={stoppedForwards().length > 0}>
                  <Section title="Stopped" divided dense>
                    <For each={stoppedForwards()}>
                      {(f) => (
                        <div class="ports-row" data-testid="stopped-row">
                          <div class="ports-row__main">
                            <div class="ports-row__text">
                              <span class="ports-row__addr">{f.destination}</span>
                              <span class="ports-row__proc">{f.stopReason ?? 'stopped'}</span>
                              <Show when={f.error}>
                                <Badge tone="danger" truncate>
                                  {f.error ?? ''}
                                </Badge>
                              </Show>
                            </div>
                            <Show
                              when={f.stopReason === 'error' || f.stopReason === 'connection lost'}
                            >
                              <Button data-testid="ports-retry-forward" onClick={() => retry(f)}>
                                Retry
                              </Button>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </Section>
                </Show>
              </Show>
            </Show>
          </Show>

          {/* Only "paused" survives here (nocx-wzc4.10). The sample's age told
              the user nothing they could act on: the list refreshes itself, and
              when a sample fails we show the failure instead of stale rows —
              so there is never a moment where the rows on screen are older
              than they look. "Paused" is different: it is the one state where
              the rows genuinely stop tracking the host, and it names why. */}
          <Show when={paused()}>
            <p class="ports-meta" data-testid="ports-meta">
              paused
            </p>
          </Show>
        </Show>
      </Stack>
    </Show>
  )
}
