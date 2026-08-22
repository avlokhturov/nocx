// @vitest-environment jsdom
//
// ToolCallLine (ui/tool-call-line.ts) — the kit contract, pinned: a stable
// identity class, the effect as typed variance, the resource shown when the
// call named one and ABSENT when it did not, and never the raw arguments or
// the tool's result.
import { describe, it, expect } from 'vitest'
import { createToolCallLine } from './tool-call-line'

describe('ToolCallLine', () => {
  it('names the tool and what it touched, under the kit identity class', () => {
    const el = createToolCallLine({
      tool: 'files.read',
      effect: 'observe',
      resource: { kind: 'path', id: '/repo/a.txt' },
    })
    expect(el.classList.contains('ui-tool-call')).toBe(true)
    expect(el.querySelector('.ui-tool-call__tool')?.textContent).toBe('files.read')
    expect(el.querySelector('.ui-tool-call__resource')?.textContent).toBe('/repo/a.txt')
    // The whole value lives on the title, so nothing is only in the ellipsis.
    expect(el.querySelector('.ui-tool-call__resource')?.getAttribute('title')).toBe(
      'path: /repo/a.txt',
    )
  })

  it('carries the effect as typed variance, never as a colour the caller picked', () => {
    const read = createToolCallLine({ tool: 'files.read', effect: 'observe' })
    const destroy = createToolCallLine({ tool: 'run', effect: 'mutate-destructive' })
    expect(read.dataset.effect).toBe('observe')
    expect(destroy.dataset.effect).toBe('mutate-destructive')
    // A surface may PLACE the component and may never repaint it: nothing
    // here writes an inline style.
    expect(destroy.getAttribute('style')).toBeNull()
  })

  it('names the tool alone when the call named no resource — no placeholder', () => {
    const el = createToolCallLine({ tool: 'git.status', effect: 'observe' })
    expect(el.querySelector('.ui-tool-call__resource')).toBeNull()
    expect(el.getAttribute('aria-label')).toBe('used git.status')
  })

  it('reads as one sentence to a screen reader, with the marker out of the tree', () => {
    const el = createToolCallLine({
      tool: 'files.read',
      effect: 'observe',
      resource: { kind: 'path', id: '/repo/a.txt' },
    })
    expect(el.getAttribute('aria-label')).toBe('used files.read on /repo/a.txt')
    expect(el.querySelector('.ui-tool-call__marker')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('ToolCallLine — a session is named, never numbered (nocx-vnzek)', () => {
  it("shows the pane's own name for a session, and never the id", () => {
    const el = createToolCallLine(
      {
        tool: 'readScreen',
        effect: 'observe',
        resource: { kind: 'session', id: '9bb9a7602c27e8ba0741972c7049b54b' },
      },
      { sessionName: (id) => (id === '9bb9a7602c27e8ba0741972c7049b54b' ? 'home/dev' : null) },
    )
    const res = el.querySelector('.ui-tool-call__resource')
    expect(res?.textContent).toBe('home/dev')
    expect(el.textContent).not.toContain('9bb9a7602c27e8ba0741972c7049b54b')
    // The tooltip is paint too — the id must not survive in it.
    expect(res?.getAttribute('title')).toBe('session: home/dev')
    expect(el.getAttribute('aria-label')).toBe('used readScreen on home/dev')
  })

  it('names the tool alone when no pane can name the session — an id is not a fallback', () => {
    const el = createToolCallLine(
      { tool: 'blocks.list', effect: 'observe', resource: { kind: 'session', id: 'sess-gone' } },
      { sessionName: () => null },
    )
    expect(el.querySelector('.ui-tool-call__resource')).toBeNull()
    expect(el.textContent).not.toContain('sess-gone')
    expect(el.getAttribute('aria-label')).toBe('used blocks.list')
  })

  it('leaves a path alone — a path is the person’s own word', () => {
    const el = createToolCallLine(
      { tool: 'files.read', effect: 'observe', resource: { kind: 'path', id: '/repo/a.txt' } },
      { sessionName: () => 'home/dev' },
    )
    expect(el.querySelector('.ui-tool-call__resource')?.textContent).toBe('/repo/a.txt')
  })
})
