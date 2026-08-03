// @vitest-environment jsdom
//
// BlockReceipt (ui/block-receipt.ts) — the after-submit capture receipt.
// The kit contract, pinned: it appears non-modal (never steals focus), one
// row per capture with the kind badge, the masked value and an editable
// name, one primary action naming its scope, per-row drop, hover reported
// so the host can emphasise the block's chip, and the capture window
// retiring the receipt with an honest line and no actions that could fail.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlockReceipt, type BlockReceiptCapture } from './block-receipt'

function capture(overrides: Partial<BlockReceiptCapture> = {}): BlockReceiptCapture {
  return {
    captureId: 'cap_1',
    kindLabel: 'OpenAI key',
    maskedValue: 'sk-p...7890',
    suggestedName: 'openrouter.ai',
    ttlMs: 30_000,
    ...overrides,
  }
}

function mount(
  captures: BlockReceiptCapture[],
  callbacks: Partial<Parameters<typeof makeReceipt>[1]> = {},
): {
  receipt: BlockReceipt
  container: HTMLElement
  calls: {
    onSaveAll: ReturnType<typeof vi.fn>
    onDismiss: ReturnType<typeof vi.fn>
    onHover: ReturnType<typeof vi.fn>
    onExpired: ReturnType<typeof vi.fn>
    onExitReview: ReturnType<typeof vi.fn>
  }
} {
  return makeReceipt(captures, callbacks)
}

function makeReceipt(
  captures: BlockReceiptCapture[],
  callbacks: Partial<{
    onSaveAll: (rows: ReadonlyArray<{ captureId: string; name: string }>) => void
    onDismiss: (captureId: string) => void
    onHover: (captureId: string | null) => void
    onExpired: () => void
    onExitReview: () => void
  }>,
): {
  receipt: BlockReceipt
  container: HTMLElement
  calls: {
    onSaveAll: ReturnType<typeof vi.fn>
    onDismiss: ReturnType<typeof vi.fn>
    onHover: ReturnType<typeof vi.fn>
    onExpired: ReturnType<typeof vi.fn>
    onExitReview: ReturnType<typeof vi.fn>
  }
} {
  const calls = {
    onSaveAll: vi.fn(),
    onDismiss: vi.fn(),
    onHover: vi.fn(),
    onExpired: vi.fn(),
    onExitReview: vi.fn(),
  }
  const receipt = new BlockReceipt(captures, {
    onSaveAll: callbacks.onSaveAll ?? calls.onSaveAll,
    onDismiss: callbacks.onDismiss ?? calls.onDismiss,
    onHover: callbacks.onHover ?? calls.onHover,
    onExpired: callbacks.onExpired ?? calls.onExpired,
    onExitReview: callbacks.onExitReview ?? calls.onExitReview,
  })
  const container = document.createElement('div')
  container.className = 'cmd-block'
  document.body.appendChild(container)
  receipt.mount(container)
  return { receipt, container, calls }
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('BlockReceipt: the kit contract', () => {
  it('renders one row per capture with the kind badge, masked value and pre-filled name', () => {
    const { container } = mount([
      capture({
        captureId: 'cap_1',
        kindLabel: 'OpenAI key',
        maskedValue: 'sk-p...7890',
        suggestedName: 'openrouter.ai',
      }),
      capture({
        captureId: 'cap_2',
        kindLabel: 'GitHub token',
        maskedValue: 'ghp...abcd',
        suggestedName: 'github-pat',
      }),
    ])
    const rows = container.querySelectorAll('.ui-block-receipt__row')
    expect(rows.length).toBe(2)
    const first = rows[0]
    expect(first.querySelector('.ui-badge')?.textContent).toBe('OpenAI key')
    expect(first.querySelector('.ui-block-receipt__value')?.textContent).toBe('sk-p...7890')
    const input = first.querySelector<HTMLInputElement>('.ui-text-field__input')
    expect(input?.value).toBe('openrouter.ai')
  })

  it('the primary action names its scope: Save for one row, Save 2 for two', () => {
    const one = mount([capture()])
    expect(one.container.querySelector('.ui-block-receipt__primary')?.textContent).toBe('Save')
    const two = mount([capture(), capture({ captureId: 'cap_2' })])
    expect(two.container.querySelector('.ui-block-receipt__primary')?.textContent).toBe('Save 2')
  })

  it('showing never steals focus: no element is focused on mount', () => {
    mount([capture()])
    expect(document.activeElement).not.toBe(document.querySelector('.ui-text-field__input'))
  })

  it('the primary action hands over every row still in play with the CURRENT names', () => {
    const { container, calls } = mount([capture(), capture({ captureId: 'cap_2' })])
    const inputs = container.querySelectorAll<HTMLInputElement>('.ui-text-field__input')
    inputs[0].value = 'edited-name'
    container.querySelector<HTMLButtonElement>('.ui-block-receipt__primary')!.click()
    expect(calls.onSaveAll).toHaveBeenCalledWith([
      { captureId: 'cap_1', name: 'edited-name' },
      { captureId: 'cap_2', name: 'openrouter.ai' },
    ])
  })

  it('a clean save removes exactly that row and relabels the primary action', () => {
    const { receipt, container } = mount([capture(), capture({ captureId: 'cap_2' })])
    receipt.removeRow('cap_1')
    expect(container.querySelectorAll('.ui-block-receipt__row').length).toBe(1)
    expect(container.querySelector('.ui-block-receipt__primary')?.textContent).toBe('Save')
  })

  it('a failed save reports on the row and keeps it', () => {
    const { receipt, container } = mount([capture()])
    receipt.markFailed('cap_1', 'could not save — try again')
    expect(container.querySelector('.ui-block-receipt__row-error')?.textContent).toContain(
      'could not save',
    )
    expect(container.querySelectorAll('.ui-block-receipt__row').length).toBe(1)
  })

  it('the drop control reports the capture id', () => {
    const { container, calls } = mount([capture(), capture({ captureId: 'cap_2' })])
    container.querySelectorAll<HTMLButtonElement>('.ui-block-receipt__drop')[1].click()
    expect(calls.onDismiss).toHaveBeenCalledWith('cap_2')
  })

  it('hover reports the row under the pointer, and leaving reports null', () => {
    const { container, calls } = mount([capture(), capture({ captureId: 'cap_2' })])
    const rows = container.querySelectorAll<HTMLElement>('.ui-block-receipt__row')
    rows[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    expect(calls.onHover).toHaveBeenLastCalledWith('cap_1')
    rows[0].dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    expect(calls.onHover).toHaveBeenLastCalledWith(null)
  })

  it('⌘S inside the receipt performs the primary action; ⇧⌘S does too', () => {
    const { container, calls } = mount([capture()])
    const input = container.querySelector<HTMLInputElement>('.ui-text-field__input')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }),
    )
    expect(calls.onSaveAll).toHaveBeenCalledTimes(1)
  })

  it('Escape inside the receipt returns focus to the editor', () => {
    const { container, calls } = mount([capture()])
    const input = container.querySelector<HTMLInputElement>('.ui-text-field__input')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(calls.onExitReview).toHaveBeenCalledTimes(1)
  })

  it('⇧⌘S review mode focuses the first name field', () => {
    const { receipt, container } = mount([capture(), capture({ captureId: 'cap_2' })])
    receipt.enterReview()
    expect(document.activeElement).toBe(container.querySelector('.ui-text-field__input'))
  })

  it('after ttlMs the receipt retires itself: the honest line, no actions that could fail', () => {
    vi.useFakeTimers()
    const { container, calls } = mount([capture({ ttlMs: 100 })])
    vi.advanceTimersByTime(150)
    expect(calls.onExpired).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.ui-block-receipt__expired')).not.toBeNull()
    expect(container.querySelector('.ui-block-receipt__row')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('no longer held')
  })

  it('after expiry the primary action is a no-op: no row is handed over', () => {
    vi.useFakeTimers()
    const { receipt, container, calls } = mount([capture({ ttlMs: 100 })])
    vi.advanceTimersByTime(150)
    container.querySelectorAll('button').forEach((b) => b.click())
    receipt.saveAll()
    expect(calls.onSaveAll).not.toHaveBeenCalled()
  })
})
