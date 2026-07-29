import { describe, it, expect } from 'vitest'
import {
  buildGroupTree,
  resolveGroupPath,
  parseQuickConnect,
  type EffectiveFieldDTO,
  type PatchParams,
} from './profiles'
import type { ProfileGroup, SSHProfile } from './profiles'

describe('buildGroupTree', () => {
  it('builds a flat tree from nested groups via parentGroupId', () => {
    const groups: ProfileGroup[] = [
      { id: 'g1', name: 'Prod' },
      { id: 'g2', name: 'Staging', parentGroupId: 'g1' },
      { id: 'g3', name: 'web-1', parentGroupId: 'g2' },
      { id: 'g4', name: 'Orphan' },
    ]
    const roots = buildGroupTree(groups)
    expect(roots).toHaveLength(2)
    const prod = roots.find((r) => r.id === 'g1')
    expect(prod).toBeDefined()
    expect(prod!.children).toHaveLength(1)
    expect(prod!.children[0].id).toBe('g2')
    expect(prod!.children[0].children).toHaveLength(1)
    expect(prod!.children[0].children[0].id).toBe('g3')
  })

  it('orphaned groups become roots', () => {
    const groups: ProfileGroup[] = [
      { id: 'g1', name: 'A' },
      { id: 'g2', name: 'B', parentGroupId: 'nonexistent' },
    ]
    const roots = buildGroupTree(groups)
    expect(roots).toHaveLength(2)
  })
})

describe('resolveGroupPath', () => {
  it('walks parent chain returning breadcrumb names', () => {
    const groups: ProfileGroup[] = [
      { id: 'g1', name: 'Prod' },
      { id: 'g2', name: 'Staging', parentGroupId: 'g1' },
      { id: 'g3', name: 'web-1', parentGroupId: 'g2' },
    ]
    const path = resolveGroupPath(groups, 'g3')
    expect(path).toEqual(['Prod', 'Staging', 'web-1'])
  })

  it('returns single-element path for root group', () => {
    const groups: ProfileGroup[] = [{ id: 'g1', name: 'Prod' }]
    const path = resolveGroupPath(groups, 'g1')
    expect(path).toEqual(['Prod'])
  })

  it('cycle-guards at 32 levels', () => {
    const groups: ProfileGroup[] = [
      { id: 'g1', name: 'A', parentGroupId: 'g2' },
      { id: 'g2', name: 'B', parentGroupId: 'g1' },
    ]
    const path = resolveGroupPath(groups, 'g1')
    expect(path.length).toBeGreaterThan(0)
    expect(path.length).toBeLessThanOrEqual(32)
  })
})

describe('parseQuickConnect', () => {
  it('parses user@host:port', () => {
    const p = parseQuickConnect('alice@example.com:2222')
    expect(p.options.user).toBe('alice')
    expect(p.options.host).toBe('example.com')
    expect(p.options.port).toBe(2222)
  })

  it('parses user@host with default port 22', () => {
    const p = parseQuickConnect('alice@example.com')
    expect(p.options.user).toBe('alice')
    expect(p.options.host).toBe('example.com')
    expect(p.options.port).toBe(22)
  })

  it('parses bare host with default user', () => {
    const p = parseQuickConnect('example.com')
    expect(p.options.host).toBe('example.com')
    expect(p.options.port).toBe(22)
  })

  it('parses [host]:port for IPv6', () => {
    const p = parseQuickConnect('[::1]:2222')
    expect(p.options.host).toBe('::1')
    expect(p.options.port).toBe(2222)
  })
})

describe('SSHProfile shape', () => {
  it('has the expected fields for credential selection', () => {
    const p: SSHProfile = {
      id: 'ssh:custom:test:0001',
      type: 'ssh',
      name: 'test',
      group: '',
      options: {
        host: 'example.com',
        port: 22,
        credentialId: 'cred:alice:123456',
      },
    }
    expect(p.type).toBe('ssh')
    expect(p.options.credentialId).toBe('cred:alice:123456')
  })
})

describe('EffectiveProfile types', () => {
  it('stores per-field effective values with closed-enum source kinds', () => {
    const field: EffectiveFieldDTO = {
      value: 2222,
      source: { kind: 'group', id: 'g1', label: 'Prod' },
    }
    expect(field.source.kind).toMatch(/^(profile|group|credential|sshConfig|global|default)$/)
    expect(field.value).toBe(2222)
    expect(field.source.label).toBe('Prod')
  })

  it('profile source kind has no id/label', () => {
    const field: EffectiveFieldDTO = {
      value: 'my-host',
      source: { kind: 'profile', id: '', label: '' },
    }
    expect(field.source.kind).toBe('profile')
  })

  it('credential source kind links to credential', () => {
    const field: EffectiveFieldDTO = {
      value: 'deploy',
      source: { kind: 'credential', id: 'cred:prod-ops', label: 'prod-ops' },
    }
    expect(field.source.id).toBe('cred:prod-ops')
    expect(field.source.label).toBe('prod-ops')
  })

  it('sshConfig source kind has no id', () => {
    const field: EffectiveFieldDTO = {
      value: 22,
      source: { kind: 'sshConfig', id: '', label: '' },
    }
    expect(field.source.kind).toBe('sshConfig')
  })
})

describe('PatchParams', () => {
  it('accepts set and unset as disjoint operations', () => {
    const params: PatchParams = {
      id: 'prof:ssh:my-server',
      set: { 'options.port': 2222 },
      unset: ['options.user'],
    }
    expect(params.set!['options.port']).toBe(2222)
    expect(params.unset).toContain('options.user')
  })

  it('accepts unset-only revert operation', () => {
    const params: PatchParams = {
      id: 'prof:ssh:my-server',
      unset: ['options.port'],
    }
    expect(params.set).toBeUndefined()
    expect(params.unset).toHaveLength(1)
  })

  it('accepts set-only override', () => {
    const params: PatchParams = {
      id: 'prof:ssh:my-server',
      set: { 'options.port': 2222 },
    }
    expect(params.unset).toBeUndefined()
    expect(params.set!['options.port']).toBe(2222)
  })
})
