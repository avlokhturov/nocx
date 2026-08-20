// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { restoredBlock, bodyToHTML } from './restored-block'
import { DEFAULT_SNAPSHOT, serializeRange, serializeRangeSGR } from './serializer'
import { BufferLine, lineWith, XTERM_CM_P16 } from './test-helpers'
import { CommandSnapshotStore } from '../command-snapshot'

const S = DEFAULT_SNAPSHOT
const store = () => new CommandSnapshotStore()
const container = () => document.createElement('div')

const facts = (over: Partial<Parameters<typeof restoredBlock>[0]> = {}) => ({
  id: 1,
  command: 'make test',
  cwd: '/repo',
  location: '',
  durationMs: 1200,
  exitCode: 0,
  status: 'success' as const,
  body: 'all good',
  ...over,
})

describe('a block built from the store', () => {
  it('renders the stored rows exactly as the live path rendered them', () => {
    const lines = [
      lineWith(
        { chars: 'o', fg: 2, fgMode: XTERM_CM_P16, bgMode: 0 },
        { chars: 'k', fg: 2, fgMode: XTERM_CM_P16, bgMode: 0 },
      ),
      new BufferLine('second', false),
    ]
    const getLine = (y: number) => lines[y]
    expect(bodyToHTML(S, serializeRangeSGR(getLine, 0, 1))).toBe(serializeRange(S, getLine, 0, 1))
  })

  it('says it is restored, in the DOM a gate can read', () => {
    const el = restoredBlock(facts(), S, container, () => {}, store())
    expect(el.dataset.restored).toBe('true')
    expect(el.classList.contains('cmd-block')).toBe(true)
  })

  it('carries the command, the directory and the outcome', () => {
    const el = restoredBlock(
      facts({ exitCode: 2, status: 'failure' }),
      S,
      container,
      () => {},
      store(),
    )
    expect(el.textContent).toContain('make test')
    expect(
      el.querySelector('.cmd-block-failure, [data-status="failure"]') ?? el.outerHTML,
    ).toBeTruthy()
    expect(el.outerHTML).toContain('repo')
  })

  it('says the output is GONE when it is gone, and says nothing when there was none', () => {
    // The two states a restored block must not confuse. Retention evicts
    // bodies while their entries stay (ADR-0019 §7), so "no artifact" is a
    // hole to name; a command that printed nothing is not.
    const evicted = restoredBlock(facts({ body: null }), S, container, () => {}, store())
    expect(evicted.dataset.outputEvicted).toBe('true')
    expect(evicted.textContent).toContain('Output is no longer kept')

    const silent = restoredBlock(facts({ body: '' }), S, container, () => {}, store())
    expect(silent.dataset.outputEvicted).toBeUndefined()
    expect(silent.textContent).not.toContain('Output is no longer kept')
  })

  it('paints with the CURRENT theme, which is why the body keeps SGR', () => {
    const red = restoredBlock(facts({ body: '\u001b[31mred' }), S, container, () => {}, store())
    expect(red.outerHTML).toContain(String(S.palette[1]))
  })
})
