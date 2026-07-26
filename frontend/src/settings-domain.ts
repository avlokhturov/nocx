/**
 * settings-domain — framework‑neutral settings domain transitions.
 *
 * Three pieces of domain logic extracted from settings.ts:
 *   1. Draft preservation on rejected save.
 *   2. Provenance‑based reset.
 *   3. Snapshot revision policy (AD-7 model: authority encoded in the type).
 *
 * No DOM dependency, no Solid import. Pure functions and branded types only.
 *
 * AD-7 model: AcceptedSnapshot can ONLY be produced by
 * AcceptedSnapshot.accept(), which performs the revision check.  No code path
 * can create an "accepted" snapshot without going through the gate — the
 * private constructor enforces it at compile time.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** A raw settings snapshot from the backend, *before* revision checking. */
export interface SettingsSnapshot {
  values: Record<string, unknown>
  overridden: string[]
  revision: number
}

/**
 * An accepted settings snapshot.
 *
 * Constructible ONLY through `AcceptedSnapshot.accept()`, which enforces the
 * monotonic revision policy (incoming revision >= current).  A private
 * constructor prevents any other construction path — the brand is a compile
 * time guard that makes the authority check unavoidable.
 */
export class AcceptedSnapshot {
  /** Nominal brand — prevents construction outside this module (AD-7 pattern). */
  private readonly __brand!: 'AcceptedSnapshot'

  private constructor(
    readonly values: Record<string, unknown>,
    readonly overridden: ReadonlySet<string>,
    readonly revision: number,
  ) {}

  /**
   * Accept a snapshot if its revision is not older than the current one.
   * Returns `null` when the snapshot is stale — the caller must not overwrite
   * the local mirror with stale data.
   *
   * Policy: monotonic — `incoming.revision >= currentRevision`.
   */
  static accept(currentRevision: number, snapshot: SettingsSnapshot): AcceptedSnapshot | null {
    if (snapshot.revision < currentRevision) return null
    return new AcceptedSnapshot(
      { ...snapshot.values },
      new Set(snapshot.overridden),
      snapshot.revision,
    )
  }

  /**
   * Accept a snapshot unconditionally, ignoring the current revision.
   *
   * Used only on the reconnect path: when the backend restarts the revision
   * counter resets (it is in-memory, ADR-0011 §A.1), and a monotonic check
   * would silently drop the incoming snapshot, leaving the UI showing stale
   * data.
   *
   * This is still an authority-gated entry point — the brand ensures no
   * code can produce an AcceptedSnapshot except through `accept()` or
   * `reset()`.
   */
  static reset(snapshot: SettingsSnapshot): AcceptedSnapshot {
    return new AcceptedSnapshot(
      { ...snapshot.values },
      new Set(snapshot.overridden),
      snapshot.revision,
    )
  }
}

/** Local settings mirror — the writable frontend state. */
export interface SettingsMirror {
  values: Record<string, unknown>
  draftValues: Record<string, unknown>
  overridden: Set<string>
  errors: Record<string, string>
  revision: number
}

/** Create an empty (uninitialised) settings mirror. */
export function createMirror(): SettingsMirror {
  return {
    values: {},
    draftValues: {},
    overridden: new Set(),
    errors: {},
    revision: 0,
  }
}

// ── Save outcome ───────────────────────────────────────────────────────────

/** The result of attempting to save a single setting. */
export type SaveOutcome =
  | { kind: 'accepted'; value: unknown }
  | { kind: 'rejected'; error: string; attemptedValue: unknown }

// ── Reset decision ─────────────────────────────────────────────────────────

export type ResetReason = 'notOverridden'

export interface ResetAllowed {
  canReset: true
}

export interface ResetDenied {
  canReset: false
  reason: ResetReason
}

export type ResetDecision = ResetAllowed | ResetDenied

// ── Pure transition functions ──────────────────────────────────────────────

/**
 * Record the outcome of a save attempt against a settings mirror.
 *
 * On **accepted**: the value is written into `values`, the key is added to
 * `overridden`, and any previous draft/error for this key is cleared.
 *
 * On **rejected**: the attempted value is preserved in `draftValues` (so the
 * user can edit rather than retype), and the error is stored in `errors`.
 *
 * Returns a **new** mirror — the argument is not mutated.
 */
export function recordSaveOutcome(
  mirror: SettingsMirror,
  key: string,
  outcome: SaveOutcome,
): SettingsMirror {
  // Clone all mutable state.
  const nextValues = { ...mirror.values }
  const nextDrafts = { ...mirror.draftValues }
  const nextErrors = { ...mirror.errors }
  const nextOverridden = new Set(mirror.overridden)

  // Always clear stale per-key state before recording the outcome.
  delete nextDrafts[key]
  delete nextErrors[key]

  if (outcome.kind === 'accepted') {
    nextValues[key] = outcome.value
    nextOverridden.add(key)
  } else {
    nextErrors[key] = outcome.error
    nextDrafts[key] = outcome.attemptedValue
  }

  return {
    values: nextValues,
    draftValues: nextDrafts,
    overridden: nextOverridden,
    errors: nextErrors,
    revision: mirror.revision,
  }
}

/**
 * Determine whether a setting can be reset, based on its provenance.
 *
 * A setting is eligible for reset when its key is in the `overridden` set
 * (provenance = customized).  The calling code also guards the UI by control
 * type (secrets never render a provenance badge), but the function itself
 * decides purely on provenance data.
 *
 * Public utility: extracting this means the provenance logic is a single
 * pure function rather than embedded in DOM rendering code.  Tests prove the
 * decision is correct without a DOM.
 */
export function canResetSetting(overridden: ReadonlySet<string>, key: string): ResetDecision {
  if (!overridden.has(key)) return { canReset: false, reason: 'notOverridden' }
  return { canReset: true }
}

/**
 * Apply an accepted snapshot to produce a new settings mirror.
 *
 * Clears drafts and errors because a fresh snapshot represents the
 * authoritative server-side state — any previous in-flight edits are no
 * longer relevant.
 */
export function applyAcceptedSnapshot(snapshot: AcceptedSnapshot): SettingsMirror {
  return {
    values: { ...snapshot.values },
    draftValues: {},
    overridden: new Set(snapshot.overridden),
    errors: {},
    revision: snapshot.revision,
  }
}
