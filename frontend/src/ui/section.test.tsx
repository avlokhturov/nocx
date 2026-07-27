// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@solidjs/testing-library'
import { Section, type SectionProps } from './section'

afterEach(() => cleanup())

function subject(overrides?: Partial<SectionProps>) {
  const props: SectionProps = {
    title: 'Terminal',
    children: 'Section body',
    ...overrides,
  }
  return render(() => <Section {...props} />)
}

describe('Section', () => {
  it('renders the title as a heading', () => {
    subject()
    const heading = screen.getByText('Terminal')
    expect(heading.tagName).toBe('H2')
  })

  it('renders children', () => {
    subject()
    expect(screen.getByText('Section body')).toBeTruthy()
  })

  it('renders complex children', () => {
    subject({
      children: [<div class="st-row">Row 1</div>, <div class="st-row">Row 2</div>],
    })
    expect(screen.getByText('Row 1')).toBeTruthy()
    expect(screen.getByText('Row 2')).toBeTruthy()
  })

  // Section is a structural container, so it keeps its `class` passthrough (§3.6) —
  // but the identity comes first and is not optional. A caller's class riding along
  // is placement; the component's own class is what section.css keys on, and a
  // Section that emitted only the caller's class would be an unstyled Section.
  it('emits its identity first, with the passthrough after it', () => {
    subject({ class: 'st-section' })
    const el = document.querySelector('section')
    expect(el?.getAttribute('class')).toBe('ui-section st-section')
  })

  it('emits its identity with no passthrough', () => {
    subject()
    expect(document.querySelector('section')?.getAttribute('class')).toBe('ui-section')
  })

  it('uses section element', () => {
    subject({ id: 'terminal-settings' })
    const section = document.querySelector('#terminal-settings')
    expect(section?.tagName).toBe('SECTION')
  })

  it('sets id for deep linking', () => {
    subject({ id: 'appearance' })
    const section = document.querySelector('#appearance')
    expect(section).not.toBeNull()
  })
})
