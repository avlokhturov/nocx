// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { commandFragment } from './command-text'

function html(f: DocumentFragment): string {
  const host = document.createElement('div')
  host.appendChild(f)
  return host.innerHTML
}

describe('commandFragment: one way to put a command on screen', () => {
  it('renders a vault reference as a chip and leaves the rest as text', () => {
    const out = html(commandFragment('echo {{secret:openrouter.ai}} | wc -c'))
    expect(out).toContain('ui-secret-chip')
    expect(out).toContain('openrouter.ai')
    expect(out).not.toContain('{{secret:')
    expect(out).toContain('| wc -c')
  })

  it('marks the search matches around a reference', () => {
    const out = html(commandFragment('echo {{secret:a}} tail', [{ from: 0, to: 4 }], 'm'))
    expect(out).toContain('<mark class="m">echo</mark>')
    expect(out).toContain('ui-secret-chip')
  })

  // A chip is one glyph to the reader; half of one painted as a search hit
  // is noise, so a match that falls inside a reference is dropped rather
  // than splitting the chip.
  it('drops a match that falls inside a reference', () => {
    const out = html(commandFragment('echo {{secret:abc}}', [{ from: 6, to: 12 }], 'm'))
    expect(out).not.toContain('<mark')
    expect(out).toContain('ui-secret-chip')
  })

  it('clamps an out-of-range highlight instead of reordering the text', () => {
    const out = html(commandFragment('ls -la', [{ from: 4, to: 99 }], 'm'))
    expect(out).toBe('ls -<mark class="m">la</mark>')
  })
})
