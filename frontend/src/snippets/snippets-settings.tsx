/**
 * The snippets settings page — where a library is authored (design §10.4,
 * bead nocx-gjnr, plan Task 10).
 *
 * Until this page existed the palette could list and fire a library nobody
 * could add to: the store's create/update/delete/reorder had no caller at
 * all, and the only records in the product were the two the service seeds.
 * This is the surface that makes the epic's sentence true.
 *
 * Kit contract (frontend/src/ui/README.md): the same shape Connections and
 * Endpoints have — a CollectionView of RecordRows with a Dialog editor,
 * showConfirm for a delete, EmptyState for every state that has no rows.
 * Nothing here is hand-rolled and nothing repaints a kit component; the
 * surface's own CSS (styles/components/snippets.css) only places wrappers.
 *
 * Two things are this page's own:
 *
 *  - The body is a real CM6 editor (the kit has no multi-line code field),
 *    mounted through the shared host's editable mode — the file viewer's
 *    host, not a second construction of a view (cm-host.ts).
 *  - The preview line under it reports what the parser recognised and what
 *    it did not, which is the one signal that stops a mistyped
 *    `{{ask:port}` from reaching somebody's agent session as literal text.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { Extension } from '@codemirror/state'
import { Button } from '../ui/button'
import { CollectionView } from '../ui/collection-view'
import { RecordRow } from '../ui/record-row'
import { Dialog, showConfirm } from '../ui/dialog'
import { EmptyState } from '../ui/empty-state'
import { Field } from '../ui/field'
import { StatusCard } from '../ui/status-card'
import { IconButton } from '../ui/icon-button'
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, TrashIcon } from '../ui/icons'
import { Stack } from '../ui/stack'
import { TextField } from '../ui/text-field'
import { createFormValidation, required } from '../ui/validation'
import { createSubmitGate } from '../ui/submit-gate'
import { showToast } from '../ui/toast'
import { log } from '../log'
import { EditableHost } from '../cm-host'
import { markdownLanguage, viewerHighlighting } from '../file-viewer/language-registry'
import { describeBody, type PreviewPart } from './preview'
import { ENV_KEYS, type EnvKey } from './resolve'
import type { Snippet, SnippetsState, SnippetsStore } from './snippets-store'

/** The body editor seam. `EditableHost` satisfies it; a test substitutes a
 *  fake because jsdom does not emulate contenteditable input, and the
 *  default path has its own test (the editor mounts and shows the body). */
export interface BodyEditorHost {
  mount(
    parent: HTMLElement,
    signal: AbortSignal,
    extensions?: Extension[],
    onDocChange?: (text: string) => void,
  ): void
  setDoc(text: string): void
  doc(): string
  focus(): void
  dispose(): void
}

export interface SnippetsSectionProps {
  /** The one library every surface reads — the same store the palette
   *  holds, so a save here is visible to the next fire without a
   *  notification on the wire (design §6). */
  store: SnippetsStore
  /** The body editor's construction, injected for the test seam above. */
  createBodyHost?: () => BodyEditorHost
}

/** One sentence per span, for the preview line. The env phrases come from
 *  the resolver's own table, so the preview cannot promise a key the fire
 *  refuses. */
function previewSentence(part: PreviewPart): string {
  switch (part.kind) {
    case 'env':
      return part.known
        ? `${part.text} → ${ENV_KEYS[part.key as EnvKey]}`
        : `${part.text} → not a key nocx can answer; the fire will refuse`
    case 'ask':
      return part.defaultValue === ''
        ? `${part.text} → you will be asked`
        : `${part.text} → you will be asked (default ${part.defaultValue})`
    case 'secret':
      return `${part.text} → the vault secret "${part.name}"`
    case 'unrecognised':
      return `${part.text} → not recognised; it will be sent as it is`
  }
}

const previewRecognised = (part: PreviewPart): boolean =>
  part.kind !== 'unrecognised' && !(part.kind === 'env' && !part.known)

/** The row's one-line description of a body: its first non-empty line,
 *  bounded. A body is multi-line and the row is one line — a raw body would
 *  make every row a different height and say nothing more. */
function bodySummary(body: string): string {
  const line = body.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export function SnippetsSection(props: SnippetsSectionProps) {
  // 'loading' until the subscription answers — which it does synchronously
  // on mount, with whatever the store already holds. Reading the store here
  // would be reading a prop outside a tracked scope.
  const [state, setState] = createSignal<SnippetsState>({ kind: 'loading' })
  const [searchQuery, setSearchQuery] = createSignal('')
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const [editing, setEditing] = createSignal<Snippet | null>(null)
  const [title, setTitle] = createSignal('')
  const [body, setBody] = createSignal('')
  /** The backend's reason for refusing the last save, kept ON the dialog:
   *  a toast over a closed editor would take away both the sentence and the
   *  draft it is about. */
  const [saveError, setSaveError] = createSignal('')

  let bodyHost: BodyEditorHost | null = null
  let bodyAbort: AbortController | null = null

  onMount(() => {
    const unsubscribe = props.store.subscribe(setState)
    onCleanup(unsubscribe)
    void props.store.refresh()
  })
  onCleanup(() => {
    bodyAbort?.abort()
  })

  const snippets = createMemo<readonly Snippet[]>(() => {
    const s = state()
    return s.kind === 'ready' ? s.snippets : []
  })
  const filtering = createMemo(() => searchQuery().trim() !== '')
  const filtered = createMemo(() => {
    const q = searchQuery().trim().toLowerCase()
    if (q === '') return snippets()
    return snippets().filter(
      (s) => s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q),
    )
  })

  const validation = createFormValidation(
    { title: () => required('Title')(title()) },
    { controlId: () => 'snippet-title' },
  )
  const gate = createSubmitGate(validation)

  /** Mount the CM6 editor into the dialog's body slot. Called by the ref,
   *  which fires once per dialog opening — the previous host is disposed
   *  with its own AbortController, the way every host consumer does it. */
  function mountBody(parent: HTMLElement): void {
    bodyAbort?.abort()
    bodyAbort = new AbortController()
    const host = props.createBodyHost ? props.createBodyHost() : new EditableHost()
    bodyHost = host
    // The language and highlighting are the file viewer's registry — one
    // owner of "which CM6 language this text is" (design §10.4: markdown is
    // already in the bundle, and a body is prose with commands in it).
    host.mount(parent, bodyAbort.signal, [markdownLanguage(), viewerHighlighting], (text) =>
      setBody(text),
    )
    host.setDoc(body())
  }

  function openNew(): void {
    setEditing(null)
    setTitle('')
    setBody('')
    setSaveError('')
    validation.reset()
    setDialogOpen(true)
  }

  function openEdit(s: Snippet): void {
    setEditing(s)
    setTitle(s.title)
    setBody(s.body)
    setSaveError('')
    validation.reset()
    setDialogOpen(true)
  }

  function closeDialog(): void {
    setDialogOpen(false)
    bodyAbort?.abort()
    bodyAbort = null
    bodyHost = null
  }

  async function save(): Promise<void> {
    if (!(await gate())) return
    // The host is the authority on what is in the field; the signal follows
    // it through onDocChange, and this read is the one that reaches the
    // wire.
    const text = bodyHost?.doc() ?? body()
    const name = title().trim()
    const target = editing()
    try {
      if (target) {
        await props.store.update(target.id, name, text)
      } else {
        await props.store.create(name, text)
      }
      closeDialog()
      showToast({ level: 'success', message: `Saved "${name}"` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Failed to save snippet', { message })
      // Stays on the dialog, beside the draft that caused it.
      setSaveError(message)
    }
  }

  async function remove(s: Snippet): Promise<void> {
    if (!(await showConfirm(`Delete "${s.title}"?`))) return
    try {
      await props.store.remove(s.id)
      showToast({ level: 'success', message: `Deleted "${s.title}"` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Failed to delete snippet', { message })
      showToast({ level: 'danger', message: `Could not delete "${s.title}": ${message}` })
    }
  }

  /** Move one snippet by one place. The wire takes the WHOLE order (the
   *  service refuses anything that is not a permutation of the library), so
   *  the move is computed over the full list and sent as the full list —
   *  never as the pair that changed. */
  async function move(s: Snippet, by: -1 | 1): Promise<void> {
    const ids = snippets().map((x) => x.id)
    const at = ids.indexOf(s.id)
    const to = at + by
    if (at < 0 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ...ids.splice(at, 1))
    try {
      await props.store.reorder(ids)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Failed to reorder snippets', { message })
      showToast({ level: 'danger', message: `Could not reorder: ${message}` })
    }
  }

  function renderRow(s: Snippet) {
    // Position is derived from the list rather than from a render index: the
    // list is what a move rewrites, and reading it keeps the two arrows
    // correct after a reorder without a second source of "where is this row".
    const first = () => filtered()[0]?.id === s.id
    const last = () => filtered()[filtered().length - 1]?.id === s.id
    return (
      <RecordRow
        title={s.title}
        meta={bodySummary(s.body)}
        onActivate={() => openEdit(s)}
        actions={
          <>
            {/* Reorder is disabled while a filter hides rows: "up" would
                mean a different place in the stored order than the one the
                person can see, and the stored order is what fires. */}
            <IconButton
              ariaLabel={`Move ${s.title} up`}
              disabled={first() || filtering()}
              onClick={() => void move(s, -1)}
            >
              <ArrowUpIcon />
            </IconButton>
            <IconButton
              ariaLabel={`Move ${s.title} down`}
              disabled={last() || filtering()}
              onClick={() => void move(s, 1)}
            >
              <ArrowDownIcon />
            </IconButton>
            <IconButton ariaLabel={`Edit ${s.title}`} onClick={() => openEdit(s)}>
              <PencilIcon />
            </IconButton>
            <IconButton ariaLabel={`Delete ${s.title}`} onClick={() => void remove(s)}>
              <TrashIcon />
            </IconButton>
          </>
        }
      />
    )
  }

  const emptyContent = () => {
    const s = state()
    if (s.kind === 'loading') return <EmptyState title="Loading snippets" />
    if (s.kind === 'unavailable') {
      // The soft degrade, visible in the product and not only in a log
      // (§11.5): the reason, a retry, and NO create — there is nothing that
      // could accept one.
      return (
        <EmptyState
          title="Couldn't load your snippets"
          description={s.message}
          action={
            <Button variant="default" onClick={() => void props.store.refresh()}>
              Retry
            </Button>
          }
        />
      )
    }
    return (
      <EmptyState
        title="No snippets yet"
        description="Save a phrase once and fire it into whatever is taking input."
        action={
          <Button variant="primary" onClick={openNew}>
            + New snippet
          </Button>
        }
      />
    )
  }

  const parts = createMemo(() => describeBody(body()))

  return (
    <div class="sn-root">
      <CollectionView
        searchValue={searchQuery()}
        onSearch={setSearchQuery}
        searchPlaceholder="Filter snippets"
        searchLabel="Filter snippets"
        actions={
          <Show when={state().kind === 'ready'}>
            <Button variant="primary" onClick={openNew}>
              + New snippet
            </Button>
          </Show>
        }
        hasItems={snippets().length > 0}
        empty={emptyContent()}
      >
        <div role="list" aria-label="Snippet list">
          <For each={filtered()}>{(s) => renderRow(s)}</For>
        </div>
        <Show when={filtering() && filtered().length === 0}>
          <EmptyState
            title="Nothing matches this filter"
            description={`No snippet's title or body contains "${searchQuery().trim()}".`}
          />
        </Show>
      </CollectionView>

      <Dialog
        open={dialogOpen()}
        onClose={closeDialog}
        onSubmit={() => void save()}
        title={editing() ? `Edit snippet: ${editing()!.title}` : 'New snippet'}
        size="lg"
        footer={
          <>
            <Button variant="default" onClick={closeDialog}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              {editing() ? 'Save snippet' : 'Create snippet'}
            </Button>
          </>
        }
      >
        <Stack>
          <TextField
            id="snippet-title"
            label="Title"
            required
            value={title()}
            onInput={setTitle}
            onBlur={() => validation.touch('title')}
            error={validation.error('title')}
            placeholder="Deploy the staging service"
          />
          {/* The editor is mounted per OPENING, not per page: the Dialog
              keeps its children in the DOM while it is closed, so a ref that
              fired once at page construction would have mounted a host
              before there was a draft to put in it — and every later edit
              would have opened on the first snippet's body. */}
          <Show when={dialogOpen()}>
            <Field for="snippet-body" label="Body">
              <div
                class="sn-body-editor"
                id="snippet-body"
                ref={(el: HTMLDivElement) => mountBody(el)}
              />
            </Field>
          </Show>
          <div class="sn-preview" role="status" aria-label="What the snippet parser recognised">
            <Show
              when={parts().length > 0}
              fallback={
                <span class="sn-preview__none">
                  Nothing to fill in — the body is sent as it is.
                </span>
              }
            >
              <For each={parts()}>
                {(part) => (
                  <span class="sn-preview__part" data-recognised={String(previewRecognised(part))}>
                    {previewSentence(part)}
                  </span>
                )}
              </For>
            </Show>
          </div>
          {/* The refusal stays ON the editor, beside the draft it is about:
              a toast would close over a dialog the person still has to fix,
              taking both the sentence and the typing with it. */}
          <Show when={saveError() !== ''}>
            <StatusCard
              tone="danger"
              title="Could not save this snippet"
              description={saveError()}
            />
          </Show>
        </Stack>
      </Dialog>
    </div>
  )
}
