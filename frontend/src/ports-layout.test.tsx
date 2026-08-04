// @vitest-environment jsdom
// The row-overflow defect (nocx-wzc4.9): in the sidebar the address — the
// row's PRIMARY KEY, the thing the user came for — was truncated to
// "127.0...." while the process chip took most of the width and wrapped to
// three lines. jsdom computes no layout, so this pins what jsdom CAN see:
// the DOM source order that expresses the intent (address first, process
// second, action last), and the stylesheet's structural contract that turns
// that order into a truncation hierarchy — the secondary text and the chip
// yield BEFORE the address does (a capped share plus an ellipsis, against an
// address whose flex-basis 0 gives it a zero shrink weight).
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

/** Extract the body of the first rule whose selector matches `selectorRe`. */
function extractRuleBySelector(css: string, selectorRe: RegExp): string | null {
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
    if (selectorRe.test(css.slice(i, open))) return css.slice(open + 1, j - 1)
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
  it('orders address, process chip, then the action icon', async () => {
    const services = fakeServices(6768)
    const root = document.createElement('div')
    document.body.append(root)
    render(
      () => (
        <PortsPanel
          profileId={() => 'ssh:p1:1'}
          services={services}
          visible={() => true}
          pause={createPortsPauseControl(services, () => 'ssh:p1:1')}
        />
      ),
      { container: root },
    )
    await waitFor(() => expect(root.querySelector('.ports-row__main')).not.toBeNull())
    const main = root.querySelector<HTMLElement>('.ports-row__main') as HTMLElement
    const order = [...main.children]
    const addr = order.find((el) => el.classList.contains('ports-row__addr'))
    const chip = order.find((el) => el.classList.contains('ui-badge'))
    const action = order.find((el) => el.classList.contains('ui-icon-button'))
    expect(addr).toBeDefined()
    expect(chip).toBeDefined()
    expect(action).toBeDefined()
    // Flex renders source order left-to-right — this IS the intent.
    expect(order.indexOf(addr as HTMLElement)).toBeLessThan(order.indexOf(chip as HTMLElement))
    expect(order.indexOf(chip as HTMLElement)).toBeLessThan(order.indexOf(action as HTMLElement))
    root.remove()
  })

  it('the stylesheet gives the address priority and the chip a capped, truncating share', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const css: string = readFileSync(PORTS_CSS, 'utf8')
    const addr = stripComments(extractRuleBlock(css, 'ports-row__addr') ?? '')
    const dest = stripComments(extractRuleBlock(css, 'ports-row__dest') ?? '')
    const chipPlacement = stripComments(
      extractRuleBySelector(css, /\.ports-row__main\s*>\s*\.ui-badge/) ?? '',
    )
    expect(addr).not.toBe('')
    expect(dest).not.toBe('')
    expect(chipPlacement).not.toBe('')

    // The address yields LAST: flex-basis 0 gives it a zero shrink weight,
    // and it carries no cap of its own.
    expect(addr).toMatch(/flex\s*:\s*1 1 0/)
    expect(addr).toMatch(/text-overflow\s*:\s*ellipsis/)
    expect(addr).not.toMatch(/max-width/)

    // The secondary text and the chip yield FIRST: capped shares that shrink
    // to nothing before the address gives up any width.
    expect(dest).toMatch(/min-width\s*:\s*0/)
    expect(dest).toMatch(/max-width\s*:\s*40%/)
    expect(dest).toMatch(/text-overflow\s*:\s*ellipsis/)
    expect(chipPlacement).toMatch(/max-width\s*:\s*45%/)
    expect(chipPlacement).toMatch(/min-width\s*:\s*0/)
  })
})
