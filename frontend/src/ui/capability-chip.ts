// CapabilityChip — the kit's capability-indicator chip (nocx-4t37.2).
//
// Renders what is true about the shell right now — a label ("Native input",
// "Command blocks", "Enhanced input") plus a caret that says the chip opens
// something. The surface maps its observed capability to a label and a
// variant; the kit never imports the app, so the variant is a closed set of
// visual tones, not a domain value.
//
// Vanilla-emitted, like the floating panels it composes with: the editor is
// a DOM surface, and the rail that hosts this chip is built imperatively by
// TerminalContent.
//
// One identity family: `ui-capability-chip` + `__label`/`__caret` parts, one
// CSS file (ADR-0013 §1). Clicking is the caller's business — the chip only
// emits the click; the caller opens the popover.

export type CapabilityChipVariant = 'native' | 'blocks' | 'enhanced' | 'degraded'

export interface CapabilityChipOptions {
  /** The statement shown, e.g. "Native input". */
  label: string
  /** Visual tone: which statement is true. */
  variant: CapabilityChipVariant
  /** Disabled = the chip states the truth but opens nothing (relay-era or
   *  off-policy tabs have no action to offer). */
  disabled?: boolean
  /** Native tooltip (the state, plus why no action is available). */
  title?: string
  onClick?: () => void
}

export function createCapabilityChip(opts: CapabilityChipOptions): HTMLElement {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'ui-capability-chip'
  chip.dataset.variant = opts.variant
  if (opts.disabled) chip.disabled = true
  if (opts.title) chip.title = opts.title
  chip.setAttribute('aria-haspopup', 'menu')

  const label = document.createElement('span')
  label.className = 'ui-capability-chip__label'
  label.textContent = opts.label

  const caret = document.createElement('span')
  caret.className = 'ui-capability-chip__caret'
  caret.setAttribute('aria-hidden', 'true')

  chip.append(label, caret)
  chip.addEventListener('click', () => opts.onClick?.())
  return chip
}
