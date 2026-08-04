// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ShellClient } from './shell-client'

describe('ShellClient', () => {
  it('requests the in-band plan for the exact session id', async () => {
    const call = vi.fn().mockResolvedValue({ wrapper: 'w', payload: 'p', terminator: 't' })
    const client = new ShellClient({ call })

    await client.integrate('0123456789abcdef0123456789abcdef')

    expect(call).toHaveBeenCalledWith('shell.integrate', {
      sessionId: '0123456789abcdef0123456789abcdef',
    })
  })

  it('propagates a backend refusal (unknown session, unwired capability)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('no such session'))
    const client = new ShellClient({ call })

    await expect(client.integrate('deadbeef')).rejects.toThrow('no such session')
  })
})
