// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalRenderer, RenderFenceEvent } from '../renderers/types'
import { ScrollbackController } from './controller'
import { CommandSnapshotStore } from '../command-snapshot'
import type { ExecutionAttempt } from '../lifecycle/state'
import { mintDomain, type IntegrationDomain } from '../lifecycle/domains'

function makeRenderer(): TerminalRenderer {
  return {
    write: vi.fn(),
    onData: vi.fn(),
    onCommandMarker: vi.fn(),
    onBufferChange: vi.fn(),
    onTitle: vi.fn(),
    mount: vi.fn(() => Promise.resolve({ cols: 80, rows: 24 })),
    dispose: vi.fn(),
    focus: vi.fn(),
    setReadOnly: vi.fn(),
    registerMarker: vi.fn(() => undefined),
    paste: vi.fn(),
    clearViewport: vi.fn(),
    fitViewport: vi.fn(),
    // 0 = "cannot measure", which the frozen-block metric publisher treats
    // as "publish nothing" — existing tests are unaffected by the metric.
    cellWidth: 0,
    getBufferLine: vi.fn(() => null),
    cursorLine: vi.fn(() => 0),
    reset: vi.fn(),
  } as unknown as TerminalRenderer
}

function makeController() {
  const pane = document.createElement('div')
  const controller = new ScrollbackController({
    pane,
    renderer: makeRenderer(),
    snapshotStore: new CommandSnapshotStore(),
  })
  // jsdom does no layout: give the scrollback area a real height so the
  // fill-the-pane sizing has something to read.
  Object.defineProperty(controller.scrollbackArea, 'clientHeight', {
    value: 360,
    configurable: true,
  })
  return { pane, controller }
}

describe('ScrollbackController unstructured mode', () => {
  it('fills the pane for a markerless session (plain SSH before any OSC 133)', () => {
    const { controller } = makeController()
    expect(controller.mode).toBe('idle')

    controller.setUnstructured()

    expect(controller.mode).toBe('unstructured')
    expect(controller.xtermLiveContainer.className).toContain('live-unstructured')
    expect(controller.xtermLiveContainer.style.height).toBe('360px')
  })

  it('lets the first OSC-133 marker transition back to the normal layout', () => {
    const { controller } = makeController()
    controller.setUnstructured()

    // The marker arrives: PROMPT_READY collapses the live region to idle.
    controller.setIdle()

    expect(controller.mode).toBe('idle')
    expect(controller.xtermLiveContainer.className).toContain('live-idle')
  })

  it('markerless alt-screen return restores the full pane, not the hidden idle', () => {
    const { controller } = makeController()
    controller.setUnstructured()
    controller.enterFullscreen()
    expect(controller.mode).toBe('fullscreen')

    // Buffer returned to normal without any OSC-133 ever arriving: the
    // terminal must fill the pane again, not collapse.
    controller.exitFullscreen()
    controller.setUnstructured()

    expect(controller.mode).toBe('unstructured')
    expect(controller.xtermLiveContainer.className).toContain('live-unstructured')
  })
})

describe('ScrollbackController render-fence rendezvous (nocx-u7uh.8)', () => {
  const FENCE = 'ab'.repeat(32)
  const domain = mintDomain({
    lane: 'l',
    lifecycle: 'prompt_ready',
    domain: 'd1',
    epoch: 1,
  }) as IntegrationDomain

  // jsdom implements no scrollIntoView; the deferred-freeze settle scrolls
  // the finished block into view via rAF, exactly like terminal-content's
  // composition-root tests stub it.
  const protoScrollIntoView = Element.prototype.scrollIntoView?.bind(Element.prototype)
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {}
  })
  afterEach(() => {
    Element.prototype.scrollIntoView = protoScrollIntoView
  })

  function completedAttempt(fence: string): ExecutionAttempt {
    return {
      id: 'att-1',
      domain,
      state: 'completed',
      exitCode: 0,
      fence,
    }
  }

  /** A renderer that records the fence callback instead of wiring it. */
  function rendererWithFence(): {
    renderer: TerminalRenderer
    sight: (ev: RenderFenceEvent) => void
  } {
    const renderer = makeRenderer()
    let fenceCb: ((ev: RenderFenceEvent) => void) | null = null
    renderer.onRenderFence = (cb: (ev: RenderFenceEvent) => void) => {
      fenceCb = cb
    }
    return {
      renderer,
      sight: (ev) => fenceCb?.(ev),
    }
  }
  it('flips the status on the completion event and settles the boundary when the fence arrives', () => {
    const { renderer, sight } = rendererWithFence()
    const pane = document.createElement('div')
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    // The block opens at submit and binds to the published attempt.
    controller.blockManager.startBlock('make', '~', 0)
    controller.blockManager.bindAttempt('att-1')

    // The authenticated completion lands with the fence still in flight:
    // the LOGICAL freeze lands now — status flips, the running slot frees
    // — while the VISUAL boundary defers (false: the live region stays up).
    expect(controller.freezeFromAttempt(completedAttempt(FENCE), 2)).toBe(false)
    expect(controller.blockManager.runningBlock).toBeNull()
    expect(controller.blockManager.blockForAttempt('att-1')?.status).toBe('success')

    // The fence bytes land (via the renderer's OSC 1337 handler): the block
    // serializes at the fence's line and the live region settles.
    sight({ hex: FENCE, line: 5, buffer: 'normal' })
    expect(controller.blockManager.runningBlock).toBeNull()
    expect(controller.blockManager.blockForAttempt('att-1')?.status).toBe('success')
    expect(controller.blockManager.blockForAttempt('att-1')?.endLine).toBe(5)
    expect(controller.mode).toBe('idle')
  })

  it('a fence in the alternate buffer is ignored — it has no scrollback line to serialize', () => {
    const { renderer, sight } = rendererWithFence()
    const pane = document.createElement('div')
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    // jsdom implements no scrollTo; setRunning scrolls to the live end.
    controller.scrollbackArea.scrollTo = vi.fn()
    controller.blockManager.startBlock('make', '~', 0)
    controller.blockManager.bindAttempt('att-1')
    controller.setRunning() // the live region is up while the block runs
    expect(controller.freezeFromAttempt(completedAttempt(FENCE), 2)).toBe(false)

    // The status flipped on the event; the boundary is still pending. An
    // alternate-buffer fence is ignored: the pending stays and the live
    // region is NOT settled.
    sight({ hex: FENCE, line: 5, buffer: 'alternate' })
    expect(controller.blockManager.runningBlock).toBeNull()
    expect(controller.blockManager.blockForAttempt('att-1')?.status).toBe('success')
    expect(controller.mode).toBe('running')
    controller.blockManager.clearAll()
  })
  it('a second shell-originated attempt opens its own block while the first is pending its fence — no merge (nocx-m87n)', () => {
    const { renderer, sight } = rendererWithFence()
    const pane = document.createElement('div')
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    controller.scrollbackArea.scrollTo = vi.fn()
    // First shell-originated command: the running fact opens the block.
    controller.beginBlock('codex', '~', 0)
    controller.blockManager.bindAttempt('att-1')
    expect(controller.mode).toBe('running')

    // Its completion lands while the fence is still in flight: the LOGICAL
    // freeze flips the status and frees the running slot, but the VISUAL
    // boundary defers — the live region stays up (u7uh.8).
    expect(
      controller.freezeFromAttempt({ ...completedAttempt(FENCE), id: 'att-1', exitCode: 130 }, 3),
    ).toBe(false)
    expect(controller.blockManager.runningBlock).toBeNull()
    expect(controller.blockManager.blockForAttempt('att-1')?.status).toBe('failure')

    // The second shell-originated command starts while the first block's
    // boundary is still pending: a NEW block opens and owns the running
    // slot (the owner's Ctrl-C then `codex` again — keys are raw, so the
    // second command arrives through openBlock, not the editor).
    controller.beginBlock('codex', '~', 4)
    controller.blockManager.bindAttempt('att-2')
    expect(controller.blockManager.blocks).toHaveLength(2)
    expect(controller.blockManager.runningBlock?.status).toBe('running')
    expect(controller.blockManager.blockForAttempt('att-2')?.status).toBe('running')

    // The first fence lands: the first block freezes with its own exit
    // status — while the second command is still running.
    sight({ hex: FENCE, line: 3, buffer: 'normal' })
    const first = controller.blockManager.blockForAttempt('att-1')
    expect(first?.status).toBe('failure')
    expect(first?.exitCode).toBe(130)
    expect(first?.el.classList.contains('cmd-block-running')).toBe(false)
    const second = controller.blockManager.blockForAttempt('att-2')
    expect(second?.status).toBe('running')
    expect(controller.blockManager.runningBlock).toBe(second)
    // The live region belongs to the second command, not the first's tail.
    expect(controller.mode).toBe('running')
    controller.blockManager.clearAll()
  })
})

describe('the frozen block\u2019s rows leave the grid (nocx-m87n live-region window)', () => {
  // The live region is the xterm grid clipped to the box `setLiveHeight`
  // sizes. A block's rows are serialized into its DOM element at freeze,
  // but they STAY in the grid — unless the viewport is cleared at the
  // freeze boundary. On a grid that has not scrolled, the box then
  // re-displays those rows inside the running command: `ls`, its output,
  // `pwd`, its output, and only then the running command's own rows, each
  // row on screen twice (once frozen, once live). This describe block
  // pins the seam that prevents it: every freeze hands the rows to the DOM
  // and clears them from the grid, and the clear never fires while a newer
  // command owns the running slot (its rows share the buffer below the
  // frozen ones — wiping the grid would wipe its serialization window).
  const FENCE = 'ab'.repeat(32)
  const FENCE2 = 'cd'.repeat(32)
  // The fence-rendezvous describe above scopes its own renderer factory,
  // domain and attempt helper — this sibling describe needs its own.
  function rendererWithFence(): {
    renderer: TerminalRenderer
    sight: (ev: RenderFenceEvent) => void
  } {
    const renderer = makeRenderer()
    let fenceCb: ((ev: RenderFenceEvent) => void) | null = null
    renderer.onRenderFence = (cb: (ev: RenderFenceEvent) => void) => {
      fenceCb = cb
    }
    return {
      renderer,
      sight: (ev) => fenceCb?.(ev),
    }
  }
  const domain = mintDomain({
    lane: 'l',
    lifecycle: 'prompt_ready',
    domain: 'd1',
    epoch: 1,
  }) as IntegrationDomain
  function completedAttempt(fence: string): ExecutionAttempt {
    return {
      id: 'att-1',
      domain,
      state: 'completed',
      exitCode: 0,
      fence,
    }
  }

  it('clears the grid when a block freezes, so the live region never re-displays rows the DOM block owns', () => {
    const { renderer, sight } = rendererWithFence()
    const pane = document.createElement('div')
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    /* eslint-disable @typescript-eslint/unbound-method */
    const clearViewport = renderer.clearViewport
    /* eslint-enable @typescript-eslint/unbound-method */
    controller.scrollbackArea.scrollTo = vi.fn()

    // `ls` runs and finishes: the block freezes at the sighted fence line
    // and its rows leave the grid.
    controller.beginBlock('ls', '~', 0)
    controller.blockManager.bindAttempt('att-1')
    expect(controller.mode).toBe('running')
    sight({ hex: FENCE, line: 2, buffer: 'normal' })
    expect(controller.freezeFromAttempt(completedAttempt(FENCE), 2)).toBe(true)
    expect(controller.mode).toBe('idle')
    expect(clearViewport).toHaveBeenCalledTimes(1)

    // `pwd` runs and finishes the same way — a second freeze, a second clear.
    controller.beginBlock('pwd', '~', 3)
    controller.blockManager.bindAttempt('att-2')
    sight({ hex: FENCE2, line: 4, buffer: 'normal' })
    expect(controller.freezeFromAttempt({ ...completedAttempt(FENCE2), id: 'att-2' }, 4)).toBe(true)
    expect(clearViewport).toHaveBeenCalledTimes(2)

    // `codex` runs: its rows are the ONLY rows in the grid (both earlier
    // blocks were cleared at their freezes), and nothing clears mid-run.
    controller.beginBlock('codex', '~', 5)
    controller.blockManager.bindAttempt('att-3')
    expect(controller.mode).toBe('running')
    expect(clearViewport).toHaveBeenCalledTimes(2)
    controller.blockManager.clearAll()
  })

  it('a deferred freeze clears the grid only when no newer command owns the running slot', () => {
    const { renderer, sight } = rendererWithFence()
    const pane = document.createElement('div')
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    /* eslint-disable @typescript-eslint/unbound-method */
    const clearViewport = renderer.clearViewport
    /* eslint-enable @typescript-eslint/unbound-method */
    controller.scrollbackArea.scrollTo = vi.fn()

    // The first command completes with its fence still in flight: the
    // VISUAL freeze defers and the grid is untouched.
    controller.beginBlock('codex', '~', 0)
    controller.blockManager.bindAttempt('att-1')
    expect(controller.freezeFromAttempt(completedAttempt(FENCE), 2)).toBe(false)
    expect(clearViewport).not.toHaveBeenCalled()

    // A second command starts while the first's boundary is pending: its
    // rows sit BELOW the first block's rows in the buffer. The first
    // fence landing must serialize the first block WITHOUT clearing —
    // clearing would wipe the second command's still-unserialized rows.
    controller.beginBlock('codex', '~', 4)
    controller.blockManager.bindAttempt('att-2')
    sight({ hex: FENCE, line: 3, buffer: 'normal' })
    expect(
      controller.blockManager.blockForAttempt('att-1')?.el.classList.contains('cmd-block-running'),
    ).toBe(false)
    expect(controller.blockManager.runningBlock).toBe(
      controller.blockManager.blockForAttempt('att-2'),
    )
    expect(clearViewport).not.toHaveBeenCalled()

    // The second command completes and its fence is already sighted: the
    // rec path freezes it and NOW the grid clears — its rows were the last
    // in the buffer.
    sight({ hex: FENCE2, line: 7, buffer: 'normal' })
    expect(controller.freezeFromAttempt({ ...completedAttempt(FENCE2), id: 'att-2' }, 7)).toBe(true)
    expect(clearViewport).toHaveBeenCalledTimes(1)
    controller.blockManager.clearAll()
  })
})

describe('the echoed command line leaves the live region too (nocx-w1n4)', () => {
  // The frozen body already skips the echo: the app-owned submit opens the
  // block BEFORE the bytes, the shell's echo lands on the creation line,
  // and the output range starts one row later (nocx-4yhi). The LIVE region
  // is the xterm grid itself, which still holds that echoed line on the
  // creation row — so the running block showed one row more than the frozen
  // one will. The range was decided in the block model; this describe pins
  // the grid to the same decision: the region's first SHOWN row is
  // outputStart. The box clips the grid's TOP rows, so offsetting the
  // box's height hides the bottom, never the echo — the grid itself must
  // move, and it does: a vertical translate on the inner wrapper.
  const FENCE = 'ab'.repeat(32)
  const domain = mintDomain({
    lane: 'l',
    lifecycle: 'prompt_ready',
    domain: 'd1',
    epoch: 1,
  }) as IntegrationDomain
  const completedAttempt = (fence: string): ExecutionAttempt => ({
    id: 'att-1',
    domain,
    state: 'completed',
    exitCode: 0,
    fence,
  })

  /** A renderer whose cell geometry the controller can read, with a
   *  settable viewport top — the number that decides when the echo has
   *  scrolled out of the grid. */
  function rendererWithGeometry(): {
    renderer: TerminalRenderer
    sight: (ev: RenderFenceEvent) => void
    setViewportTop: (line: number) => void
  } {
    const renderer = makeRenderer()
    let fenceCb: ((ev: RenderFenceEvent) => void) | null = null
    renderer.onRenderFence = (cb: (ev: RenderFenceEvent) => void) => {
      fenceCb = cb
    }
    let top = 0
    Object.defineProperty(renderer, 'cellHeight', { value: 16, configurable: true })
    Object.defineProperty(renderer, 'viewportTopLine', {
      configurable: true,
      get: () => top,
    })
    return {
      renderer,
      sight: (ev) => fenceCb?.(ev),
      setViewportTop: (line: number) => {
        top = line
      },
    }
  }

  it('hides the echo row from the running block and releases it once the grid scrolls past', () => {
    const { renderer, sight, setViewportTop } = rendererWithGeometry()

    /* eslint-disable @typescript-eslint/unbound-method */
    const clearViewport = renderer.clearViewport
    /* eslint-enable @typescript-eslint/unbound-method */
    const pane = document.createElement('div')
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    Object.defineProperty(controller.scrollbackArea, 'clientHeight', {
      value: 360,
      configurable: true,
    })
    controller.scrollbackArea.scrollTo = vi.fn()

    // App-owned submit: the block opens at the prompt line and the output
    // range starts one row later (nocx-4yhi) — the shape Defect 1 is about.
    // The grid was cleared at the previous freeze, so the echo row IS the
    // grid's top row and the shift is exactly one cell.
    controller.beginBlock('ls', '~', 0, 1)
    expect(controller.mode).toBe('running')
    expect(controller.xtermInner.style.transform).toBe('translateY(-16px)')

    // Output arrives: the box is sized to the measured content and the
    // echo stays out of view — and the height itself is NOT offset (an
    // offset moves what is measured, not what is shown).
    controller.setLiveHeight(3 * 16)
    expect(controller.xtermLiveContainer.style.height).toBe('48px')
    expect(controller.xtermInner.style.transform).toBe('translateY(-16px)')

    // The output outgrows the viewport: the echo row scrolls above the
    // grid, and the shift MUST release — a stale shift would clip the
    // first real output row instead.
    setViewportTop(1)
    controller.setLiveHeight(24 * 16)
    expect(controller.xtermInner.style.transform).toBe('')
    // The box still clamps to the live-region cap (nocx-zn4d).
    expect(controller.xtermLiveContainer.style.height).toBe('360px')

    // The shift is live, not one-shot: back before the echo scrolled out,
    // it re-applies on the next sizing frame.
    setViewportTop(0)
    controller.setLiveHeight(3 * 16)
    expect(controller.xtermInner.style.transform).toBe('translateY(-16px)')

    // Freeze hands the rows to the DOM and the live region settles: the
    // shift is gone at idle, exactly like the box's height.
    controller.blockManager.bindAttempt('att-1')
    sight({ hex: FENCE, line: 3, buffer: 'normal' })
    expect(controller.freezeFromAttempt(completedAttempt(FENCE), 3)).toBe(true)
    expect(controller.mode).toBe('idle')
    expect(controller.xtermInner.style.transform).toBe('')
    expect(clearViewport).toHaveBeenCalledTimes(1)
    controller.blockManager.clearAll()
  })
})

describe('the frozen block metric is published from the renderer (nocx-yy9g)', () => {
  /** A renderer whose cell width the test controls and whose cell-dims
   *  notification the test can fire. */
  function metricRenderer() {
    let cellWidth = 8.5
    let onChange: (() => void) | null = null
    const renderer = makeRenderer() as TerminalRenderer & {
      cellWidth: number
      onCellDimsChange: (cb: () => void) => void
      _setCellWidth: (w: number) => void
      _fireCellDimsChange: () => void
    }
    renderer.cellWidth = cellWidth
    renderer.onCellDimsChange = (cb) => {
      onChange = cb
    }
    renderer._setCellWidth = (w) => {
      cellWidth = w
      renderer.cellWidth = w
    }
    renderer._fireCellDimsChange = () => onChange?.()
    return renderer
  }

  /** The publisher's probe measures its text as 64 W's at 10px = 640px,
   *  so the natural advance is 10 — a stand-in for the real layout the
   *  browser computes. */
  function stubProbeMeasurement(container: HTMLElement): void {
    const probe = container.querySelector<HTMLElement>('.cell-metric-probe')
    expect(probe).not.toBeNull()
    Object.defineProperty(probe!, 'getBoundingClientRect', {
      value: () => ({ width: 640, height: 16 }),
      configurable: true,
    })
  }

  it('publishes the renderer cell width onto the scrollback at construction', () => {
    const pane = document.createElement('div')
    const renderer = metricRenderer()
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    stubProbeMeasurement(controller.scrollbackInner)
    // The constructor publish ran before the probe was measurable, so the
    // properties land on the first refresh — same path the mount-end
    // notification takes in the app.
    renderer._fireCellDimsChange()
    expect(controller.scrollbackInner.style.getPropertyValue('--term-cell-width')).toBe('8.5px')
    expect(controller.scrollbackInner.style.getPropertyValue('--term-cell-delta')).toBe('-1.5px')
  })

  it('re-publishes when the renderer reports its cell dims changed (resize, dpr)', () => {
    const pane = document.createElement('div')
    const renderer = metricRenderer()
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    stubProbeMeasurement(controller.scrollbackInner)

    renderer._setCellWidth(9)
    renderer._fireCellDimsChange()

    expect(controller.scrollbackInner.style.getPropertyValue('--term-cell-width')).toBe('9px')
    expect(controller.scrollbackInner.style.getPropertyValue('--term-cell-delta')).toBe('-1px')
  })

  it('publishes nothing while the renderer cannot measure — blocks keep their natural advance', () => {
    const pane = document.createElement('div')
    const renderer = metricRenderer()
    renderer._setCellWidth(0)
    const controller = new ScrollbackController({
      pane,
      renderer,
      snapshotStore: new CommandSnapshotStore(),
    })
    renderer._fireCellDimsChange()
    expect(controller.scrollbackInner.style.getPropertyValue('--term-cell-width')).toBe('')
    expect(controller.scrollbackInner.style.getPropertyValue('--term-cell-delta')).toBe('')
  })
})
