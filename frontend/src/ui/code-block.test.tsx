// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { clearToasts, toasts } from './toast'
import { CodeBlock } from './code-block'

afterEach(() => {
  cleanup()
  clearToasts()
})

describe('CodeBlock', () => {
  it('renders a copy control without duplicating the payload', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(
      () => (
        <CodeBlock copy={() => Promise.resolve()} ariaLabel="Payload">
          {'alpha\nbeta'}
        </CodeBlock>
      ),
      { container: host },
    )

    expect(host.querySelector('.ui-code-block')?.textContent).toBe('alpha\nbeta')
    expect(host.querySelector('[aria-label="Copy code"]')).not.toBeNull()
  })

  it('does not reserve copy-control space when no copy operation is supplied', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(() => <CodeBlock ariaLabel="Payload">alpha</CodeBlock>, { container: host })

    const wrap = host.querySelector('.ui-code-block-wrap')
    expect(wrap?.classList.contains('ui-code-block-wrap--copy')).toBe(false)
    expect(wrap?.querySelector('.ui-icon-button')).toBeNull()
  })

  it('copies the exact payload and reports success', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(
      () => (
        <CodeBlock copy={copy} ariaLabel="Payload">
          {'alpha\nbeta'}
        </CodeBlock>
      ),
      { container: host },
    )

    const button = screen.getByRole('button', { name: /copy code/i })
    fireEvent.click(button)

    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('alpha\nbeta'))
    const successToast = toasts()[toasts().length - 1]
    expect(successToast?.message).toBe('Code copied')
    expect(successToast?.level).toBe('success')
  })

  it('keeps the block usable and reports a clipboard refusal', async () => {
    const copy = vi.fn().mockRejectedValue(new Error('clipboard refused'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(
      () => (
        <CodeBlock copy={copy} ariaLabel="Payload">
          alpha
        </CodeBlock>
      ),
      { container: host },
    )

    const button = screen.getByRole('button', { name: /copy code/i })
    fireEvent.click(button)

    await vi.waitFor(() => expect(toasts().length).toBe(1))
    expect(button.getAttribute('aria-label')).toBe('Copy code')
    expect(toasts()[0].message).toBe('Could not copy code')
    expect(toasts()[0].level).toBe('danger')
  })
})
