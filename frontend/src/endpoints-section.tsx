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
import { Stack } from './ui/stack'
import { TextField } from './ui/text-field'
import { absoluteHttpUrl, combine, createFormValidation, required } from './ui/validation'
import { createSubmitGate } from './ui/submit-gate'
import { showToast } from './ui/toast'
import { log } from './log'
import { EndpointClient, type Endpoint } from './endpoints'

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

  onMount(() => {
    void load()
  })

  // ── Draft editing ────────────────────────────────────────────────────

  function openNew() {
    setEditing(null)
    setDraft(blankDraft())
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
    try {
      if (editingId) {
        await props.client.updateEndpoint(editingId, input)
      } else {
        await props.client.createEndpoint(input)
      }
      closeDialog()
      await load()
      showToast({ level: 'success', message: `Saved "${input.name}"` })
    } catch (err) {
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

  function renderModelRow(row: ModelDraft, index: number) {
    return (
      <div class="ep-model-row">
        <TextField
          id={`endpoint-model-${index}-name`}
          label="Model id"
          required
          value={row.name}
          onInput={(v) => updateModel(index, { name: v })}
          onBlur={() => validation.touch('models')}
          placeholder="gpt-4o"
        />
        <TextField
          id={`endpoint-model-${index}-alias`}
          label="Picker label"
          value={row.alias}
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
