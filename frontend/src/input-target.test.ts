import { describe, it, expect, vi } from 'vitest'
import { createRegistry, type InputTarget, ShellInputTarget } from './input-target'

const fake = (id: string): InputTarget => ({
  id,
  label: id,
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

describe('ShellInputTarget with bracketed-paste mode ON', () => {
  const on = () => true

  it('sends the doc as one bracketed paste followed by CR', async () => {
    const sendRaw = vi.fn()
    const t = new ShellInputTarget(sendRaw, on)
    await t.submit('echo hi')
    expect(sendRaw).toHaveBeenCalledTimes(1)
    expect(sendRaw).toHaveBeenCalledWith('\x1b[200~echo hi\x1b[201~\r')
  })
  it('preserves \\n so every line executes as a command separator (nocx-4ff.14)', async () => {
    const sendRaw = vi.fn()
    await new ShellInputTarget(sendRaw, on).submit('a\nb')
    expect(sendRaw).toHaveBeenCalledWith('\x1b[200~a\nb\x1b[201~\r')
  })
})

// nocx-hi2 / nocx-5zl4. A shell that never sets DECSET 2004 does not consume
// the wrappers, so they arrive as ordinary characters and are absorbed into the
// COMMAND NAME: macOS /bin/bash is 3.2, predates readline 6.1, and turned
// `read` into `0~read` — "bash: 0~read: command not found" in the CI trace.
describe('ShellInputTarget with bracketed-paste mode OFF', () => {
  const off = () => false

  it('sends no wrappers at all — they would corrupt the command name', async () => {
    const sendRaw = vi.fn()
    await new ShellInputTarget(sendRaw, off).submit('read x')
    expect(sendRaw).toHaveBeenCalledTimes(1)
    const sent = sendRaw.mock.calls[0][0] as string
    expect(sent).toBe('read x\r')
    expect(sent).not.toContain('\x1b[200~')
    expect(sent).not.toContain('\x1b[201~')
  })

  it('normalises newlines to CR so each line executes exactly once', async () => {
    const sendRaw = vi.fn()
    await new ShellInputTarget(sendRaw, off).submit('a\nb')
    // Not 'a\nb\r': a trailing LF plus CR would submit an extra empty line.
    expect(sendRaw).toHaveBeenCalledWith('a\rb\r')
  })

  it('normalises CRLF the same way', async () => {
    const sendRaw = vi.fn()
    await new ShellInputTarget(sendRaw, off).submit('a\r\nb')
    expect(sendRaw).toHaveBeenCalledWith('a\rb\r')
  })
})

describe('ShellInputTarget mode is read per submit', () => {
  // The mode is dynamic: the shell sets it at its prompt and clears it while a
  // full-screen program runs. Reading it once at construction would reintroduce
  // the race in lesson-nocx-input-editor-do-not-hand-roll, where a fast second
  // submit raced the prompt and leaked wrappers because 2004 was not on YET.
  it('follows the mode as it changes between submits', async () => {
    const sendRaw = vi.fn()
    let enabled = false
    const t = new ShellInputTarget(sendRaw, () => enabled)

    await t.submit('first')
    expect(sendRaw).toHaveBeenLastCalledWith('first\r')

    enabled = true
    await t.submit('second')
    expect(sendRaw).toHaveBeenLastCalledWith('\x1b[200~second\x1b[201~\r')
  })
})
