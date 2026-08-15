/**
 * AI Endpoints surface — the Settings page listing configured AI endpoints
 * (bead nocx-kn9q, design §4.5, ADR-0030).
 *
 * Follows the connections manager shape: a full-width CollectionView list
 * with dialog-based add/edit. The four endpoints.* methods are the whole
 * wire; the key is an input that never crosses back (ADR-0030 §3).
 *
 * Kit contract (frontend/src/ui/README.md): the schema is a field on the
 * record and there is NO select while one implementation exists; the Test
 * button and the address restriction belong to nocx-edio. Validation goes
 * through the kit's createFormValidation + createSubmitGate.
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { CollectionRow, CollectionView } from './ui/collection-view'
import { Dialog, showConfirm } from './ui/dialog'
import { EditableRowList } from './ui/row-list'
import { EmptyState } from './ui/empty-state'
import { IconButton } from './ui/icon-button'
import { PencilIcon, TrashIcon } from './ui/icons'
import { Spinner } from './ui/spinner'
import { Stack } from './ui/stack'
import { SuggestionField } from './ui/suggestion-field'
import { TextField } from './ui/text-field'
import { absoluteHttpUrl, combine, createFormValidation, required } from './ui/validation'
import { createSubmitGate } from './ui/submit-gate'
import { showToast } from './ui/toast'
import { log } from './log'
import type { AgentClient } from './agent'
// The probe result shape is declared once in endpoints.probe.schema.json and
// INLINED by agent.status.schema.json's cross-file ref, so the generated
// agent.status.ts exports both AgentStatusResult and its own copy of
// EndpointsProbeResult. This module consumes the latter (the type is
// structurally identical) so the dead-export ratchet sees every generated
// export used — the same union trick endpoints.ts documents.
import type { EndpointsProbeResult } from './generated/agent.status'
import { EndpointClient, type Endpoint } from './endpoints'
import { VaultOperationCancelledError, type VaultController } from './vault'

/** The schema's one value today (design §4.5, decision 2). Display label
 *  only; the select appears when the second implementation does. */
const SCHEMA_LABEL: Record<Endpoint['schema'], string> = {
  'openai-compatible': 'OpenAI-compatible',
}

/** One model row in the editor draft. Alias is '' while typing and becomes
 *  null on the wire when blank. */
interface ModelDraft {
  name: string
  alias: string
}

/** The dialog draft: the key is an input ('' = none / keep), never a value
 *  read back from the record. */
interface EndpointDraft {
  name: string
  baseUrl: string
  key: string
  models: ModelDraft[]
}

const blankDraft = (): EndpointDraft => ({ name: '', baseUrl: '', key: '', models: [] })
type LoadState = 'loading' | 'ready' | 'failed'
export interface EndpointsSectionProps {
  client: EndpointClient
  /** The assistant's control-plane client (nocx-edio). Kept because the
   *  editor's Test button probes through the same wire the ask uses; the
   *  page itself shows no assistant status — readiness belongs on the ask
   *  chip, where a person is actually asking, not as a badge floating above
   *  this page's frame. */
  agentClient?: AgentClient
  /** The vault layer's controller. A save that carries a key is minted into
   *  the vault (design §4.5.3), so it routes through the vault's own
   *  operation-first seam (saveSecretWithVault) — the same owner the
   *  connections path uses at the moment a secret is created (nocx-v64o).
   *  Absent in the dev-web harness and bare embeds. */
  vaultController?: VaultController
}

export function EndpointsSection(props: EndpointsSectionProps) {
  const [endpoints, setEndpoints] = createSignal<Endpoint[]>([])
  const [loadState, setLoadState] = createSignal<LoadState>('loading')
  const [loadError, setLoadError] = createSignal('')
  const [searchQuery, setSearchQuery] = createSignal('')
  const [dialogOpen, setDialogOpen] = createSignal(false)
  /** The endpoint being edited, or null for a new one. */
  const [editing, setEditing] = createSignal<Endpoint | null>(null)
  const [draft, setDraft] = createSignal<EndpointDraft>(blankDraft())
  /** The Test button's state: idle, running, or the probe result. */
  const [probeResult, setProbeResult] = createSignal<EndpointsProbeResult | null>(null)
  const [probing, setProbing] = createSignal(false)
  /** Models the endpoint says it offers — filled by an explicit connection
   *  test OR by the silent discovery on focus. One owner, so the two paths
   *  cannot disagree about what an endpoint offers. */
  const [discovered, setDiscovered] = createSignal<string[]>([])
  /** The (base URL, key, endpoint) the discovered list belongs to, so
   *  re-focusing does not re-dial and changing the URL does. */
  const [discoveryKey, setDiscoveryKey] = createSignal('')

  // ── Data loading ─────────────────────────────────────────────────────

  async function load() {
    try {
      const eps = await props.client.listEndpoints()
      setEndpoints(eps ?? [])
      setLoadState('ready')
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to load endpoints', { message })
      setEndpoints([])
      setLoadError(message)
      setLoadState('failed')
    }
  }

  /** The Test button: probe the form's DRAFT values with a real streaming
   *  completion — what will actually be used, not one cheap completion
   *  (design §4.5). The first model is the one the picker would use.
   *
   *  When editing a SAVED endpoint the probe NAMES the record (endpointId)
   *  and the backend resolves the credential it owns — exactly how
   *  connections.test names a profile. A key typed into the form is sent
   *  too and WINS on the backend: testing a new key before saving it is
   *  the other half of what this button is for. The renderer never reads a
   *  key back (ADR-0030 §3), so it cannot send a stored one. */
  async function runProbe() {
    const d = draft()
    // An empty model is not a reason to do nothing — it is the connection
    // check. There used to be an early return here, left behind when the
    // button stopped requiring a model, which made an enabled button do
    // nothing at all: the same defect one layer down.
    const model = d.models[0]?.name.trim() ?? ''
    setProbing(true)
    setProbeResult(null)
    try {
      const res = await props.client.probeEndpoint({
        name: d.name.trim(),
        baseUrl: d.baseUrl.trim(),
        key: d.key,
        model,
        ...(editing() ? { endpointId: editing()!.id } : {}),
      })
      setProbeResult(res)
      if (res.ok && res.kind === 'connection') setDiscovered(res.models ?? [])
    } catch (err) {
      const message = (err as Error).message
      log.error('Endpoint test failed', { message })
      setProbeResult({
        name: d.name.trim(),
        model,
        // The check the call WOULD have been: a refusal must not be
        // reported as a model answer when no model was named.
        kind: model === '' ? 'connection' : 'model',
        ok: false,
        error: message,
        elapsedMs: 0,
        at: new Date().toISOString(),
      })
    } finally {
      setProbing(false)
    }
  }

  onMount(() => {
    void load()
  })

  // ── Draft editing ────────────────────────────────────────────────────
  function openNew() {
    setEditing(null)
    setDraft(blankDraft())
    setProbeResult(null)
    setDiscovered([])
    setDiscoveryKey('')
    validation.reset()
    setDialogOpen(true)
  }

  function openEdit(ep: Endpoint) {
    setEditing(ep)
    // The key is never pre-filled: it is an input, and the record cannot
    // be read back (ADR-0030 §3) — an empty key means "keep the existing
    // material" on update.
    setDraft({
      name: ep.name,
      baseUrl: ep.baseUrl,
      key: '',
      models: ep.models.map((m) => ({ name: m.name, alias: m.alias ?? '' })),
    })
    validation.reset()
    setProbeResult(null)
    setDiscovered([])
    setDiscoveryKey('')
    setDialogOpen(true)
  }

  function closeDialog() {
    setDialogOpen(false)
    setEditing(null)
  }

  function setDraftField(field: 'name' | 'baseUrl' | 'key', value: string) {
    setDraft((d) => ({ ...d, [field]: value }))
  }

  function updateModel(index: number, patch: Partial<ModelDraft>) {
    setDraft((d) => ({
      ...d,
      models: d.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }))
  }

  function addModel() {
    setDraft((d) => ({ ...d, models: [...d.models, { name: '', alias: '' }] }))
  }

  function removeModel(index: number) {
    setDraft((d) => ({ ...d, models: d.models.filter((_, i) => i !== index) }))
  }

  // ── Validation (the kit's one answer to "how a form refuses") ─────────

  const validation = createFormValidation(
    {
      name: () => required('Name')(draft().name),
      baseUrl: () => combine(required('Base URL'), absoluteHttpUrl())(draft().baseUrl),
      models: () => {
        const rows = draft().models
        if (rows.length === 0) return 'Add at least one model'
        return rows.some((m) => m.name.trim() === '') ? 'Model name is required' : undefined
      },
    },
    {
      controlId: (field) => {
        if (field === 'name') return 'endpoint-name'
        if (field === 'baseUrl') return 'endpoint-base-url'
        if (field === 'models') {
          const first = draft().models.findIndex((m) => m.name.trim() === '')
          return first >= 0 ? `endpoint-model-${first}-name` : undefined
        }
        return field
      },
    },
  )
  const gate = createSubmitGate(validation)

  // ── Save / delete ────────────────────────────────────────────────────

  async function save() {
    if (!(await gate())) return
    const d = draft()
    const input = {
      name: d.name.trim(),
      baseUrl: d.baseUrl.trim(),
      key: d.key,
      models: d.models.map((m) => ({
        name: m.name.trim(),
        alias: m.alias.trim() === '' ? null : m.alias.trim(),
      })),
    }
    const editingId = editing()?.id
    const persist = async (): Promise<void> => {
      if (editingId) {
        await props.client.updateEndpoint(editingId, input)
      } else {
        await props.client.createEndpoint(input)
      }
    }
    try {
      if (props.vaultController && d.key !== '') {
        // The key is about to be minted into the vault (design §4.5.3), so
        // the save goes through the vault layer's own operation-first seam —
        // the same owner the connections path uses at the moment a secret is
        // created ("save this key", nocx-v64o). A missing or sealed vault
        // raises the vault's setup/unlock sheet and retries THIS save when
        // it completes; cancelling rejects with VaultOperationCancelledError,
        // nothing ran, and the editor stays open with the draft intact so
        // the person does not retype it.
        await props.vaultController.saveSecretWithVault(persist, 'save this endpoint key')
      } else {
        await persist()
      }
      closeDialog()
      await load()
      showToast({ level: 'success', message: `Saved "${input.name}"` })
    } catch (err) {
      // A cancelled setup/unlock is not an error: the sheet is the surface
      // while it is up, and the editor behind it still holds the draft.
      if (err instanceof VaultOperationCancelledError) return
      const message = (err as Error).message
      log.error('Failed to save endpoint', { message })
      showToast({ level: 'danger', message: `Could not save the endpoint: ${message}` })
    }
  }

  async function remove(ep: Endpoint) {
    if (!(await showConfirm(`Delete "${ep.name}"?`))) return
    try {
      await props.client.deleteEndpoint(ep.id)
      await load()
      showToast({ level: 'success', message: `Deleted "${ep.name}"` })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to delete endpoint', { message })
      showToast({ level: 'danger', message: `Could not delete "${ep.name}": ${message}` })
    }
  }

  // ── Derived ──────────────────────────────────────────────────────────

  const filteredEndpoints = createMemo(() => {
    const q = searchQuery().trim().toLowerCase()
    if (q === '') return endpoints()
    return endpoints().filter(
      (ep) => ep.name.toLowerCase().includes(q) || ep.baseUrl.toLowerCase().includes(q),
    )
  })

  const keyHint = () => {
    const ep = editing()
    return ep !== null && ep.credential !== null
      ? 'Leave blank to keep the saved key. A new key replaces it.'
      : 'Optional — the key is stored in your vault, never in the record.'
  }

  function modelSummary(models: Endpoint['models']): string {
    const n = models.length
    return `${n} model${n === 1 ? '' : 's'}`
  }

  // ── Rows ─────────────────────────────────────────────────────────────

  // ── Assistant status + probe display ───────────────────────────────

  /** The Test button's result, from endpoints.probe. The sentence names
   *  WHICH check ran: "the endpoint is reachable" and "the model answered"
   *  are different facts and a person acts on them differently. */
  const probeLine = () => {
    const p = probeResult()
    if (!p) return null
    if (!p.ok) return { tone: 'danger' as const, text: `Test failed: ${p.error}` }
    if (p.kind === 'model') {
      return {
        tone: 'success' as const,
        text: `${p.model} answered in ${Math.max(p.elapsedMs, 1)} ms`,
      }
    }
    const found = p.models?.length ?? 0
    return {
      tone: 'success' as const,
      // An endpoint that lists nothing is reachable and usable — GET /models
      // is not universally implemented — so the sentence says what happened
      // rather than implying something is missing.
      text: found > 0 ? `Connected — ${found} models offered` : 'Connected — it lists no models',
    }
  }

  /** The models a connection check found, for the picker below. Additive:
   *  an endpoint that lists none is configured by hand exactly as before. */
  const discoveredModels = () => discovered()

  /**
   * Ask the endpoint what models it offers, WITHOUT being asked to test.
   *
   * A person opening the model field is about to need this list, and making
   * them press Test first is making them do the lookup by hand. So focus
   * triggers it — but silently, and that silence is the whole design:
   *
   *  - it never writes probeResult, so a background attempt cannot paint a
   *    red verdict nobody asked for. A failure leaves the suggestions empty
   *    and the field exactly as usable as it was;
   *  - it runs once per (base URL, key, endpoint) triple, so re-focusing the
   *    field does not re-dial, and changing the URL does;
   *  - it never runs while an explicit test is in flight.
   *
   * An explicit connection test fills the same list, so there is one owner of
   * "what models does this endpoint offer" and the two cannot disagree.
   */
  async function discoverModels() {
    const d = draft()
    const baseUrl = d.baseUrl.trim()
    if (baseUrl === '' || probing()) return
    const ep = editing()
    const key = `${baseUrl} ${d.key} ${ep?.id ?? ''}`
    if (discoveryKey() === key) return
    setDiscoveryKey(key)
    try {
      const res = await props.client.probeEndpoint({
        name: d.name.trim(),
        baseUrl,
        key: d.key,
        model: '',
        ...(ep ? { endpointId: ep.id } : {}),
      })
      if (res.ok && res.kind === 'connection') setDiscovered(res.models ?? [])
    } catch {
      // Silent by design: nobody asked for a verdict. The field stays free
      // text, which is what it would have been anyway.
    }
  }

  /** The Test button needs a base URL and NOTHING else. It used to require a
   *  first model, which made it dead in the one state where a person most
   *  wants it — a new endpoint whose URL and key are typed and whose models
   *  are not, because the models are what the test is about to find
   *  (nocx-q27y). With no model it checks the connection; with one it asks
   *  that model to answer. */
  const testDisabled = () => probing() || draft().baseUrl.trim() === ''

  /** Why the Test button is unavailable, rendered beside it. A disabled
   *  control that does not say why is the half of this defect the owner
   *  actually hit: a grey button and silence. */
  const testDisabledReason = () => {
    if (probing()) return undefined
    if (draft().baseUrl.trim() === '') return 'Add a base URL to test the connection'
    return undefined
  }

  /** What pressing Test will do right now, so the label never promises the
   *  check it is not about to run. */
  const testLabel = () => {
    if (probing()) return 'Testing…'
    return (draft().models[0]?.name.trim() ?? '') === '' ? 'Test connection' : 'Test endpoint'
  }

  function renderRow(ep: Endpoint) {
    return (
      <CollectionRow
        onActivate={() => openEdit(ep)}
        info={
          <>
            <div class="ep-item-name">{ep.name}</div>
            <div class="ep-item-meta">
              <Badge tone="neutral">{SCHEMA_LABEL[ep.schema]}</Badge>
              <span class="ep-item-models">{modelSummary(ep.models)}</span>
              <Show when={ep.credential !== null} fallback={<Badge tone="neutral">No key</Badge>}>
                <Badge tone="info">Key saved</Badge>
              </Show>
            </div>
          </>
        }
        actions={
          <>
            <IconButton
              size="sm"
              title="Edit"
              ariaLabel={`Edit ${ep.name}`}
              onClick={() => openEdit(ep)}
            >
              <PencilIcon />
            </IconButton>
            <IconButton
              size="sm"
              title="Delete"
              ariaLabel={`Delete ${ep.name}`}
              onClick={() => void remove(ep)}
            >
              <TrashIcon />
            </IconButton>
          </>
        }
      />
    )
  }

  function renderModelRow(row: () => ModelDraft, index: number) {
    return (
      <div class="ep-model-row">
        <SuggestionField
          id={`endpoint-model-${index}-name`}
          label="Model id"
          required
          value={row().name}
          onInput={(v) => updateModel(index, { name: v })}
          onBlur={() => validation.touch('models')}
          onFocus={() => void discoverModels()}
          placeholder="gpt-4o"
          // What a successful connection test found the endpoint offering.
          // Free text still: an endpoint that lists nothing — GET /models is
          // not universally implemented — is configured by hand exactly as
          // before, and a model the list omits is still typeable.
          suggestions={discoveredModels()}
        />
        <TextField
          id={`endpoint-model-${index}-alias`}
          label="Picker label"
          value={row().alias}
          onInput={(v) => updateModel(index, { alias: v })}
          placeholder="Optional"
        />
      </div>
    )
  }

  // ── Empty / failure states ───────────────────────────────────────────

  const emptyContent = () => {
    if (loadState() === 'loading') {
      return <EmptyState title="Loading endpoints" />
    }
    if (loadState() === 'failed') {
      return (
        <EmptyState
          title="Couldn't load endpoints"
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
      <EmptyState
        title="No endpoints yet"
        description="Add an AI endpoint to configure the assistant's model provider."
        action={
          <Button variant="primary" onClick={openNew}>
            + New endpoint
          </Button>
        }
      />
    )
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div class="ep-root">
      <CollectionView
        searchValue={searchQuery()}
        onSearch={setSearchQuery}
        searchPlaceholder="Filter endpoints"
        searchLabel="Filter endpoints"
        actions={
          <Button variant="primary" onClick={openNew}>
            + New endpoint
          </Button>
        }
        hasItems={endpoints().length > 0}
        empty={emptyContent()}
      >
        <div role="list" aria-label="Endpoint list">
          <For each={filteredEndpoints()}>{(ep) => renderRow(ep)}</For>
        </div>
        {/* A filter that matches nothing hid every row and said nothing,
            which is indistinguishable from the list failing to load. */}
        <Show when={searchQuery().trim() !== '' && filteredEndpoints().length === 0}>
          <EmptyState
            title="Nothing matches this filter"
            description={`No endpoint's name or base URL contains "${searchQuery().trim()}".`}
          />
        </Show>
      </CollectionView>

      <Dialog
        open={dialogOpen()}
        onClose={closeDialog}
        onSubmit={() => void save()}
        title={editing() ? `Edit Endpoint: ${editing()!.name}` : 'New Endpoint'}
        size="lg"
        footer={
          <>
            <Button variant="default" onClick={closeDialog}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              {editing() ? 'Save Endpoint' : 'Create Endpoint'}
            </Button>
          </>
        }
      >
        <Stack>
          <TextField
            id="endpoint-name"
            label="Name"
            required
            value={draft().name}
            onInput={(v) => setDraftField('name', v)}
            onBlur={() => validation.touch('name')}
            error={validation.error('name')}
            placeholder="My provider"
          />
          <TextField
            id="endpoint-base-url"
            label="Base URL"
            required
            value={draft().baseUrl}
            onInput={(v) => setDraftField('baseUrl', v)}
            onBlur={() => validation.touch('baseUrl')}
            error={validation.error('baseUrl')}
            placeholder="https://api.example.com/v1"
          />
          <TextField
            id="endpoint-key"
            label="API key"
            type="password"
            value={draft().key}
            onInput={(v) => setDraftField('key', v)}
            description={keyHint()}
          />
          <div class="ep-test-row">
            <Button
              variant="default"
              size="sm"
              disabled={testDisabled()}
              onClick={() => void runProbe()}
            >
              {testLabel()}
            </Button>
            <Show when={probing()}>
              <Spinner size="sm" label="Testing endpoint" />
            </Show>
            <Show when={testDisabledReason()}>
              <span class="ep-test-reason">{testDisabledReason()}</span>
            </Show>
            <Show when={probeLine()}>
              <Badge tone={probeLine()!.tone}>{probeLine()!.text}</Badge>
            </Show>
          </div>
          <EditableRowList
            rows={draft().models}
            ariaLabel="Endpoint models"
            addLabel="Add model"
            emptyLabel="No models — add the model id the API understands."
            removeLabel={(i) => `Remove model ${i + 1}`}
            onRemove={removeModel}
            onAdd={addModel}
            error={validation.error('models')}
            renderRow={renderModelRow}
          />
        </Stack>
      </Dialog>
    </div>
  )
}
