// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { AgentInputTarget } from './agent-ask'
import type { AnswerBlockHandle } from './scrollback/blocks'

/** A fake dispatcher: records agent.* calls and delivers subscriptions on
 *  demand. The wire contract the target produces is asserted from the
 *  RECORDED params — never from what the target echoes back. */
class FakeDispatcher {
  calls: { method: string; params: unknown }[] = []
  private subs = new Map<string, (params: unknown) => void>()
  next = { frameId: 'frame-1', run: 7, answerEntry: 'answer-1' }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'agent.captureFrame')
      return Promise.resolve({ frameId: this.next.frameId }) as Promise<T>
    if (method === 'agent.ask') {
      const res = {
        runId: this.next.run,
        questionId: 'ask-1',
        answerEntryId: this.next.answerEntry,
        state: 'prepared',
        ingestSeq: 1,
        replayed: false,
      }
      // Each ask is a new run with a new answer entry (two overlapping
      // asks stream concurrently; ids never repeat).
      this.next.run += 1
      this.next.answerEntry = `answer-${this.next.run}`
      return Promise.resolve(res) as Promise<T>
    }
    return Promise.reject(new Error(`unexpected call ${method}`))
  }

  subscribe(method: string, handler: (params: unknown) => void): () => void {
    this.subs.set(method, handler)
    return () => this.subs.delete(method)
  }

  emit(method: string, params: unknown): void {
    this.subs.get(method)?.(params)
  }
}

/** A fake selected block whose output text is "line one\nline two" — the
 *  text the frozen mint will derive. */
function blockEl(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cmd-block cmd-block-selected'
  const output = document.createElement('div')
  output.className = 'cmd-output'
  const l1 = document.createElement('span')
  l1.className = 'term-line'
  l1.textContent = 'line one'
  const l2 = document.createElement('span')
  l2.className = 'term-line'
  l2.textContent = 'line two'
  output.append(l1, l2)
  el.appendChild(output)
  return el
}

function makeTarget() {
  const dispatcher = new FakeDispatcher()
  const block = blockEl()
  const handle: AnswerBlockHandle = {
    id: 1,
    el: document.createElement('div'),
    append: vi.fn(),
    close: vi.fn(),
  }
  const onRefusal = vi.fn()
  const target = new AgentInputTarget({
    dispatcher: dispatcher as never,
    sessionId: () => 'session-a',
    cwd: () => '/repo',
    askBlock: () => block,
    openAnswer: vi.fn(() => handle),
    onRefusal,
  })
  return { dispatcher, block, handle, onRefusal, target }
}

describe('AgentInputTarget', () => {
  it('mints the frozen frame from the selected block and asks (source=frozen, text rows, the ONE derivation)', async () => {
    const { dispatcher, handle, target } = makeTarget()
    await target.submit('what does this screen mean?')

    const capture = dispatcher.calls.find((c) => c.method === 'agent.captureFrame')
    expect(capture).toBeDefined()
    const p = capture!.params as {
      captureId: string
      sessionId: string
      source: string
      rows: { kind: string; text: string }[]
      serializerVersion: number
      cwd: string
    }
    expect(p.source).toBe('frozen')
    expect(p.sessionId).toBe('session-a')
    expect(p.serializerVersion).toBe(1)
    expect(p.rows).toEqual([
      { kind: 'text', text: 'line one' },
      { kind: 'text', text: 'line two' },
    ])
    // A frozen frame carries no cursor, no identity, no range — the backend
    // enforces exactly this.
    expect(p).not.toHaveProperty('cursor')
    expect(p).not.toHaveProperty('identity')
    expect(p).not.toHaveProperty('range')

    const ask = dispatcher.calls.find((c) => c.method === 'agent.ask')
    const a = ask!.params as {
      askId: string
      question: string
      references: { frameId: string; region: { rowStart: number; rowEnd: number } }[]
    }
    expect(a.question).toBe('what does this screen mean?')
    expect(a.references).toEqual([{ frameId: 'frame-1', region: { rowStart: 0, rowEnd: 2 } }])

    // The answer block opened, associated with the run AND the answer entry
    // id BEFORE the first delta (a no-delta failure still closes the right
    // block).
    expect(handle.el.dataset.answerEntryId).toBe('answer-1')
  })

  it('routes runDelta to the run’s block by runId and entryId', async () => {
    const { dispatcher, handle, target } = makeTarget()
    await target.submit('q')

    dispatcher.emit('agent.runDelta', {
      runId: 7,
      entryId: 'answer-1',
      seq: 0,
      text: 'hello',
    })
    dispatcher.emit('agent.runDelta', {
      runId: 7,
      entryId: 'answer-1',
      seq: 1,
      text: ' world',
    })
    expect(handle.append).toHaveBeenCalledTimes(2)
    expect(handle.append).toHaveBeenNthCalledWith(1, 'hello')
    expect(handle.append).toHaveBeenNthCalledWith(2, ' world')
  })

  it('ignores a delta whose entryId does not match the run’s answer entry', async () => {
    const { dispatcher, handle, target } = makeTarget()
    await target.submit('q')

    dispatcher.emit('agent.runDelta', {
      runId: 7,
      entryId: 'some-other-answer',
      seq: 0,
      text: 'stale',
    })
    expect(handle.append).not.toHaveBeenCalled()
  })

  it('closes the block completed on the terminal state; failed carries the renderable reason', async () => {
    const { dispatcher, handle, target } = makeTarget()
    await target.submit('q')

    dispatcher.emit('agent.runState', { runId: 7, state: 'completed' })
    expect(handle.close).toHaveBeenCalledWith('success')
    expect(handle.close).toHaveBeenCalledTimes(1)

    await target.submit('q2')
    dispatcher.emit('agent.runState', {
      runId: 8,
      state: 'failed',
      error: 'the model returned no text',
    })
    expect(handle.close).toHaveBeenLastCalledWith('failure', 'the model returned no text')
  })

  it('closes the block on a runState with NO prior delta (failure before any text)', async () => {
    const { dispatcher, handle, target } = makeTarget()
    await target.submit('q')
    dispatcher.emit('agent.runState', {
      runId: 7,
      state: 'failed',
      error: 'the connection was lost',
    })
    expect(handle.close).toHaveBeenCalledWith('failure', 'the connection was lost')
  })
})

describe('AgentInputTarget refusal', () => {
  it('surfaces a no-endpoint refusal through onRefusal — the renderable condition, not a silent throw', async () => {
    const dispatcher = new FakeDispatcher()
    const block = blockEl()
    const handle: AnswerBlockHandle = {
      id: 1,
      el: document.createElement('div'),
      append: vi.fn(),
      close: vi.fn(),
    }
    const onRefusal = vi.fn()
    // The backend refuses the ask with the fixed message.
    dispatcher.calls = []
    const failDispatcher = {
      calls: [] as { method: string; params: unknown }[],
      call<T = unknown>(method: string): Promise<T> {
        if (method === 'agent.captureFrame') {
          return Promise.resolve({ frameId: 'frame-1' }) as Promise<T>
        }
        const err = new Error('no endpoint configured') as Error & { code?: number }
        err.code = -32603
        return Promise.reject(err)
      },
      subscribe: () => () => {},
    }
    const target = new AgentInputTarget({
      dispatcher: failDispatcher as never,
      sessionId: () => 's',
      cwd: () => '/',
      askBlock: () => block,
      openAnswer: () => handle,
      onRefusal,
    })
    await expect(target.submit('q')).rejects.toThrow('no endpoint configured')
    expect(onRefusal).toHaveBeenCalledWith('no endpoint configured')
  })
})
