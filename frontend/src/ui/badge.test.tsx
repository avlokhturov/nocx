// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@solidjs/testing-library'
import { Badge, type BadgeProps } from './badge'

afterEach(() => cleanup())

function subject(overrides?: Partial<BadgeProps>) {
  const props: BadgeProps = {
    children: 'Customized',
    ...overrides,
  }
  return render(() => <Badge {...props} />)
}

describe('Badge', () => {
  it('renders text content', () => {
    subject()
    expect(screen.getByText('Customized')).toBeTruthy()
  })

  it('renders with ui-badge class identity', () => {
    subject()
    const el = screen.getByText('Customized')
    expect(el.classList.contains('ui-badge')).toBe(true)
  })

  it('defaults to neutral tone', () => {
    subject()
    const el = screen.getByText('Customized')
    expect(el.getAttribute('data-tone')).toBe('neutral')
  })

  it('applies info tone', () => {
    subject({ tone: 'info' })
    const el = screen.getByText('Customized')
    expect(el.getAttribute('data-tone')).toBe('info')
  })

  it('applies warning tone', () => {
    subject({ tone: 'warning' })
    const el = screen.getByText('Customized')
    expect(el.getAttribute('data-tone')).toBe('warning')
  })

  it('applies danger tone', () => {
    subject({ tone: 'danger' })
    const el = screen.getByText('Customized')
    expect(el.getAttribute('data-tone')).toBe('danger')
  })

  it('is a span element', () => {
    subject()
    const el = screen.getByText('Customized')
    expect(el.tagName).toBe('SPAN')
  })

  it('opts into truncation with data-truncate', () => {
    subject({ truncate: true })
    expect(screen.getByText('Customized').getAttribute('data-truncate')).toBe('true')
  })

  it('does not truncate by default', () => {
    subject()
    expect(screen.getByText('Customized').getAttribute('data-truncate')).toBeNull()
  })
})
