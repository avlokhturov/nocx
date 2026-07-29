/**
 * RolloutPanel — credential version rollout surface.
 *
 * Reachable from the Credentials section: stage a candidate, choose a canary,
 * run a rollout, watch it, and perform the three transitions (promote, retire,
 * revoke).
 *
 * This component renders inside a Dialog owned by the parent. The parent owns
 * the dialog chrome (title, close button, focus management). This component
 * manages the rollout workflow state.
 *
 * Design rules from spec §6:
 * - The renderer is a display layer, not a logic layer. No blast-radius
 *   computation, no threshold decisions, no session-list filtering.
 * - A rollout reads as a run that happened, not as settings. Past tense,
 *   timestamps, outcome — not a form with a Save button.
 * - The blast radius is shown before destructive transitions via
 *   versions.impact.
 * - Emergency revoke is never a single unqualified button.
 * - Promotion asks for its threshold and reports returned evidence.
 * - Nothing auto-runs.
 */
import { For, Show, createSignal, createMemo, untrack } from 'solid-js'
import { Button } from './ui/button'
import { TextField } from './ui/text-field'
import { Checkbox } from './ui/checkbox'
import { Badge } from './ui/badge'
import { showConfirm } from './ui/dialog'
import { showToast } from './ui/toast'
import { Section } from './ui/section'
import type {
  Credential,
  CredentialUsage,
  ProfileClient,
  ProbeOutcome,
  RolloutRunResult,
  EndpointResult,
  Exclusion,
  NotAttempted,
  VersionImpactResult,
} from './profiles'

// ── Props ──────────────────────────────────────────────────────────────────

export interface RolloutPanelProps {
  client: ProfileClient
  credential: Credential
  usage: CredentialUsage | null
  /** Called after a state-changing action so the parent refreshes its data. */
  onStateChange?: () => void
}

// ── Outcome helpers ─────────────────────────────────────────────────────────

export function outcomeLabel(outcome: ProbeOutcome): string {
  switch (outcome) {
    case 'accepted':
      return 'Accepted'
    case 'rejected':
      return 'Rejected'
    case 'unreachable':
      return 'Unreachable'
    case 'host-key-problem':
      return 'Host key problem'
    case 'needs-interactive':
      return 'Needs interactive'
  }
}

export function outcomeTone(outcome: ProbeOutcome): 'neutral' | 'info' | 'warning' | 'danger' {
  switch (outcome) {
    case 'accepted':
      return 'info'
    case 'rejected':
      return 'danger'
    case 'unreachable':
      return 'warning'
    case 'host-key-problem':
      return 'danger'
    case 'needs-interactive':
      return 'warning'
  }
}

function rolloutStatusBadge(status: string): {
  tone: 'neutral' | 'info' | 'warning' | 'danger'
  label: string
} {
  switch (status) {
    case 'completed':
      return { tone: 'info', label: 'Completed' }
    case 'running':
      return { tone: 'warning', label: 'Running' }
    case 'cancelled':
      return { tone: 'neutral', label: 'Cancelled' }
    case 'failed':
      return { tone: 'danger', label: 'Failed' }
    default:
      return { tone: 'neutral', label: status }
  }
}

function createdLabel(created?: string): string {
  if (!created) return ''
  try {
    const d = new Date(created)
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return created
  }
}

// ── Rollout result tables ──────────────────────────────────────────────────

function OutcomeRow(props: { result: EndpointResult }) {
  return (
    <tr class="ro-item">
      <td class="ro-item-profile">{props.result.profileId}</td>
      <td class="ro-item-endpoint">{props.result.endpoint}</td>
      <td class="ro-item-outcome">
        <Badge tone={outcomeTone(props.result.outcome)}>{outcomeLabel(props.result.outcome)}</Badge>
      </td>
      <td class="ro-item-detail">{props.result.detail ?? ''}</td>
    </tr>
  )
}

function ExclusionRow(props: { ex: Exclusion }) {
  return (
    <tr class="ro-item">
      <td class="ro-item-profile">{props.ex.profileId}</td>
      <td class="ro-item-endpoint">{props.ex.endpoint}</td>
      <td class="ro-item-outcome">
        <Badge tone="warning">Excluded</Badge>
      </td>
      <td class="ro-item-detail">{props.ex.reason}</td>
    </tr>
  )
}

function NotAttemptedRow(props: { na: NotAttempted }) {
  return (
    <tr class="ro-item">
      <td class="ro-item-profile">{props.na.profileId}</td>
      <td class="ro-item-endpoint">{props.na.endpoint}</td>
      <td class="ro-item-outcome">
        <Badge tone="neutral">Not attempted</Badge>
      </td>
      <td class="ro-item-detail">—</td>
    </tr>
  )
}

// ── Version badge helper ────────────────────────────────────────────────────

function VersionBadge(props: { label: string; versionId: string; created?: string }) {
  return (
    <div class="ro-version-badge">
      <strong>{props.label}:</strong> <code>{props.versionId}</code>
      <Show when={props.created}>
        <span class="ro-version-date">{createdLabel(props.created)}</span>
      </Show>
    </div>
  )
}

// ── Component ───────────────────────────────────────────────────────────────

export function RolloutPanel(props: RolloutPanelProps) {
  const cred = () => props.credential

  // ── Stage state ────────────────────────────────────────────────────────
  const [candidatePassword, setCandidatePassword] = createSignal('')
  const [stagingBusy, setStagingBusy] = createSignal(false)

  // ── Discard state ──────────────────────────────────────────────────────
  const [discardingBusy, setDiscardingBusy] = createSignal(false)

  // ── Rollout state ──────────────────────────────────────────────────────
  const profileIds = createMemo(() => {
    const u = props.usage
    if (!u) return []
    return u.profiles.map((p) => p.profileId)
  })
  const [selectedTargetIds, setSelectedTargetIds] = createSignal<Set<string>>(
    new Set(
      untrack(() => {
        const u = props.usage
        if (!u) return [] as string[]
        return u.profiles.map((p) => p.profileId)
      }),
    ),
  )
  const [canaryIds, setCanaryIds] = createSignal<Set<string>>(new Set())
  const [batchSize, setBatchSize] = createSignal('')
  const [globalConcurrency, setGlobalConcurrency] = createSignal('')
  const [rolloutRunning, setRolloutRunning] = createSignal(false)
  const [rolloutResult, setRolloutResult] = createSignal<RolloutRunResult | null>(null)
  const [rolloutError, setRolloutError] = createSignal<string | null>(null)

  // ── Promote state ──────────────────────────────────────────────────────
  const [promoteThreshold, setPromoteThreshold] = createSignal('3')
  const [promotingBusy, setPromotingBusy] = createSignal(false)
  const [promoteEvidence, setPromoteEvidence] = createSignal<{
    accepted: number
    total: number
  } | null>(null)

  // ── Retire state ───────────────────────────────────────────────────────
  const [retireDrain, setRetireDrain] = createSignal(false)
  const [retiringBusy, setRetiringBusy] = createSignal(false)

  // ── Revoke state ───────────────────────────────────────────────────────
  const [revokeImpact, setRevokeImpact] = createSignal<VersionImpactResult | null>(null)
  const [revokeBusy, setRevokeBusy] = createSignal(false)
  const [revokeConfirmOpen, setRevokeConfirmOpen] = createSignal(false)

  // ── Derived state ───────────────────────────────────────────────────────

  const candidate = createMemo(() => {
    const c = cred()
    if (!c.candidateVersionId || !c.versions) return null
    return c.versions.find((v) => v.id === c.candidateVersionId) ?? null
  })

  const current = createMemo(() => {
    const c = cred()
    if (!c.currentVersionId || !c.versions) return null
    return c.versions.find((v) => v.id === c.currentVersionId) ?? null
  })

  const isPasswordAuth = () => cred().auth === 'password'

  // ── Stage candidate ────────────────────────────────────────────────────
  async function handleStageCandidate() {
    const pw = candidatePassword()
    if (!pw) {
      showToast({ level: 'warning', message: 'Enter a new password to stage' })
      return
    }
    setStagingBusy(true)
    try {
      await props.client.stagePassword(cred().id, pw)
      setCandidatePassword('')
      showToast({
        level: 'success',
        message: 'Candidate version staged for ' + cred().name,
      })
      props.onStateChange?.()
    } catch (err) {
      const msg = (err as Error).message
      showToast({ level: 'danger', message: 'Could not stage: ' + msg })
    } finally {
      setStagingBusy(false)
    }
  }

  // ── Discard candidate ──────────────────────────────────────────────────
  async function handleDiscardCandidate() {
    if (!(await showConfirm('Discard the staged candidate version?', 'Discard', 'Cancel'))) {
      return
    }
    setDiscardingBusy(true)
    try {
      await props.client.discardCandidate(cred().id)
      setRolloutResult(null)
      showToast({
        level: 'success',
        message: 'Candidate discarded for ' + cred().name,
      })
      props.onStateChange?.()
    } catch (err) {
      const msg = (err as Error).message
      showToast({ level: 'danger', message: 'Could not discard: ' + msg })
    } finally {
      setDiscardingBusy(false)
    }
  }

  // ── Run rollout ────────────────────────────────────────────────────────
  async function handleRunRollout() {
    const can = candidate()
    if (!can) return

    const targets = [...selectedTargetIds()]
    if (targets.length === 0) {
      showToast({
        level: 'warning',
        message: 'Select at least one target profile',
      })
      return
    }

    setRolloutRunning(true)
    setRolloutResult(null)
    setRolloutError(null)
    try {
      const result = await props.client.rolloutRun({
        credentialId: cred().id,
        versionId: can.id,
        targetIds: targets,
        canaryIds: canaryIds().size > 0 ? [...canaryIds()] : undefined,
        batchSize: batchSize() ? parseInt(batchSize(), 10) : undefined,
        globalConcurrency: globalConcurrency() ? parseInt(globalConcurrency(), 10) : undefined,
      })
      setRolloutResult(result)
      showToast({
        level: 'success',
        message: `Rollout completed: ${result.probed?.length ?? 0} probed`,
      })
      // Refresh credential data to get updated version info
      props.onStateChange?.()
    } catch (err) {
      const msg = (err as Error).message
      setRolloutError(msg)
      showToast({ level: 'danger', message: 'Rollout failed: ' + msg })
    } finally {
      setRolloutRunning(false)
    }
  }
  // ── Promote ────────────────────────────────────────────────────────────
  async function handlePromote() {
    const threshold = parseInt(promoteThreshold(), 10)
    if (isNaN(threshold) || threshold <= 0) {
      showToast({
        level: 'warning',
        message: 'Threshold must be a positive number',
      })
      return
    }
    if (
      !(await showConfirm(
        `Promote the candidate version with a threshold of ${threshold} accepted?`,
        'Promote',
        'Cancel',
      ))
    ) {
      return
    }

    setPromotingBusy(true)
    setPromoteEvidence(null)
    try {
      const result = await props.client.versionPromote(cred().id, {
        minAccepted: threshold,
      })
      setPromoteEvidence(result.evidence)
      showToast({
        level: 'success',
        message: `Version promoted (${result.evidence.accepted} accepted out of ${result.evidence.total})`,
      })
      props.onStateChange?.()
    } catch (err) {
      const msg = (err as Error).message
      showToast({ level: 'danger', message: 'Promotion failed: ' + msg })
    } finally {
      setPromotingBusy(false)
    }
  }

  // ── Retire ──────────────────────────────────────────────────────────────
  async function handleRetire() {
    const cur = current()
    if (!cur) return

    // Show impact before retiring
    try {
      const impact = await props.client.versionImpact(cred().id, cur.id)
      const profilesList = impact.profilesUsing
      const pinnedList = impact.pinnedProfiles

      let msg = `Retire version ${cur.id}?`
      if (profilesList.length > 0) {
        msg +=
          `\n${profilesList.length} profile(s) will stop resolving to this version: ` +
          profilesList.map((p) => p.profileName).join(', ')
      }
      if (pinnedList.length > 0) {
        msg +=
          `\n${pinnedList.length} profile(s) are pinned to this version and will NOT be affected by retirement: ` +
          pinnedList.map((p) => p.profileName).join(', ')
      }

      if (!(await showConfirm(msg, 'Retire', 'Cancel'))) return
    } catch {
      // If impact fails, fall back to a simpler confirm
      if (!(await showConfirm(`Retire version ${cur.id}?`, 'Retire', 'Cancel'))) return
    }

    setRetiringBusy(true)
    try {
      const result = await props.client.versionRetire(cred().id, cur.id, retireDrain())
      showToast({
        level: 'success',
        message: `Version ${cur.id} retired (${result.sessionsClosed} session(s) closed)`,
      })
      props.onStateChange?.()
    } catch (err) {
      const msg = (err as Error).message
      showToast({ level: 'danger', message: 'Retire failed: ' + msg })
    } finally {
      setRetiringBusy(false)
    }
  }

  // ── Revoke ─────────────────────────────────────────────────────────────
  async function handleRevokeImpact() {
    const cur = current()
    if (!cur) return
    setRevokeBusy(true)
    try {
      const impact = await props.client.versionImpact(cred().id, cur.id)
      setRevokeImpact(impact)
      setRevokeConfirmOpen(true)
    } catch (err) {
      const msg = (err as Error).message
      showToast({ level: 'danger', message: 'Could not load impact: ' + msg })
    } finally {
      setRevokeBusy(false)
    }
  }

  async function confirmRevoke() {
    const cur = current()
    if (!cur) return
    const impact = revokeImpact()
    const liveCount = impact?.liveSessions.length ?? 0

    if (
      !(await showConfirm(
        `Emergency revoke version ${cur.id}?\n\n` +
          `This will close ${liveCount} live session(s) and the version will no ` +
          `longer be usable for any connection.\n\n` +
          (impact && impact.liveSessions.length > 0
            ? 'Sessions to close: ' + impact.liveSessions.map((s) => s.profileName).join(', ')
            : 'No live sessions on this version.'),
        'Revoke',
        'Cancel',
      ))
    ) {
      return
    }

    setRevokeBusy(true)
    try {
      const result = await props.client.versionRevoke(cred().id, cur.id)
      setRevokeConfirmOpen(false)
      setRevokeImpact(null)
      showToast({
        level: 'success',
        message: `Version revoked (${result.sessionsClosed} session(s) closed)`,
      })
      props.onStateChange?.()
    } catch (err) {
      const msg = (err as Error).message
      showToast({ level: 'danger', message: 'Revoke failed: ' + msg })
    } finally {
      setRevokeBusy(false)
    }
  }

  function cancelRevoke() {
    setRevokeConfirmOpen(false)
    setRevokeImpact(null)
  }

  // ── Toggle a target in the selection set ───────────────────────────────
  function toggleTarget(id: string) {
    setSelectedTargetIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleCanary(id: string) {
    setCanaryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function selectAllTargets() {
    setSelectedTargetIds(new Set(profileIds()))
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const can = () => candidate()
  const cur = () => current()
  const result = () => rolloutResult()
  const hasRolloutRun = () => result() !== null
  const promoteEvidenceVal = () => promoteEvidence()

  return (
    <div class="ro-root">
      <Section title="Versions">
        <Show when={cur()} fallback={<p>Legacy credential (no version tracking)</p>}>
          {(v) => (
            <div class="ro-versions">
              <VersionBadge label="Current" versionId={v().id} created={v().created} />
              <Show when={can()}>
                {(cv) => (
                  <VersionBadge label="Candidate" versionId={cv().id} created={cv().created} />
                )}
              </Show>
            </div>
          )}
        </Show>
      </Section>

      {/* Stage candidate section */}
      <Show when={!can() && isPasswordAuth()}>
        <Section title="Stage candidate">
          <p class="ro-desc">
            Create a candidate version with a new password. The current version is unaffected until
            you promote the candidate after probing.
          </p>
          <TextField
            id="ro-candidate-password"
            label="New password"
            type="password"
            value={candidatePassword()}
            onInput={setCandidatePassword}
          />
          <div class="ro-action-row">
            <Button
              variant="primary"
              onClick={() => void handleStageCandidate()}
              disabled={stagingBusy() || !candidatePassword()}
            >
              {stagingBusy() ? 'Staging...' : 'Stage candidate'}
            </Button>
          </div>
        </Section>
      </Show>

      {/* Candidate exists — rollout controls */}
      <Show when={can()}>
        <Section title="Rollout">
          {/* Discard */}
          <div class="ro-action-row">
            <Button
              variant="ghost"
              onClick={() => void handleDiscardCandidate()}
              disabled={discardingBusy()}
            >
              {discardingBusy() ? 'Discarding...' : 'Discard candidate'}
            </Button>
          </div>

          {/* Target selection */}
          <Show when={profileIds().length > 0}>
            <div class="ro-field-group">
              <span class="ro-field-label">Target profiles</span>
              <p class="ro-desc">
                Select the profiles to probe with the candidate credential.
                {canaryIds().size > 0 ? ' Canaries will be probed first.' : ''}
              </p>
              <div class="ro-target-list">
                <For each={props.usage?.profiles ?? []}>
                  {(p) => (
                    <label class="ro-target-row">
                      <Checkbox
                        label={p.profileName}
                        checked={selectedTargetIds().has(p.profileId)}
                        onChange={() => toggleTarget(p.profileId)}
                      />
                      <Show when={canaryIds().has(p.profileId)}>
                        <Badge tone="info">Canary</Badge>
                      </Show>
                    </label>
                  )}
                </For>
              </div>
              <div class="ro-target-actions">
                <Button variant="ghost" size="sm" onClick={selectAllTargets}>
                  Select all
                </Button>
              </div>
            </div>

            {/* Canary selection */}
            <div class="ro-field-group">
              <span class="ro-field-label">Canaries (optional)</span>
              <p class="ro-desc">
                Select one or more profiles to probe first. If all canaries fail, the full rollout
                is not attempted.
              </p>
              <div class="ro-target-list">
                <For each={props.usage?.profiles ?? []}>
                  {(p) => (
                    <label class="ro-target-row">
                      <Checkbox
                        label={p.profileName}
                        checked={canaryIds().has(p.profileId)}
                        onChange={() => toggleCanary(p.profileId)}
                      />
                    </label>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Optional rollout parameters */}
          <Show when={profileIds().length > 0}>
            <div class="ro-params-row">
              <TextField
                id="ro-batch-size"
                label="Batch size"
                type="number"
                value={batchSize()}
                onInput={setBatchSize}
                min={1}
              />
              <TextField
                id="ro-concurrency"
                label="Global concurrency"
                type="number"
                value={globalConcurrency()}
                onInput={setGlobalConcurrency}
                min={1}
              />
            </div>
          </Show>

          {/* Run rollout button */}
          <div class="ro-action-row">
            <Button
              variant="primary"
              onClick={() => void handleRunRollout()}
              disabled={rolloutRunning() || selectedTargetIds().size === 0}
            >
              {rolloutRunning() ? 'Running...' : 'Run rollout'}
            </Button>
          </div>
        </Section>
      </Show>

      {/* Rollout error */}
      <Show when={rolloutError()}>
        <div class="ro-error" role="alert">
          {rolloutError()}
        </div>
      </Show>

      {/* Rollout results */}
      <Show when={hasRolloutRun() && result()}>
        <Section title="Rollout results">
          <div class="ro-result-summary" role="status">
            Status:{' '}
            <Badge tone={rolloutStatusBadge(result()!.status).tone}>
              {rolloutStatusBadge(result()!.status).label}
            </Badge>
            <span class="ro-timestamp">Started: {createdLabel(result()!.startedAt)}</span>
            <Show when={result()!.completedAt}>
              <span class="ro-timestamp">Completed: {createdLabel(result()!.completedAt)}</span>
            </Show>
          </div>

          <div class="ro-result-counts">
            <span class="ro-count">
              Probed: <strong>{result()!.probed?.length ?? 0}</strong>
            </span>
            <span class="ro-count">
              Excluded: <strong>{result()!.excluded?.length ?? 0}</strong>
            </span>
            <span class="ro-count">
              Not attempted: <strong>{result()!.notAttempted?.length ?? 0}</strong>
            </span>
          </div>

          {/* Probed table */}
          <Show when={(result()!.probed?.length ?? 0) > 0}>
            <table class="ro-table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Endpoint</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                <For each={result()!.probed}>{(ep) => <OutcomeRow result={ep} />}</For>
              </tbody>
            </table>
          </Show>

          {/* Excluded table */}
          <Show when={(result()!.excluded?.length ?? 0) > 0}>
            <Section title="Excluded">
              <p class="ro-desc">
                These targets were excluded from probing. An exclusion is not a probe outcome —
                these profiles were not tested.
              </p>
              <table class="ro-table">
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th>Endpoint</th>
                    <th>Reason</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={result()!.excluded}>{(ex) => <ExclusionRow ex={ex} />}</For>
                </tbody>
              </table>
            </Section>
          </Show>

          {/* Not attempted */}
          <Show when={(result()!.notAttempted?.length ?? 0) > 0}>
            <Section title="Not attempted">
              <p class="ro-desc">
                These targets were not reached during the rollout. A host nobody reached must not
                read as a host that rejected the password.
              </p>
              <table class="ro-table">
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th>Endpoint</th>
                    <th />
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={result()!.notAttempted}>{(na) => <NotAttemptedRow na={na} />}</For>
                </tbody>
              </table>
            </Section>
          </Show>
        </Section>
      </Show>

      {/* Post-rollout actions */}
      <Show when={hasRolloutRun() && can()}>
        <Section title="Actions">
          {/* Promote */}
          <div class="ro-action-card">
            <p class="ro-action-desc">
              Promote the candidate to become the current version. The previous version stays usable
              for profiles explicitly pinned to it. A minimum threshold of accepted probe results is
              required.
            </p>
            <div class="ro-action-controls">
              <TextField
                id="ro-promote-threshold"
                label="Min accepted"
                type="number"
                value={promoteThreshold()}
                onInput={setPromoteThreshold}
                min={1}
              />
              <Button
                variant="primary"
                onClick={() => void handlePromote()}
                disabled={promotingBusy()}
              >
                {promotingBusy() ? 'Promoting...' : 'Promote to current'}
              </Button>
            </div>
            <Show when={promoteEvidenceVal()}>
              {(ev) => (
                <div class="ro-evidence" role="status">
                  Evidence: {ev().accepted} accepted out of {ev().total}
                </div>
              )}
            </Show>
          </div>

          {/* Retire */}
          <div class="ro-action-card">
            <p class="ro-action-desc">
              Retire the current version. It will no longer be selected for new connections.
              Existing sessions may be drained or left running.
            </p>
            <div class="ro-action-controls">
              <Checkbox
                label="Drain existing sessions"
                checked={retireDrain()}
                onChange={setRetireDrain}
              />
              <Button
                variant="default"
                onClick={() => void handleRetire()}
                disabled={retiringBusy() || !cur()}
              >
                {retiringBusy() ? 'Retiring...' : 'Retire current version'}
              </Button>
            </div>
          </div>

          {/* Emergency Revoke */}
          <div class="ro-action-card ro-action-danger">
            <p class="ro-action-desc">
              Immediately revoke the current version. This closes ALL live sessions using this
              version. The version cannot be used for any connection after revocation.
            </p>
            <Show when={!revokeConfirmOpen()}>
              <Button
                variant="danger"
                onClick={() => void handleRevokeImpact()}
                disabled={revokeBusy() || !cur()}
              >
                {revokeBusy() ? 'Loading impact...' : 'Emergency revoke current version'}
              </Button>
            </Show>
            <Show when={revokeConfirmOpen() && revokeImpact()}>
              {(impact) => (
                <div class="ro-revoke-confirm" role="alert">
                  <p>
                    <strong>Revoke version {cur()?.id}?</strong>
                  </p>
                  <p>
                    {impact().liveSessions.length} live session(s) on this version will be closed:
                  </p>
                  <ul>
                    <For each={impact().liveSessions}>
                      {(s) => (
                        <li>
                          {s.profileName} ({s.sessionId})
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={impact().profilesUsing.length > 0}>
                    <p>
                      {impact().profilesUsing.length} profile(s) using this version will stop
                      working:
                    </p>
                    <ul>
                      <For each={impact().profilesUsing}>{(p) => <li>{p.profileName}</li>}</For>
                    </ul>
                  </Show>
                  <div class="ro-revoke-buttons">
                    <Button
                      variant="danger"
                      onClick={() => void confirmRevoke()}
                      disabled={revokeBusy()}
                    >
                      {revokeBusy() ? 'Revoking...' : 'Confirm revoke'}
                    </Button>
                    <Button variant="default" onClick={cancelRevoke} disabled={revokeBusy()}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Section>
      </Show>

      {/* No actions available */}
      <Show when={!can() && !isPasswordAuth()}>
        <p class="ro-desc">
          Rollout is only available for password-based credentials. Stage a candidate version to
          begin.
        </p>
      </Show>
    </div>
  )
}
