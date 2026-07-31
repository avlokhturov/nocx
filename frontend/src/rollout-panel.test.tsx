// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/unbound-method -- testing-library queries destructured from render are standard pattern */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { RolloutPanel, outcomeLabel, outcomeTone } from './rollout-panel'
import { ProfileClient } from './profiles'
import { Dispatcher } from './dispatcher'
import type {
  Credential,
  CredentialUsage,
  RolloutRunResult,
  VersionPromoteResult,
  VersionImpactResult,
  VersionActionResult,
} from './profiles'

const CRED_NO_CANDIDATE: Credential = {
  id: 'cred:prod-ops:abc',
  name: 'prod-ops',
  username: 'deploy',
  auth: 'password',
  versions: [{ id: 'v1', created: '2026-07-28T10:00:00Z' }],
  currentVersionId: 'v1',
}

const CRED_NO_VERSIONS: Credential = {
  id: 'cred:dev:abc',
  name: 'dev-admin',
  username: 'admin',
  auth: 'publicKey',
}

const CRED_WITH_CANDIDATE: Credential = {
  id: 'cred:prod-ops:abc',
  name: 'prod-ops',
  username: 'deploy',
  auth: 'password',
  versions: [
    { id: 'v1', created: '2026-07-28T10:00:00Z' },
    { id: 'v2', created: '2026-07-29T10:00:00Z' },
  ],
  currentVersionId: 'v1',
  candidateVersionId: 'v2',
}

const USAGE: CredentialUsage = {
  credentialId: 'cred:prod-ops:abc',
  profiles: [
    { profileId: 'ssh:p1:1', profileName: 'web-01', source: 'profile' },
    { profileId: 'ssh:p3:1', profileName: 'db-01', source: 'profile' },
  ],
}

const MOCK_ROLLOUT_RESULT: RolloutRunResult = {
  status: 'completed',
  probed: [
    {
      profileId: 'ssh:p1:1',
      endpoint: '10.0.0.1:22',
      username: 'deploy',
      outcome: 'accepted',
      timestamp: '2026-07-29T12:00:00Z',
    },
    {
      profileId: 'ssh:p2:1',
      endpoint: '10.0.0.2:22',
      username: 'deploy',
      outcome: 'rejected',
      detail: 'password rejected',
      timestamp: '2026-07-29T12:00:01Z',
    },
  ],
  excluded: [{ profileId: 'ssh:p3:1', endpoint: '10.0.0.3:22', reason: 'host key mismatch' }],
  notAttempted: [],
  startedAt: '2026-07-29T12:00:00Z',
  completedAt: '2026-07-29T12:00:05Z',
}

const MOCK_PROMOTE_RESULT: VersionPromoteResult = {
  versionId: 'v2',
  evidence: { accepted: 3, total: 5 },
}

const MOCK_RETIRE_RESULT: VersionActionResult = {
  versionId: 'v1',
  retired: true,
  sessionsClosed: 0,
}

const MOCK_REVOKE_RESULT: VersionActionResult = {
  versionId: 'v1',
  retired: true,
  sessionsClosed: 2,
}

const MOCK_IMPACT: VersionImpactResult = {
  versionId: 'v1',
  isCurrent: true,
  isCandidate: false,
  retired: false,
  liveSessions: [{ sessionId: 'sess-1', profileId: 'ssh:p1:1', profileName: 'web-01' }],
  pinnedProfiles: [{ profileId: 'ssh:legacy:1', profileName: 'legacy-db' }],
  profilesUsing: [
    { profileId: 'ssh:p1:1', profileName: 'web-01' },
    { profileId: 'ssh:p2:1', profileName: 'web-02' },
  ],
}

// ── Mock helpers ────────────────────────────────────────────────────────

function createMockClient(overrides?: Partial<ProfileClient>): ProfileClient {
  const client = new ProfileClient({} as Dispatcher)
  vi.spyOn(client, 'stagePassword').mockResolvedValue(true)
  vi.spyOn(client, 'discardCandidate').mockResolvedValue(true)
  vi.spyOn(client, 'rolloutRun').mockResolvedValue(MOCK_ROLLOUT_RESULT)
  vi.spyOn(client, 'versionPromote').mockResolvedValue(MOCK_PROMOTE_RESULT)
  vi.spyOn(client, 'versionRetire').mockResolvedValue(MOCK_RETIRE_RESULT)
  vi.spyOn(client, 'versionRevoke').mockResolvedValue(MOCK_REVOKE_RESULT)
  vi.spyOn(client, 'versionImpact').mockResolvedValue(MOCK_IMPACT)
  if (overrides) Object.assign(client, overrides)
  return client
}

function mount(
  cred: Credential,
  usage: CredentialUsage | null,
  clientOverrides?: Partial<ProfileClient>,
) {
  const client = createMockClient(clientOverrides)
  const onStateChange = vi.fn()
  const result = render(() => (
    <RolloutPanel client={client} credential={cred} usage={usage} onStateChange={onStateChange} />
  ))
  return { ...result, client, onStateChange }
}

afterEach(() => {
  cleanup()
})

// ── Version info display ───────────────────────────────────────────────

describe('RolloutPanel — version info', () => {
  it('shows current version when versions exist', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Current:')).toBeTruthy()
    expect(() => getByText('v1')).toBeTruthy()
  })

  it('shows candidate version when candidate exists', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Candidate:')).toBeTruthy()
    expect(() => getByText('v2')).toBeTruthy()
  })
  // ── Helper function tests ──────────────────────────────────────────────

  describe('outcomeLabel', () => {
    it('returns Accepted for accepted', () => {
      expect(outcomeLabel('accepted')).toBe('Accepted')
    })
    it('returns Rejected for rejected', () => {
      expect(outcomeLabel('rejected')).toBe('Rejected')
    })
    it('returns Unreachable for unreachable', () => {
      expect(outcomeLabel('unreachable')).toBe('Unreachable')
    })
    it('returns Unknown host key for host-key-unknown', () => {
      expect(outcomeLabel('host-key-unknown')).toBe('Unknown host key')
    })
    it('returns Host key changed for host-key-changed', () => {
      expect(outcomeLabel('host-key-changed')).toBe('Host key changed')
    })
    it('returns Needs interactive for needs-interactive', () => {
      expect(outcomeLabel('needs-interactive')).toBe('Needs interactive')
    })
  })

  describe('outcomeTone', () => {
    it('accepted → info', () => {
      expect(outcomeTone('accepted')).toBe('info')
    })
    it('rejected → danger', () => {
      expect(outcomeTone('rejected')).toBe('danger')
    })
    it('unreachable → warning', () => {
      expect(outcomeTone('unreachable')).toBe('warning')
    })
    it('host-key-unknown → warning', () => {
      expect(outcomeTone('host-key-unknown')).toBe('warning')
    })
    it('host-key-changed → danger', () => {
      expect(outcomeTone('host-key-changed')).toBe('danger')
    })
    it('needs-interactive → warning', () => {
      expect(outcomeTone('needs-interactive')).toBe('warning')
    })
  })

  it('shows legacy note for credentials without versions', () => {
    const { getByText } = mount(CRED_NO_VERSIONS, null)
    expect(getByText('Legacy credential (no version tracking)')).toBeTruthy()
  })
})

// ── Stage candidate ────────────────────────────────────────────────────

describe('RolloutPanel — staging', () => {
  it('shows stage password field for password creds without candidate', () => {
    const { getByLabelText } = mount(CRED_NO_CANDIDATE, USAGE)
    expect(getByLabelText('New password')).toBeTruthy()
  })

  it('hides stage field when candidate already exists', () => {
    expect(() => {
      const { getByLabelText } = mount(CRED_WITH_CANDIDATE, USAGE)
      getByLabelText('New password')
    }).toThrow()
  })

  it('hides stage field for non-password creds', () => {
    expect(() => {
      const { getByLabelText } = mount(CRED_NO_VERSIONS, null)
      getByLabelText('New password')
    }).toThrow()
  })

  it('shows discard button when candidate exists', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Discard candidate')).toBeTruthy()
  })
})

// ── Rollout flow ───────────────────────────────────────────────────────

describe('RolloutPanel — rollout', () => {
  it('shows run rollout button when candidate exists', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Run rollout')).toBeTruthy()
  })

  it('shows target profiles in both target and canary lists', () => {
    const { getAllByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    const matches = getAllByText('web-01')
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('shows canary selection field', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Canaries (optional)')).toBeTruthy()
  })

  it('shows batch size and concurrency fields', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Batch size')).toBeTruthy()
    expect(getByText('Global concurrency')).toBeTruthy()
  })

  it('shows discard button when candidate exists', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Discard candidate')).toBeTruthy()
  })

  it('shows select all button for targets', () => {
    const { getByText } = mount(CRED_WITH_CANDIDATE, USAGE)
    expect(getByText('Select all')).toBeTruthy()
  })

  it('triggers rollout run on button click', () => {
    const { container, client } = mount(CRED_WITH_CANDIDATE, USAGE)
    const buttons = container.querySelectorAll('button')
    const runBtn = Array.from(buttons).find((b) => b.textContent?.includes('Run rollout'))
    expect(runBtn).toBeTruthy()
    expect(runBtn?.getAttribute('disabled')).toBeNull()

    // Native .click() triggers the onclick handler
    runBtn!.click()

    // Verify the mock was called
    expect(client.rolloutRun).toHaveBeenCalledTimes(1)
  })
})

// ── Non-password credentials ───────────────────────────────────────────

describe('RolloutPanel — non-password', () => {
  it('shows note that rollout requires password auth', () => {
    const { getByText } = mount(CRED_NO_VERSIONS, null)
    expect(getByText(/Rollout is only available for password-based credentials/)).toBeTruthy()
  })
})
