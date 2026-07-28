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

function pick(container: HTMLElement, file: File | null) {
  const input = container.querySelector('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: file === null ? [] : [file], configurable: true })
  fireEvent.change(input)
  return input
}

describe('FileInput', () => {
  it('renders the ui-file-input identity on the wrapper', () => {
    const { container } = subject()
    expect(container.querySelector('.ui-file-input')).toBeTruthy()
  })

  // The point of the rewrite: the trigger is a kit Button, not the platform's
  // own file-selector button labelled in the browser's language.
  it('draws its trigger as a kit Button', () => {
    const { container } = subject()
    const button = container.querySelector('button.ui-button')
    expect(button?.textContent).toBe('Choose file…')
  })

  it('takes a custom button label', () => {
    const { container } = subject({ buttonLabel: 'Browse…' })
    expect(container.querySelector('button.ui-button')?.textContent).toBe('Browse…')
  })

  // Hidden, not removed — a `display: none` input is out of the tab order and
  // out of the accessibility tree, which would make this mouse-only.
  it('keeps the native input in the DOM', () => {
    const { container } = subject()
    const input = container.querySelector('input[type="file"]')
    expect(input?.getAttribute('class')).toBe('ui-file-input__native')
    expect(input?.hasAttribute('hidden')).toBe(false)
  })

  it('opens the native picker when the button is clicked', () => {
    const { container } = subject()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(container.querySelector('button.ui-button')!)
    expect(click).toHaveBeenCalled()
  })

  it('accepts an accept attribute', () => {
    const { container } = subject({ accept: '.json' })
    const input = container.querySelector('input[type="file"]')
    expect(input?.getAttribute('accept')).toBe('.json')
  })

  it('calls onChange with the selected file and shows its name', () => {
    const onChange = vi.fn()
    const { container } = subject({ onChange })
    const file = new File(['{}'], 'test.json', { type: 'application/json' })
    pick(container, file)
    expect(onChange).toHaveBeenCalledWith(file)
    expect(container.querySelector('.ui-file-input__name')?.textContent).toBe('test.json')
  })

  it('calls onChange with null when no file selected', () => {
    const onChange = vi.fn()
    const { container } = subject({ onChange })
    pick(container, null)
    expect(onChange).toHaveBeenCalledWith(null)
    expect(container.querySelector('.ui-file-input__name')?.textContent).toBe('No file selected')
  })

  it('disables both the native input and the trigger', () => {
    const { container } = subject({ disabled: true })
    expect(container.querySelector('input[type="file"]')?.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('button.ui-button')?.hasAttribute('disabled')).toBe(true)
  })

  it('sets aria-label', () => {
    subject({ ariaLabel: 'Import configuration' })
    expect(screen.getByLabelText('Import configuration')).toBeTruthy()
  })
})
