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

  // `ui-toolbar` is the component's identity and is the whole of it: toolbar.css keys
  // off it, and a caller can neither add to it nor replace it.
  it('emits its identity and nothing else', () => {
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
