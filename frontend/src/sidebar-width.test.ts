// @vitest-environment jsdom
// sidebar-width — the shell's width policy for the sidebar panel (nocx-qmcu):
// one clamped number, applied to the panel as a CSS variable, persisted
// through the settings seam by whoever owns that seam. The controller is the
// single owner of the value; the DOM and the subscribers are projections.
import { describe, expect, it, vi } from 'vitest'
import {
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  clampSidebarWidth,
  applySidebarWidth,
  createSidebarWidthController,
  persistSidebarWidth,
} from './sidebar-width'

describe('bounds', () => {
  it('the minimum leaves room for a name; the maximum keeps the panes', () => {
    // The numbers are the contract — see sidebar-width.ts for the measured
    // reasoning. If they move, the comment and the Go NumberSpec move too.
    expect(SIDEBAR_WIDTH_MIN).toBe(200)
    expect(SIDEBAR_WIDTH_MAX).toBe(640)
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(240)
    expect(SIDEBAR_WIDTH_KEY).toBe('sidebar.width')
  })

  it('clamps below the minimum and above the maximum', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_WIDTH_MAX)
    expect(clampSidebarWidth(320)).toBe(320)
  })

  it('maps non-finite widths to the default', () => {
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})

describe('applySidebarWidth', () => {
  it('sets the --sidebar-width CSS variable on the panel', () => {
    const panel = document.createElement('div')
    applySidebarWidth(panel, 320)
    expect(panel.style.getPropertyValue('--sidebar-width')).toBe('320px')
  })
})

describe('createSidebarWidthController', () => {
  it('applies the initial width on creation', () => {
    const panel = document.createElement('div')
    const ctrl = createSidebarWidthController(panel, 320)
    expect(ctrl.width).toBe(320)
    expect(panel.style.getPropertyValue('--sidebar-width')).toBe('320px')
  })

  it('clamps the initial width', () => {
    const panel = document.createElement('div')
    const ctrl = createSidebarWidthController(panel, 9999)
    expect(ctrl.width).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('apply clamps and notifies subscribers', () => {
    const panel = document.createElement('div')
    const ctrl = createSidebarWidthController(panel, 240)
    const listener = vi.fn()
    const unsub = ctrl.subscribe(listener)
    ctrl.apply(400)
    expect(ctrl.width).toBe(400)
    expect(listener).toHaveBeenCalledWith(400)
    unsub()
    ctrl.apply(500)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('persists as a command at a commit boundary, not as a side effect of painting', () => {
    const panel = document.createElement('div')
    const persist = vi.fn()
    const ctrl = createSidebarWidthController(panel, 240, persist)
    // An explicit commit persists even when the value did not move — the
    // drag's final live apply often painted the same number a moment
    // earlier, and deduping would drop the write that survives a restart.
    ctrl.apply(240, { persist: true })
    expect(persist).toHaveBeenCalledWith(240)
    ctrl.apply(300) // live paint during a drag — no write
    expect(persist).toHaveBeenCalledTimes(1)
    ctrl.apply(300, { persist: true }) // the commit — the write
    expect(persist).toHaveBeenLastCalledWith(300)
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('paints and notifies only when the value changed', () => {
    const panel = document.createElement('div')
    const ctrl = createSidebarWidthController(panel, 240)
    const listener = vi.fn()
    ctrl.subscribe(listener)
    ctrl.apply(240)
    expect(listener).not.toHaveBeenCalled()
    ctrl.apply(300)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a throwing persist cannot break the drag or lose the applied width', () => {
    const panel = document.createElement('div')
    const ctrl = createSidebarWidthController(panel, 240, () => {
      throw new Error('settings store is on fire')
    })
    expect(() => ctrl.apply(400, { persist: true })).not.toThrow()
    expect(ctrl.width).toBe(400)
    expect(panel.style.getPropertyValue('--sidebar-width')).toBe('400px')
  })

  it('reports dragging state so the settings observer stands down', () => {
    const panel = document.createElement('div')
    const ctrl = createSidebarWidthController(panel, 240)
    expect(ctrl.isDragging()).toBe(false)
    ctrl.setDragging(true)
    expect(ctrl.isDragging()).toBe(true)
    ctrl.setDragging(false)
    expect(ctrl.isDragging()).toBe(false)
  })
})

describe('persistSidebarWidth', () => {
  it('writes the key and stays silent when the write succeeds', async () => {
    const onFailure = vi.fn()
    const setSetting = vi.fn().mockResolvedValue({ ok: true })
    persistSidebarWidth(setSetting, onFailure, 320)
    expect(setSetting).toHaveBeenCalledWith('sidebar.width', 320)
    await vi.waitFor(() => expect(onFailure).not.toHaveBeenCalled())
  })

  it('a rejected write surfaces a warning and never throws into the drag', async () => {
    const onFailure = vi.fn()
    let rejectWrite!: (err: Error) => void
    const pending = new Promise<never>((_, reject) => {
      rejectWrite = reject
    })
    const setSetting = vi.fn(() => pending)

    // Fire-and-forget: the caller (the controller's commit) must never see
    // the rejection — the width is already applied and stays on screen.
    expect(() => persistSidebarWidth(setSetting, onFailure, 400)).not.toThrow()

    rejectWrite(new Error('settings store is down'))
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1))
    expect(onFailure).toHaveBeenCalledWith(
      'Could not save the sidebar width — it will not survive a restart',
    )
  })
  it('a synchronous throw from the writer is caught and surfaced too', () => {
    const onFailure = vi.fn()
    const setSetting = vi.fn(() => {
      throw new Error('transport died synchronously')
    })
    expect(() => persistSidebarWidth(setSetting, onFailure, 480)).not.toThrow()
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledWith(
      'Could not save the sidebar width — it will not survive a restart',
    )
  })
})
