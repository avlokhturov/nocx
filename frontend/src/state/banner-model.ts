/**
 * banner-model — framework‑neutral clipboard banner state.
 *
 * Derived from: frontend/src/banner.tsx
 *   ClipboardBannerImpl._shown → .shown  (line 86)
 *   ClipboardBanner.shown getter → .shown  (line 32-33)
 *
 * The banner has single-bits of state: has it been shown in this session?
 * The promise-based `show()` / `_decide()` flow is entirely inside the
 * imperative implementation and is NOT modeled here.
 *
 * Authority:
 *   Shown flag  → ClipboardBannerImpl (set true on show, cleared on choice)
 *
 * Terminal render state is NOT modeled (AD-6).
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Clipboard banner state — tracks whether the banner has been shown in this
 * application session.
 *
 * Derived from: `ClipboardBanner` interface / `ClipboardBannerImpl` class
 * (banner.tsx:31-144)
 *   .shown (line 33 / line 86)
 */
export interface BannerState {
  /** True once the banner has been shown in this run. */
  readonly shown: boolean
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create the initial banner state (not yet shown). */
export function createBannerState(): BannerState {
  return { shown: false }
}

// ── Pure transition functions ───────────────────────────────────────────────

/**
 * Mark the banner as shown.
 *
 * Authority: ClipboardBannerImpl.show().
 *
 * Derived from: banner.tsx:102 (`this._shown = true`)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function showBanner(state: BannerState): BannerState {
  return { shown: true }
}

/**
 * Clear the banner shown flag.  The banner can be shown again.
 *
 * Authority: ClipboardBannerImpl._decide().
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function dismissBanner(state: BannerState): BannerState {
  return { shown: false }
}
