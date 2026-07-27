// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library'
import { FileInput, type FileInputProps } from './file-input'

afterEach(() => cleanup())

function subject(overrides?: Partial<FileInputProps>) {
  const props: FileInputProps = {
    onChange: vi.fn(),
    ...overrides,
  }
  return render(() => <FileInput {...props} />)
}

describe('FileInput', () => {
  it('renders the ui-file-input class on the element', () => {
    const { container } = subject()
    const input = container.querySelector('input[type="file"]')
    expect(input?.getAttribute('class')).toBe('ui-file-input')
  })

  it('accepts an accept attribute', () => {
    const { container } = subject({ accept: '.json' })
    const input = container.querySelector('input[type="file"]')
    expect(input?.getAttribute('accept')).toBe('.json')
  })

  it('calls onChange with the selected file', () => {
    const onChange = vi.fn()
    const { container } = subject({ onChange })
    const input = container.querySelector('input[type="file"]')!
    const file = new File(['{}'], 'test.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [file] })
    fireEvent.change(input)
    expect(onChange).toHaveBeenCalledWith(file)
  })

  it('calls onChange with null when no file selected', () => {
    const onChange = vi.fn()
    const { container } = subject({ onChange })
    const input = container.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [] })
    fireEvent.change(input)
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('sets disabled attribute', () => {
    const { container } = subject({ disabled: true })
    const input = container.querySelector('input[type="file"]')
    expect(input?.hasAttribute('disabled')).toBe(true)
  })

  it('sets aria-label', () => {
    subject({ ariaLabel: 'Import configuration' })
    expect(screen.getByLabelText('Import configuration')).toBeTruthy()
  })
})
