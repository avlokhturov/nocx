/**
 * Model Roles surface — the Settings page where a person assigns one
 * (endpoint, model) pair to each model role (bead nocx-e6kn2). A feature
 * asks for a role — the assistant asks for `answering`, the classifier bead
 * will ask for `classifier` — and NEVER names a model id; the pair is
 * written HERE and every feature picks it up at its next call, resolved in
 * exactly one place on the backend.
 *
 * The role set is CLOSED and defined by the product. The wire's roles.list
 * sends every role (an unassigned role is a row with nulls, never an absent
 * row), so an unassigned role — and a role whose assigned endpoint or model
 * no longer exists — is a first-class VISIBLE state on this page, the same
 * failure the ask transaction refuses on: a role is never silently
 * re-pointed at another model, because then nobody could tell which model
 * answered.
 *
 * Kit contract: every control is the kit's native `Select`; the state
 * sentence is the kit's StatusDot + text vocabulary (the tones the endpoint
 * rows already use); rows are spaced by `Stack` (surface-spacing-kit).
 * Nothing here is a hand-rolled control or a repainted kit component.
 */
import { For, Show, createSignal, onMount } from 'solid-js'
import { Select } from './ui/select'
import { Stack } from './ui/stack'
import { StatusDot, type StatusDotTone } from './ui/status-dot'
import { EmptyState } from './ui/empty-state'
import { Spinner } from './ui/spinner'
import { Button } from './ui/button'
import { showToast } from './ui/toast'
import { log } from './log'
import { EndpointClient, type Endpoint, type WireRole } from './endpoints'

export interface RolesSectionProps {
  /** The endpoint client, which is also the roles client (one backend
   *  domain). Absent in the dev-web harness; the section then renders
   *  nothing rather than offering controls that cannot run. */
  client?: EndpointClient
}

/** What each role is FOR, rendered under its name. The set is closed: every
 *  role the wire sends must be describable here, and an unknown role from a
 *  newer backend renders its value with no description rather than crash. */
const ROLE_NAME: Record<string, string> = {
  answering: 'Answering',
  classifier: 'Classifier',
}

const ROLE_DESCRIPTION: Record<string, string> = {
  answering: 'The model the assistant speaks with — the one that answers your questions.',
  classifier:
    'The second model that will judge proposed tool calls. No feature uses it yet; it is assignable so the classifier task (its own bead) has a role to ask for.',
}

/** The tone + sentence of one role's assignment (the wire row + the
 *  endpoint list this page already holds). The sentence NAMES the assigned
 *  endpoint and model, and names what is missing when resolution would
 *  refuse — the same three refusals profile.ResolveRole raises, so the page
 *  and the ask can never disagree about what a role means.
 *  Pure: unit-tested, no component state. */
export function roleStateLine(
  row: WireRole,
  endpoints: Endpoint[],
): { tone: StatusDotTone; text: string } {
  if (row.endpointId === null || row.model === null) {
    return { tone: 'warning', text: 'No model assigned — the role cannot be used until it is' }
  }
  const ep = endpoints.find((e) => e.id === row.endpointId)
  if (!ep) {
    return { tone: 'error', text: 'The assigned endpoint no longer exists — reassign this role' }
  }
  const model = ep.models.find((m) => m.name === row.model)
  if (!model) {
    return {
      tone: 'error',
      text: `The assigned model "${row.model}" is no longer offered by ${ep.name} — reassign this role`,
    }
  }
  return { tone: 'ok', text: `Answers with ${ep.name} · ${model.alias ?? model.name}` }
}

interface RoleDraft {
  endpointId: string
  modelId: string
}

function blankDraft(): RoleDraft {
  return { endpointId: '', modelId: '' }
}

/** Re-derive the per-role drafts from the wire table — the one source of
 *  truth after every load and every write. */
function draftFromWire(roles: WireRole[]): Record<string, RoleDraft> {
  const d: Record<string, RoleDraft> = {}
  for (const r of roles) {
    d[r.role] = { endpointId: r.endpointId ?? '', modelId: r.model ?? '' }
  }
  return d
}

export function RolesSection(props: RolesSectionProps) {
  const [roles, setRoles] = createSignal<WireRole[]>([])
  const [endpoints, setEndpoints] = createSignal<Endpoint[]>([])
  const [loadState, setLoadState] = createSignal<'loading' | 'ready' | 'failed'>('loading')
  const [loadError, setLoadError] = createSignal('')
  /** Per-role draft: what the selects show while a change is mid-gesture
   *  (an endpoint without a model yet — half a pair is never written). The
   *  state line renders the WIRE: a draft never claims to be assigned. */
  const [drafts, setDrafts] = createSignal<Record<string, RoleDraft>>({})
  const [busyRole, setBusyRole] = createSignal<string | null>(null)

  async function load() {
    if (!props.client) return
    try {
      const [rs, eps] = await Promise.all([props.client.listRoles(), props.client.listEndpoints()])
      setRoles(rs ?? [])
      setEndpoints(eps ?? [])
      setDrafts(draftFromWire(rs ?? []))
      setLoadState('ready')
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to load model roles', { message })
      setLoadError(message)
      setLoadState('failed')
    }
  }

  onMount(() => {
    void load()
  })

  function setDraft(role: string, patch: Partial<RoleDraft>) {
    setDrafts((d) => ({ ...d, [role]: { ...blankDraft(), ...d[role], ...patch } }))
  }

  /** Writes the role's pair (or clears it) and adopts the returned table —
   *  the single shape the wire declares, so this page cannot disagree with
   *  itself about what is assigned. */
  async function commit(role: string, endpointId: string | null, modelId: string | null) {
    if (!props.client) return
    setBusyRole(role)
    try {
      const table = await props.client.assignRole({ role, endpointId, model: modelId })
      setRoles(table)
      setDrafts(draftFromWire(table))
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to assign a model role', { role, message })
      showToast({ level: 'danger', message: `Could not assign the role: ${message}` })
      // The wire may have changed under us; re-read rather than trust the
      // draft to still mean anything.
      void load()
    } finally {
      setBusyRole(null)
    }
  }

  /** Endpoint select change: a real endpoint starts a new draft (no write
   *  yet — an (endpoint, model) pair needs both halves); "— None —" is the
   *  CLEAR write that returns the role to its visible unassigned state. */
  function onEndpointChange(row: WireRole, value: string) {
    if (value === '') {
      setDraft(row.role, { endpointId: '', modelId: '' })
      void commit(row.role, null, null)
      return
    }
    setDraft(row.role, { endpointId: value, modelId: '' })
  }

  /** Model select: completes the pair and writes it. */
  function onModelChange(row: WireRole, value: string) {
    if (value === '') return // the placeholder is a no-op, never a half-pair
    const epId = draftEndpoint(drafts(), row.role)
    if (epId === '') return
    setDraft(row.role, { modelId: value })
    void commit(row.role, epId, value)
  }

  function renderRow(row: WireRole) {
    const draft = () => drafts()[row.role] ?? blankDraft()
    const line = () => roleStateLine(row, endpoints())
    const busy = () => busyRole() === row.role
    const modelOptions = () => {
      const ep = endpoints().find((e) => e.id === draft().endpointId)
      return (ep?.models ?? []).map((m) => ({ value: m.name, label: m.alias ?? m.name }))
    }
    const endpointOptions = () => endpoints().map((e) => ({ value: e.id, label: e.name }))

    return (
      <div class="roles-role">
        <Stack>
          <div>
            <div class="roles-role__title">{ROLE_NAME[row.role] ?? row.role}</div>
            <div class="roles-role__description">{ROLE_DESCRIPTION[row.role] ?? ''}</div>
          </div>
          <div class="roles-role__controls">
            <label class="roles-role__field">
              <span class="roles-role__label">Endpoint</span>
              <Select
                value={draft().endpointId}
                disabled={busy()}
                placeholder="— None —"
                options={endpointOptions()}
                onChange={(v) => onEndpointChange(row, v)}
              />
            </label>
            <label class="roles-role__field">
              <span class="roles-role__label">Model</span>
              <Select
                value={draft().modelId}
                disabled={busy() || draft().endpointId === ''}
                placeholder="— pick a model —"
                options={modelOptions()}
                onChange={(v) => onModelChange(row, v)}
              />
            </label>
          </div>
          <div class="roles-role__state" data-tone={line().tone}>
            <StatusDot tone={line().tone} accessibleName="Role state">
              {line().text}
            </StatusDot>
          </div>
        </Stack>
      </div>
    )
  }

  const content = () => {
    if (loadState() === 'loading') {
      return <Spinner size="sm" label="Loading model roles" />
    }
    if (loadState() === 'failed') {
      return (
        <EmptyState
          title="Couldn't load model roles"
          description={loadError()}
          action={
            <Button variant="default" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      )
    }
    return (
      <Stack divided>
        <Show when={endpoints().length === 0}>
          <EmptyState
            title="No endpoints yet"
            description="Add an AI endpoint on the Endpoints page first — a role assigns an endpoint's model."
          />
        </Show>
        <For each={roles()}>{(row) => renderRow(row)}</For>
      </Stack>
    )
  }

  return (
    <Show when={props.client}>
      <Stack>{content()}</Stack>
    </Show>
  )
}

/** The draft endpoint id for a role ('' when none). One owner of the
 *  lookup so the model select and the write share the same draft. */
function draftEndpoint(drafts: Record<string, RoleDraft>, role: string): string {
  return drafts[role]?.endpointId ?? ''
}
