// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollectionRow, CollectionView } from './collection-view'

afterEach(cleanup)

describe('CollectionView', () => {
  it('composes one searchable toolbar and shared rows', () => {
    const onSearch = vi.fn()
    const { container } = render(() => (
      <CollectionView
        searchValue=""
        onSearch={onSearch}
        searchPlaceholder="Filter things"
        searchLabel="Filter things"
        actions={<button type="button">Add</button>}
        hasItems
        empty={<p>Empty</p>}
      >
        <CollectionRow info={<span>Item</span>} actions={<button type="button">Edit</button>} />
      </CollectionView>
    ))

    fireEvent.input(container.querySelector('input')!, { target: { value: 'item' } })
    expect(onSearch).toHaveBeenCalledWith('item')
    expect(container.querySelector('.ui-collection-row')?.textContent).toContain('Item')
    expect(container.querySelector('.ui-collection-view__actions')?.textContent).toBe('Add')
  })

  it('renders the supplied empty state without a list body', () => {
    const { container } = render(() => (
      <CollectionView
        searchValue=""
        onSearch={() => undefined}
        searchPlaceholder="Filter things"
        searchLabel="Filter things"
        actions={null}
        hasItems={false}
        empty={<p>No things</p>}
      >
        <span>Hidden</span>
      </CollectionView>
    ))

    expect(container.textContent).toContain('No things')
    expect(container.querySelector('.ui-collection-view__body')).toBeNull()
  })
})

describe('CollectionRow', () => {
  it('stays inert without activation: tabIndex -1, default density', () => {
    const { container } = render(() => (
      <CollectionRow info={<span>Item</span>} actions={<button type="button">Edit</button>} />
    ))
    const row = container.querySelector('.ui-collection-row') as HTMLElement
    expect(row.tabIndex).toBe(-1)
    expect(row.getAttribute('data-density')).toBe('default')
  })
  it('an activatable row is reachable and operable from the keyboard', () => {
    const onActivate = vi.fn()
    const { container } = render(() => (
      <CollectionRow info={<span>Item</span>} actions={null} onActivate={onActivate} />
    ))
    const row = container.querySelector('.ui-collection-row') as HTMLElement
    expect(row.tabIndex).toBe(0)
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(row, { key: ' ' })
    expect(onActivate).toHaveBeenCalledTimes(2)
  })

  it('a click on the row body activates it', () => {
    const onActivate = vi.fn()
    const { container } = render(() => (
      <CollectionRow info={<span>Item</span>} actions={null} onActivate={onActivate} />
    ))
    fireEvent.click(container.querySelector('.ui-collection-row__info')!)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('activating a control inside actions does not also activate the row', () => {
    const onActivate = vi.fn()
    const onEdit = vi.fn()
    const { container } = render(() => (
      <CollectionRow
        info={<span>Item</span>}
        actions={
          <button type="button" onClick={onEdit}>
            Edit
          </button>
        }
        onActivate={onActivate}
      />
    ))
    fireEvent.click(container.querySelector('button')!)
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
    // The row still activates on its own body.
    fireEvent.click(container.querySelector('.ui-collection-row__info')!)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('emits the dense variant as typed data-density', () => {
    const { container } = render(() => (
      <CollectionRow info={<span>a</span>} actions={null} density="dense" />
    ))
    expect(container.querySelector('.ui-collection-row')?.getAttribute('data-density')).toBe(
      'dense',
    )
  })

  it('reflects selection and focus as typed state', () => {
    const { container } = render(() => (
      <CollectionRow info={<span>a</span>} actions={null} selected focused />
    ))
    const row = container.querySelector('.ui-collection-row')
    expect(row?.getAttribute('data-selected')).toBe('true')
    expect(row?.getAttribute('data-focused')).toBe('true')
  })
})
