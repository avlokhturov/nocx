// SecretChip — the kit's badge wearing the atomic reference chip (ui/README
// table). Rendered by the CM6 decoration over {{secret:NAME}} (secret-chip.ts
// beside the editor) and, in the unresolved variant, over a recalled masked
// segment: the badge shape is the kit's (ui-badge), this module is the
// chip's DOM. A surface may place it and never repaint it.
//
// Two variants, one chip (the kit grows by variants, never by
// near-duplicates):
//
//   - resolved: a rendering of the REFERENCE, never of its value — the
//     document keeps `{{secret:NAME}}` verbatim (ADR-0021). The lock glyph
//     marks it as a vault secret; the name is the inventory name
//     (ADR-0016); the tone is info.
//   - unresolved: a rendering of a MASK — the block's command line after
//     the ack, and a recalled row that cannot run as written. It shows the
//     kind's human label, not a name (there is no name yet) and not the
//     value (there is no value in the renderer); the tone is warning. This
//     is what the receipt points at when a row is hovered.
export type SecretChipVariant = 'resolved' | 'unresolved'

export function createSecretChip(name: string): HTMLElement {
  return buildChip('resolved', name)
}

/** The unresolved variant: the kind label in the chip's warning tone. */
export function createSecretChipUnresolved(kindLabel: string): HTMLElement {
  return buildChip('unresolved', kindLabel)
}

function buildChip(variant: SecretChipVariant, label: string): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'ui-badge ui-secret-chip'
  chip.dataset.variant = variant
  chip.dataset.tone = variant === 'resolved' ? 'info' : 'warning'
  chip.title =
    variant === 'resolved'
      ? `secret from the vault: ${label}`
      : 'a masked secret — pick a live value to run this command'

  const lock = document.createElement('span')
  lock.className = 'ui-secret-chip__lock'
  lock.setAttribute('aria-hidden', 'true')
  lock.textContent = '\u{1F512}' // lock — the same register the cwd chip uses

  const labelEl = document.createElement('span')
  labelEl.className = 'ui-secret-chip__name'
  labelEl.textContent = label

  chip.append(lock, labelEl)
  return chip
}
