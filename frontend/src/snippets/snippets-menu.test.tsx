// @vitest-environment jsdom
// The toolbar menu (design §10.3, bead nocx-d346): the library, findable
// without knowing the chord. It is a kit ContextMenu and nothing else — the
// rows go through the palette's accept path, which is why this surface has
// no fire logic to test.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnippetsStore, type Snippet, type SnippetsClientLike } from './snippets-store'
import { mountSnippetsMenu } from './snippets-menu'

const SNIP = (over: Partial<Snippet> & { id: string }): Snippet => ({
  title: over.id,
  body: 'body',
  ...over,
})

function storeOf(snippets: Snippet[], over: Partial<SnippetsClientLike> = {}): SnippetsStore {
  const client: SnippetsClientLike = {
    list: vi.fn().mockResolvedValue({ snippets }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    ...over,
  }
  return new SnippetsStore(client)
}

function mount(snippets: Snippet[], over: Partial<SnippetsClientLike> = {}) {
  const store = storeOf(snippets, over)
  const onPick = vi.fn()
  const onManage = vi.fn()
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const menu = mountSnippetsMenu(parent, { store, onPick, onManage })
  return { store, onPick, onManage, menu }
}

const items = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.ui-context-menu__item'),
]
const labels = (): string[] => items().map((i) => i.textContent ?? '')

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('the snippets toolbar menu (nocx-d346)', () => {
  it('lists the library in stored order, with "Manage snippets…" last', async () => {
    const m = mount([SNIP({ id: 'b', title: 'second' }), SNIP({ id: 'a', title: 'first' })])
    m.menu.openAt(10, 10)

    await vi.waitFor(() => {
      expect(labels()).toEqual(['second', 'first', 'Manage snippets…'])
    })
    m.menu.dispose()
  })

  it('picking a row hands the snippet back — the menu itself fires nothing', async () => {
    const m = mount([SNIP({ id: 'a', title: 'deploy', body: 'kubectl' })])
    m.menu.openAt(10, 10)
    await vi.waitFor(() => {
      expect(labels()[0]).toBe('deploy')
    })

    items()[0].click()

    expect(m.onPick).toHaveBeenCalledTimes(1)
    expect(m.onPick.mock.calls[0][0]).toMatchObject({ id: 'a', body: 'kubectl' })
    expect(m.onManage).not.toHaveBeenCalled()
    m.menu.dispose()
  })

  it('"Manage snippets…" opens the settings page', async () => {
    const m = mount([SNIP({ id: 'a' })])
    m.menu.openAt(10, 10)
    await vi.waitFor(() => {
      expect(labels()).toContain('Manage snippets…')
    })

    items()[items().length - 1].click()

    expect(m.onManage).toHaveBeenCalledTimes(1)
    expect(m.onPick).not.toHaveBeenCalled()
    m.menu.dispose()
  })

  it('with the store unavailable it says the reason and offers no rows', async () => {
    const m = mount([], { list: vi.fn().mockRejectedValue(new Error('snippets not available')) })
    m.menu.openAt(10, 10)

    await vi.waitFor(() => {
      expect(labels().join(' ')).toContain('snippets not available')
    })
    // The degrade is visible AND honest: no snippet row is offered, because
    // there is no library to offer one from (§11.5).
    expect(labels()).toHaveLength(2)
    expect(labels()[labels().length - 1]).toBe('Manage snippets…')
    m.menu.dispose()
  })

  it('re-reads the library every time it opens — one store, no notification', async () => {
    const list = vi.fn().mockResolvedValue({ snippets: [SNIP({ id: 'a', title: 'one' })] })
    const m = mount([], { list })
    m.menu.openAt(10, 10)
    await vi.waitFor(() => {
      expect(labels()[0]).toBe('one')
    })
    const readsAfterFirstOpen = list.mock.calls.length

    m.menu.close()
    list.mockResolvedValue({ snippets: [SNIP({ id: 'b', title: 'two' })] })
    m.menu.openAt(10, 10)

    await vi.waitFor(() => {
      expect(labels()[0]).toBe('two')
    })
    expect(list.mock.calls.length).toBeGreaterThan(readsAfterFirstOpen)
    m.menu.dispose()
  })
})
