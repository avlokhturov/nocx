// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library'
import { SearchField, createSearchFieldDisplay, type SearchFieldProps } from './search-field'

afterEach(() => cleanup())

function subject(overrides?: Partial<SearchFieldProps>) {
  const props: SearchFieldProps = {
    value: '',
    onInput: vi.fn(),
    ...overrides,
  }
  return render(() => <SearchField {...props} />)
}

describe('SearchField', () => {
  it('renders a search input', () => {
    subject()
    const input = screen.getByRole('searchbox')
    expect(input).toHaveProperty('type', 'search')
  })

  it('sets the value', () => {
    subject({ value: 'font' })
    const input = screen.getByRole('searchbox')
    expect(input).toHaveProperty('value', 'font')
  })

  it('calls onInput on each keystroke', () => {
    const onInput = vi.fn()
    subject({ onInput })
    const input = screen.getByRole('searchbox')
    fireEvent.input(input, { target: { value: 'term' } })
    expect(onInput).toHaveBeenCalledWith('term')
  })

  it('sets placeholder', () => {
    subject({ placeholder: 'Search settings…' })
    const input = screen.getByPlaceholderText('Search settings…')
    expect(input).toBeTruthy()
  })

  it('sets aria-label', () => {
    subject({ ariaLabel: 'Search settings' })
    expect(screen.getByLabelText('Search settings')).toBeTruthy()
  })

  // The input used to render whatever class the caller handed it and nothing of its
  // own, so `st-search-input` WAS its identity — owned by the settings surface, for a
  // component the settings surface does not own. That is the inversion this migration
  // removes: the element that carries the appearance names itself (§3.1).
  it('names its own input', () => {
    subject()
    const input = screen.getByRole('searchbox')
    expect(input.getAttribute('class')).toBe('ui-search-field__input')
  })

  it('sets disabled attribute', () => {
    subject({ disabled: true })
    const input = screen.getByRole('searchbox')
    expect(input).toHaveProperty('disabled', true)
  })

  it('is focusable via tab', () => {
    subject()
    const input = screen.getByRole('searchbox')
    expect(input.getAttribute('tabindex')).toBeNull() // natively focusable
  })
})

describe('createSearchFieldDisplay — the kit search field as a read-only display', () => {
  it('emits the same identities as the interactive field, with a caret', () => {
    const root = createSearchFieldDisplay({ value: 'git' })
    expect(root.className).toBe('ui-search-field')
    const input = root.querySelector<HTMLElement>('.ui-search-field__input')
    expect(input).not.toBeNull()
    expect(input?.getAttribute('data-display')).toBe('true')
    expect(input?.textContent).toBe('git')
    expect(root.querySelector('.ui-search-field__icon')).not.toBeNull()
    expect(root.querySelector('.ui-search-field__caret')).not.toBeNull()
  })

  it('is not a focusable input: no input element, no tabindex', () => {
    const root = createSearchFieldDisplay({ value: 'git' })
    expect(root.querySelector('input')).toBeNull()
    expect(root.querySelector('[tabindex]')).toBeNull()
  })

  it('carries the value as text and the placeholder as data, empty marked', () => {
    const filled = createSearchFieldDisplay({ value: 'make', placeholder: 'search history' })
    const filledInput = filled.querySelector<HTMLElement>('.ui-search-field__input')
    expect(filledInput?.dataset.empty).toBeUndefined()
    expect(filledInput?.dataset.placeholder).toBe('search history')
    expect(filledInput?.getAttribute('role')).toBe('searchbox')

    const empty = createSearchFieldDisplay({ value: '', placeholder: 'search history' })
    const emptyInput = empty.querySelector<HTMLElement>('.ui-search-field__input')
    expect(emptyInput?.dataset.empty).toBe('true')
    expect(emptyInput?.textContent).toBe('') // the caret carries no text
  })
})
