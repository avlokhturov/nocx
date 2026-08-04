// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@solidjs/testing-library'
import { Spinner, type SpinnerProps } from './spinner'

afterEach(() => cleanup())

function subject(overrides?: Partial<SpinnerProps>) {
  const props: SpinnerProps = { label: 'Loading ports', ...overrides }
  return render(() => <Spinner {...props} />)
}

describe('Spinner', () => {
  it('renders with ui-spinner class identity', () => {
    subject()
    const el = screen.getByRole('status')
    expect(el.classList.contains('ui-spinner')).toBe(true)
  })

  it('announces the loading state with role=status and the label', () => {
    subject()
    const el = screen.getByRole('status')
    expect(el.getAttribute('aria-label')).toBe('Loading ports')
  })

  it('defaults to md size', () => {
    subject()
    expect(screen.getByRole('status').getAttribute('data-size')).toBe('md')
  })

  it('applies sm size', () => {
    subject({ size: 'sm' })
    expect(screen.getByRole('status').getAttribute('data-size')).toBe('sm')
  })

  it('is a span, not a focusable control', () => {
    subject()
    const el = screen.getByRole('status')
    expect(el.tagName).toBe('SPAN')
    expect(el.hasAttribute('tabindex')).toBe(false)
  })
})
