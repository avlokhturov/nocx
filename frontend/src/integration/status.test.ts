import { describe, it, expect, vi } from 'vitest'
import {
  IntegrationSeenStore,
  integrationMessage,
  isDegraded,
  subscribeIntegrationChanged,
  type IntegrationReason,
} from './status'
import type { Dispatcher } from '../dispatcher'
import type { SessionIntegrationChanged } from '../generated/session.integrationChanged'

/** Every reason the schema declares. Written out rather than derived, so a
 *  reason added to the contract without a message fails here instead of
 *  reaching a user as a card with no words in it. */
const REASONS: IntegrationReason[] = [
  'unsupported-shell',
  'no-secure-temp',
  'remote-command',
  'handshake-timeout',
  'channel-lost',
  'unknown',
]

const fact = (over: Partial<SessionIntegrationChanged> = {}): SessionIntegrationChanged => ({
  sessionId: 's1',
  status: 'conventional',
  reason: 'handshake-timeout',
  shell: '/bin/bash',
  ...over,
})

describe('what the product says about a degraded session', () => {
  it('has words for every reason the wire can carry', () => {
    for (const reason of REASONS) {
      const m = integrationMessage(fact({ reason }))
      expect(m, reason).not.toBeNull()
      expect(m!.title.length, reason).toBeGreaterThan(0)
      expect(m!.description.length, reason).toBeGreaterThan(0)
      expect(m!.happening.length, reason).toBeGreaterThan(0)
      expect(m!.lastGoodStep.length, reason).toBeGreaterThan(0)
    }
  })

  // The owner's rule, asserted rather than trusted to review: nocx cannot
  // see which program took the shell over — AD-6 forbids reading the byte
  // stream and the process table is a race — so naming one would present a
  // guess as a finding. The Details dialog carries the observation instead,
  // labelled as a guess.
  it('names no third-party program in any message', () => {
    const forbidden = [
      'oh-my-zsh',
      'ohmyzsh',
      'powerlevel',
      'starship',
      'fish',
      'tmux',
      'zplug',
      'nvm',
      'conda',
    ]
    for (const reason of REASONS) {
      const m = integrationMessage(fact({ reason }))!
      const text = [m.title, m.description, m.happening, m.lastGoodStep, m.snippet ?? '']
        .join(' ')
        .toLowerCase()
      for (const name of forbidden) {
        expect(text.includes(name), `${reason} mentions ${name}`).toBe(false)
      }
    }
  })

  // handshake-timeout is the reason the backend can actually emit today.
  // The agreed sentence about startup files taking the shell over belongs to
  // a reason nothing produces yet, and using it here would claim the backend
  // knows something it does not.
  it('does not claim an interception it cannot observe', () => {
    const m = integrationMessage(fact({ reason: 'handshake-timeout' }))!
    expect(m.description.toLowerCase()).not.toContain('startup file')
  })

  it('says nothing about a session that is starting or integrated', () => {
    expect(integrationMessage(fact({ status: 'starting', reason: undefined }))).toBeNull()
    expect(integrationMessage(fact({ status: 'integrated', reason: undefined }))).toBeNull()
    expect(isDegraded(fact({ status: 'starting', reason: undefined }))).toBe(false)
    expect(isDegraded(null)).toBe(false)
  })

  it('treats lost as degraded — an integration that ended is still a plain terminal', () => {
    expect(isDegraded(fact({ status: 'lost', reason: 'channel-lost' }))).toBe(true)
  })

  // An unrenderable reason is still a degraded session. Silence is the
  // defect this whole surface exists to remove, so a reason from a newer
  // backend falls back to "unknown" rather than to nothing.
  it('falls back to unknown for a reason it does not recognise', () => {
    const m = integrationMessage(fact({ reason: 'brand-new' as IntegrationReason }))
    expect(m).not.toBeNull()
    expect(m!.title).toBe('Not integrated')
  })
})

describe('the subscription seam', () => {
  const dispatcherWith = (capture: { handler?: (params: unknown) => void }): Dispatcher =>
    ({
      subscribe: (_method: string, h: (params: unknown) => void) => {
        capture.handler = h
        return () => undefined
      },
    }) as unknown as Dispatcher

  it('delivers a well-formed fact', () => {
    const capture: { handler?: (params: unknown) => void } = {}
    const seen: SessionIntegrationChanged[] = []
    subscribeIntegrationChanged(dispatcherWith(capture), (f) => seen.push(f))
    capture.handler!(fact())
    expect(seen).toHaveLength(1)
    expect(seen[0].reason).toBe('handshake-timeout')
  })

  // The unsolicited-notification defect class: nothing correlates this
  // frame and nothing checks its shape at the call site, so the boundary
  // does — exactly like files.changed and lifecycle.changed.
  it('drops a payload that is not a fact', () => {
    const capture: { handler?: (params: unknown) => void } = {}
    const seen: SessionIntegrationChanged[] = []
    subscribeIntegrationChanged(dispatcherWith(capture), (f) => seen.push(f))
    capture.handler!(null)
    capture.handler!({ sessionId: 's1' })
    capture.handler!({ shell: '/bin/bash' })
    expect(seen).toHaveLength(0)
  })
})

describe('which card the user has already seen', () => {
  const memoryStorage = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
  }

  it('shows a (shell, reason) pair once and never again', () => {
    const store = new IntegrationSeenStore(memoryStorage())
    expect(store.shouldShow('/bin/bash', 'handshake-timeout')).toBe(true)
    store.markShown('/bin/bash', 'handshake-timeout')
    expect(store.shouldShow('/bin/bash', 'handshake-timeout')).toBe(false)
  })

  // Keyed by the PAIR, which is the owner's decision: one shell failing one
  // way is one thing to learn, however many tabs it happens in — but a
  // different failure of the same shell is genuinely new information.
  it('still shows a different reason for the same shell', () => {
    const store = new IntegrationSeenStore(memoryStorage())
    store.markShown('/bin/bash', 'handshake-timeout')
    expect(store.shouldShow('/bin/bash', 'channel-lost')).toBe(true)
  })

  it('still shows the same reason for a different shell', () => {
    const store = new IntegrationSeenStore(memoryStorage())
    store.markShown('/bin/bash', 'handshake-timeout')
    expect(store.shouldShow('/bin/zsh', 'handshake-timeout')).toBe(true)
  })

  // Per shell, not global: a user who has accepted that their login shell is
  // not integrated has said nothing about the next host they connect to.
  it('suppresses every reason for a shell the user silenced, and only that shell', () => {
    const store = new IntegrationSeenStore(memoryStorage())
    store.suppressShell('/bin/bash')
    expect(store.shouldShow('/bin/bash', 'handshake-timeout')).toBe(false)
    expect(store.shouldShow('/bin/bash', 'channel-lost')).toBe(false)
    expect(store.shouldShow('/bin/zsh', 'handshake-timeout')).toBe(true)
  })

  it('survives a restart — the record is what the next run reads', () => {
    const storage = memoryStorage()
    new IntegrationSeenStore(storage).markShown('/bin/bash', 'handshake-timeout')
    expect(new IntegrationSeenStore(storage).shouldShow('/bin/bash', 'handshake-timeout')).toBe(
      false,
    )
  })

  // The failure paths. Showing a card twice is a nuisance; never showing it
  // is the defect, so every storage failure degrades towards showing.
  it('shows the card when the record is corrupt', () => {
    const storage = memoryStorage()
    storage.setItem('nocx.integration.seen.v1', '{not json')
    expect(new IntegrationSeenStore(storage).shouldShow('/bin/bash', 'handshake-timeout')).toBe(
      true,
    )
  })

  it('shows the card when the record is the wrong shape', () => {
    const storage = memoryStorage()
    storage.setItem('nocx.integration.seen.v1', '{"seen":true}')
    expect(new IntegrationSeenStore(storage).shouldShow('/bin/bash', 'handshake-timeout')).toBe(
      true,
    )
  })

  it('shows the card when there is no storage at all', () => {
    const store = new IntegrationSeenStore(null)
    store.markShown('/bin/bash', 'handshake-timeout')
    expect(store.shouldShow('/bin/bash', 'handshake-timeout')).toBe(true)
  })

  it('shows the card when writing is denied, rather than throwing at the user', () => {
    const denied = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError')
      }),
    }
    const store = new IntegrationSeenStore(denied)
    expect(() => store.markShown('/bin/bash', 'handshake-timeout')).not.toThrow()
    expect(store.shouldShow('/bin/bash', 'handshake-timeout')).toBe(true)
  })
})
