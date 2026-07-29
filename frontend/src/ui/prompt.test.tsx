// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prompt } from './prompt'

afterEach(cleanup)

describe('Prompt', () => {
  it('renders a labelled top sheet with its actions', () => {
    const { container } = render(() => (
      <Prompt
        open
        ariaLabel="Password"
        placement="top-sheet"
        onClose={() => undefined}
        actions={<button type="button">OK</button>}
      >
        <input />
      </Prompt>
    ))

    const prompt = container.querySelector('.ui-prompt')
    expect(prompt?.getAttribute('role')).toBe('dialog')
    expect(prompt?.getAttribute('aria-label')).toBe('Password')
    expect(prompt?.getAttribute('data-placement')).toBe('top-sheet')
    expect(prompt?.querySelector('.ui-prompt__actions')?.textContent).toBe('OK')
  })

  it('closes when the scrim is pressed', () => {
    const close = vi.fn()
    const [open, setOpen] = createSignal(true)
    const { container } = render(() => (
      <Prompt
        open={open()}
        ariaLabel="Password"
        onClose={() => {
          close()
          setOpen(false)
        }}
        actions={null}
      >
        Secret
      </Prompt>
    ))

    fireEvent.mouseDown(container.querySelector('.ui-prompt-overlay')!)
    expect(close).toHaveBeenCalledOnce()
    expect(container.querySelector('.ui-prompt')).toBeNull()
  })
})
