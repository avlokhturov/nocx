// FilesTreeStore — the Files panel's tree: lazy expansion with pagination
// (D10), origin-scoped staleness (D4) and canonical cycle detection (D9).
//
// The four rules that make it correct, each with the failure it stops:
//
// 1. THE ROOT COMES FROM files.open AND DOES NOT MOVE. The composition
//    layer pins it to the FILESYSTEM ROOT `/` — a verified OSC 7 cwd is
//    never handed to files.open, so a later `cd` (a new OSC 7 cwd on the
//    same session) must not re-root the tree: rescope() is a no-op when
//    the session scope is unchanged and REVEALS instead (walk the chain
//    from the root down to the new cwd, expand, select — never collapse).
//    Only a different tab or a dead binding re-opens.
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
import type { FilesChanged } from '../generated/files.changed'
import type { FilesPanelServices } from './files-client'
import type { ActiveOrigin } from '../tab-content'
import { isExpandable, type TreeRowKind } from '../ui/tree-row-kind'

/** The watch set for a tree: the root (its rows are always on screen) plus
 *  every EXPANDED directory — the panel's change surface is exactly what it
 *  renders (§5.2). The backend REPLACES the set on every files.watch, so the
 *  client sends the whole set it currently wants and the backend diffs:
 *  collapsing a directory removes it by construction and can never leak a
 *  watch. The notification carries the same provider-syntax paths, so the
 *  changed handler matches against this vocabulary. */
function currentWatchPaths(root: FilesRoot): string[] {
  const paths = [root.path]
  const collect = (dir: FilesRoot | FilesNode): void => {
    for (const child of dir.children) {
      if (child.expanded) {
        paths.push(child.path)
        collect(child)
      }
    }
  }
  collect(root)
  return paths
}

/** The entry's path relative to the display root, as spelled — lexical,
 *  symlinks unresolved. That is what a person means by "the path in this
 *  tree"; the D9 canonical is the deduplication identity and resolves
 *  symlinks, so copying it would hand the user a path they did not click
 *  on. The root is always the tree's own root, so every visible entry is
 *  under it; the fallback spells the path as-is rather than inventing a
 *  relative form for a node that is not in the tree. */
function relativePathOf(rootPath: string | null, nodePath: string): string {
  // The filesystem root has no prefix: the path as spelled from / IS the
  // path minus its leading slash. (rootPath + '/' would be '//' — a
  // prefix no path has — so the general form cannot serve the root.)
  if (rootPath === '/') return nodePath.startsWith('/') ? nodePath.slice(1) : nodePath
  if (rootPath !== null && nodePath.startsWith(rootPath + '/')) {
    return nodePath.slice(rootPath.length + 1)
  }
  return nodePath
}

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
  /** Walk from the root down to `path`, listing and expanding each level
   *  that is not already expanded, then select the target (revealTarget).
   *  NEVER collapses — a directory the user opened by hand stays open.
   *  Idempotent: revealing the path already revealed (or a reveal to it
   *  in flight) does nothing. Stops honestly: a level that comes back
   *  tooLarge/timedOut/unreadable, or a path that does not exist under
   *  the root, ends the walk with what was expanded left expanded and
   *  the level's state row rendered — the reveal did not reach the
   *  target and the tree says so where it stopped. */
  revealPath(path: string): void
  /** The path the last completed reveal selected, or null when nothing
   *  has been revealed: no verified cwd yet, a viewer origin (no
   *  opinion), or a fresh scope. The view renders the matching row
   *  selected and scrolls it into view — the scroll belongs to the
   *  view, never the store. */
  revealTarget(): string | null
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
   *  header's refresh action); re-opens when the binding is gone. Also
   *  re-sends the watch set, so it is the Retry for a failed watch. */
  refresh(): void
  /** The backend's reported refresh mode for the current watch set: null
   *  until the first files.watch response (§5.5). */
  watchMode(): 'watching' | 'polling' | null
  /** Why refresh is degraded — non-null only for a LOCAL binding whose live
   *  watch could not be established and which fell back to polling. The
   *  persistent badge renders from this; a remote binding's designed-mode
   *  polling has no reason and warns about nothing. */
  watchDegradedReason(): string | null
  /** A files.watch call failed — the change stream may be gone. Sticky
   *  until the next successful watch (the header refresh re-establishes
   *  it); rendered as an inline message with Retry, never a toast. */
  watchFailed(): string | null
  /** The entry's path relative to the display root, as spelled — lexical,
   *  symlinks unresolved (the copy-path action's "path in this tree"). */
  relativePath(node: FilesNode): string
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
  /** The §5.5 watching state: the backend's reported refresh mode for the
   *  current watch set, the degraded-mode reason (local fallback to
   *  polling), and a sticky failure — the inline "refresh stopped" state,
   *  cleared by the next successful files.watch (the header refresh). */
  const [watchMode, setWatchMode] = createSignal<'watching' | 'polling' | null>(null)
  const [watchDegradedReason, setWatchDegradedReason] = createSignal<string | null>(null)
  const [watchFailed, setWatchFailed] = createSignal<string | null>(null)
  /** The path the last completed reveal selected (see the interface doc).
   *  Reset on every re-scope and dispose — a selection from a previous
   *  machine must not linger. */
  const [revealTarget, setRevealTarget] = createSignal<string | null>(null)
  /** The reveal walk currently in flight, if any: the path it is walking.
   *  A NEW path supersedes it (walkId drops the older walk's responses);
   *  the SAME path while in flight is a no-op — the walk is already doing
   *  exactly that work. Cleared when the walk ends, so a later reveal of
   *  the same path walks again (and is still idempotent via revealTarget). */
  let pendingReveal: string | null = null
  /** True while a reveal walk is in flight. The change stream must not
   *  refresh a directory the walk is paging: a files.changed issued
   *  against the walk's first page would re-list `offset=0, limit=50`,
   *  and if that response lands AFTER the walk's later pages it replaces
   *  them — the accumulated rows shrink back to page 1 and the revealed
   *  target vanishes. The walk's own pages are the freshest data for the
   *  dirs it touches; the next poll's change (or the walk's re-sent watch
   *  set) re-validates anything missed in the few milliseconds it runs. */
  let revealing = false
  /** The current reveal walk's identity. Every walk captures it; a step
   *  applies only while it still matches — a reveal in flight when the
   *  origin changes (or a newer reveal starts) must drop, never paint. */
  let revealWalkId = 0

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

  /** Send the watch set the panel currently wants — files.watch REPLACES
   *  the set rather than adding to it, so this is the whole set, every
   *  time: the backend diffs and collapsing a directory cannot leak a
   *  watch. Called when the binding opens, when a directory expands or
   *  collapses, on reconnect, and by refresh() — the Retry for a failed
   *  watch. The response carries the refresh mode (§5.5): 'polling' with a
   *  reason on a local binding is a real degrade and gets the persistent
   *  badge; a rejection means the change stream may be gone and becomes
   *  the sticky inline message. */
  function pushWatchSet(): void {
    const ctx = captureCtx()
    const r = untrack(root)
    if (ctx === null || r === null) return
    services.watch(ctx.bindingId as string, currentWatchPaths(r)).then(
      (res) => {
        if (!scopeCurrent(ctx)) return
        setWatchFailed(null)
        setWatchMode(res.mode)
        setWatchDegradedReason(res.degradedReason ?? null)
      },
      (e) => {
        if (!scopeCurrent(ctx)) return
        setWatchFailed(messageOf(e))
      },
    )
  }

  /** The server-initiated invalidation (SettingsObserver pattern). The
   *  notification names one dirty path and carries no entries — re-listing
   *  through refreshDir keeps exactly one code path rendering a directory.
   *  Three filters, each for a different defect: a change for a binding
   *  this tree does not follow is not this tree's business (a viewer's
   *  binding, or a previous scope's); a directory whose rows are not
   *  rendered (tooLarge/timedOut/error) keeps its state row until the user
   *  retries; and a rev that already matches what is applied means the
   *  change is already on screen. A busy directory is skipped too — an
   *  enumeration is already on the wire and its response is newer than
   *  this notification's knowledge. */
  function onFilesChanged(p: FilesChanged): void {
    // A reveal walk is paging: a refresh here would re-list at the walk's
    // first-page count and, landing late, replace the rows the walk has
    // since accumulated — the reveal would collapse out from under the
    // user (the files.changed-vs-pagination race, nocx-r3bz). The walk's
    // own pages are the freshest data; the next poll re-validates.
    if (revealing) return
    const b = untrack(binding)
    if (b === null || p.bindingId !== b.bindingId) return
    const r = untrack(root)
    if (r === null) return
    const ctx = captureCtx()
    if (ctx === null) return
    let dir: FilesRoot | FilesNode | null = r.path === p.path ? r : null
    if (dir === null) {
      const find = (d: FilesRoot | FilesNode): void => {
        for (const child of d.children) {
          if (child.path === p.path) {
            dir = child
            return
          }
          if (child.expanded) find(child)
        }
      }
      find(r)
    }
    if (dir === null || dir.state !== 'ok' || dir.busy) return
    if (p.rev !== undefined && p.rev === dir.rev) return
    refreshDir(dir, ctx)
  }

  function openScope(o: ActiveOrigin): void {
    generation++
    setPhase('opening')
    setOpenError(null)
    // A fresh binding has no watch state yet: the badge and the sticky
    // message wait for this binding's first files.watch response.
    setWatchMode(null)
    setWatchDegradedReason(null)
    setWatchFailed(null)
    // A fresh scope starts with nothing revealed — a selection from a
    // previous machine must not linger — and supersedes any walk still
    // in flight from the previous scope: its responses must not paint,
    // and its pending marker must not suppress this scope's reveal of
    // the same path.
    setRevealTarget(null)
    pendingReveal = null
    revealing = false
    revealWalkId++
    // The root is the FILESYSTEM ROOT, pinned here and never derived from
    // the cwd: a verified OSC 7 cwd must not re-root the tree (it REVEALS
    // instead), and the provider's fallback machinery is not reachable
    // from the panel — the panel is a file manager from / whether or not
    // the shell reports where it is.
    const ctx = { tabId: o.tabId, generation }
    const opening = services.open(o.sessionId, '/')
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
        // The root's rows are on screen from the first list, so the watch
        // set starts with the root (the e2e clause: a file created outside
        // nocx in the root appears with nobody pressing anything).
        pushWatchSet()
        // Reveal-on-open: land where the terminal is. Read the LIVE origin
        // — the cwd may have moved while the open was in flight (an OSC 7
        // that arrived mid-open), and the walk reads the committed root.
        const live = untrack(origin)
        if (live !== null && live.cwdVerified && live.cwd !== null && live.cwdFollow) {
          revealPath(live.cwd)
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
      // The stored origin stays CURRENT even though the scope does not
      // re-open: openFile hands it to the viewer, and the reveal check
      // reads the live cwd. A stale cwd here would reach the viewer.
      setOrigin(next)
      // Same scope: the tree does not move, but a VERIFIED cwd change on
      // the origin the panel follows REVEALS — the chain from the root
      // down to the new cwd is expanded and the target selected. This is
      // the product rule: the terminal owns "where am I", and the panel,
      // rooted at /, follows by revealing, never by re-rooting. An
      // unverified or absent cwd reveals nothing (AD-5: no silent $HOME
      // guess); an origin with no opinion — a viewer tab's frozen origin —
      // reveals nothing either: it is "stay exactly as you are".
      if (next.cwdVerified && next.cwd !== null && next.cwdFollow) {
        revealPath(next.cwd)
      }
      return
    }
    // An open already in flight for the same session: re-opening would
    // mint a second binding that supersedes the first (nocx-myts leaks
    // it). The stored origin is STILL updated to the newest answer — the
    // in-flight open reveals from the LIVE origin on success, and a
    // stale cwd here would make it reveal the wrong path, or nothing at
    // all: the unverified startup cwd is exactly what an early OSC 7
    // races against.
    if (
      prev !== null &&
      next !== null &&
      prev.sessionId === next.sessionId &&
      prev.kind === next.kind &&
      phase() === 'opening'
    ) {
      setOrigin(next)
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
      // The collapsed directory leaves the watch set: the set is what the
      // panel renders, and files.watch replaces it wholesale, so sending
      // the set without the collapsed path is what stops the watch.
      pushWatchSet()
      return
    }
    node.expanded = true
    // Collapse keeps the children; re-expanding a loaded directory is
    // instant, and the header refresh is what re-validates it.
    if (node.state === 'ok' && node.children.length > 0) {
      bumpTree()
      pushWatchSet()
      return
    }
    const ctx = captureCtx()
    if (ctx === null) {
      node.expanded = false
      bumpTree()
      return
    }
    issueList(node, 0, FILES_PAGE_SIZE, ctx)
    pushWatchSet()
  }

  // ── Reveal (the product rule: the terminal owns "where am I"; the
  //    panel, rooted at the filesystem root, follows by revealing) ─────

  /** Reveal `targetPath`: walk from the root down to it, listing and
   *  expanding each level that is not already expanded, then select the
   *  target (revealTarget — the view scrolls it into view). NEVER
   *  collapses: a directory the user opened by hand stays open. Stops
   *  honestly: a level that comes back tooLarge/timedOut/unreadable, or
   *  a path that does not exist under the root, ends the walk with what
   *  was expanded left expanded and the level's state row rendered —
   *  the reveal did not reach the target and the tree says so where it
   *  stopped. Idempotent: the path already revealed (or a reveal to it
   *  in flight) is a no-op. Every step rides the {tabId, generation,
   *  bindingId} discipline (rules 2 and 3): a reveal in flight when the
   *  origin changes must drop, never paint. */
  function revealPath(targetPath: string): void {
    const r = untrack(root)
    if (r === null) return
    if (targetPath === revealTarget() || targetPath === pendingReveal) return
    const ctx = captureCtx()
    if (ctx === null) return
    // The target must sit under the root. The root is the filesystem
    // root, so in practice every absolute cwd does; the guard is the
    // walk's honesty about a path it cannot reach. (The '/' case below
    // is the only one the panel reaches; the general form stays honest
    // if a provider ever answers a different root.)
    const under = r.path === '/' ? targetPath.startsWith('/') : targetPath.startsWith(r.path + '/')
    if (targetPath !== r.path && !under) return
    pendingReveal = targetPath
    const walk = ++revealWalkId
    revealing = true
    // The path segments of the target below the root, in order; empty
    // when the target IS the root (it has no row — selecting the root
    // is selecting nothing, and that is the correct answer to `cd /`).
    const rest = r.path === '/' ? targetPath.slice(1) : targetPath.slice(r.path.length + 1)
    const segments = targetPath === r.path ? [] : rest.split('/').filter((s) => s !== '')
    descend(r, segments, 0, walk)
  }

  /** One walk step. `dir` is the parent at level `i`; the child named by
   *  `segments[i]` must be found (listing the parent if necessary,
   *  paging exactly like "show next" when the child sits beyond the
   *  loaded pages) and expanded, then the walk descends into it. When
   *  `i` exhausts the segments, `dir` IS the target: select it. Every
   *  entry re-checks the walk id and the scope — a superseded walk or a
   *  changed origin drops without painting. */
  function descend(dir: FilesRoot | FilesNode, segments: string[], i: number, walk: number): void {
    if (walk !== revealWalkId) return
    const ctx = captureCtx()
    if (ctx === null || !scopeCurrent(ctx)) return
    if (i >= segments.length) {
      // The target: select it. Its own children are NOT listed —
      // selecting is not expanding, and the user expands the target
      // like any other directory.
      finishReveal(dir, walk)
      return
    }
    if (dir.state === 'tooLarge' || dir.state === 'timedOut' || dir.state === 'error') {
      // Honest stop: the level's state row is the visible "the reveal
      // did not reach the target". Nothing further is expanded.
      endWalk(walk)
      return
    }
    if (dir.state !== 'ok') {
      // Not enumerated yet (the root's first list is in flight, or the
      // directory was just expanded): list one page, then continue from
      // the committed children.
      revealList(dir, ctx, walk, () => descend(dir, segments, i, walk))
      return
    }
    const child = dir.children.find((c) => c.name === segments[i])
    if (child !== undefined) {
      // A non-directory cannot be descended into: the path ends here.
      // Asked of the kit, not re-derived: the row that draws a disclosure
      // owns what "expandable" means, and a second copy here would agree
      // everywhere anyone looked and disagree on the cyclic symlink.
      if (!isExpandable(child.kind, child.linkKind, child.cyclic === true)) {
        endWalk(walk)
        return
      }
      if (i + 1 >= segments.length) {
        // The child IS the target: select it without listing or expanding
        // it — selecting is not expanding, and the user expands the
        // target like any other directory.
        finishReveal(child, walk)
        return
      }
      // A level ON the way: expand it (never collapse — a directory the
      // user opened by hand stays open), join its path to the watch set,
      // and descend.
      if (!child.expanded) {
        child.expanded = true
        bumpTree()
        pushWatchSet()
      }
      descend(child, segments, i + 1, walk)
      return
    }
    if (dir.hasMore) {
      // The child sits beyond the loaded pages: fetch the next page and
      // look again (D10 pagination applies to the walk too — the target
      // can be the 200th entry of a level).
      revealList(dir, ctx, walk, () => descend(dir, segments, i, walk))
      return
    }
    // The level is fully listed and holds no child by that name: the
    // target does not exist under the root.
    endWalk(walk)
  }
  /** One listing step of a reveal walk: issue the page, apply it, and
   *  continue the walk only when it is still the current walk. Pages
   *  APPEND to the loaded children — the walk enumerates the directory
   *  progressively, and a later page must never discard the rows an
   *  earlier page already showed (applyListing's replace semantics are
   *  for refreshes, whose limit covers the whole displayed window; a
   *  page's limit covers only the page). The ordering guard still
   *  applies: a response superseded by a newer cycle drops, and the walk
   *  continues from whatever state the tree is in. */
  function revealList(
    dir: FilesRoot | FilesNode,
    ctx: ListCtx,
    walk: number,
    onDone: () => void,
  ): void {
    dir.busy = true
    bumpTree()
    services.list(ctx.bindingId as string, dir.path, dir.nextOffset, FILES_PAGE_SIZE).then(
      (res) => {
        if (walk !== revealWalkId) return
        if (ctx.generation < dir.appliedGeneration) {
          dir.busy = false
          bumpTree()
          onDone()
          return
        }
        if (res.state === 'ok') {
          dir.state = 'ok'
          dir.canonical = res.canonical
          dir.rev = res.rev
          dir.total = res.total
          // Dedupe by path: a refresh that slipped in mid-walk (the
          // manual header refresh supersedes by generation, but a change
          // stream notification can race the same cycle) must not
          // duplicate rows the walk already holds.
          const known = new Set(dir.children.map((c) => c.path))
          for (const e of res.entries) {
            if (!known.has(e.path)) {
              dir.children.push(entryToNode(e))
              known.add(e.path)
            }
          }
          dir.hasMore = res.hasMore
          dir.nextOffset = res.offset + res.entries.length
          dir.error = null
          dir.appliedGeneration = ctx.generation
          dir.busy = false
          bumpTree()
          onDone()
          return
        }
        // tooLarge/timedOut: apply through the same path every other
        // refusal rides, so the state row renders identically.
        applyListing(dir, ctx, res)
        onDone()
      },
      (e) => {
        if (walk !== revealWalkId) return
        applyListError(dir, ctx, e)
        onDone()
      },
    )
  }

  /** The walk reached the target: EXPAND it, then select it. Expanding is
   *  the point — `cd` into a directory is a statement about what the user
   *  is now looking at, and answering it with a closed folder they have to
   *  click makes them do the work twice. Only a node expands: the root has
   *  no row and is enumerated already, so `cd /` selects nothing, which is
   *  the right answer. Listing goes through the walk's own path so the
   *  append semantics and the walk-id guard still hold. */
  function finishReveal(dir: FilesRoot | FilesNode, walk: number): void {
    if (walk !== revealWalkId) return
    const node = 'expanded' in dir ? dir : null
    if (
      node !== null &&
      !node.expanded &&
      isExpandable(node.kind, node.linkKind, node.cyclic === true)
    ) {
      node.expanded = true
      pushWatchSet()
      // Mirrors toggle(): a directory listed once and collapsed re-opens
      // instantly; anything else needs its first page.
      if (node.state !== 'ok' || node.children.length === 0) {
        const ctx = captureCtx()
        if (ctx !== null) {
          revealList(node, ctx, walk, () => completeReveal(dir, walk))
          return
        }
      }
    }
    completeReveal(dir, walk)
  }

  /** Land the reveal: publish the target and release the walk. bumpTree so
   *  the rows recompute — the selection is derived from revealTarget, and a
   *  referentially-unchanged rows array would not re-render the row. */
  function completeReveal(dir: FilesRoot | FilesNode, walk: number): void {
    if (walk !== revealWalkId) return
    pendingReveal = null
    revealing = false
    setRevealTarget(dir.path)
    bumpTree()
  }
  /** The walk stopped before the target (a refused level, a missing
   *  child, a superseding walk): release the pending marker. What was
   *  expanded stays expanded; revealTarget stays at the last level the
   *  walk actually reached. A SUPERSEDED walk does not clear the flag —
   *  the newer walk is still revealing. */
  function endWalk(walk: number): void {
    if (walk !== revealWalkId) return
    pendingReveal = null
    revealing = false
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
    // The watch set rides the refresh cycle too: re-establishing it is
    // what recovers a failed watch, and the header refresh is the sticky
    // message's Retry. Success clears watchFailed inside pushWatchSet.
    pushWatchSet()
  }

  function dispose(): void {
    closed = true
    const b = binding()
    setOrigin(null)
    setBinding(null)
    setRoot(null)
    setPhase('no-origin')
    setOpenError(null)
    setWatchMode(null)
    setWatchDegradedReason(null)
    setWatchFailed(null)
    setRevealTarget(null)
    // Supersede any walk still in flight: closed already drops its
    // responses, and the pending marker must not suppress the next
    // scope's reveal of the same path.
    pendingReveal = null
    revealing = false
    revealWalkId++
    bumpTree()
    if (b !== null) void services.close(b.bindingId).catch(() => {})
    unsubChanged()
    unsubConnect()
  }

  /** The change stream, subscribed once for the store's whole life: the
   *  handler filters by binding, so a notification for another binding —
   *  a viewer's, or a previous scope's — is ignored. On reconnect the
   *  watch set is re-sent: the backend's dirty set is flushed to the
   *  re-attached subscriber, and re-sending the set is idempotent (the
   *  backend diffs), so a dropped socket cannot silently detach the panel
   *  from the change stream. Unsubscribed in dispose() with the binding. */
  const unsubChanged = services.subscribeFilesChanged((p) => onFilesChanged(p))
  const unsubConnect = services.onConnect(() => pushWatchSet())

  return {
    phase,
    openError,
    binding,
    origin,
    root,
    rows,
    rescope,
    toggle,
    revealPath,
    revealTarget,
    showMore,
    retry,
    refresh,
    watchMode,
    watchDegradedReason,
    watchFailed,
    relativePath: (node) => relativePathOf(untrack(root)?.path ?? null, node.path),
    dispose,
  }
}
