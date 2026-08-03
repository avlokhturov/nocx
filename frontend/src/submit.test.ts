import { describe, it, expect } from 'vitest'
import {
  submitCommand,
  planSubmit,
  planSubmitSync,
  isSubmitFailure,
  type ResolveLineFn,
} from './submit'
import { RpcError } from './dispatcher'

describe('submitCommand', () => {
  it('dispatches submit, refocuses the grid, then sends — in order (nocx-4ff.12)', () => {
    const calls: string[] = []
    submitCommand('echo hi', {
      dispatchSubmit: () => calls.push('dispatch'),
      focusGrid: () => calls.push('focus'),
      sendDoc: (d) => calls.push(`send:${d}`),
    })
    expect(calls).toEqual(['dispatch', 'focus', 'send:echo hi'])
  })
})

describe('planSubmitSync — the no-gap fast path', () => {
  it('a plain line resolves to itself, synchronously, with no wire call', () => {
    expect(planSubmitSync('curl https://api.example.com')).toEqual({
      sendLine: 'curl https://api.example.com',
      recordLine: 'curl https://api.example.com',
      refs: [],
    })
  })

  it('a line with references returns null — the async resolve is required', () => {
    expect(planSubmitSync('curl {{secret:openai-key}}')).toBeNull()
  })
})

describe('planSubmit', () => {
  it('a plain line costs no wire call — no resolve, no await of substance', async () => {
    const resolve = (() => Promise.reject(new Error('must not be called'))) as ResolveLineFn
    const verdict = await planSubmit('curl https://api.example.com', resolve)
    expect(isSubmitFailure(verdict)).toBe(false)
    expect(verdict).toEqual({
      sendLine: 'curl https://api.example.com',
      recordLine: 'curl https://api.example.com',
      refs: [],
    })
  })

  it('resolves references: the RESOLVED line is sent, the reference-intact line is recorded', async () => {
    const resolve = ((line: string) => {
      expect(line).toBe('curl -H "Authorization: Bearer {{secret:openai-key}}" https://x')
      return Promise.resolve({
        line: 'curl -H "Authorization: Bearer sk-live-abc" https://x',
        refs: [{ name: 'openai-key', resolved: true }],
      })
    }) as ResolveLineFn
    const verdict = await planSubmit(
      'curl -H "Authorization: Bearer {{secret:openai-key}}" https://x',
      resolve,
    )
    expect(isSubmitFailure(verdict)).toBe(false)
    expect(verdict).toEqual({
      sendLine: 'curl -H "Authorization: Bearer sk-live-abc" https://x',
      recordLine: 'curl -H "Authorization: Bearer {{secret:openai-key}}" https://x',
      refs: [{ name: 'openai-key', resolved: true }],
    })
  })

  it('an unresolved name is a failure, never a silent send of the broken line', async () => {
    const resolve = (() =>
      Promise.resolve({
        line: 'curl -H "Authorization: Bearer {{secret:nope}}" https://x',
        refs: [
          { name: 'nope', resolved: false },
          { name: 'also-nope', resolved: false },
          { name: 'nope', resolved: false },
        ],
      })) as ResolveLineFn
    const verdict = await planSubmit(
      'curl {{secret:nope}} {{secret:also-nope}} {{secret:nope}}',
      resolve,
    )
    expect(isSubmitFailure(verdict)).toBe(true)
    if (isSubmitFailure(verdict)) {
      expect(verdict.reason).toBe('unresolved')
      // First-occurrence, deduplicated.
      expect(verdict.names).toEqual(['nope', 'also-nope'])
    }
  })

  it('a sealed vault is a distinct failure (code -32001)', async () => {
    const resolve = (() =>
      Promise.reject(
        new RpcError('vault is sealed', -32001, { reason: 'vault-sealed' }),
      )) as ResolveLineFn
    const verdict = await planSubmit('curl {{secret:openai-key}}', resolve)
    expect(isSubmitFailure(verdict)).toBe(true)
    if (isSubmitFailure(verdict)) expect(verdict.reason).toBe('sealed')
  })

  it('a sealed vault is a distinct failure (data.reason vault-sealed)', async () => {
    const resolve = (() =>
      Promise.reject(
        new RpcError('vault error', -32603, { reason: 'vault-sealed' }),
      )) as ResolveLineFn
    const verdict = await planSubmit('curl {{secret:openai-key}}', resolve)
    expect(isSubmitFailure(verdict)).toBe(true)
    if (isSubmitFailure(verdict)) expect(verdict.reason).toBe('sealed')
  })

  it('any other resolve error is a failure with the message', async () => {
    const resolve = (() => Promise.reject(new Error('connection lost'))) as ResolveLineFn
    const verdict = await planSubmit('curl {{secret:openai-key}}', resolve)
    expect(isSubmitFailure(verdict)).toBe(true)
    if (isSubmitFailure(verdict)) {
      expect(verdict.reason).toBe('error')
      expect(verdict.message).toBe('connection lost')
    }
  })
})
