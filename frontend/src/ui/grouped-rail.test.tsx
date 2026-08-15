// @vitest-environment jsdom
/**
 * GroupedRail — the settings rail with group headings (nocx-dgsp).
 *
 * The kit's grouped navigation rail: group headings in catalogue order with
 * their items beneath, and ungrouped items at top level beside the groups.
 * The surface resolves WHICH item goes in WHICH group; this component only
 * renders the structure. A page naming a group the catalogue does not
 * declare throws — it must fail, never render silently at top level.
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import {
  GroupedRail,
  type GroupedRailProps,
  type GroupedRailItem,
  type GroupedRailGroup,
} from './grouped-rail'

afterEach(() => cleanup())

const GROUPS: GroupedRailGroup[] = [
  { id: 'assistant', title: 'Assistant', order: 0 },
  { id: 'application', title: 'Application', order: 1 },
  { id: 'developer', title: 'Developer', order: 2 },
]

function item(over: Partial<GroupedRailItem>): GroupedRailItem {
  return { id: 'x', title: 'X', active: () => false, onSelect: () => {}, ...over }
}

function subject(overrides?: Partial<GroupedRailProps>) {
  const props: GroupedRailProps = {
    label: 'Settings sections',
    groups: GROUPS,
    items: [],
    ...overrides,
  }
  return render(() => <GroupedRail {...props} />)
}

describe('GroupedRail', () => {
  it('renders ungrouped items at top level, before the groups', () => {
    subject({ items: [item({ id: 'connections', title: 'Connections' })] })
    const list = document.querySelector('.ui-grouped-nav__list')!
    const first = list.querySelector(':scope > li') as HTMLElement
    expect(first.classList.contains('ui-grouped-nav__item')).toBe(true)
    expect(first.textContent).toContain('Connections')
    expect(list.querySelectorAll('.ui-grouped-nav__group').length).toBe(3)
  })

  it('renders group headings in catalogue order with their items beneath', () => {
    subject({
      groups: [
        { id: 'application', title: 'Application', order: 1 },
        { id: 'assistant', title: 'Assistant', order: 0 },
      ],
      items: [
        item({ id: 'endpoints', title: 'Endpoints', groupId: 'assistant' }),
        item({ id: 'backup', title: 'Backup & Restore', groupId: 'application' }),
      ],
    })
    const groups = Array.from(document.querySelectorAll<HTMLElement>('.ui-grouped-nav__group'))
    // Ordered by the order field, not by array order; vault is not declared
    // in this catalogue, so its member must throw — see the throw test.
    expect(groups.length).toBe(2)
    expect(groups[0].dataset.group).toBe('assistant')
    expect(groups[1].dataset.group).toBe('application')
    const headings = Array.from(document.querySelectorAll('.ui-grouped-nav__heading')).map(
      (h) => h.textContent,
    )
    expect(headings).toEqual(['Assistant', 'Application'])
    expect(groups[0].textContent).toContain('Endpoints')
    expect(groups[0].textContent).not.toContain('Backup & Restore')
  })

  it('marks the active item and fires onSelect from the row button', () => {
    const onSelect = vi.fn()
    subject({
      items: [
        item({
          id: 'secrets',
          title: 'Secrets',
          groupId: 'assistant',
          active: () => true,
          onSelect,
        }),
      ],
    })
    const row = document.querySelector<HTMLElement>('[data-item="secrets"]')!
    expect(row.getAttribute('data-selected')).toBe('true')
    ;(row.querySelector('button') as HTMLButtonElement).click()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('does not mark a non-active item selected', () => {
    subject({ items: [item({ id: 'idle', title: 'Idle', groupId: 'assistant' })] })
    const row = document.querySelector<HTMLElement>('[data-item="idle"]')!
    expect(row.hasAttribute('data-selected')).toBe(false)
  })

  it('renders the count badge only when the count is positive', () => {
    subject({
      items: [
        item({ id: 'a', title: 'A', groupId: 'application', count: () => 2 }),
        item({ id: 'b', title: 'B', groupId: 'application', count: () => 0 }),
      ],
    })
    const badges = document.querySelectorAll('.ui-grouped-nav__item .ui-badge')
    expect(badges.length).toBe(1)
    expect(badges[0].textContent).toBe('2')
  })

  it('throws when an item names a group the catalogue does not declare', () => {
    expect(() =>
      subject({ items: [item({ id: 'ghost', title: 'Ghost', groupId: 'no-such-group' })] }),
    ).toThrow(/no-such-group/)
  })

  it('renders a declared group even when it has no members yet', () => {
    subject({
      groups: [{ id: 'vault', title: 'Vault', order: 0 }],
      items: [],
    })
    const headings = Array.from(document.querySelectorAll('.ui-grouped-nav__heading')).map(
      (h) => h.textContent,
    )
    expect(headings).toEqual(['Vault'])
  })

  it('renders the nav with the given aria-label', () => {
    subject({ label: 'Settings sections' })
    const nav = document.querySelector('.ui-grouped-nav')!
    expect(nav.getAttribute('aria-label')).toBe('Settings sections')
  })
})
