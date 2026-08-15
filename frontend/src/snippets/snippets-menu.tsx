/**
 * The snippets toolbar menu (design §10.3, bead nocx-d346) — the library,
 * findable without knowing the chord.
 *
 * A kit ContextMenu and nothing else: every row hands its snippet back to
 * the composition root, which runs the PALETTE's accept path
 * (SnippetPalette.fireChosen). This surface has no fire logic, no resolver
 * and no refusal vocabulary of its own — a second copy of any of them would
 * be a second owner of one behaviour (AD-8), and the one that drifted would
 * be whichever a person used less.
 *
 * Mounted imperatively because the composition root is not a Solid tree:
 * the tab strip is a presentation port that reports "the snippets button
 * was pressed, here" and knows nothing about a store.
 */
import { Show, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { ContextMenu, type ContextMenuItem } from '../ui/context-menu'
import type { Snippet, SnippetsState, SnippetsStore } from './snippets-store'

export interface SnippetsMenuDeps {
  /** The one library every surface reads (design §6). */
  store: SnippetsStore
  /** A row was picked — the caller runs the palette's accept path. */
  onPick: (snippet: Snippet) => void
  /** "Manage snippets…" — the caller opens the settings page. */
  onManage: () => void
}

export interface SnippetsMenuHandle {
  /** Open at viewport coordinates — the anchor the toolbar button reports. */
  openAt(x: number, y: number): void
  close(): void
  dispose(): void
}

/** The label for a state with nothing to list. Loading is not one of these:
 *  it renders no message at all, because the rows arrive in the same breath
 *  and a flash of "Loading…" says less than the rows do. */
function stateNotice(state: SnippetsState): string | null {
  if (state.kind === 'unavailable') return `Couldn't load your snippets: ${state.message}`
  if (state.kind === 'ready' && state.snippets.length === 0) return 'No snippets yet'
  return null
}

export function mountSnippetsMenu(parent: HTMLElement, deps: SnippetsMenuDeps): SnippetsMenuHandle {
  const [open, setOpen] = createSignal(false)
  const [at, setAt] = createSignal({ x: 0, y: 0 })
  const [state, setState] = createSignal<SnippetsState>({ kind: 'loading' })

  const unsubscribe = deps.store.subscribe(setState)

  const items = (): ContextMenuItem[] => {
    const s = state()
    const rows: ContextMenuItem[] =
      s.kind === 'ready'
        ? s.snippets.map((snippet) => ({
            id: `snippet:${snippet.id}`,
            label: snippet.title,
            onSelect: () => deps.onPick(snippet),
          }))
        : []
    const notice = stateNotice(s)
    if (notice !== null) {
      // The reason, as a row that retries rather than a row that does
      // nothing: the person is already here, and the only useful answer to
      // "we could not read the library" is to look again (§11.5).
      rows.push({
        id: 'notice',
        label: notice,
        onSelect: () => void deps.store.refresh(),
      })
    }
    rows.push({ id: 'manage', label: 'Manage snippets…', onSelect: () => deps.onManage() })
    return rows
  }

  const dispose = render(
    () => (
      <Show when={open()}>
        <ContextMenu
          open={open()}
          x={at().x}
          y={at().y}
          items={items()}
          onClose={() => setOpen(false)}
          data-testid="snippets-menu"
        />
      </Show>
    ),
    parent,
  )

  return {
    openAt(x: number, y: number): void {
      setAt({ x, y })
      setOpen(true)
      // Re-read on every open: there is no change notification on the wire,
      // so a surface that shows a list re-reads before showing it (§6).
      void deps.store.refresh()
    },
    close(): void {
      setOpen(false)
    },
    dispose(): void {
      setOpen(false)
      unsubscribe()
      dispose()
    },
  }
}
