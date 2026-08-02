// @vitest-environment jsdom
// The non-modal save offer (ui/secret-offer.ts): a row that appears, never
// steals focus, and can be ignored while typing continues. Engagement is by
// click (or the field's own Enter/Escape once focused).
import { describe, it, expect, vi } from 'vitest'
import { SecretOffer } from './secret-offer'

const setup = () => {
  const callbacks = {
    onStore: vi.fn(() => Promise.resolve()),
    onDismiss: vi.fn(),
  }
  const offer = new SecretOffer(callbacks)
  const container = document.createElement('div')
  document.body.appendChild(container)
  offer.mount(container)
  return { offer, callbacks, container }
}

describe('SecretOffer', () => {
  it('show renders the kind badge, message, prefilled name and the two actions', () => {
    const { offer, container } = setup()
    offer.show({ kindLabel: 'OpenAI key', suggestedName: 'openai-key', maskedValue: 'sk-p...7890' })
    expect(offer.isVisible).toBe(true)
    const text = container.textContent ?? ''
    expect(text).toContain('OpenAI key')
    expect(text).toContain('Store this key in the vault?')
    expect(text).toContain('Store')
    expect(text).toContain('Not now')
    const input = container.querySelector<HTMLInputElement>('.ui-secret-offer__name')
    expect(input?.value).toBe('openai-key')
  })

  it('show does NOT steal focus — the next keystroke stays in the prompt (non-modal)', () => {
    const { offer, container } = setup()
    offer.show({ kindLabel: 'OpenAI key', suggestedName: 'openai-key', maskedValue: 'sk-p...7890' })
    expect(document.activeElement).not.toBe(container.querySelector('.ui-secret-offer__name'))
  })

  it('Enter in the name field stores under the typed name and hides', () => {
    const { offer, callbacks, container } = setup()
    offer.show({ kindLabel: 'OpenAI key', suggestedName: 'openai-key', maskedValue: 'sk-p...7890' })
    const input = container.querySelector<HTMLInputElement>('.ui-secret-offer__name')!
    input.value = 'my-api-key'
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(callbacks.onStore).toHaveBeenCalledWith('my-api-key')
    expect(offer.isVisible).toBe(false)
  })

  it('an empty name does not store', () => {
    const { offer, callbacks, container } = setup()
    offer.show({ kindLabel: 'OpenAI key', suggestedName: '', maskedValue: 'sk-p...7890' })
    const input = container.querySelector<HTMLInputElement>('.ui-secret-offer__name')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(callbacks.onStore).not.toHaveBeenCalled()
  })

  it('Escape in the name field dismisses and stops the key (the draft survives)', () => {
    const { offer, callbacks, container } = setup()
    offer.show({ kindLabel: 'OpenAI key', suggestedName: 'openai-key', maskedValue: 'sk-p...7890' })
    const input = container.querySelector<HTMLInputElement>('.ui-secret-offer__name')!
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(callbacks.onDismiss).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true) // never reaches the draft-clearing rescue
    expect(offer.isVisible).toBe(false)
  })

  it('Store click stores; Not now click dismisses', () => {
    const { offer, callbacks, container } = setup()
    offer.show({ kindLabel: 'OpenAI key', suggestedName: 'openai-key', maskedValue: 'sk-p...7890' })
    container.querySelector<HTMLButtonElement>('.ui-secret-offer__store')!.click()
    expect(callbacks.onStore).toHaveBeenCalledWith('openai-key')
    offer.show({ kindLabel: 'OpenAI key', suggestedName: 'openai-key', maskedValue: 'sk-p...7890' })
    container.querySelector<HTMLButtonElement>('.ui-secret-offer__dismiss')!.click()
    expect(callbacks.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a rejecting onStore leaves the offer hidden (the controller reports)', async () => {
    const { offer, callbacks } = setup()
    callbacks.onStore.mockRejectedValue(new Error('store failed'))
    offer.show({ kindLabel: 'OpenAI key', suggestedName: 'openai-key', maskedValue: 'sk-p...7890' })
    const input = offer.root.querySelector<HTMLInputElement>('.ui-secret-offer__name')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(offer.isVisible).toBe(false)
  })
})
