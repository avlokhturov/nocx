// profiles-model — pure functions only, no jsdom, no Solid.
import { describe, it, expect } from 'vitest'
import { createProfileLists, setProfileLists } from './profiles-model'
import type { SSHProfile, ProfileGroup, Credential } from '../profiles'

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeProfile(overrides?: Record<string, unknown>): SSHProfile {
  const p: SSHProfile = {
    id: 'p1',
    type: 'ssh',
    name: 'Server',
    options: {
      host: 'example.com',
      port: 22,
      user: 'admin',
      auth: 'publicKey',
      keepaliveInterval: 0,
      jumpHost: '',
      agentForward: false,
    },
  }
  return { ...p, ...overrides }
}

function makeGroup(overrides?: Record<string, unknown>): ProfileGroup {
  const g: ProfileGroup = { id: 'g1', name: 'Production' }
  return { ...g, ...overrides }
}

function makeCredential(overrides?: Record<string, unknown>): Credential {
  const c: Credential = {
    id: 'c1',
    name: 'Admin Key',
    username: 'admin',
    auth: 'publicKey',
  }
  return { ...c, ...overrides }
}

// ── createProfileLists ─────────────────────────────────────────────────────

describe('createProfileLists', () => {
  it('creates empty lists', () => {
    const p = createProfileLists()
    expect(p.profiles).toEqual([])
    expect(p.groups).toEqual([])
    expect(p.credentials).toEqual([])
  })
})

// ── setProfileLists ────────────────────────────────────────────────────────

describe('setProfileLists', () => {
  it('replaces all lists atomically', () => {
    const prev = createProfileLists()
    const next = setProfileLists(prev, [makeProfile()], [makeGroup()], [makeCredential()])
    expect(next.profiles).toHaveLength(1)
    expect(next.profiles[0].id).toBe('p1')
    expect(next.groups).toHaveLength(1)
    expect(next.groups[0].id).toBe('g1')
    expect(next.credentials).toHaveLength(1)
    expect(next.credentials[0].id).toBe('c1')
  })

  it('does not mutate the input lists', () => {
    const prev = createProfileLists()
    const profiles: SSHProfile[] = [makeProfile()]
    const next = setProfileLists(prev, profiles, [], [])
    expect(prev.profiles).toHaveLength(0)
    expect(next.profiles).toHaveLength(1)
    // Original array unchanged.
    expect(profiles).toHaveLength(1)
  })

  it('preserves references for identical lists', () => {
    const prev = createProfileLists()
    const next = setProfileLists(prev, [], [], [])
    // Empty inputs produce empty copies — different array refs but same data.
    expect(next.profiles).toEqual([])
    expect(next.groups).toEqual([])
    expect(next.credentials).toEqual([])
  })
})
