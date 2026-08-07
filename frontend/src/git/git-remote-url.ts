// The remote-to-web-URL conversion (brief, nocx-hc0m) — ONE owner of the
// host table and the two URL shapes, with its own exhaustive tests.
//
// git remote get-url answers several spellings of the same repository, and
// the panel must never send a user to a URL it invented: scp-style, https
// and ssh:// forms of one repository must produce the same web URL, `.git`
// and trailing slashes are noise, and a local-path remote or a host with
// no known web UI produces NO link rather than a guessed one (design D14).
//
// The hosts this module claims to know are exactly the three public ones,
// each with its own branch and commit path shapes:
//
//	github.com    /tree/<branch>      /commit/<hash>
//	gitlab.com    /-/tree/<branch>    /-/commit/<hash>
//	bitbucket.org /branch/<branch>    /commits/<hash>
//
// Anything else — git://, a self-hosted GitLab, a bare host, a Windows
// drive — is null, and the panel draws no link. The wire carries the RAW
// remote URL (git.remote); this module is where it becomes a web page.

interface HostShapes {
  branch: (b: string) => string
  commit: (h: string) => string
}

const HOSTS: Record<string, HostShapes> = {
  'github.com': { branch: (b) => `/tree/${b}`, commit: (h) => `/commit/${h}` },
  'gitlab.com': { branch: (b) => `/-/tree/${b}`, commit: (h) => `/-/commit/${h}` },
  'bitbucket.org': { branch: (b) => `/branch/${b}`, commit: (h) => `/commits/${h}` },
}

/** The parsed halves of a recognised remote: the host and the repository
 *  path, both already web-shaped (no .git, no trailing slash, segments
 *  encoded). Null when the remote is a local path or an unknown host. */
interface WebRemote {
  host: string
  path: string
}

/** Parse one remote URL into its web halves, or null when there is no web
 *  UI to open. Pure string work; every branch of it is tested. */
function toWebRemote(remote: string): WebRemote | null {
  const trimmed = remote.trim()
  if (trimmed === '') return null

  let host: string
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // URL forms. git:// is a transport this product refuses to map — a
    // recognised host on an unrecognised transport is still a guess.
    if (/^git:\/\//i.test(trimmed)) return null
    let u: URL
    try {
      u = new URL(trimmed)
    } catch {
      return null
    }
    host = u.hostname
    path = u.pathname
  } else {
    // scp-style: [user@]host:path — the colon sits before any slash. A
    // Windows drive (C:/x) parses here too, with a single-letter host,
    // which the host table then refuses — the outcome is still "no link".
    const m = /^([^/@:]+@)?([^/:]+):(.+)$/.exec(trimmed)
    if (m === null) return null
    host = m[2]
    path = m[3]
  }

  const known = host.toLowerCase()
  if (HOSTS[known] === undefined) return null
  let p = path
  // .git and a trailing slash are spelling, not identity — remove the
  // whole ".git" or ".git/" suffix, never a fixed character count.
  p = p.replace(/\.git\/?$/i, '')
  if (p.endsWith('/')) p = p.slice(0, -1)
  const segments = p
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s))
  if (segments.length === 0) return null
  return { host: known, path: segments.join('/') }
}

/** The repository's web root, e.g. https://github.com/owner/repo, or null
 *  when the remote has no web UI. */
export function webBase(remote: string): string | null {
  const w = toWebRemote(remote)
  if (w === null) return null
  return `https://${w.host}/${w.path}`
}

/** The branch's web URL, or null. The branch is encoded per segment: a
 *  branch name may contain slashes (feature/x), and those are separators,
 *  while anything else is encoded so a # or ? in a branch name cannot
 *  become URL syntax. */
export function branchUrl(remote: string, branch: string): string | null {
  const w = toWebRemote(remote)
  if (w === null || branch === '') return null
  const encoded = branch
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/')
  if (encoded === '') return null
  return `https://${w.host}/${w.path}${HOSTS[w.host].branch(encoded)}`
}

/** The commit's web URL, or null. */
export function commitUrl(remote: string, hash: string): string | null {
  const w = toWebRemote(remote)
  if (w === null || hash === '') return null
  return `https://${w.host}/${w.path}${HOSTS[w.host].commit(encodeURIComponent(hash))}`
}
