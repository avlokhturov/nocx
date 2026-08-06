// FilesPanel — the Files sidebar view (design §5.4): the first icon in the
// activity bar, a session-scoped tree of the ACTIVE tab's machine.
//
// The panel follows the active tab through SidebarViewProps.activeOrigin —
// never a silent fall back to local, which would breach §0 in the same
// gesture as the panel's own primary action. Opening a file is the panel's
// primary action but the viewer is another worker's, so the panel takes a
// FileOpener as a dependency (the seam agreed in advance; a no-op default
// keeps the panel testable and runnable before the viewer lands).
//
// The header carries the root's display path (an inferred root is labelled —
// AD-5 surfaces a fallback, never applies it silently), the refresh action,
// and the polling badge slot: the badge itself belongs to the watching wave
// (§5.5), so the slot is left here and nothing else invents a different one.

import { createEffect, For, on, onCleanup, Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { SidebarViewDescriptor } from '../sidebar'
import type { ActiveOrigin } from '../tab-content'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState } from '../ui/empty-state'
import { IconButton } from '../ui/icon-button'
import { RefreshIcon } from '../ui/icons'
import { Spinner } from '../ui/spinner'
import { showToast } from '../ui/toast'
import { TreeRow } from '../ui/tree-row'
import type { FilesPanelServices } from './files-client'
import {
  createFilesTreeStore,
  type FilesFlatRow,
  type FilesNode,
  type FilesTreeStore,
} from './files-store'

// ── The opener seam ────────────────────────────────────────────────────────

/** The panel's primary action, delegated: the viewer tab is another worker's
 *  deliverable, so the panel calls this fixed contract and never builds a
 *  tab itself. The canonical comes from files.read (the file's identity —
 *  what the viewer's singletonKey deduplicates on); displayHost is null for
 *  a local file. */
export interface FileOpener {
  open(target: {
    bindingId: string
    endpointId: string | null
    path: string // lexical, as listed
    canonical: string // from files.read / files.list — the identity
    displayHost: string | null // null for local
    name: string
  }): void
}

/** A no-op default: the panel is testable and runnable before the viewer
 *  lands, and a registration that forgets the opener degrades to nothing. */
const NOOP_OPENER: FileOpener = { open: () => {} }

// ── Activity-bar icon ──────────────────────────────────────────────────────

/** A folder (Lucide `folder` under ISC, like the other kit icons) — the
 *  activity bar's Files glyph. currentColor, same viewBox and stroke
 *  vocabulary as ui/icons so the rail treats it identically. */
const FilesIcon: Component = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
)

// ── Panel ─────────────────────────────────────────────────────────────────

export const FILES_VIEW_ID = 'files'

/** The activity-bar order. Ports registers 0 (main.tsx); Files registers
 *  BELOW it so it sorts to the top of the view zone — an owner requirement
 *  (the first icon is Files), asserted in files-view.test.tsx. */
export const FILES_VIEW_ORDER = -1

export interface FilesPanelProps {
  store: FilesTreeStore
  services: FilesPanelServices
  opener: FileOpener
  /** The ACTIVE tab's origin — a reactive accessor, never a capture: the
   *  panel follows the tab in front. */
  activeOrigin: () => ActiveOrigin | null
}

export function FilesPanel(props: FilesPanelProps) {
  // Re-scope on origin change: the panel follows the ACTIVE tab. The store
  // itself decides whether the change re-opens (different session) or is a
  // no-op (same session, rule 1). The accessor is read INSIDE the on()
  // source function so the read is tracked: props.activeOrigin is itself a
  // prop access (reactive), and the accessor it wraps is a signal read.
  createEffect(
    on(
      () => props.activeOrigin(),
      (origin) => props.store.rescope(origin),
    ),
  )
  // The view unmounts when another view takes the panel; its binding closes
  // with it, and the next mount re-opens through the rescope above.
  onCleanup(() => props.store.dispose())

  /** The primary action: resolve the file's canonical (files.read — the
   *  only shape that carries identity for a file, D12) and hand the target
   *  to the opener. A refusal here is an action outcome: a toast, never a
   *  silently dead row. */
  const openFile = async (node: FilesNode): Promise<void> => {
    const b = props.store.binding()
    const o = props.store.origin()
    if (b === null || o === null) return
    try {
      const res = await props.services.read(b.bindingId, node.path, 0)
      props.opener.open({
        bindingId: b.bindingId,
        endpointId: b.endpointId,
        path: node.path,
        canonical: res.canonical,
        // Provenance rides the origin's host label: null for a local file.
        // The viewer titles a remote file "host · name" and a local file by
        // its basename alone — the asymmetry is carried, never invented.
        displayHost: o.host,
        name: node.name,
      })
    } catch (e) {
      showToast({ level: 'danger', message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** What may be opened — the §5.1 table, kept in the renderer's words:
   *  regular opens, symlink→regular opens after canonical resolution,
   *  dir expands, other (FIFO, device) does neither. */
  const openable = (node: FilesNode): boolean =>
    node.kind === 'regular' || (node.kind === 'symlink' && node.linkKind === 'regular')

  const renderRow = (row: FilesFlatRow) => {
    if (row.kind === 'entry') {
      const node = row.node
      return (
        <div
          class="files-row"
          data-testid="files-row"
          onClick={() => {
            if (openable(node)) void openFile(node)
          }}
        >
          <TreeRow
            name={node.name}
            depth={row.depth}
            kind={node.kind}
            linkKind={node.linkKind}
            cyclic={node.cyclic}
            disabled={node.state === 'error'}
            busy={node.busy}
            expanded={node.expanded}
            onToggle={() => props.store.toggle(node)}
          />
        </div>
      )
    }
    if (row.kind === 'loading') {
      return (
        <div class="files-row" data-depth={row.depth} data-testid="files-loading-row">
          <Spinner size="sm" label="Loading directory" />
        </div>
      )
    }
    if (row.kind === 'more') {
      // D10: an explicit "show next N", never virtualised rows. N is what
      // remains — the next page will hold min(pageSize, remaining).
      const remaining = Math.max(0, row.dir.total - row.dir.children.length)
      return (
        <div class="files-row" data-depth={row.depth}>
          <Button
            size="sm"
            data-testid="files-show-more"
            disabled={row.dir.busy}
            onClick={() => props.store.showMore(row.dir)}
          >
            Show next {remaining}
          </Button>
        </div>
      )
    }
    // state row — rule 4: tooLarge and timedOut are REAL states, switched on
    // first, and neither is a toast nor an empty directory.
    const dir = row.dir
    if (dir.state === 'tooLarge') {
      const observed = dir.observedCount !== null ? ` (${dir.observedCount} entries)` : ''
      return (
        <div
          class="files-row files-row-state"
          data-depth={row.depth}
          data-testid="files-state-too-large"
        >
          <Badge tone="warning">Directory too large</Badge>
          <span>
            More than {dir.tooLargeLimit} entries{observed} — nocx does not display directories this
            large.
          </span>
        </div>
      )
    }
    if (dir.state === 'timedOut') {
      return (
        <div
          class="files-row files-row-state"
          data-depth={row.depth}
          data-testid="files-state-timed-out"
        >
          <span>This directory took too long to load.</span>
          <Button size="sm" data-testid="files-retry" onClick={() => props.store.retry(dir)}>
            Retry
          </Button>
        </div>
      )
    }
    return (
      <div class="files-row files-row-state" data-depth={row.depth} data-testid="files-state-error">
        <span>{dir.error}</span>
      </div>
    )
  }

  return (
    <div class="files-panel" data-testid="files-panel">
      <Show when={props.store.phase() === 'no-origin'}>
        <EmptyState
          icon={<FilesIcon />}
          title="No files to show"
          description="Focus a terminal tab to see the files of the machine you are on."
        />
      </Show>
      <Show when={props.store.phase() === 'opening'}>
        <div class="files-loading" data-testid="files-loading">
          <Spinner label="Opening files" />
        </div>
      </Show>
      <Show when={props.store.phase() === 'failed'}>
        <div class="files-error" data-testid="files-error">
          <p>{props.store.openError()}</p>
          <Button size="sm" data-testid="files-retry-open" onClick={() => props.store.refresh()}>
            Retry
          </Button>
        </div>
      </Show>
      <Show when={props.store.phase() === 'ready'}>
        <div class="files-tree" role="tree" aria-label="Files">
          <For each={props.store.rows()}>{(row) => renderRow(row)}</For>
        </div>
      </Show>
    </div>
  )
}

// ── Registration ───────────────────────────────────────────────────────────

export interface FilesViewDeps {
  /** The panel's backend surface (createFilesPanelServices(dispatcher)). */
  services: FilesPanelServices
  /** The viewer-tab opener; a no-op default keeps the panel runnable before
   *  the viewer lands. */
  opener?: FileOpener
  /** Reactive accessor for the ACTIVE tab's origin — the coordinator wires
   *  it to TabManager.activeOrigin() through onActiveTabChange, exactly like
   *  the ports target id. */
  activeOrigin: () => ActiveOrigin | null
}

/** Build the Files view descriptor. The store is created once, per
 *  descriptor, and shared between the header action (refresh) and the panel
 *  body — one signal, one backend call site (the ports pause pattern). */
export function createFilesView(deps: FilesViewDeps): SidebarViewDescriptor {
  const opener = deps.opener ?? NOOP_OPENER
  const store = createFilesTreeStore(deps.services)
  return {
    id: FILES_VIEW_ID,
    title: 'Files',
    icon: FilesIcon,
    actions: () => (
      <>
        {/* Read store.root() INSIDE the JSX: a component body executes once,
            so capturing `const root = store.root()` would freeze the header
            path at its first render (the Solid gate's silent-reactivity
            failure — the refresh button's disabled binding is reactive, the
            captured const is not). */}
        <Show when={store.root() !== null}>
          <span
            class="files-header-path"
            data-testid="files-root-path"
            title={store.root()?.inferred ? store.root()?.inferredReason : undefined}
          >
            {store.root()?.display}
            {store.root()?.inferred ? ' (inferred)' : ''}
          </span>
        </Show>
        <IconButton
          data-testid="files-refresh"
          size="sm"
          ariaLabel="Refresh files"
          title="Refresh files"
          disabled={store.origin() === null}
          onClick={() => store.refresh()}
        >
          <RefreshIcon />
        </IconButton>
        {/* Polling badge slot (§5.5): the watching wave renders the
              degraded-mode badge here, beside Refresh. Intentionally empty
              until then — do not invent a second slot. */}
        <span data-testid="files-polling-badge-slot" />
      </>
    ),
    view: (props) => (
      <FilesPanel
        store={store}
        services={deps.services}
        opener={opener}
        activeOrigin={props.activeOrigin}
      />
    ),
    order: FILES_VIEW_ORDER,
  }
}
