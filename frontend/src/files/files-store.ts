// FilesTreeStore — the Files panel's tree: lazy expansion with pagination
// (D10), origin-scoped staleness (D4) and canonical cycle detection (D9).
//
// The four rules that make it correct, each with the failure it stops:
//
// 1. ROOT COMES FROM files.open AND DOES NOT MOVE. A later `cd` (a new OSC 7
//    cwd on the same session) must not re-root the tree, so rescope() is a
//    no-op when the session scope is unchanged — only a different tab or a
//    dead binding re-opens.
// 2. STALE RESPONSES ARE DROPPED, AND NOTHING CLIENT-MINTED GOES ON THE
//    WIRE. Every request captures the {tabId, generation, bindingId} triple
//    it was issued for; a response applies only if that triple still matches
//    the view's current state (the tab switch guard — a files.list for tab A,
//    still in flight when the user activates tab B, must never paint A's
//    listing into B's tree) AND the response's generation is not older than
//    what has already been applied to that node (the ordering guard — a
//    refresh re-list that landed first must not be overwritten by the expand
//    that started before it). The generation counter bumps on every re-scope
//    and every refresh cycle.
// 3. CYCLE DETECTION COSTS NO EXTRA CALL. Every successful list returns the
//    listed directory's `canonical`; the store compares it against the
//    canonicals it already holds for the directory's expanded ancestors
//    (root first) BEFORE committing children, marks the row cyclic on a
//    match, commits nothing and never asks again.
// 4. state IS A DISCRIMINATOR, SWITCHED ON FIRST. tooLarge is a real state
//    ("more than N entries", no pagination offered), timedOut is its own
//    state with a retry; permission-denied arrives as a rejected call and is
//    a rendered node state too. None of them is a toast, none is an empty
//    directory.
//
// The tree is plain mutable objects behind a version signal: Solid re-renders
// on the bump, and the mutation-before-render order is enforced by methods
// never being called during a render.

import { createMemo, createSignal, untrack } from 'solid-js'
import type { FilesListResult, FilesListEntry } from '../generated/files.list'
import type { FilesPanelServices } from './files-client'
import type { ActiveOrigin } from '../tab-content'
import type { TreeRowKind } from '../ui/tree-row'

/** One page of children per expanded directory (D10). A starting number,
 *  named in code because §9 of the design says so: the backend's ordering is
 *  deterministic before pagination, so the page size is a product choice to
 *  tune once the panel is in daily use — not a constant somebody picked. */
export const FILES_PAGE_SIZE = 50

type FilesPanelPhase = 'no-origin' | 'opening' | 'ready' | 'failed'

type FilesListingState = 'ok' | 'tooLarge' | 'timedOut' | 'error'

/** The state of one expanded-or-attempted directory's enumeration. */
interface DirListing {
  /** A list request is in flight for this directory. */
  busy: boolean
  /** The outcome discriminator of the last enumeration: null before the
   *  first attempt completes. */
  state: FilesListingState | null
  tooLargeLimit: number | null
  observedCount: number | null
  timeout: number | null
  /** Rejected-call message (permission denied, dead channel). */
  error: string | null
  /** The directory's provider-canonical identity, from its last successful
   *  list — the D9 cycle vocabulary. */
  canonical: string | null
  rev: string
  total: number
  hasMore: boolean
  nextOffset: number
  /** The generation whose response was last applied to this directory. */
  appliedGeneration: number
}

function emptyListing(): DirListing {
  return {
    busy: false,
    state: null,
    tooLargeLimit: null,
    observedCount: null,
    timeout: null,
    error: null,
    canonical: null,
    rev: '',
    total: 0,
    hasMore: false,
    nextOffset: 0,
    appliedGeneration: -1,
  }
}

/** One row of the tree: the entry as the wire listed it, plus the tree's
 *  own state for it. `children` is only meaningful while `expanded`. */
export interface FilesNode extends DirListing {
  name: string
  path: string
  kind: TreeRowKind
  linkTarget?: string
  linkKind?: TreeRowKind
  size: number
  modTime: string
  mode: number
  expanded: boolean
  /** Symlink whose canonical matched an expanded ancestor (D9): renders as
   *  a leaf and is never requested again. */
  cyclic: boolean
  children: FilesNode[]
}

/** The root from files.open, plus its own listing state — the root is a
 *  directory like any other and can be tooLarge or timedOut too. It is never
 *  a row (no TreeRow); its children are the depth-0 rows. */
interface FilesRoot extends DirListing {
  path: string
  display: string
  inferred: boolean
  inferredReason: string
  children: FilesNode[]
}

export type FilesFlatRow =
  | { kind: 'entry'; node: FilesNode; depth: number }
  | { kind: 'loading'; dir: FilesRoot | FilesNode; depth: number }
  | { kind: 'more'; dir: FilesRoot | FilesNode; depth: number }
  | { kind: 'state'; dir: FilesRoot | FilesNode; depth: number }

interface FilesBinding {
  bindingId: string
  endpointId: string | null
}
export interface FilesTreeStore {
  phase(): FilesPanelPhase
  openError(): string | null
  binding(): FilesBinding | null
  origin(): ActiveOrigin | null
  root(): FilesRoot | null
  /** The visible rows in display order (the flatten of the expanded tree). */
  rows(): FilesFlatRow[]
  /** Re-scope to the active tab's origin: opens a fresh binding when the
   *  session changed or the previous binding is gone; a no-op when the same
   *  session is still in front (the root does not move, rule 1). */
  rescope(origin: ActiveOrigin | null): void
  /** Expand or collapse a directory row. */
  toggle(node: FilesNode): void
  /** Fetch the next page of an expanded directory. */
  showMore(dir: FilesRoot | FilesNode): void
  /** Re-issue the failed enumeration of a timedOut (or error) directory. */
  retry(dir: FilesRoot | FilesNode): void
  /** Re-list the root and every expanded directory in one cycle (the
   *  header's refresh action); re-opens when the binding is gone. */
  refresh(): void
  /** Close the binding and reset. Called when the view unmounts; the store
   *  is reusable — the next rescope re-opens. */
  dispose(): void
}

interface ListCtx {
  tabId: number
  generation: number
  bindingId: string | null
}

export function createFilesTreeStore(services: FilesPanelServices): FilesTreeStore {
  let generation = 0
  /** True between dispose() and the next rescope(): late responses from a
   *  previous life of this store must not touch the reset state. */
  let closed = true

  const [phase, setPhase] = createSignal<FilesPanelPhase>('no-origin')
  const [openError, setOpenError] = createSignal<string | null>(null)
  const [binding, setBinding] = createSignal<FilesBinding | null>(null)
  const [origin, setOrigin] = createSignal<ActiveOrigin | null>(null)
  const [root, setRoot] = createSignal<FilesRoot | null>(null)
  const [treeVersion, setTreeVersion] = createSignal(0)
  const bumpTree = (): void => {
    setTreeVersion((v) => v + 1)
  }

  const rows = createMemo<FilesFlatRow[]>(() => {
    treeVersion()
    const r = root()
    if (r === null) return []
    const out: FilesFlatRow[] = []
    const emitDir = (dir: FilesRoot | FilesNode, childDepth: number): void => {
      if (dir.state === 'ok') {
        for (const child of dir.children) emitNode(child, childDepth)
        if (dir.hasMore) out.push({ kind: 'more', dir, depth: childDepth })
      } else if (dir.state !== null) {
        out.push({ kind: 'state', dir, depth: childDepth })
      } else if (dir.busy) {
        out.push({ kind: 'loading', dir, depth: childDepth })
      }
    }
    const emitNode = (node: FilesNode, depth: number): void => {
      out.push({ kind: 'entry', node, depth })
      if (!node.expanded) return
      emitDir(node, depth + 1)
    }
    emitDir(r, 0)
    return out
  })
  /** The response's request is still the view's current scope: same tab,
   *  and — once a binding exists — the same binding. The generation part of
   *  the triple is checked per node (rule 2), not here.
   *
   *  The signal reads are deliberately UNTRACKED: a response handler asks
   *  "is this still the scope?" at the moment the response lands, and must
   *  never re-run when the scope changes — rule 2 exists precisely because
   *  a response applies to the state it lands in, not to a state it could
   *  have re-rendered for. untrack says that in code, and keeps the
   *  one-shot guard from looking like a reactive derivation. */
  function scopeCurrent(ctx: ListCtx): boolean {
    if (closed) return false
    const o = untrack(origin)
    const b = untrack(binding)
    if (o === null || ctx.tabId !== o.tabId) return false
    if (ctx.bindingId !== null && (b === null || ctx.bindingId !== b.bindingId)) return false
    return true
  }

  /** An files.open response applies only if it is still the newest scope
   *  request: the open that establishes a binding wins by generation. Same
   *  untracked read as scopeCurrent — a one-shot guard, never a reactive
   *  derivation. */
  function openCurrent(ctx: { tabId: number; generation: number }): boolean {
    if (closed) return false
    const o = untrack(origin)
    return o !== null && ctx.tabId === o.tabId && ctx.generation === generation
  }

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  function entryToNode(e: FilesListEntry): FilesNode {
    return {
      ...emptyListing(),
      name: e.name,
      path: e.path,
      kind: e.kind,
      ...(e.linkTarget !== undefined ? { linkTarget: e.linkTarget } : {}),
      ...(e.linkKind !== undefined ? { linkKind: e.linkKind } : {}),
      size: e.size,
      modTime: e.modTime,
      mode: e.mode,
      expanded: false,
      cyclic: false,
      children: [],
    }
  }

  /** Merge a fresh listing page into the existing children, preserving node
   *  identity for rows that persist: a refresh re-list of a parent must not
   *  orphan the in-flight re-list of an expanded child (its response would
   *  apply to a node the tree no longer holds and the tree would collapse).
   *  Wire facts (name, kind, size, mtime, mode, link) are refreshed from the
   *  new listing; tree state (expanded, children, canonical, cyclic) stays
   *  with the surviving node. Rows the new listing no longer contains are
   *  dropped. */
  function mergeChildren(oldChildren: FilesNode[], entries: FilesListEntry[]): FilesNode[] {
    const byPath = new Map(oldChildren.map((c) => [c.path, c]))
    return entries.map((e) => {
      const existing = byPath.get(e.path)
      if (existing === undefined) return entryToNode(e)
      existing.name = e.name
      existing.kind = e.kind
      if (e.linkTarget !== undefined) existing.linkTarget = e.linkTarget
      if (e.linkKind !== undefined) existing.linkKind = e.linkKind
      existing.size = e.size
      existing.modTime = e.modTime
      existing.mode = e.mode
      return existing
    })
  }
  /** The canonicals of the node's expanded ancestors, root first — the D9
   *  chain. Only ancestors can be listed before the node (a row is visible
   *  only under expanded directories), so a canonical match against this
   *  chain is exactly "resolves back into an already-expanded ancestor".
   *  The node itself is never part of the chain: its own canonical must not
   *  trip the check on a refresh re-list. The root read is untracked like
   *  the other response-time snapshots — this runs inside applyListing,
   *  never during a render. */
  function ancestorCanonicals(node: FilesNode): (string | null)[] {
    const r = untrack(root)
    if (r === null) return []
    const chain: (string | null)[] = [r.canonical]
    let dir: FilesRoot | FilesNode = r
    for (;;) {
      if (dir === node) break
      let child: FilesNode | undefined
      for (const candidate of dir.children) {
        if (
          candidate === node ||
          node.path === candidate.path ||
          node.path.startsWith(candidate.path + '/')
        ) {
          child = candidate
          break
        }
      }
      if (child === undefined || child === node) break
      chain.push(child.canonical)
      dir = child
    }
    return chain
  }

  function isCyclic(node: FilesNode, canonical: string): boolean {
    return canonical !== '' && ancestorCanonicals(node).includes(canonical)
  }

  function applyListing(dir: FilesRoot | FilesNode, ctx: ListCtx, res: FilesListResult): void {
    if (!scopeCurrent(ctx)) return
    if (ctx.generation < dir.appliedGeneration) {
      dir.busy = false
      bumpTree()
      return
    }
    if (res.state === 'ok') {
      // Rule 3: the cycle check runs BEFORE the children are committed, so
      // a cyclic expansion never flashes a listing.
      if ('kind' in dir && isCyclic(dir, res.canonical)) {
        dir.cyclic = true
        dir.expanded = false
        dir.busy = false
        dir.state = null
        dir.children = []
        dir.hasMore = false
        bumpTree()
        return
      }
      dir.state = 'ok'
      dir.canonical = res.canonical
      dir.rev = res.rev
      dir.total = res.total
      dir.children = mergeChildren(dir.children, res.entries)
      dir.hasMore = res.hasMore
      dir.nextOffset = res.offset + res.entries.length
      dir.error = null
      dir.appliedGeneration = ctx.generation
      dir.busy = false
      bumpTree()
      return
    }
    if (res.state === 'tooLarge') {
      // D14: a real state — "more than N entries" — with no pagination
      // offered. The header refresh stays the manual retry.
      dir.state = 'tooLarge'
      dir.tooLargeLimit = res.limit
      dir.observedCount = res.observedCount ?? null
      dir.children = []
      dir.hasMore = false
      dir.canonical = null
      dir.appliedGeneration = ctx.generation
      dir.busy = false
      bumpTree()
      return
    }
    dir.state = 'timedOut'
    dir.timeout = res.timeout
    dir.children = []
    dir.hasMore = false
    dir.canonical = null
    dir.appliedGeneration = ctx.generation
    dir.busy = false
    bumpTree()
  }

  function applyListError(dir: FilesRoot | FilesNode, ctx: ListCtx, e: unknown): void {
    if (!scopeCurrent(ctx)) return
    if (ctx.generation < dir.appliedGeneration) {
      dir.busy = false
      bumpTree()
      return
    }
    // Permission denied is a rendered node state, never a silently empty
    // directory (AGENTS.md): the row renders disabled and this message is
    // the state row beneath it.
    dir.state = 'error'
    dir.error = messageOf(e)
    dir.children = []
    dir.hasMore = false
    dir.appliedGeneration = ctx.generation
    dir.busy = false
    bumpTree()
  }

  /** Snapshot the current scope for a request, untracked like the guards:
   *  the request must carry the scope that ISSUED it, and the caller asks
   *  once, at call time. */
  function captureCtx(): ListCtx | null {
    const o = untrack(origin)
    const b = untrack(binding)
    if (o === null || b === null) return null
    return { tabId: o.tabId, generation, bindingId: b.bindingId }
  }

  function issueList(
    dir: FilesRoot | FilesNode,
    offset: number,
    limit: number,
    ctx: ListCtx,
  ): void {
    dir.busy = true
    bumpTree()
    services.list(ctx.bindingId as string, dir.path, offset, limit).then(
      (res) => applyListing(dir, ctx, res),
      (e) => applyListError(dir, ctx, e),
    )
  }

  /** The §5.1 refresh form: re-list at offset 0 with the count currently
   *  displayed, replacing every displayed row atomically. With no explicit
   *  ctx this starts a new cycle (it supersedes in-flight page requests). */
  function refreshDir(dir: FilesRoot | FilesNode, ctx?: ListCtx): void {
    const next = ctx ?? captureCtx()
    if (next === null) return
    const limit = dir.children.length > 0 ? dir.children.length : FILES_PAGE_SIZE
    issueList(dir, 0, limit, next)
  }

  function openScope(o: ActiveOrigin): void {
    generation++
    setPhase('opening')
    setOpenError(null)
    const ctx = { tabId: o.tabId, generation }
    // D2: a verified OSC 7 cwd overrides the provider's root; anything else
    // omits rootPath and lets the provider fall back (and say it did).
    const rootPath = o.cwdVerified && o.cwd !== null ? o.cwd : undefined
    // Omitting rootPath entirely — an explicit `undefined` is not the same
    // as an absent parameter to the fake seam's call matchers, and the wire
    // contract omits it.
    const opening =
      rootPath !== undefined ? services.open(o.sessionId, rootPath) : services.open(o.sessionId)
    opening
      .then((res) => {
        if (!openCurrent(ctx)) return
        setBinding({ bindingId: res.bindingId, endpointId: res.endpointId })
        setRoot({
          ...emptyListing(),
          path: res.root.path,
          display: res.root.display,
          inferred: res.root.inferred,
          inferredReason: res.root.inferredReason,
          children: [],
        })
        setPhase('ready')
        // One-shot reads at response time, untracked for the same reason as
        // the guards: the first list is issued against the state that just
        // landed, never re-run for a state that replaced it.
        const b = untrack(binding)
        if (b !== null) {
          const listCtx: ListCtx = { tabId: o.tabId, generation, bindingId: b.bindingId }
          const r = untrack(root)
          if (r !== null) issueList(r, 0, FILES_PAGE_SIZE, listCtx)
        }
      })
      .catch((e) => {
        if (!openCurrent(ctx)) return
        setPhase('failed')
        setOpenError(messageOf(e))
      })
  }

  function rescope(next: ActiveOrigin | null): void {
    const prev = origin()
    const prevBinding = binding()
    // Rule 1: the same session scope keeps its binding and its tree — a
    // later OSC 7 cwd must not re-root the tree, and neither may a viewer
    // tab that answers the origin it was opened from (design §5.4): the
    // viewer is the same machine with a different tabId, and re-opening
    // there would close the very binding the viewer is reading through.
    // Only a different session, a different kind, or a dead binding
    // (dispose, or an origin that went null and came back) re-opens.
    if (
      prev !== null &&
      next !== null &&
      prev.sessionId === next.sessionId &&
      prev.kind === next.kind &&
      prevBinding !== null
    ) {
      return
    }
    closed = false
    generation++
    if (prevBinding !== null) {
      void services.close(prevBinding.bindingId).catch(() => {})
    }
    setOrigin(next)
    setBinding(null)
    setRoot(null)
    if (next === null) {
      setPhase('no-origin')
      bumpTree()
      return
    }
    openScope(next)
  }

  function toggle(node: FilesNode): void {
    if (node.busy || node.cyclic) return
    if (node.expanded) {
      node.expanded = false
      bumpTree()
      return
    }
    node.expanded = true
    // Collapse keeps the children; re-expanding a loaded directory is
    // instant, and the header refresh is what re-validates it.
    if (node.state === 'ok' && node.children.length > 0) {
      bumpTree()
      return
    }
    const ctx = captureCtx()
    if (ctx === null) {
      node.expanded = false
      bumpTree()
      return
    }
    issueList(node, 0, FILES_PAGE_SIZE, ctx)
  }

  function showMore(dir: FilesRoot | FilesNode): void {
    if (dir.busy || dir.state !== 'ok' || !dir.hasMore) return
    const ctx = captureCtx()
    if (ctx === null) return
    const offset = dir.nextOffset
    dir.busy = true
    bumpTree()
    services.list(ctx.bindingId as string, dir.path, offset, FILES_PAGE_SIZE).then(
      (res) => {
        if (!scopeCurrent(ctx)) return
        if (ctx.generation < dir.appliedGeneration || dir.state !== 'ok') {
          dir.busy = false
          bumpTree()
          return
        }
        if (res.state === 'ok') {
          // A directory that changed between pages must not have a page
          // from the old snapshot appended to a page from the new one —
          // that is how rows duplicate and skip (§7). Re-list the
          // displayed window in one call instead (the refresh form).
          if (res.rev !== dir.rev) {
            refreshDir(dir)
            return
          }
          // The pagination was reset while this page was in flight (a
          // refresh landed first): appending would corrupt the fresh
          // listing, so drop the page — the refresh already replaced it.
          if (res.offset !== dir.nextOffset) {
            dir.busy = false
            bumpTree()
            return
          }
          dir.children.push(...res.entries.map(entryToNode))
          dir.nextOffset = res.offset + res.entries.length
          dir.hasMore = res.hasMore
          dir.total = res.total
          dir.rev = res.rev
          dir.appliedGeneration = ctx.generation
          dir.busy = false
          bumpTree()
          return
        }
        // A page request refused: the directory is now too large or too
        // slow. Render that state; the partial listing is discarded
        // (D14: an apparently complete prefix is worse than a refusal).
        dir.state = res.state === 'tooLarge' ? 'tooLarge' : 'timedOut'
        if (res.state === 'tooLarge') {
          dir.tooLargeLimit = res.limit
          dir.observedCount = res.observedCount ?? null
        } else {
          dir.timeout = res.timeout
        }
        dir.children = []
        dir.hasMore = false
        dir.appliedGeneration = ctx.generation
        dir.busy = false
        bumpTree()
      },
      (e) => applyListError(dir, ctx, e),
    )
  }

  function retry(dir: FilesRoot | FilesNode): void {
    if (dir.busy || (dir.state !== 'timedOut' && dir.state !== 'error')) return
    const ctx = captureCtx()
    if (ctx === null) return
    issueList(dir, dir.nextOffset, FILES_PAGE_SIZE, ctx)
  }

  function refresh(): void {
    const o = origin()
    if (o === null) return
    if (phase() === 'no-origin') return
    if (binding() === null) {
      // The binding is gone (open failed, or disposed): re-establish the
      // scope — the header refresh is the retry for a failed open too.
      if (phase() === 'failed') rescope(o)
      return
    }
    // One cycle for the whole tree: every expanded directory is re-listed
    // at its displayed count, so a refresh is a single snapshot per
    // directory and in-flight page requests are superseded by the bump.
    generation++
    const ctx = captureCtx()
    const r = root()
    if (ctx === null || r === null) return
    refreshDir(r, ctx)
    const expanded: FilesNode[] = []
    const collect = (dir: FilesRoot | FilesNode): void => {
      for (const child of dir.children) {
        if (child.expanded) {
          expanded.push(child)
          collect(child)
        }
      }
    }
    collect(r)
    for (const node of expanded) refreshDir(node, ctx)
  }

  function dispose(): void {
    closed = true
    const b = binding()
    setOrigin(null)
    setBinding(null)
    setRoot(null)
    setPhase('no-origin')
    setOpenError(null)
    bumpTree()
    if (b !== null) void services.close(b.bindingId).catch(() => {})
  }

  return {
    phase,
    openError,
    binding,
    origin,
    root,
    rows,
    rescope,
    toggle,
    showMore,
    retry,
    refresh,
    dispose,
  }
}
