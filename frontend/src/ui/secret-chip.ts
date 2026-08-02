// SecretChip — the kit's badge wearing the atomic reference chip (ui/README
// table). Rendered by the CM6 decoration over {{secret:NAME}} (secret-chip.ts
// beside the editor): the badge shape and the info tone are the kit's
// (ui-badge, data-tone), this module is the chip's DOM. A surface may place
// it and never repaint it.
//
// The chip is a rendering of the REFERENCE, never of its value: the document
// keeps `{{secret:NAME}}` verbatim — that is what gets stored, sent and
// resolved (ADR-0021). The lock glyph marks it as a vault secret; the name
// is the inventory name (ADR-0016).
export function createSecretChip(name: string): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'ui-badge ui-secret-chip'
  chip.dataset.tone = 'info'
  chip.title = `secret from the vault: ${name}`

  const lock = document.createElement('span')
  lock.className = 'ui-secret-chip__lock'
  lock.setAttribute('aria-hidden', 'true')
  lock.textContent = '\u{1F512}' // lock — the same register the cwd chip uses

  const label = document.createElement('span')
  label.className = 'ui-secret-chip__name'
  label.textContent = name

  chip.append(lock, label)
  return chip
}
