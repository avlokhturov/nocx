// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, cleanup } from '@solidjs/testing-library'
import { Section, type SectionProps } from './section'

afterEach(() => cleanup())

function subject(overrides?: Partial<SectionProps>) {
  // The spread of a Partial<union> cannot satisfy the discriminated union
  // statically (collapsible comes out `true | undefined`); the helper is
  // the fixture, and the tests pass the collapsible pair together.
  const props = {
    title: 'Terminal',
    children: 'Section body',
    ...overrides,
  } as SectionProps
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

  // The class is the component's alone: a caller cannot add to it and cannot replace
  // it. `ui-section` is what section.css keys on, so a Section carrying anything else
  // would be a Section somebody else can restyle.
  it('emits its identity and nothing else', () => {
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

  describe('divided', () => {
    it('forwards divided prop to inner Stack', () => {
      subject({ divided: true })
      const stack = document.querySelector('.ui-stack')
      expect(stack?.getAttribute('data-divided')).toBe('true')
    })

    it('omits data-divided when divided is not set', () => {
      subject()
      const stack = document.querySelector('.ui-stack')
      expect(stack?.hasAttribute('data-divided')).toBe(false)
    })
  })
})

describe('collapsible', () => {
  it('renders the title inside a disclosure button carrying aria-expanded', () => {
    subject({ collapsible: true, open: true, onToggle: () => {} })
    const button = document.querySelector<HTMLButtonElement>('.ui-section__disclosure')
    expect(button).not.toBeNull()
    expect(button?.tagName).toBe('BUTTON')
    expect(button?.type).toBe('button')
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    // The button's name is the section's title — the heading is still a
    // heading with its accessible name.
    expect(button?.textContent).toContain('Terminal')
    expect(document.querySelector('.ui-section h2')?.textContent).toContain('Terminal')
  })

  it('clicking the disclosure reports the toggle — the caller owns the state', () => {
    const onToggle = vi.fn()
    subject({ collapsible: true, open: true, onToggle })
    fireEvent.click(document.querySelector('.ui-section__disclosure') as HTMLButtonElement)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('a collapsed section hides its body and keeps the heading', () => {
    subject({ collapsible: true, open: false, onToggle: () => {} })
    const button = document.querySelector('.ui-section__disclosure')
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.ui-stack')).toBeNull()
    expect(screen.queryByText('Section body')).toBeNull()
    expect(screen.getByText('Terminal')).toBeTruthy()
  })

  it('an open section renders its body', () => {
    subject({ collapsible: true, open: true, onToggle: () => {} })
    expect(screen.getByText('Section body')).toBeTruthy()
  })

  it("the disclosure is a native button — the browser's Enter/Space activation is a click, proven with real keys in the e2e", () => {
    const onToggle = vi.fn()
    subject({ collapsible: true, open: true, onToggle })
    const button = document.querySelector('.ui-section__disclosure') as HTMLButtonElement
    // A native, focusable button: jsdom cannot synthesize the browser's
    // Enter/Space default action, so that half is proven in the e2e
    // (git-panel.spec.ts, nocx-nak2) against a real browser.
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('a non-collapsible section renders no disclosure and keeps its DOM', () => {
    subject()
    expect(document.querySelector('.ui-section__disclosure')).toBeNull()
    expect(document.querySelector('.ui-section')?.hasAttribute('data-disclosure')).toBe(false)
  })
})
