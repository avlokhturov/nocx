// @vitest-environment node
// The quick-connect host assembly (bead nocx-n9i6) — the shared derivation
// of "which hosts do I know" that quick-connect.tsx renders and
// suggest/host-provider.ts routes. Its behaviour is specified by those two
// suites; this file pins the one thing the old shape could not express: the
// degraded-resolver condition travels as typed data, not as a label that has
// to be parsed back out.
import { describe, expect, it } from 'vitest'
import { aliasRows, resolveSshProfileOverlay } from './quick-connect-assembly'
import type { SSHProfile, SSHProfileOptions } from './profiles'

const sshProfile = (
  over: Partial<SSHProfileOptions> = {},
  id = 'p1',
  name = 'Prod',
): SSHProfile => ({
  id,
  type: 'ssh',
  name,
  options: { host: 'prod', ...over },
})

describe('quick-connect host assembly', () => {
  it('the degraded condition is typed data, not a parsed label', () => {
    // The old shape carried the reason only inside the row's human-facing
    // label (`SSH config: ${reason}`) and host-provider recovered it with a
    // string-prefix slice. The assembly answers with the condition itself —
    // no human-facing string is involved anywhere on the path.
    const { degraded } = aliasRows({
      profiles: [],
      aliases: [],
      unavailable: { reason: 'no-ssh-binary', detail: 'ssh not found' },
    })
    expect(degraded).toEqual({ reason: 'no-ssh-binary', detail: 'ssh not found' })
  })
})

describe('resolveSshProfileOverlay — a submitted ssh resolves to its saved profile', () => {
  it('matches the typed host and carries the profile settings and canonical identity', () => {
    const out = resolveSshProfileOverlay(
      [sshProfile({ user: 'root', port: 2222, keyPath: '~/.ssh/prod' })],
      { host: 'prod' },
    )
    expect(out).toEqual({
      profileId: 'p1',
      identity: 'root@prod:2222',
      user: 'root',
      port: 2222,
      keyPath: '~/.ssh/prod',
    })
  })

  it('a typed user equal to the profile user matches; a contradicting one does not', () => {
    const profiles = [sshProfile({ user: 'root' })]
    expect(resolveSshProfileOverlay(profiles, { host: 'prod', user: 'root' })).not.toBeNull()
    expect(resolveSshProfileOverlay(profiles, { host: 'prod', user: 'bob' })).toBeNull()
  })

  it('a profile port never blocks the match — the port is what the overlay adds', () => {
    expect(resolveSshProfileOverlay([sshProfile({ port: 2222 })], { host: 'prod' })?.port).toBe(
      2222,
    )
  })

  it('a profile with no user does not constrain a typed user', () => {
    expect(
      resolveSshProfileOverlay([sshProfile({})], { host: 'prod', user: 'root' }),
    ).not.toBeNull()
  })

  it('another host or an empty profile list answers null — never a guess', () => {
    expect(resolveSshProfileOverlay([sshProfile()], { host: 'other' })).toBeNull()
    expect(resolveSshProfileOverlay([], { host: 'prod' })).toBeNull()
  })

  it('two profiles sharing the host are ambiguous — null, not a guess', () => {
    const profiles = [sshProfile({ user: 'root' }), sshProfile({ user: 'bob' }, 'p2', 'Prod Two')]
    expect(resolveSshProfileOverlay(profiles, { host: 'prod' })).toBeNull()
  })

  it('-J is resolved through the jump profile the source names — by id or by name', () => {
    const jump = (id: string, name: string): SSHProfile => ({
      id,
      type: 'ssh',
      name,
      options: { host: 'bastion.example.com', user: 'root', port: 2200 },
    })
    const byName = resolveSshProfileOverlay(
      [sshProfile({ jumpHost: 'bastion' }), jump('j1', 'bastion')],
      { host: 'prod' },
    )
    expect(byName?.jumpHost).toBe('root@bastion.example.com:2200')
    const byId = resolveSshProfileOverlay([sshProfile({ jumpHost: 'j1' }), jump('j1', 'Bastion')], {
      host: 'prod',
    })
    expect(byId?.jumpHost).toBe('root@bastion.example.com:2200')
  })

  it('a missing or hostless jump profile contributes no -J', () => {
    expect(
      resolveSshProfileOverlay([sshProfile({ jumpHost: 'nope' })], { host: 'prod' })?.jumpHost,
    ).toBeUndefined()
    expect(
      resolveSshProfileOverlay(
        [
          sshProfile({ jumpHost: 'j1' }),
          { id: 'j1', type: 'ssh', name: 'j1', options: { host: '' } },
        ],
        { host: 'prod' },
      )?.jumpHost,
    ).toBeUndefined()
  })

  it('the identity normalizes the port to 22 and brackets a bare IPv6 host', () => {
    expect(resolveSshProfileOverlay([sshProfile({})], { host: 'prod' })?.identity).toBe('prod:22')
    expect(resolveSshProfileOverlay([sshProfile({ user: 'u' })], { host: 'prod' })?.identity).toBe(
      'u@prod:22',
    )
    expect(
      resolveSshProfileOverlay([sshProfile({ host: '::1', user: 'u', port: 2222 })], {
        host: '::1',
      })?.identity,
    ).toBe('u@[::1]:2222')
  })

  it('a password-auth or key-bound profile contributes no -i — nothing secret ever rides the line', () => {
    expect(
      resolveSshProfileOverlay([sshProfile({ auth: 'password' })], { host: 'prod' })?.keyPath,
    ).toBeUndefined()
    expect(
      resolveSshProfileOverlay([sshProfile({ keySecret: 'cred:x' })], { host: 'prod' })?.keyPath,
    ).toBeUndefined()
  })
})
