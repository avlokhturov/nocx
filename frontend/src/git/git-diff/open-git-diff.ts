// The diff surface's public seam. The panel calls openGitDiff; the surface
// itself is worker G's, and this signature is the contract between them —
// created by the coordinator before either started so both compile from the
// first minute rather than waiting on each other.

import type { PaneManager } from '../../panes'
import type { SurfaceRegistry } from '../../surface-registry'
import type { ContentDescriptor, SingletonKey, SurfaceType } from '../../pane-content'
import type { ActiveOrigin } from '../../pane-content'
import type { GitDiffSide } from '../git-client'
import { GitDiffContent, type GitDiffDeps } from './git-diff-content'

export type { GitDiffDeps }

/** Stable surface id: the registry key for this surface. */
const SURFACE_ID_GIT_DIFF = 'gitDiff'

/** Stable surface type (B.7), used in restore descriptors and deep links. */
const SURFACE_GIT_DIFF: SurfaceType = 'nocx.gitDiff' as SurfaceType

// ── Wiring (module-level, set once by the composition root) ────────────────

interface Wiring {
  readonly tm: PaneManager
  readonly deps: GitDiffDeps
}

let wiring: Wiring | null = null

/**
 * The one wiring point. Call exactly once, after the PaneManager and the
 * caller's binding registry exist.
 *
 * `deps.onBindingLiveness` must invoke its callback synchronously with the
 * binding's current state and on every later transition (the content relies
 * on the synchronous first call to decide whether to read at all).
 */
export function registerGitDiffSurface(
  registry: SurfaceRegistry,
  tm: PaneManager,
  deps: GitDiffDeps,
): void {
  wiring = { tm, deps }
  registry.register(SURFACE_ID_GIT_DIFF, {
    surfaceType: SURFACE_GIT_DIFF,
    singletonKey: null,
    factory: () => {
      throw new Error(
        `nocx: ${SURFACE_ID_GIT_DIFF} cannot be opened without a target — use openGitDiff()`,
      )
    },
    descriptor: {
      restoreDescriptor: null,
      supportsAttention: false,
      defaultTitle: '',
    },
  })
}

/**
 * Open (or focus) the diff tab for one row.
 *
 * The singletonKey is `${toplevel}:${side}:${path}` — the repository and the
 * side are part of the identity: two worktrees of one repository are
 * different tabs, and the staged and unstaged diffs of one file show
 * different things and are legitimately two tabs (design §5.4). Clicking the
 * same row twice focuses one tab — the dedup lives in PaneManager.openPane.
 *
 * restoreDescriptor is deliberately null, for the reason open-file-viewer
 * states in its own comment: nothing serialises the tab list, and adding a
 * fifth writer of a field nobody reads is a defect this repo has shipped
 * before. When tab restore grows a reader, the shape it should adopt is
 * `{type:'gitDiff', bindingId, toplevel, path, side}`.
 */
export function openGitDiff(target: GitDiffTarget): void {
  if (!wiring) {
    throw new Error('nocx: openGitDiff called before registerGitDiffSurface')
  }
  const singletonKey: SingletonKey =
    `git:${target.toplevel}:${target.side}:${target.path}` as SingletonKey
  const descriptor: ContentDescriptor = {
    surfaceType: SURFACE_GIT_DIFF,
    singletonKey,
    restoreDescriptor: null,
    supportsAttention: false,
    // The side rides the title because the two tabs of one file must be
    // distinguishable at a glance; the path because a monorepo has many
    // files of one name.
    defaultTitle: `${target.path} (${target.side})`,
  }
  wiring.tm.openPane(new GitDiffContent(target, wiring.deps), descriptor)
}

/** What a diff tab is opened for. `toplevel` is the repository, not the file:
 *  it is what makes two worktrees of one repository different tabs. `side` is
 *  part of the identity too — the staged and unstaged diffs of one file show
 *  different things and are legitimately two tabs. */
export interface GitDiffTarget {
  readonly bindingId: string
  readonly toplevel: string
  readonly path: string
  readonly side: GitDiffSide
  /** The origin the row was clicked in, FROZEN. The content answers
   *  activeOrigin() with it, so an origin-following panel treats the diff tab
   *  as the same machine and keeps its binding — and this tab's read — alive.
   *  Without it the panel sees no origin when the tab is activated, drops to
   *  its empty state, closes the binding this tab reads through, and the
   *  singletonKey then focuses a dead tab forever. FileViewerTarget carries
   *  the same field for the same reason (file-viewer-content.tsx:47). It
   *  carries cwdFollow:false: a frozen cwd is a snapshot, never a claim about
   *  where we are now. `paneId` is absent — a tab does not know its own id. */
  readonly origin: Omit<ActiveOrigin, 'paneId'> | null
}
