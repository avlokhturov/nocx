// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { createCapabilityChip } from './capability-chip'

describe('createCapabilityChip', () => {
  it('renders the label, the variant and a caret', () => {
    const chip = createCapabilityChip({ label: 'Command blocks', variant: 'blocks' })
    expect(chip.className).toBe('ui-capability-chip')
    expect(chip.dataset.variant).toBe('blocks')
    expect(chip.querySelector('.ui-capability-chip__label')?.textContent).toBe('Command blocks')
    expect(chip.querySelector('.ui-capability-chip__caret')).not.toBeNull()
    expect(chip.getAttribute('aria-haspopup')).toBe('menu')
  })

  it('emits clicks to the caller', () => {
    const onClick = vi.fn()
    const chip = createCapabilityChip({ label: 'Native input', variant: 'native', onClick })
    chip.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('is a disabled button when there is nothing to offer, with the reason as title', () => {
    const chip = createCapabilityChip({
      label: 'Native input',
      variant: 'native',
      disabled: true,
      title: 'This connection is set to never integrate (off)',
    })
    expect((chip as HTMLButtonElement).disabled).toBe(true)
    expect(chip.title).toBe('This connection is set to never integrate (off)')
    const onClick = vi.fn()
    chip.addEventListener('click', onClick)
    chip.click()
    expect(onClick).not.toHaveBeenCalled()
  })
})
