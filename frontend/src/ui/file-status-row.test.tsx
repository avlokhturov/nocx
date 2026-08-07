// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStatusRow, type FileStatus } from './file-status-row'

afterEach(cleanup)

describe('FileStatusRow', () => {
  it('renders the wire status letter with the kit-decided tone for all seven statuses', () => {
    const expected: Record<FileStatus, string> = {
      M: 'warning',
      A: 'success',
      '?': 'success',
      D: 'danger',
      U: 'danger',
      R: 'info',
      C: 'info',
    }
    for (const status of Object.keys(expected) as FileStatus[]) {
      const { container, unmount } = render(() => (
        <FileStatusRow path="src/main.go" status={status} />
      ))
      const glyph = container.querySelector('.ui-file-status-row__status')
      expect(glyph?.textContent).toBe(status)
      expect(glyph?.getAttribute('data-tone')).toBe(expected[status])
      unmount()
    }
  })

  it('untracked renders as an addition, like both reference products', () => {
    const { container } = render(() => <FileStatusRow path="new.txt" status="?" />)
    expect(container.querySelector('.ui-file-status-row__status')?.getAttribute('data-tone')).toBe(
      'success',
    )
  })

  it('splits a nested path into a name and its dimmed directory', () => {
    const { container } = render(() => <FileStatusRow path="src/app/main.go" status="M" />)
    expect(container.querySelector('.ui-file-status-row__name')?.textContent).toBe('main.go')
    // No trailing slash: the directory follows the name, it does not prefix it.
    expect(container.querySelector('.ui-file-status-row__dir')?.textContent).toBe('src/app')
  })

  it('the NAME comes first and the directory after it', () => {
    // The order is the property, not a detail of it. A path rendered
    // name-last ellipsises away the file name, and a list of files under one
    // deep directory then reads as N identical rows (nocx-uf0p).
    const { container } = render(() => <FileStatusRow path="src/app/main.go" status="M" />)
    const parts = Array.from(
      container.querySelectorAll('.ui-file-status-row__name, .ui-file-status-row__dir'),
    ).map((el) => el.textContent)
    expect(parts).toEqual(['main.go', 'src/app'])
  })

  it('renders a root-level path with no directory at all', () => {
    const { container } = render(() => <FileStatusRow path="main.go" status="M" />)
    expect(container.querySelector('.ui-file-status-row__dir')).toBeNull()
    expect(container.querySelector('.ui-file-status-row__name')?.textContent).toBe('main.go')
  })

  it('the whole path stays on the title, whatever the row can show', () => {
    // The row gives up the directory before the name when it runs out of
    // width, so the title is the only place the complete path survives.
    const { container } = render(() => (
      <FileStatusRow path="graphify-out/cache/ast/v0.9.3/chunk.json" status="?" />
    ))
    expect(container.querySelector('.ui-file-status-row__path')?.getAttribute('title')).toBe(
      'graphify-out/cache/ast/v0.9.3/chunk.json',
    )
  })

  it('composes the kit CollectionRow in its dense variant', () => {
    const { container } = render(() => <FileStatusRow path="a.ts" status="A" />)
    const row = container.querySelector('.ui-collection-row')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('role')).toBe('listitem')
    expect(row?.getAttribute('data-density')).toBe('dense')
  })

  it('forwards selection and focus as typed state', () => {
    const { container } = render(() => <FileStatusRow path="a.ts" status="A" selected focused />)
    const row = container.querySelector('.ui-collection-row')
    expect(row?.getAttribute('data-selected')).toBe('true')
    expect(row?.getAttribute('data-focused')).toBe('true')
  })

  it('an activatable row is reachable and operable from the keyboard', () => {
    const onActivate = vi.fn()
    const { container } = render(() => (
      <FileStatusRow path="a.ts" status="M" onActivate={onActivate} />
    ))
    const row = container.querySelector('.ui-collection-row') as HTMLElement
    expect(row.tabIndex).toBe(0)
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(row, { key: ' ' })
    expect(onActivate).toHaveBeenCalledTimes(2)
  })

  it('activating a control inside actions does not also activate the row', () => {
    const onActivate = vi.fn()
    const onStage = vi.fn()
    const { container } = render(() => (
      <FileStatusRow
        path="a.ts"
        status="M"
        onActivate={onActivate}
        actions={
          <button type="button" onClick={onStage}>
            Stage
          </button>
        }
      />
    ))
    fireEvent.click(container.querySelector('button')!)
    expect(onStage).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('the file-type glyph is decorative; the row names the path', () => {
    render(() => <FileStatusRow path="src/a.ts" status="A" />)
    const icon = document.querySelector('.ui-file-status-row__type-icon')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    // The row's text is the status letter and the path; the glyph contributes
    // nothing to the accessible tree.
    const row = screen.getByRole('listitem')
    expect(row.textContent).toBe('Aa.tssrc')
  })

  it('the listitem is a DIRECT child of its list, so a surface can put rows in one', () => {
    // ARIA requires a listitem to be owned by its list. A wrapper element
    // around CollectionRow would sit between the two and orphan it — which is
    // exactly what a surface would then have to work around, and what a
    // reviewer would not see, because the rendered row looks identical.
    const { container } = render(() => (
      <div role="list" aria-label="Unstaged">
        <FileStatusRow path="src/a.ts" status="M" />
        <FileStatusRow path="src/b.ts" status="A" />
      </div>
    ))
    const list = container.querySelector('[role="list"]')!
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.parentElement).toBe(list)
    }
  })
})
