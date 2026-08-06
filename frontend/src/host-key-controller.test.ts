import { describe, expect, it, vi } from 'vitest'
import { OpenHostKeyRequestQueue, type OpenHostKeyRequest } from './host-key-controller'
import type { HostKeyErrorEvidence } from './terminal-content'

function evidence(knownHostsHost: string, key: string): HostKeyErrorEvidence {
  return {
    host: 'db.example.com:22',
    knownHostsHost,
    changed: false,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:abc',
    key,
    profileId: 'ssh:test',
  }
}

describe('OpenHostKeyRequestQueue', () => {
  it('one accepted key resolves every queued request for the same route and key', async () => {
    const active: Array<OpenHostKeyRequest | null> = []
    const queue = new OpenHostKeyRequestQueue((request) => active.push(request))

    const first = queue.request(evidence('nocx-v1-route:22', 'a2V5'), new AbortController().signal)
    const accepted = active[active.length - 1]
    if (!accepted) throw new Error('first request did not become active')
    expect(accepted).not.toBeNull()

    const duplicate = queue.request(
      evidence('nocx-v1-route:22', 'a2V5'),
      new AbortController().signal,
    )
    const different = queue.request(
      evidence('nocx-v1-other:22', 'b3RoZXI='),
      new AbortController().signal,
    )
    const duplicateSettled = vi.fn()
    const differentSettled = vi.fn()
    void duplicate.then(duplicateSettled)
    void different.then(differentSettled)

    queue.settleMatchingQueued(accepted)
    await expect(duplicate).resolves.toBe(true)
    expect(differentSettled).not.toHaveBeenCalled()

    queue.settle(accepted, true)
    await expect(first).resolves.toBe(true)
    expect(active[active.length - 1]?.evidence.knownHostsHost).toBe('nocx-v1-other:22')

    const remaining = active[active.length - 1]
    if (!remaining) throw new Error('different request did not become active')
    queue.settle(remaining, false)
    await expect(different).resolves.toBe(false)
  })
})
