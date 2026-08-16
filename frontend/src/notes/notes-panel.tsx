/**
 * The notes panel in the activity bar (design §6.1) — where a note is
 * FOUND. It deliberately does not edit one: the panel is 240px wide by
 * default, which is a good width for finding and a bad one for writing, and
 * a surface that is bad at its own job is worse than an absent one.
 *
 * Search runs on the backend (the FTS index is there), so what this panel
 * does with the query is hand it over and render rows — it never filters a
 * list it loaded, because that would mean loading every note to look inside
 * it.
 */
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { Button } from '../ui/button'
import { RecordRow } from '../ui/record-row'
import { SearchField } from '../ui/search-field'
import { EmptyState } from '../ui/empty-state'
import { IconButton } from '../ui/icon-button'
import { TrashIcon } from '../ui/icons'
import { showConfirm } from '../ui/dialog'
import { showToast } from '../ui/toast'
import { log } from '../log'
import type { NoteRow, NotesState, NotesStore } from './notes-store'

export interface NotesPanelProps {
  store: NotesStore
  /** Open this note's tab — the panel finds, the tab writes. */
  onOpen: (id: string) => void
  /** Make one and open it: the panel's own "+", and the same path the
   *  chord takes. */
  onCreate: () => void
  /** The activity bar tells a panel when it is on screen; a panel that is
   *  not visible has no business re-reading. */
  visible: boolean
}

/** A row's date, in the person's locale — the one piece of naming that
 *  needs one, which is why it is here and not in the store. */
function when(ms: number): string {
  return new Date(ms).toLocaleDateString()
}

/** A note with nothing in it yet has no derived title (the backend returns
 *  an empty one); the surface names it by when it was made. */
function nameOf(row: NoteRow): string {
  return row.title !== '' ? row.title : `Note — ${when(row.updatedAt)}`
}

export function NotesPanel(props: NotesPanelProps) {
  const [state, setState] = createSignal<NotesState>({ kind: 'loading' })
  const [query, setQuery] = createSignal('')

  onMount(() => {
    const unsubscribe = props.store.subscribe(setState)
    onCleanup(unsubscribe)
    void props.store.refresh()
  })

  const rows = (): readonly NoteRow[] => {
    const s = state()
    return s.kind === 'ready' ? s.rows : []
  }

  const onSearch = (value: string): void => {
    setQuery(value)
    // Every keystroke asks; the store's generation guard is what keeps a
    // slow answer from overwriting a newer one.
    void props.store.search(value)
  }

  const remove = async (row: NoteRow): Promise<void> => {
    if (!(await showConfirm(`Delete "${nameOf(row)}"?`))) return
    try {
      await props.store.remove(row.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('Failed to delete note', { message: msg })
      showToast({ level: 'danger', message: `Could not delete the note: ${msg}` })
    }
  }

  return (
    <div class="notes-panel">
      <div class="notes-panel__search">
        <SearchField
          value={query()}
          onInput={onSearch}
          placeholder="Search notes…"
          ariaLabel="Search notes"
        />
        {/* The create affordance is absent while the store is unavailable:
            an offer that cannot be honoured is a lie (design §8). */}
        <Show when={state().kind !== 'unavailable'}>
          <Button variant="primary" onClick={() => props.onCreate()}>
            + New note
          </Button>
        </Show>
      </div>

      <Show
        when={rows().length > 0}
        fallback={
          <Show
            when={state().kind === 'unavailable'}
            fallback={
              <Show
                when={query().trim() !== ''}
                fallback={
                  <EmptyState
                    title="No notes yet"
                    description="Write something down without leaving the terminal — ⌥⌘N."
                    action={
                      <Button variant="primary" onClick={() => props.onCreate()}>
                        + New note
                      </Button>
                    }
                  />
                }
              >
                <EmptyState
                  title="Nothing matches"
                  description={`No note contains "${query().trim()}".`}
                />
              </Show>
            }
          >
            <EmptyState
              title="Couldn't load your notes"
              description={state().kind === 'unavailable' ? unavailableMessage(state()) : ''}
              action={
                <Button variant="default" onClick={() => void props.store.refresh()}>
                  Retry
                </Button>
              }
            />
          </Show>
        }
      >
        <div class="notes-panel__list" role="list" aria-label="Notes">
          <For each={rows()}>
            {(row) => (
              <RecordRow
                density="dense"
                title={nameOf(row)}
                meta={row.excerpt}
                status={{ tone: 'neutral', text: when(row.updatedAt) }}
                onActivate={() => props.onOpen(row.id)}
                actions={
                  <IconButton
                    size="sm"
                    ariaLabel={`Delete ${nameOf(row)}`}
                    onClick={() => void remove(row)}
                  >
                    <TrashIcon />
                  </IconButton>
                }
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function unavailableMessage(s: NotesState): string {
  return s.kind === 'unavailable' ? s.message : ''
}
