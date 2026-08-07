// The remote-to-web conversion, asserted case by case (brief, nocx-hc0m):
// scp-style, https and ssh:// spellings of one repository produce the SAME
// web URL, .git and trailing slashes are noise, and a local path, an
// unknown host or a bare host produces NO link — never a guess. Each case
// is asserted, not sampled (AGENTS.md rule 3).
import { describe, expect, it } from 'vitest'
import { branchUrl, commitUrl, webBase } from './git-remote-url'

// The same repository, three spellings (brief: "must produce the same web
// URL") — the case that makes this module exist.
const SAME_REPO = [
  'git@github.com:shady2k/nocx.git',
  'https://github.com/shady2k/nocx.git',
  'ssh://git@github.com:22/shady2k/nocx.git',
  'https://github.com/shady2k/nocx',
  'git@github.com:shady2k/nocx',
  'https://github.com/shady2k/nocx.git/',
  'ssh://git@github.com/shady2k/nocx.git',
]

describe('toWebRemote / webBase — the spellings of one repository', () => {
  it('produces the same web base for scp, https and ssh:// spellings', () => {
    for (const remote of SAME_REPO) {
      expect(webBase(remote), remote).toBe('https://github.com/shady2k/nocx')
    }
  })

  it('parses an https remote with a trailing slash', () => {
    expect(webBase('https://github.com/shady2k/nocx/')).toBe('https://github.com/shady2k/nocx')
  })

  it('strips a trailing .git case-insensitively', () => {
    expect(webBase('https://github.com/shady2k/nocx.GIT')).toBe('https://github.com/shady2k/nocx')
    expect(webBase('git@github.com:shady2k/nocx.git/')).toBe('https://github.com/shady2k/nocx')
  })

  it('keeps a multi-segment GitLab path (subgroups)', () => {
    expect(webBase('git@gitlab.com:group/subgroup/repo.git')).toBe(
      'https://gitlab.com/group/subgroup/repo',
    )
  })

  it('recognises bitbucket', () => {
    expect(webBase('https://bitbucket.org/shady2k/nocx.git')).toBe(
      'https://bitbucket.org/shady2k/nocx',
    )
  })

  it('matches the host case-insensitively', () => {
    expect(webBase('git@GitHub.com:shady2k/nocx.git')).toBe('https://github.com/shady2k/nocx')
  })

  it('ignores the port in an ssh:// spelling', () => {
    expect(webBase('ssh://git@github.com:2222/shady2k/nocx.git')).toBe(
      'https://github.com/shady2k/nocx',
    )
  })

  it('ignores the user in an scp-style spelling', () => {
    expect(webBase('deploy@github.com:shady2k/nocx.git')).toBe('https://github.com/shady2k/nocx')
  })
})

describe('toWebRemote — the refusals', () => {
  it('refuses an empty remote', () => {
    expect(webBase('')).toBeNull()
    expect(webBase('   ')).toBeNull()
  })

  it('refuses a local path — absolute, relative, and a file URL', () => {
    expect(webBase('/srv/git/repo.git')).toBeNull()
    expect(webBase('../other/repo')).toBeNull()
    expect(webBase('./repo')).toBeNull()
    expect(webBase('file:///srv/git/repo.git')).toBeNull()
  })

  it('refuses a Windows drive (parses as scp, refused by the host table)', () => {
    expect(webBase('C:/Users/me/repo.git')).toBeNull()
  })

  it('refuses an unknown host — never a GitHub-shaped guess at another host', () => {
    expect(webBase('git@gitlab.example.com:group/repo.git')).toBeNull()
    expect(webBase('https://github.example.net/owner/repo.git')).toBeNull()
    expect(webBase('git@example.com:owner/repo.git')).toBeNull()
  })

  it('refuses a bare host with no repository path', () => {
    expect(webBase('https://github.com')).toBeNull()
    expect(webBase('git@github.com:')).toBeNull()
  })

  it('refuses the git:// transport even on a recognised host', () => {
    expect(webBase('git://github.com/shady2k/nocx.git')).toBeNull()
  })

  it('refuses an unparseable URL', () => {
    expect(webBase('https://')).toBeNull()
    expect(webBase('not a remote at all')).toBeNull()
  })
})

describe('branchUrl — the branch shapes', () => {
  it('builds the GitHub tree URL', () => {
    expect(branchUrl('git@github.com:shady2k/nocx.git', 'main')).toBe(
      'https://github.com/shady2k/nocx/tree/main',
    )
  })

  it('builds the GitLab -/tree URL', () => {
    expect(branchUrl('git@gitlab.com:group/sub/repo.git', 'main')).toBe(
      'https://gitlab.com/group/sub/repo/-/tree/main',
    )
  })

  it('builds the Bitbucket branch URL', () => {
    expect(branchUrl('https://bitbucket.org/shady2k/nocx.git', 'main')).toBe(
      'https://bitbucket.org/shady2k/nocx/branch/main',
    )
  })

  it('keeps branch-name slashes as separators', () => {
    expect(branchUrl('git@github.com:shady2k/nocx.git', 'feature/quick-fix')).toBe(
      'https://github.com/shady2k/nocx/tree/feature/quick-fix',
    )
  })

  it('encodes a # or ? in a branch name so it cannot become URL syntax', () => {
    expect(branchUrl('git@github.com:shady2k/nocx.git', 'issue#42')).toBe(
      'https://github.com/shady2k/nocx/tree/issue%2342',
    )
    expect(branchUrl('git@github.com:shady2k/nocx.git', 'wip?x')).toBe(
      'https://github.com/shady2k/nocx/tree/wip%3Fx',
    )
  })

  it('is null without a recognised remote or a branch name', () => {
    expect(branchUrl('git@github.com:shady2k/nocx.git', '')).toBeNull()
    expect(branchUrl('/srv/git/repo.git', 'main')).toBeNull()
    expect(branchUrl('git@example.com:owner/repo.git', 'main')).toBeNull()
  })
})

describe('commitUrl — the commit shapes', () => {
  const HASH = '5738d62b66777a78af894c0708d3a7e8798a4d8d'

  it('builds the GitHub commit URL', () => {
    expect(commitUrl('git@github.com:shady2k/nocx.git', HASH)).toBe(
      `https://github.com/shady2k/nocx/commit/${HASH}`,
    )
  })

  it('builds the GitLab -/commit URL', () => {
    expect(commitUrl('git@gitlab.com:group/sub/repo.git', HASH)).toBe(
      `https://gitlab.com/group/sub/repo/-/commit/${HASH}`,
    )
  })

  it('builds the Bitbucket commits URL', () => {
    expect(commitUrl('https://bitbucket.org/shady2k/nocx.git', HASH)).toBe(
      `https://bitbucket.org/shady2k/nocx/commits/${HASH}`,
    )
  })

  it('is null without a recognised remote or a hash', () => {
    expect(commitUrl('git@github.com:shady2k/nocx.git', '')).toBeNull()
    expect(commitUrl('/srv/git/repo.git', HASH)).toBeNull()
  })

  it('the three spellings of one repository produce one commit URL', () => {
    for (const remote of SAME_REPO) {
      expect(commitUrl(remote, HASH), remote).toBe(`https://github.com/shady2k/nocx/commit/${HASH}`)
    }
  })
})
