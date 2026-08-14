import { describe, it, expect, vi } from 'vitest'
import { createRegistry, type InputTarget, ShellInputTarget } from './input-target'

const fake = (id: string, routesToShell = false): InputTarget => ({
  id,
  label: id,
  routesToShell,
  submit: vi.fn(async () => {}),
})

describe('InputTargetRegistry', () => {
  it('first registered target is active by default', () => {
    const r = createRegistry()
    r.register(fake('shell'))
    expect(r.active().id).toBe('shell')
  })
  it('setActive switches; unknown id throws', () => {
    const r = createRegistry()
    r.register(fake('shell'))
    r.register(fake('agent'))
    r.setActive('agent')
    expect(r.active().id).toBe('agent')
    expect(() => r.setActive('nope')).toThrow()
  })
  it('active() with no targets throws', () => {
    expect(() => createRegistry().active()).toThrow()
  })
})

describe('ShellInputTarget', () => {
  it('delegates paste semantics to the renderer, then sends CR', async () => {
    const paste = vi.fn()
    const sendRaw = vi.fn()
    const t = new ShellInputTarget(paste, sendRaw)
    expect(t.routesToShell).toBe(true)
    await t.submit('echo hi')

    expect(paste).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith('echo hi')
    expect(sendRaw).toHaveBeenCalledTimes(1)
    expect(sendRaw).toHaveBeenCalledWith('\r')
    expect(paste.mock.invocationCallOrder[0]).toBeLessThan(sendRaw.mock.invocationCallOrder[0])
  })
  it('preserves \\n so every line executes as a command separator (nocx-4ff.14)', async () => {
    const paste = vi.fn()
    const sendRaw = vi.fn()
    const t = new ShellInputTarget(paste, sendRaw)
    expect(t.routesToShell).toBe(true)
    await t.submit('a\nb')
    expect(paste).toHaveBeenCalledWith('a\nb')
    expect(sendRaw).toHaveBeenCalledWith('\r')
  })
})
