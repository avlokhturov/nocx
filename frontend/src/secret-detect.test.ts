// Parity tests for the TypeScript port of internal/secrets (secret-detect.ts).
// The fixtures mirror internal/secrets/secrets_test.go case for case, so a
// drift between the two rule sets fails HERE, in the same commit that made it.
// The one deliberate divergence: Go findings carry BYTE offsets, the port
// carries UTF-16 code-unit offsets (what CodeMirror positions and JS string
// slicing use). For ASCII input they are identical; the UTF-8 test below pins
// the divergence explicitly.
import { describe, it, expect } from 'vitest'
import {
  detectSecrets,
  maskSecrets,
  findReferences,
  SECRET_KINDS,
  type SecretKind,
} from './secret-detect'

describe('secret-detect: golden cases (mirrors TestMaskGoldenCases)', () => {
  const cases: Array<{ name: string; input: string; want: string; kind: SecretKind }> = [
    { name: 'openai', input: 'sk-proj-abcdef1234567890', want: 'sk-p...7890', kind: 'openai' },
    {
      name: 'github classic pat',
      input: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      want: 'ghp_...6789',
      kind: 'github-pat',
    },
    {
      name: 'slack token',
      input: 'xoxp-abcdefghijklmnopqrstuvwxyz1234567890',
      want: 'xoxp...7890',
      kind: 'slack',
    },
    {
      name: 'aws access key',
      input: 'AKIAIOSFODNN7EXAMPLE',
      want: 'AKIA...MPLE',
      kind: 'aws-access-key',
    },
    {
      name: 'gitlab pat',
      input: 'glpat-abcdefghijklmnopqrstuvwxyz123456',
      want: 'glpa...3456',
      kind: 'gitlab',
    },
    {
      name: 'jwt',
      input:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      want: 'eyJh...sw5c',
      kind: 'jwt',
    },
    {
      name: 'private key block',
      input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7dGJ\n-----END RSA PRIVATE KEY-----',
      want: '[REDACTED PRIVATE KEY]',
      kind: 'private-key',
    },
    {
      name: 'url userinfo',
      input: 'https://user:sup3rs3cret@api.example.com/v1',
      want: 'https://user:***@api.example.com/v1',
      kind: 'url-userinfo',
    },
    {
      name: 'github pat inside url userinfo',
      input: 'https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/org/repo.git',
      want: 'https://ghp_...6789@github.com/org/repo.git',
      kind: 'github-pat',
    },
    {
      name: 'db connstring',
      input: 'postgres://dbuser:dbpass123@db.internal:5432/main',
      want: 'postgres://dbuser:***@db.internal:5432/main',
      kind: 'db-connstring',
    },
    {
      name: 'dollar-prefixed literal is not a reference',
      input: `deploy --password='$2a$10$abcdefghijklmnopqrstuvwxyz123456'`,
      want: `deploy --password='$2a$...3456'`,
      kind: 'high-entropy',
    },
    {
      name: 'secret header',
      input: `curl -H "x-api-key: abcdefghijklmnopqrstuvwxyz123456" https://api`,
      want: `curl -H "x-api-key: abcd...3456" https://api`,
      kind: 'auth-header',
    },
    {
      name: 'env assignment long value',
      input: 'export OPENAI_TOKEN=abcdefghijklmnopqrstuvwxyz ./run.sh',
      want: 'export OPENAI_TOKEN=abcd...wxyz ./run.sh',
      kind: 'env-assignment',
    },
    {
      name: 'env assignment short value',
      input: 'TOKEN=short',
      want: 'TOKEN=***',
      kind: 'env-assignment',
    },
    {
      name: 'env assignment quoted',
      input: `TOKEN="abcdefghijklmnopqrstuvwxyz"`,
      want: `TOKEN="abcd...wxyz"`,
      kind: 'env-assignment',
    },
    {
      name: 'high-entropy after flag',
      input: 'deploy --token abcdefghijklmnopqrstuvwxyz123456',
      want: 'deploy --token abcd...3456',
      kind: 'high-entropy',
    },
    {
      name: 'high-entropy flag equals',
      input: 'deploy --password=abcdefghijklmnopqrstuvwxyz123456',
      want: 'deploy --password=abcd...3456',
      kind: 'high-entropy',
    },
    {
      name: 'high-entropy quoted value',
      input: `deploy --token='abcdefghijklmnopqrstuvwxyz123456'`,
      want: `deploy --token='abcd...3456'`,
      kind: 'high-entropy',
    },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      const masked = maskSecrets(tc.input)
      expect(masked).toBe(tc.want)
      const findings = detectSecrets(tc.input)
      expect(findings).toHaveLength(1)
      expect(findings[0].kind).toBe(tc.kind)
      // The finding span slices the input, and the span's text is gone from
      // the masked output (the same invariant the Go test pins).
      const span = tc.input.slice(findings[0].start, findings[0].end)
      expect(span.length).toBeGreaterThan(0)
      expect(masked).not.toContain(span)
    })
  }
})

describe('secret-detect: negative cases (mirrors TestMaskNegativeCases)', () => {
  const cases: string[] = [
    'git checkout 9f8e7d6c5b4a3928172635445362718291048576',
    'cat /tmp/550e8400-e29b-41d4-a716-446655440000.log',
    `echo "aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyBmb3IgdGVzdGluZw=="`,
    '/home/user/very/long/path/to/some/deeply/nested/directory/file.txt',
    'prog --output /tmp/some/long/output/file/name/that/goes/on/and/on/forever.txt',
    'prog --output=/tmp/some/long/output/file/name/that/goes/on/and/on/forever.txt',
    'https://example.com/cb?code=ABC123&state=xyz',
    'ssh user@10.0.0.1 -p 2222',
    'author=Smith',
    'keyboard=abc',
    'ls -la /var/log/something/very/long/that/is/just/a/path/with/no/equals/or/flags',
    'echo 550e8400e29b41d4a716446655440000',
    'ssh://developer@example.com',
    'git clone ssh://myusername@github.com/o/r.git',
    'https://sup3rt0kenvalue12345@github.com/org/repo.git',
    `curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api`,
    `curl -H "Authorization: Bearer ${'${OPENAI_API_KEY}'}" https://api`,
    `curl -H "Authorization: Bearer $(pass show gh/token)" https://api`,
    `curl -H "Authorization: Bearer {{secret:OPENAI}}" https://api`,
    'curl -H "Authorization: Bearer `pass show gh/token`" https://api',
    `curl -H "x-api-key: $API_KEY" https://api`,
    'TOKEN={{secret:GH}} gh repo list',
    "TOKEN='{{secret:GH}}' ./run.sh",
    'TOKEN=${OPENAI_API_KEY} ./run.sh',
    'export GITHUB_TOKEN=$(pass show gh/token)',
    `export GITHUB_TOKEN="$(pass show gh/token)"`,
    `export GITHUB_TOKEN='pass show gh/token'`,
    `export TOKEN="some pass phrase with spaces"`,
    "export API_KEY=os.getenv('X') ./run.sh",
    'export API_KEY=process.env.TOKEN ./run.sh',
    'export API_KEY=$ENV{TOKEN} ./run.sh',
    `--token "$(cat /tmp/some/very/long/secret/file/path/here.txt)"`,
    `--token '$(cat /tmp/some/very/long/secret/file/path/here.txt)'`,
  ]

  for (const input of cases) {
    it(`leaves alone: ${input.slice(0, 60)}`, () => {
      expect(maskSecrets(input)).toBe(input)
      expect(detectSecrets(input)).toHaveLength(0)
    })
  }
})

describe('secret-detect: references (mirrors TestMaskLeavesReferencesByteForByte)', () => {
  const cases: string[] = [
    `curl -H "Authorization: Bearer {{secret:OPENAI}}" https://api`,
    'TOKEN={{secret:GH}} gh repo list',
    'export GITHUB_TOKEN={{secret:GH}} && ./run.sh',
    `deploy --token "{{secret:db-password}}" --region eu`,
    'echo {{secret:with space in name}}',
  ]

  for (const input of cases) {
    it(`reference intact: ${input.slice(0, 60)}`, () => {
      expect(maskSecrets(input)).toBe(input)
      expect(detectSecrets(input)).toHaveLength(0)
    })
  }
})

describe('secret-detect: prefix boundary guard (mirrors TestMaskPrefixBoundaryGuard)', () => {
  const cases: string[] = [
    'mysk-proj-abcdefghijklmnopqrstuvwxyz',
    'prefix_ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'mxoxp-token-abcdefghijklmnopqrstuvwxyz1234567890-suffix',
    'xsk-proj-abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLEa',
  ]
  for (const input of cases) {
    it(`boundary guard: ${input.slice(0, 50)}`, () => {
      expect(maskSecrets(input)).toBe(input)
    })
  }
})

describe('secret-detect: overlap resolution (mirrors TestMaskOverlapResolutionDeterministic)', () => {
  it('a recognised prefix beats the position heuristic', () => {
    const input = 'deploy --token sk-proj-abcdefghijklmnopqrstuvwxyz123456'
    expect(maskSecrets(input)).toBe('deploy --token sk-p...3456')
    const findings = detectSecrets(input)
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('openai')
  })
})

describe('secret-detect: findings reproduce the mask (mirrors TestMaskFindingsAreByteOffsetsAndReproduceMask)', () => {
  it('findings slice the input and their text never survives into the output', () => {
    const input = 'выполнить TOKEN=abcdefghijklmnopqrstuvwxyz123456'
    const masked = maskSecrets(input)
    expect(masked).toContain('TOKEN=abcd...3456')
    const findings = detectSecrets(input)
    expect(findings).toHaveLength(1)
    // The DELIBERATE divergence: Go reports byte offsets (19 for a 9-rune
    // Cyrillic prefix); the port reports UTF-16 code-unit offsets (10), which
    // is what CM6 positions and JS string slicing use.
    expect(findings[0].start).toBe(10)
    const span = input.slice(findings[0].start, findings[0].end)
    expect(span.length).toBeGreaterThan(0)
    expect(masked).not.toContain(span)
    expect(masked.startsWith('выполнить ')).toBe(true)
  })

  it('a rune-safe mask keeps the head and tail (mirrors TestMaskRuneSafeValue)', () => {
    const input = 'deploy --token абвгдежзиклмнопрстуфхцчшщъыьэюяя'
    const masked = maskSecrets(input)
    const findings = detectSecrets(input)
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('high-entropy')
    expect(masked).toMatch(/^deploy --token абвг\.\.\.эюяя$/)
  })

  it('long bare words after non-credential flags are left alone (mirrors TestMaskLongBareWordsLeftAlone)', () => {
    expect(maskSecrets('run --batch abcdefghijklmnopqrstuvwxyz1234567890')).toBe(
      'run --batch abcdefghijklmnopqrstuvwxyz1234567890',
    )
    expect(maskSecrets('tool name=abcdefghijklmnopqrstuvwxyz1234567890')).toBe(
      'tool name=abcdefghijklmnopqrstuvwxyz1234567890',
    )
  })
})

describe('secret-detect: kind vocabulary (mirrors TestKindVocabulary)', () => {
  it('is the closed set, in order', () => {
    expect(SECRET_KINDS).toEqual([
      'openai',
      'github-pat',
      'slack',
      'aws-access-key',
      'gitlab',
      'jwt',
      'private-key',
      'url-userinfo',
      'db-connstring',
      'auth-header',
      'env-assignment',
      'high-entropy',
    ])
  })
})

describe('findReferences', () => {
  it('finds every reference span with its name', () => {
    expect(findReferences('echo {{secret:OPENAI}} && echo {{secret:with space}}')).toEqual([
      { from: 5, to: 22, name: 'OPENAI' },
      { from: 31, to: 52, name: 'with space' },
    ])
  })

  it('returns [] for a line without references', () => {
    expect(findReferences('curl https://api')).toEqual([])
  })
})

// Parity with internal/secrets/secrets_test.go's TestAuthHeaderWithNoCredentialYet:
// deleting a key to paste a new one leaves `Authorization: Bearer ` on screen.
// The Go side PANICKED on the absent scheme group; this side offered to store
// the word "Bearer", which the owner saw as `Auth...arer` in the offer row.
describe('an Authorization header with no credential yet', () => {
  it('is not a secret, with or without the scheme', () => {
    for (const input of [
      'curl -H "Authorization: Bearer " https://api',
      'curl -H "Authorization: Bearer" https://api',
      'curl -H "Authorization: Basic " https://api',
      'curl -H "Authorization: " https://api',
      'curl -H "Proxy-Authorization: Digest " https://api',
    ]) {
      expect(maskSecrets(input)).toBe(input)
      expect(detectSecrets(input)).toEqual([])
    }
  })

  it('still masks a real credential', () => {
    expect(maskSecrets('curl -H "Authorization: Bearer abcdefghijklmnop" x')).toBe(
      'curl -H "Authorization: Bearer abcd...mnop" x',
    )
    expect(maskSecrets('curl -H "Authorization: abcdefghijklmnop" x')).toBe(
      'curl -H "Authorization: abcd...mnop" x',
    )
  })
})
