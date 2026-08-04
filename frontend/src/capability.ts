// Three independent axes replaced the single 'capability' value on
// 2026-08-04, after codex diagnosed the root cause of the rejected rail's
// offer-gate disagreement (nocx-atyf.1).
//
// The old model collapsed delivery path, observed shell state, and input
// presentation into one three-valued enum. A shell can emit useful markers
// while the user has deliberately selected terminal input; a shell can be
// ELIGIBLE for integration without nocx being AUTHORISED to inject it. One
// axis cannot say either thing.
//
// The action set is derived ONLY after both authorisation and technical
// eligibility are resolved — the invariant that kills the worst defect in
// what was rejected: clicking an offered action never produces a
// prerequisite-rejection message.

/** How nocx delivered (or will deliver) its hooks onto the remote host. */
export type Delivery = 'launcher' | 'in-band' | 'relay'

/** What nocx observes about the shell right now — semantic evidence, not
 *  keyboard ownership (that lives in input-state.ts). */
export type ShellState =
  | 'unsupported' // No markers have ever arrived; plain shell
  | 'eligible' // Markers arrived, shell speaks our protocol, nocx not
  // yet authorised for this destination
  | 'integrating' // In-band bootstrap is running
  | 'integrated' // Shell is fully integrated and providing markers
  | 'lost' // Markers stopped unexpectedly (nested env, broken hook)
  | 'failed' // Integration attempt failed

/** What the user sees at the prompt. */
export type InputPresentation = 'editor' | 'terminal'

/** The connection-scope launch policy (nocx-4t37.2): the default the tab's
 *  integration control starts from. auto integrates at session open; ask
 *  and off open a plain shell and leave the explicit-request path to the
 *  renderer. off refuses even the explicit path. */
export type ShellIntegrationPolicy = 'auto' | 'ask' | 'off'

/** One recovery action the UI may offer. Derived ONLY after both
 *  authorisation and technical eligibility are resolved — never disabled
 *  and never rejected at click time. */
export type RecoveryAction =
  | { kind: 'integrate'; label: string }
  | { kind: 'enable-editor'; label: string }
  | { kind: 'retry-integration'; label: string }
  | { kind: 'restore-editor'; label: string }

/** The facts the action set is derived from. Authorisation and technical
 *  eligibility are separate gates, resolved BEFORE the action set is
 *  computed. */
export interface ActionFacts {
  shellState: ShellState
  presentation: InputPresentation
  delivery: Delivery
  /** Has the user authorised nocx to own input at this destination? */
  authorized: boolean
  /** Is it technically safe for nocx to own input right now?
   *  (trusted prompt, not alt-screen, editor can show) */
  eligible: boolean
}

/**
 * Derive the actions the UI may offer.
 *
 * Returns empty when prerequisites are absent — no disabled-then-rejected
 * actions exist. The caller need only test array length to decide whether
 * a chip or menu item should appear at all.
 */
export function deriveActions(f: ActionFacts): RecoveryAction[] {
  if (!f.authorized || !f.eligible) return []

  const actions: RecoveryAction[] = []

  // A shell that has never been integrated: offer the integration path.
  if (f.shellState === 'unsupported' || f.shellState === 'eligible') {
    actions.push({ kind: 'integrate', label: 'Integrate this shell' })
    return actions
  }

  // A failed integration: offer retry.
  if (f.shellState === 'failed') {
    actions.push({ kind: 'retry-integration', label: 'Retry integration' })
    return actions
  }

  // Integrated but the user is in terminal input: offer to switch back.
  if (f.shellState === 'integrated' && f.presentation === 'terminal') {
    actions.push({ kind: 'enable-editor', label: 'Enable command editor' })
    return actions
  }

  // Markers stopped unexpectedly: offer restoration.
  if (f.shellState === 'lost') {
    actions.push({ kind: 'restore-editor', label: 'Restore command editor' })
    return actions
  }

  // Integrated + editor = healthy state: no actions.
  return actions
}

// ── Derivation helpers ─────────────────────────────────────────────────

/** Derive the observed shell state from the facts the renderer holds. */
export function deriveShellState(opts: {
  integrated: boolean
  integrating: boolean
  integrationFailed: boolean
  trusted: boolean
}): ShellState {
  if (opts.integrating) return 'integrating'
  if (opts.integrationFailed) return 'failed'
  if (!opts.integrated) return 'unsupported'
  if (!opts.trusted) return 'lost'
  return 'integrated'
}
