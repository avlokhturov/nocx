// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createToolCallGroup } from './tool-call-group'
import { createToolCallLine } from './tool-call-line'

const line = (tool: string): HTMLElement => createToolCallLine({ tool, effect: 'observe' })

describe('ToolCallGroup', () => {
  it('is a native disclosure that starts closed and holds the lines it was given', () => {
    const group = createToolCallGroup([line('readScreen'), line('blocks.list')])
    expect(group.el.tagName).toBe('DETAILS')
    expect(group.el.open).toBe(false)
    expect(group.el.querySelectorAll('.ui-tool-call')).toHaveLength(2)
  })

  it('counts what it holds, and names the last one so the report is still live', () => {
    const group = createToolCallGroup([line('readScreen'), line('blocks.list')])
    const summary = () => group.el.querySelector('.ui-tool-calls__summary')?.textContent ?? ''
    expect(summary()).toContain('2')
    expect(summary()).toContain('blocks.list')
    group.add(line('blocks.read'))
    expect(summary()).toContain('3')
    expect(summary()).toContain('blocks.read')
    expect(group.el.querySelectorAll('.ui-tool-call')).toHaveLength(3)
  })

  it('says what it is to a screen reader, not just how many', () => {
    const group = createToolCallGroup([line('readScreen'), line('blocks.list')])
    expect(group.el.getAttribute('aria-label')).toBe('2 tool calls')
  })

  it('refuses to be built empty — a group of nothing is a control that says nothing', () => {
    expect(() => createToolCallGroup([])).toThrow()
  })
})
