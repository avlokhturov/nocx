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
      tool: 'readScreen',
      effect: 'observe',
      resource: { kind: 'session', id: 'sess-1' },
    })
    expect(el.getAttribute('aria-label')).toBe('used readScreen on sess-1')
    expect(el.querySelector('.ui-tool-call__marker')?.getAttribute('aria-hidden')).toBe('true')
  })
})
