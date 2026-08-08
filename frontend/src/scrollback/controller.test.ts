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
})
