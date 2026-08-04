// @vitest-environment jsdom
// The row-overflow defect (nocx-wzc4.9, reshaped in nocx-wzc4.10): in the
// sidebar the address — the row's PRIMARY KEY, the thing the user came for —
// was truncated to "127.0...." while the process took the rest of the width.
// Ranking them against each other only decided which one lost; the answer is
// that they stop competing. The address owns its own line and the process
// sits beneath it, which costs nothing because the rows were already spending
// their height on air. jsdom computes no layout, so this pins what jsdom CAN
// see: the DOM structure that expresses the intent (a stacked text column
// beside the action), and the stylesheet contract that keeps the address
// unbounded on its own line.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { PortsPanel, createPortsPauseControl, type PortsPanelServices } from './ports'
import type { PortsStatusResult } from './generated/ports.status'

declare global {
  interface ImportMeta {
    dirname?: string
  }
}

afterEach(() => cleanup())

/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                      @typescript-eslint/no-unsafe-call */
// @ts-expect-error — @types/node not installed; vitest resolves at runtime
import { readFileSync } from 'node:fs'
// @ts-expect-error — @types/node not installed; vitest resolves at runtime
import { resolve } from 'node:path'
const PORTS_CSS = resolve(import.meta.dirname ?? '.', 'styles/surfaces/ports.css')
/* eslint-enable @typescript-eslint/no-unsafe-assignment,
                       @typescript-eslint/no-unsafe-call */
function extractRuleBlock(css: string, needle: string): string | null {
  const re = new RegExp(`\\.${needle}(?![\\w-])`)
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) return null
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    if (depth !== 0) return null
    if (re.test(css.slice(i, open))) return css.slice(open + 1, j - 1)
    i = j
  }
  return null
}

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '')

// ── Fixtures (mirror ports.test.tsx) ─────────────────────────────────────

const statusFixture = (port: number): PortsStatusResult => ({
  profileId: 'ssh:p1:1',
  host: 'host.example',
  discovery: {
    state: 'available',
    listeners: [
      {
        family: 'ipv4' as const,
        address: '127.0.0.1',
        port,
        process: { evidence: 'known', name: 'node', pid: 123 },
      },
    ],
    probe: 'ss',
    probesTried: ['ss'],
    classification: '',
    stderr: '',
    lastSampleAt: null,
    paused: false,
    visible: true,
    connLost: false,
  },
  forwards: [],
})

function fakeServices(port: number): PortsPanelServices {
  const status = (): Promise<PortsStatusResult> => Promise.resolve(statusFixture(port))
  return {
    status: vi.fn(status),
    sample: vi.fn(status),
    pause: vi.fn().mockResolvedValue({}),
    visible: vi.fn().mockResolvedValue({}),
    openForward: vi.fn().mockResolvedValue({}),
    stopForward: vi.fn().mockResolvedValue({}),
  }
}

describe('the detected row keeps the address first and primary (nocx-wzc4.9)', () => {
  it('stacks the address above the process, with the action beside them', async () => {
    const services = fakeServices(6768)
    const root = document.createElement('div')
    document.body.append(root)
    // Created once, outside the JSX: Solid wraps prop expressions in getters,
    // so building it inline yields a fresh control on every read.
    const pause = createPortsPauseControl(services, () => 'ssh:p1:1')
    render(
      () => (
        <PortsPanel
          profileId={() => 'ssh:p1:1'}
          services={services}
          visible={() => true}
          pause={pause}
        />
      ),
      { container: root },
    )
    await waitFor(() => expect(root.querySelector('.ports-row__main')).not.toBeNull())
    const main = root.querySelector<HTMLElement>('.ports-row__main') as HTMLElement
    const text = main.querySelector<HTMLElement>('.ports-row__text')
    expect(text).not.toBeNull()

    // The text column holds the address and the process, in that order, so
    // neither can steal the other's width.
    const stacked = [...(text as HTMLElement).children]
    const addr = stacked.find((el) => el.classList.contains('ports-row__addr'))
    const proc = stacked.find((el) => el.classList.contains('ports-row__proc'))
    expect(addr).toBeDefined()
    expect(proc).toBeDefined()
    expect(stacked.indexOf(addr as HTMLElement)).toBeLessThan(stacked.indexOf(proc as HTMLElement))
    expect(addr?.textContent).toBe('127.0.0.1:6768')

    // A known process is a label, not a caution: quiet text, no chip.
    expect(text?.querySelector('.ui-badge')).toBeNull()
    expect(proc?.textContent).toBe('node (pid 123)')

    // The action sits beside the column, not inside it.
    const action = [...main.children].find((el) => el.classList.contains('ui-icon-button'))
    expect(action).toBeDefined()
    expect((text as HTMLElement).contains(action as HTMLElement)).toBe(false)
    root.remove()
  })

  it('the stylesheet stacks the column and leaves the address unbounded', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const css: string = readFileSync(PORTS_CSS, 'utf8')
    const text = stripComments(extractRuleBlock(css, 'ports-row__text') ?? '')
    const addr = stripComments(extractRuleBlock(css, 'ports-row__addr') ?? '')
    const proc = stripComments(extractRuleBlock(css, 'ports-row__proc') ?? '')
    expect(text).not.toBe('')
    expect(addr).not.toBe('')
    expect(proc).not.toBe('')

    // The column is what removes the competition: a flex COLUMN, so the two
    // lines never share a width. If this reverts to a row, the defect is back.
    expect(text).toMatch(/flex-direction\s*:\s*column/)
    expect(text).toMatch(/min-width\s*:\s*0/)

    // The address carries no cap and no share of anything — it has the whole
    // line. The ellipsis is a floor for a pathological address, not the norm.
    expect(addr).not.toMatch(/max-width/)
    expect(addr).not.toMatch(/flex\s*:/)
    expect(addr).toMatch(/text-overflow\s*:\s*ellipsis/)

    // The process is in the quiet register beneath it.
    expect(proc).toMatch(/text-overflow\s*:\s*ellipsis/)
    expect(proc).toMatch(/--color-text-dim/)
  })
})
