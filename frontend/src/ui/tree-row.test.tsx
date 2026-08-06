// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TreeRow } from './tree-row'

afterEach(cleanup)

describe('TreeRow', () => {
  it('renders a row at a depth with the name visible', () => {
    const { container } = render(() => (
      <TreeRow name="src" depth={2} kind="dir" onToggle={() => undefined} />
    ))
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-depth')).toBe('2')
    expect(row?.getAttribute('aria-level')).toBe('3')
    expect(row?.textContent).toContain('src')
  })

  it('offers a keyboard-operable disclosure for a directory and announces its expanded state', () => {
    const onToggle = vi.fn()
    const { container } = render(() => (
      <TreeRow name="src" depth={0} kind="dir" expanded onToggle={onToggle} />
    ))
    const disclosure = container.querySelector('.ui-tree-row__disclosure')
    expect(disclosure).not.toBeNull()
    expect(disclosure?.tagName).toBe('BUTTON')
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true')
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-disclosure')).toBe('expanded')
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(disclosure!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('a collapsed directory announces collapsed and its disclosure activates the callback', () => {
    const onToggle = vi.fn()
    const { container } = render(() => (
      <TreeRow name="src" depth={0} kind="dir" onToggle={onToggle} />
    ))
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-disclosure')).toBe('collapsed')
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(container.querySelector('.ui-tree-row__disclosure')!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('renders no disclosure for a file', () => {
    const { container } = render(() => <TreeRow name="main.ts" depth={1} kind="regular" />)
    const row = container.querySelector('.ui-tree-row')
    expect(container.querySelector('.ui-tree-row__disclosure')).toBeNull()
    expect(row?.getAttribute('data-disclosure')).toBe('leaf')
    expect(row?.getAttribute('aria-expanded')).toBeNull()
  })

  it('a symlink to a directory is expandable', () => {
    const onToggle = vi.fn()
    const { container } = render(() => (
      <TreeRow name="docs" depth={0} kind="symlink" linkKind="dir" onToggle={onToggle} />
    ))
    expect(container.querySelector('.ui-tree-row__disclosure')).not.toBeNull()
    expect(container.querySelector('.ui-tree-row')?.getAttribute('data-link-kind')).toBe('dir')
  })

  it('a cyclic symlink renders as a leaf with no disclosure, even with a toggle supplied', () => {
    const onToggle = vi.fn()
    const { container } = render(() => (
      <TreeRow name="loop" depth={0} kind="symlink" linkKind="dir" cyclic onToggle={onToggle} />
    ))
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-cyclic')).toBe('true')
    expect(container.querySelector('.ui-tree-row__disclosure')).toBeNull()
    expect(row?.getAttribute('data-disclosure')).toBe('leaf')
  })

  it('a broken symlink renders as a leaf', () => {
    const { container } = render(() => (
      <TreeRow name="gone" depth={0} kind="symlink" linkKind="other" />
    ))
    expect(container.querySelector('.ui-tree-row__disclosure')).toBeNull()
    expect(container.querySelector('.ui-tree-row')?.getAttribute('data-disclosure')).toBe('leaf')
  })

  it('an `other` entry — a FIFO, socket or device — lists and cannot be expanded', () => {
    // The wire lists these (design §5.1 Kind); mapping them to `regular` would
    // offer to open something whose read blocks forever, which is the hang the
    // openability table exists to prevent.
    const { container } = render(() => <TreeRow name="docker.sock" depth={1} kind="other" />)
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-kind')).toBe('other')
    expect(container.querySelector('.ui-tree-row__disclosure')).toBeNull()
    expect(row?.getAttribute('data-disclosure')).toBe('leaf')
    expect(row?.textContent).toContain('docker.sock')
  })

  it('renders an unreadable row instead of nothing', () => {
    const { container } = render(() => (
      <TreeRow name="secret.key" depth={0} kind="regular" disabled />
    ))
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-disabled')).toBe('true')
    expect(row?.getAttribute('aria-disabled')).toBe('true')
    expect(row?.textContent).toContain('secret.key')
  })

  it('marks a loading directory busy and disables its disclosure', () => {
    const onToggle = vi.fn()
    const { container } = render(() => (
      <TreeRow name="src" depth={0} kind="dir" busy onToggle={onToggle} />
    ))
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-busy')).toBe('true')
    const disclosure = container.querySelector('.ui-tree-row__disclosure') as HTMLButtonElement
    expect(disclosure.disabled).toBe(true)
    fireEvent.click(disclosure)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('renders the trailing badge slot', () => {
    const { container } = render(() => (
      <TreeRow name="src" depth={0} kind="dir" badge={<span>12 items</span>} />
    ))
    expect(container.querySelector('.ui-tree-row__badge')?.textContent).toBe('12 items')
  })

  it('reflects selection and focus as typed state', () => {
    const { container } = render(() => (
      <TreeRow name="a" depth={0} kind="regular" selected focused />
    ))
    const row = container.querySelector('.ui-tree-row')
    expect(row?.getAttribute('data-selected')).toBe('true')
    expect(row?.getAttribute('data-focused')).toBe('true')
    expect(row?.getAttribute('aria-selected')).toBe('true')
  })
})
