// The environment projection (bead nocx-u7uh.11): cwd, host, the tab title
// and the completion scope follow the ACTIVE domain (ADR-0024 §6, protocol
// §9), never ambient frontend state.
//
// A domain is opaque — the published fact carries only id and epoch, and no
// domain metadata rides the wire (decision 7: the backend authenticates, the
// renderer validates legal application transitions and can construct no
// authority of its own). So this module keeps the per-domain values the
// lane's own reports produced: an OSC 7 cwd or OSC 0/2 title is attributed
// to whichever domain is active when it arrives, and the composition root
// reads the ACTIVE domain's record. The parent's values return only when the
// parent is authentically re-activated — never on a child's close, never on
// a pop of frontend state (§9: activation is the only way a suspended domain
// returns).
//
// What a fresh domain starts with is deliberately nothing. A nested
// environment is "a place with no directory until it tells us otherwise"
// (environment-commands.ts, nocx-695k.2) — the same decision the codebase
// already made, generalised here to host and title: the child is populated
// by its OWN reports, exactly as the parent was, and a parsed command line
// never populates an authenticated domain's identity (the backend
// definitively knows what an integrated child is; the renderer does not and
// must not guess). While the lane names NO active domain — a suspended
// parent awaiting its child, or a closed child awaiting the parent's
// activation — the projection is blank: showing the parent's values over a
// gap where nobody owns the lane would name an identity that is not taking
// the keystrokes, the same class of lie this epic exists to remove.
//
// One tier stays outside the domain stack: the LANE environment — the
// session-open facts (the provider's cwd guess, the ssh binding) plus any
// report that arrives while no domain has ever been live. It is what a
// conventional terminal shows (ADR-0024 §4: no live domain, the session is
// a conventional terminal, and OSC 7 keeps its location role), and it seeds
// the root domain at establishment so the transition into integration is
// seamless. Child domains never see it.

import type { LifecycleKernel, LifecycleState } from './state'
import type { IntegrationDomain } from './domains'

/** The environment values one domain (or the lane tier) carries. Every
 *  field is derived from an authenticated fact, a session-open binding, or
 *  a report the active domain itself produced — never from a submitted
 *  command line. */
export interface DomainEnvironment {
  /** The working directory, '' when unknown (no OSC 7 yet). A nested
   *  environment is a place with no directory until it tells us otherwise. */
  cwd: string
  /** True only when cwd came from a verified OSC 7 report (AD-5): the one
   *  cwd a composition layer may hand to files.open as rootPath (D2). */
  cwdVerified: boolean
  /** The host, '' for the local machine. Only the session-open binding
   *  writes it today; a child domain has no authenticated host source and
   *  shows none until one exists. */
  host: string
  /** The ssh user of `host`, for the location line — '' for local shells. */
  user: string
  /** Whether the environment is the local machine. Inherited from the
   *  session for a fresh domain: a child's locality is not on the wire, and
   *  the completion providers keep today's session-level answer rather than
   *  inventing one (a local path must never masquerade as a remote one —
   *  the flag stays as conservative as it was, never more optimistic). */
  isLocal: boolean
  /** The OSC 0/2 program title, '' when the shell has not set one. */
  programTitle: string
}

/** A blank record — what a fresh child domain starts with, and what the
 *  lane shows while the stack holds domains but none is active. */
function blankEnvironment(isLocal: boolean): DomainEnvironment {
  return { cwd: '', cwdVerified: false, host: '', user: '', isLocal, programTitle: '' }
}

/** The domain the lane's current state names as active, or null when it
 *  names none. A desynchronized domain still holds the lane and its
 *  terminal stays visible (decision 9), so its values keep showing. */
function activeDomainOf(state: LifecycleState): IntegrationDomain | null {
  switch (state.kind) {
    case 'prompt_ready':
    case 'running':
    case 'desynchronized':
      return state.domain
    default:
      return null
  }
}

/** The domain-scoped environment projection. One instance per terminal tab
 *  (one lane). It subscribes to the lane's kernel and recomputes the view
 *  on every change; stream reports (cwd, title) are routed through
 *  recordCwd/recordTitle and land on whichever domain is active then.
 *  `onEnvironmentChange` fires only when the visible environment changed —
 *  a switch of the active domain or a write that altered the view. */
export class DomainEnvironmentProjection {
  /** Per-domain records keyed by `${id}@${epoch}`. A domain whose epoch
   *  passes is a new domain with a new record; a closed or lost domain is
   *  removed with its lane (the records are cleared when the stack empties,
   *  which is exactly when no live domain exists). */
  private readonly _records = new Map<string, DomainEnvironment>()
  /** The conventional tier: session-open facts + reports that arrived while
   *  no domain was live, and the last view folded in when the lane fell
   *  conventional (loss / reset) — the terminal keeps showing where it was
   *  while the next reports update the tier. Shown when the stack is empty,
   *  and the root domain's seed at establishment. */
  private _lane: DomainEnvironment
  private _view: DomainEnvironment
  private _unsub: (() => void) | null = null

  constructor(
    private readonly kernel: LifecycleKernel,
    private readonly onEnvironmentChange: () => void,
  ) {
    this._lane = blankEnvironment(true)
    this._view = this._lane
  }

  /** Subscribe to kernel changes and reconcile once with the current state
   *  (a no-op until the first fact or report). */
  attach(): void {
    if (this._unsub !== null) return
    this._unsub = this.kernel.onChange(() => this._reconcile())
    this._reconcile()
  }

  detach(): void {
    this._unsub?.()
    this._unsub = null
  }
  /** Replace the lane tier with the session-open facts (called at session
   *  open, and again when a session re-opens — a new session is a new lane
   *  story). Deliberately fires no change callback: the composition root
   *  applies the view itself at open, because the origin's null → live
   *  session transition must push even when the values are unchanged. The
   *  domain records are NOT cleared here: a re-opened session resets the
   *  kernel, whose onChange already drops them with the stack. */
  seedLane(env: DomainEnvironment): void {
    this._lane = env
    if (this.kernel.domainStack.length === 0) this._view = env
  }

  /** The visible environment: the active domain's record, the lane tier
   *  while no domain has ever been live (or after the lane fell back to
   *  conventional), or a blank record over a suspension/closure gap. */
  view(): DomainEnvironment {
    return this._view
  }

  /** An OSC 7 cwd report. Attributed to the active domain when the lane has
   *  one, else to the lane tier — the stream has no writer identity, and
   *  the domain that was active when the bytes arrived is the only honest
   *  attribution (ADR-0024 §1 keeps OSC 7 as render-only location metadata
   *  feeding the location chip and completion scope). */
  recordCwd(path: string): void {
    const active = activeDomainOf(this.kernel.state)
    if (active === null) {
      this._lane = { ...this._lane, cwd: path, cwdVerified: true }
    } else {
      this._records.set(this._key(active), {
        ...this._recordOf(active),
        cwd: path,
        cwdVerified: true,
      })
    }
    this._refresh()
  }

  /** An OSC 0/2 title report — attributed exactly like recordCwd. */
  recordTitle(title: string): void {
    const active = activeDomainOf(this.kernel.state)
    if (active === null) {
      this._lane = { ...this._lane, programTitle: title }
    } else {
      this._records.set(this._key(active), { ...this._recordOf(active), programTitle: title })
    }
    this._refresh()
  }

  // ── reconciliation ─────────────────────────────────────────────────────

  private _reconcile(): void {
    // An empty stack means no live domain: a conventional terminal, a lost
    // lane, or a reset. Every record belongs to a dead domain — epochs are
    // never resumed, and a new establishment is a new domain (§9, §12).
    // Clearing here keeps a closed/lost lane's values from ever leaking
    // into a NEW session's domain records, and bounds the map. The lane
    // tier folds the last view first: when the lane falls conventional the
    // terminal keeps showing where it was (exactly as the pre-projection
    // fields did through loss), and the next OSC 7 — which now has no
    // active domain and lands on the lane — updates it from there.
    if (this.kernel.domainStack.length === 0 && this._records.size > 0) {
      this._lane = { ...this._view }
      this._records.clear()
    }
    const active = activeDomainOf(this.kernel.state)
    if (active !== null && !this._records.has(this._key(active))) {
      const seed = this._seedFor(active)
      this._records.set(this._key(active), seed)
    }
    this._refresh()
  }

  /** The record a newly-seen domain starts with. The ROOT (the stack's
   *  bottom) is seeded from the lane tier — the session-open facts and
   *  anything the shell reported before integration — so the first
   *  establishment takes over seamlessly. A CHILD starts blank: nothing
   *  about it is on the wire, and a command line is not an identity. */
  private _seedFor(domain: IntegrationDomain): DomainEnvironment {
    const stack = this.kernel.domainStack
    const root = stack[0]
    if (root !== undefined && root.id === domain.id && root.epoch === domain.epoch) {
      return { ...this._lane }
    }
    return blankEnvironment(this._lane.isLocal)
  }

  private _recordOf(domain: IntegrationDomain): DomainEnvironment {
    return this._records.get(this._key(domain)) ?? blankEnvironment(this._lane.isLocal)
  }

  private _key(domain: IntegrationDomain): string {
    return `${domain.id}@${domain.epoch}`
  }

  private _refresh(): void {
    const stack = this.kernel.domainStack
    const active = activeDomainOf(this.kernel.state)
    const next =
      active !== null
        ? this._recordOf(active)
        : stack.length === 0
          ? this._lane
          : blankEnvironment(this._lane.isLocal)
    if (sameEnvironment(next, this._view)) return
    this._view = next
    this.onEnvironmentChange()
  }
}

/** Value equality over the projection fields — the view changed exactly
 *  when one of the values the composition root reads changed. */
function sameEnvironment(a: DomainEnvironment, b: DomainEnvironment): boolean {
  return (
    a.cwd === b.cwd &&
    a.cwdVerified === b.cwdVerified &&
    a.host === b.host &&
    a.user === b.user &&
    a.isLocal === b.isLocal &&
    a.programTitle === b.programTitle
  )
}
