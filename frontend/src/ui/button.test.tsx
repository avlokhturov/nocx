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

  it('is natively keyboard-activatable (Enter/Space handled by browser)', () => {
    subject()
    const btn = screen.getByText('Click me')
    // Native <button> handles Enter/Space activation — test that it's a real button
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('renders base class ui-button', () => {
    subject()
    const btn = screen.getByText('Click me')
    expect(btn.classList.contains('ui-button')).toBe(true)
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

  it('sets disabled attribute', () => {
    subject({ disabled: true })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('disabled')).not.toBeNull()
  })

  it('does not call onClick when disabled', () => {
    const onClick = vi.fn()
    subject({ disabled: true, onClick })
    const btn = screen.getByText('Click me')
    btn.click()
    expect(onClick).not.toHaveBeenCalled()
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

  it('defaults data-variant to default', () => {
    subject()
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('data-variant')).toBe('default')
  })

  it('renders data-variant="primary" for primary variant', () => {
    subject({ variant: 'primary' })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('data-variant')).toBe('primary')
  })

  it('renders data-variant="danger" for danger variant', () => {
    subject({ variant: 'danger' })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('data-variant')).toBe('danger')
  })

  it('renders data-size="sm" when size is sm', () => {
    subject({ size: 'sm' })
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('data-size')).toBe('sm')
  })

  it('does not render data-size for md (default)', () => {
    subject({ size: 'md' })
    const btn = screen.getByText('Click me')
    expect(btn.hasAttribute('data-size')).toBe(false)
  })

  it('has role button for accessibility', () => {
    subject()
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('is focusable via tab', () => {
    subject()
    const btn = screen.getByText('Click me')
    expect(btn.getAttribute('tabindex')).toBeNull() // natively focusable
  })
})

// Rule 1 is enforced by the type system, not by a lint rule, and this records why
// that needed checking. Removing `class` from ButtonProps looked sufficient and was
// not: `ButtonProps & JSX.IntrinsicElements['button']` handed it straight back, and
// since `class` had also left `knownKeys` it fell into `rest` and was spread onto the
// element. The escape hatch stayed fully open while every signal said it was closed.
//
// A runtime test cannot express "this does not compile", so what it can check is the
// consequence: nothing a caller passes reaches the element's class attribute.
describe('Button — the class escape hatch is closed', () => {
  it('emits only its own identity and variant, whatever the caller does', () => {
    render(() => (
      // @ts-expect-error — `class` is omitted from the props on purpose (§3.6)
      <Button class="sneaky" onClick={() => {}}>
        Save
      </Button>
    ))
    const el = screen.getByRole('button')
    expect(el.getAttribute('class')).toBe('ui-button')
    expect(el.classList.contains('sneaky')).toBe(false)
  })
})
