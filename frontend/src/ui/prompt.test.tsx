// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prompt } from './prompt'
import { ToastHost, clearToasts, showToast } from './toast'

afterEach(() => {
  clearToasts()
  cleanup()
})

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

  // ── Keyboard: Enter submits, Escape cancels ──────────────────────────
  // A Prompt is not a `<dialog>`: the native cancel and showModal Enter
  // behaviour do not come for free. Escape comes from the overlay stack's
  // document-level handler; Enter is supplied here, with the same guards
  // Dialog uses — only a single-line input, never a textarea or a button,
  // never while an IME is composing, and only when the caller declared one.

  it('submits on Enter in a single-line field when onSubmit is passed', () => {
    const submit = vi.fn()
    render(() => (
      <Prompt open ariaLabel="Password" onSubmit={submit} onClose={() => undefined} actions={null}>
        <input type="text" />
      </Prompt>
    ))

    fireEvent.keyDown(document.querySelector('.ui-prompt input')!, { key: 'Enter' })
    expect(submit).toHaveBeenCalledOnce()
  })

  it('does not submit on Enter when no onSubmit is passed', () => {
    const submit = vi.fn()
    render(() => (
      <Prompt open ariaLabel="Password" onClose={() => undefined} actions={null}>
        <input type="text" />
      </Prompt>
    ))

    fireEvent.keyDown(document.querySelector('.ui-prompt input')!, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('leaves Enter to a textarea and to a button', () => {
    const submit = vi.fn()
    render(() => (
      <Prompt open ariaLabel="Password" onSubmit={submit} onClose={() => undefined} actions={null}>
        <textarea />
        <button type="button">Go</button>
      </Prompt>
    ))

    fireEvent.keyDown(document.querySelector('.ui-prompt textarea')!, { key: 'Enter' })
    fireEvent.keyDown(document.querySelector('.ui-prompt button')!, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('cancels on Escape, supplied by the overlay stack', () => {
    const close = vi.fn()
    const [open, setOpen] = createSignal(true)
    render(() => (
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

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    expect(document.querySelector('.ui-prompt')).toBeNull()
  })

  // ── Focus: to the field on open, back to the opener on close ────────
  // Dialog gets both from showModal(); a Prompt is a plain div and must do
  // them itself — the overlay stack records the pre-open focus for return.

  it('focuses the autofocus field when opened', () => {
    render(() => (
      <Prompt open ariaLabel="Password" onClose={() => undefined} actions={null}>
        <input type="text" />
      </Prompt>
    ))

    expect(document.activeElement).toBe(document.querySelector('.ui-prompt input'))
  })

  it('returns focus to the element that had it before opening', () => {
    vi.useFakeTimers()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const [open, setOpen] = createSignal(true)
    render(() => (
      <Prompt open={open()} ariaLabel="Password" onClose={() => setOpen(false)} actions={null}>
        <input />
      </Prompt>
    ))

    vi.runAllTimers()
    fireEvent.keyDown(document, { key: 'Escape' })
    vi.runAllTimers()

    expect(document.activeElement).toBe(opener)
    document.body.removeChild(opener)
    vi.useRealTimers()
  })

  // ── Toast visibility: the brief's question, answered in a test ───────
  // ToastHost portals into the topmost open overlay; a Prompt registers
  // itself as one (pushOverlay with its element), so a toast raised while
  // the prompt is open must render inside the prompt, not under it.

  it('hosts toasts raised while open inside the prompt overlay', async () => {
    render(() => (
      <>
        <Prompt open ariaLabel="Password" onClose={() => undefined} actions={null}>
          Secret
        </Prompt>
        <ToastHost />
      </>
    ))

    showToast({ level: 'success', message: 'Vault unlocked.' })

    await vi.waitFor(() => {
      const toast = document.querySelector('.ui-toast')
      expect(toast).toBeTruthy()
      expect(toast!.closest('.ui-prompt-overlay')).not.toBeNull()
    })
  })
})
