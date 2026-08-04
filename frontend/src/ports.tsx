// ═══════════════════════════════════════════════════════════════════════════
// PortsPanel — the Detected / Forwarded / Stopped surface (spec §9,
// nocx-wzc4.2), now a SIDEBAR VIEW (nocx-wzc4.7): the owner's reference
// (Orca's PORTS panel) sits beside the terminal so a port can be watched
// while the command that opens it is being typed. The panel follows the
// ACTIVE tab — profileId is a reactive accessor, never a capture — and
// pauses when the view is not visible (collapsed sidebar counts as hidden).
//
// Discovery's own state — unavailable, limited, last sample, Pause, Retry —
// lives in this same surface, because a degrade that is only in a log is
// the failure AGENTS.md names.
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
import { MarkerList } from './ui/marker-list'
import { Section } from './ui/section'
import { Stack } from './ui/stack'
import { showToast } from './ui/toast'

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

// ── Panel ─────────────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = 5_000

export interface PortsPanelProps {
  /** Reactive scope — the ACTIVE tab's saved-profile id, never a capture.
   *  Null when the active tab has no profile (local shell, alias,
   *  Settings): the panel then shows the no-connection state instead of a
   *  stale host's ports. */
  profileId: () => string | null
  services: PortsPanelServices
  /** Reactive visibility; false stops the status poll and tells the
   *  backend to pause sampling. A collapsed sidebar is not visible. */
  visible: () => boolean
}

type ForwardRecord = TunnelOpenResult | TunnelStopResult

export function PortsPanel(props: PortsPanelProps) {
  const [status, setStatus] = createSignal<PortsStatusResult | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(true)
  const [paused, setPaused] = createSignal(false)
  const [forwards, setForwards] = createSignal<Map<string, ForwardRecord>>(new Map())

  /** The panel's current scope — an alias for the reactive prop, read at
   *  call sites so every fetch and mutation targets the ACTIVE tab. */
  const profileId = () => props.profileId()

  /** Merge a fresh status: discovery state, cadence flags, and the backend's
   *  tracked forwards (which include connection-loss stops) on top of the
   *  panel's own records (which include user stops). */
  const applyStatus = (st: PortsStatusResult): void => {
    setStatus(st)
    setError(null)
    setPaused(st.discovery.paused)
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
    } finally {
      if (profileId() === pid) setBusy(false)
    }
  }

  // Re-scope: the panel follows the ACTIVE tab. A profile switch discards
  // the previous connection's entire state — a local tab must not keep
  // showing a stale host's ports.
  createEffect(
    on(profileId, () => {
      setStatus(null)
      setError(null)
      setBusy(true)
      setPaused(false)
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
    if (pid === null) {
      setBusy(false)
      return
    }
    void refresh()
    if (!props.visible()) return
    poll = setInterval(() => void refresh(), POLL_INTERVAL_MS)
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
    if (pid === null) return
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

  /** The Retry button: force a fresh sample for the current profile. */
  const sampleNow = async (): Promise<void> => {
    const pid = profileId()
    if (pid === null) return
    setBusy(true)
    try {
      const st = await props.services.sample(pid)
      if (profileId() !== pid) return
      applyStatus(st)
    } catch (e) {
      if (profileId() !== pid) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (profileId() === pid) setBusy(false)
    }
  }

  const togglePause = (): void => {
    const pid = profileId()
    if (pid === null) return
    const next = !paused()
    setPaused(next)
    void props.services.pause(pid, next).catch(() => {})
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
  const runningForwards = () => [...forwards().values()].filter((f) => f.state === 'running')
  const stoppedForwards = () => [...forwards().values()].filter((f) => f.state === 'stopped')

  const lastSample = (): string | null => {
    const at = st()?.lastSampleAt
    if (!at) return null
    const d = new Date(at)
    if (Number.isNaN(d.getTime())) return at
    return d.toLocaleTimeString()
  }

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
        {/* Controls row — the panel's own header line inside the sidebar
            body (the SidebarView header hosts the view's actions slot;
            these need the panel's live state, so they live with it). */}
        <Stack gap="default">
          <Show when={lastSample()}>
            <Badge tone="neutral">{`last sample ${lastSample()}`}</Badge>
          </Show>
          <Show when={paused()}>
            <Badge tone="warning">paused</Badge>
          </Show>
          <Button
            data-testid="ports-retry"
            onClick={() => void sampleNow()}
            disabled={busy() || st()?.connLost}
          >
            Retry
          </Button>
          <Button data-testid="ports-pause" onClick={togglePause}>
            {paused() ? 'Resume' : 'Pause'}
          </Button>
        </Stack>
        <Show when={error()}>
          <Badge tone="danger">{error() ?? ''}</Badge>
        </Show>

        {/* ── Discovery state ─────────────────────────────────────── */}
        <Show
          when={!busy() && st() !== undefined}
          fallback={
            <EmptyState
              title="Contacting the backend…"
              description="Reading discovery state for this connection."
            />
          }
        >
          <Show when={!host() && st()?.state === 'pending'}>
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
              <Section title={`Detected${host() ? ` — ${host()}` : ''}`} divided>
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
                            <span class="ports-row__addr">
                              {l.address}:{l.port}
                            </span>
                            <Badge
                              tone={
                                l.process.evidence === 'known'
                                  ? 'neutral'
                                  : l.process.evidence === 'permission-denied'
                                    ? 'warning'
                                    : 'info'
                              }
                            >
                              {processLabel(l.process)}
                            </Badge>
                            <Button
                              data-testid="ports-forward"
                              onClick={() => void forward(destinationFor(l), l.port)}
                            >
                              Forward
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
              </Section>

              {/* ── Forwarded ─────────────────────────────────────── */}
              <Section title="Forwarded" divided>
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
                          <span class="ports-row__addr">
                            {f.actualBind.host}:{f.actualBind.port}
                            <span class="ports-row__arrow"> → </span>
                            {f.destination}
                          </span>
                          <Button
                            data-testid="ports-copy"
                            onClick={() => copyAddress(`${f.actualBind.host}:${f.actualBind.port}`)}
                          >
                            Copy
                          </Button>
                          <Button
                            data-testid="ports-open"
                            onClick={() => openAddress(`${f.actualBind.host}:${f.actualBind.port}`)}
                          >
                            Open
                          </Button>
                          <Button data-testid="ports-stop" onClick={() => void stop(f.id)}>
                            Stop
                          </Button>
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
                <Section title="Stopped" divided>
                  <For each={stoppedForwards()}>
                    {(f) => (
                      <div class="ports-row" data-testid="stopped-row">
                        <div class="ports-row__main">
                          <span class="ports-row__addr">
                            {f.destination}
                            <span class="ports-row__arrow"> — </span>
                            {f.stopReason ?? 'stopped'}
                          </span>
                          <Show when={f.error}>
                            <Badge tone="danger">{f.error ?? ''}</Badge>
                          </Show>
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
      </Stack>
    </Show>
  )
}
