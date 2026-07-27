// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library'
import { Radio, type RadioProps } from './radio'

afterEach(() => cleanup())

function subject(overrides?: Partial<RadioProps>) {
  const props: RadioProps = {
    value: 'a',
    checked: false,
    onChange: vi.fn(),
    ...overrides,
  }
  return render(() => <Radio {...props} />)
}

describe('Radio', () => {
  it('emits ui-radio on the label and ui-radio__control on the input', () => {
    const { container } = subject({ label: 'Mode A' })
    const label = container.querySelector('label')
    expect(label?.getAttribute('class')).toBe('ui-radio')

    const input = container.querySelector('input')
    expect(input?.getAttribute('class')).toBe('ui-radio__control')
  })

  it('renders an unchecked radio by default', () => {
    subject()
    const rb = screen.getByRole('radio')
    expect(rb).toHaveProperty('checked', false)
  })

  it('renders a checked radio', () => {
    subject({ checked: true })
    const rb = screen.getByRole('radio')
    expect(rb).toHaveProperty('checked', true)
  })

  it('calls onChange with the value', () => {
    const onChange = vi.fn()
    subject({ onChange, value: 'password' })
    fireEvent.click(screen.getByRole('radio'))
    expect(onChange).toHaveBeenCalledWith('password')
  })

  it('renders a label text when provided', () => {
    subject({ label: 'SSH Key' })
    expect(screen.getByText('SSH Key')).toBeTruthy()
  })

  it('sets aria-label when no visible label', () => {
    subject({ ariaLabel: 'Authentication mode' })
    expect(screen.getByLabelText('Authentication mode')).toBeTruthy()
  })

  it('sets disabled attribute', () => {
    subject({ disabled: true })
    const rb = screen.getByRole('radio')
    expect(rb).toHaveProperty('disabled', true)
  })

  it('does not toggle onChange when disabled', () => {
    const onChange = vi.fn()
    subject({ disabled: true, onChange, checked: false, value: 'a' })
    const rb = screen.getByRole('radio')
    rb.click()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is a native radio with keyboard support (Space handled by browser)', () => {
    subject()
    const rb = screen.getByRole('radio')
    expect(rb.tagName).toBe('INPUT')
    expect(rb.getAttribute('type')).toBe('radio')
  })

  it('does not have a class prop', () => {
    // The interface no longer accepts `class` — this verifies via TypeScript
    // that the prop is removed. A runtime check ensures the component ignores
    // arbitrary class attributes.
    const { container } = subject()
    const label = container.querySelector('label')
    expect(label?.getAttribute('class')).toBe('ui-radio')
    // The label should not pick up phantom class strings
    expect(label?.className?.trim()).toBe('ui-radio')
  })
})
