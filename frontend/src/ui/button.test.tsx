// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library'
import { Button, type ButtonProps } from './button'

afterEach(() => cleanup())

function subject(overrides?: Partial<ButtonProps>) {
  const props: ButtonProps = {
    onClick: vi.fn(),
    children: 'Click me',
    ...overrides,
  }
  return render(() => <Button {...props} />)
}

describe('Button', () => {
  it('renders the label text', () => {
    subject()
    expect(screen.getByText('Click me')).toBeTruthy()
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    subject({ onClick })
    fireEvent.click(screen.getByText('Click me'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('sets the class attribute', () => {
    subject({ class: 'my-btn' })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('class')).toBe('my-btn')
  })

  it('defaults type to button', () => {
    subject()
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('respects explicit type', () => {
    subject({ type: 'submit' })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('type')).toBe('submit')
  })

  it('sets disabled', () => {
    subject({ disabled: true })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('disabled')).not.toBeNull()
  })

  it('sets title', () => {
    subject({ title: 'Tooltip text' })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('title')).toBe('Tooltip text')
  })

  it('sets aria-label', () => {
    subject({ ariaLabel: 'Dismiss', children: '✕' })
    expect(screen.getByLabelText('Dismiss')).toBeTruthy()
  })
})
