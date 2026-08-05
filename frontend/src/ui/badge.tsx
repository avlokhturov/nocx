/**
 * Badge — small inline label showing status, category or count.
 *
 * Replaces ad-hoc markup like .st-provenance, .st-section-nav-badge.
 *
 * Justified by callers:
 * - settings.ts: .st-provenance / .st-customized / .st-default (Customized/Default badge)
 * - settings.ts: .st-section-nav-badge (modified-only count)
 *
 * Per §3.1: class="ui-badge" always, variance on data-tone.
 */

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface BadgeProps {
  children: string
  tone?: BadgeTone
  /** The chip yields to its row (nocx-wzc4.9): it ellipsizes instead of
   *  wrapping or pushing the row. The row places it (a bounded flex share);
   *  this variance is the ellipsis itself. */
  truncate?: boolean
}

export function Badge(props: BadgeProps) {
  return (
    <span
      class="ui-badge"
      data-tone={props.tone ?? 'neutral'}
      data-truncate={props.truncate === true ? 'true' : undefined}
    >
      {props.children}
    </span>
  )
}
