// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@solidjs/testing-library'
import { Toolbar, type ToolbarProps } from './toolbar'

afterEach(() => cleanup())

function subject(overrides?: Partial<ToolbarProps>) {
  const props: ToolbarProps = {
    children: 'Toolbar content',
    ...overrides,
  }
  return render(() => <Toolbar {...props} />)
}

describe('Toolbar', () => {
  it('renders children', () => {
    subject()
    expect(screen.getByText('Toolbar content')).toBeTruthy()
  })

  it('always emits its own base class, before any passthrough', () => {
    subject({ class: 'cm-header' })
    // The wrapper is a div with role="toolbar"
    const el = screen.getByRole('toolbar')
    // `ui-toolbar` is the component's identity and is not optional: the shared
    // rules in kit.css key off it, so a Toolbar that renders only the caller's
    // class is an unstyled Toolbar.
    expect(el.getAttribute('class')).toBe('ui-toolbar cm-header')
  })

  it('emits the base class with no passthrough', () => {
    subject()
    expect(screen.getByRole('toolbar').getAttribute('class')).toBe('ui-toolbar')
  })

  it('renders with toolbar role', () => {
    subject()
    expect(screen.getByRole('toolbar')).toBeTruthy()
  })

  it('sets aria-label when provided', () => {
    subject({ ariaLabel: 'Profile actions' })
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar.getAttribute('aria-label')).toBe('Profile actions')
  })

  it('renders complex children', () => {
    subject({
      children: [<h1>Title</h1>, <button>Action</button>],
    })
    expect(screen.getByText('Title')).toBeTruthy()
    expect(screen.getByText('Action')).toBeTruthy()
  })
})
