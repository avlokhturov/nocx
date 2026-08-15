// @vitest-environment jsdom
/**
 * Caption — the kit's group-caption register (nocx-dgsp).
 *
 * Identity is asserted the kit's way: the stable base class on the element
 * that carries the appearance. The register itself (uppercase, letter-spaced,
 * semibold, small, muted) lives in caption.css — this test pins that the
 * component emits the identity the register is attached to, so a surface
 * composing it gets the vocabulary rather than a fifth private copy.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { Caption } from './caption'

afterEach(() => cleanup())

describe('Caption', () => {
  it('renders the kit caption identity on the text element', () => {
    render(() => <Caption>Group</Caption>)
    const el = document.querySelector('.ui-caption') as HTMLElement
    expect(el).not.toBeNull()
    expect(el.tagName).toBe('SPAN')
    expect(el.textContent).toBe('Group')
  })
})
