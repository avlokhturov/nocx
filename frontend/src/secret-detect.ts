// The TypeScript port of internal/secrets detection (secrets.go) — the one
// frontend consumer is the offer-to-save: while the line is still ours,
// detectSecrets tells us a key was typed or pasted, and the offer stores it
// and replaces the literal with its reference.
//
// The rules live in Go and are the wire's masking authority (the single
// masked text is produced there, at the store write). This file is a SECOND
// copy of the same rules, and two copies drift — the parity tests
// (secret-detect.test.ts) mirror internal/secrets/secrets_test.go case for
// case, so a drift fails in the commit that made it, and the Go side stays
// the source of truth for wording and kind vocabulary. Prefer the wire when
// a detection seam exists; there is none, and per-keystroke RPC would be a
// round trip per character for a handful of regexes over a command line.
//
// Offsets are UTF-16 code-unit positions — what JS string slicing and
// CodeMirror positions use — NOT the byte offsets internal/secrets reports.
// For ASCII they are identical; the divergence is pinned by a test.
//
// One deliberate divergence from Go: \s in JS matches Unicode whitespace,
// in RE2 only ASCII. A command line typed at a prompt is ASCII; the
// difference is noted, not chased.
export { findReferences } from './secret-reference'

// ── kind vocabulary ────────────────────────────────────────────────────────

/** The closed vocabulary of what can be detected, in rule order. A new kind
 *  is a deliberate addition to the vocabulary, never a silent one. */
export const SECRET_KINDS = [
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
] as const

export type SecretKind = (typeof SECRET_KINDS)[number]

/** One secret-shaped region of the input. Offsets are inclusive/exclusive
 *  code-unit positions into the original input; the VALUE never appears in a
 *  finding — kind and offsets are the fact, the matched text is the thing
 *  being stored or masked. */
export interface SecretFinding {
  kind: SecretKind
  start: number
  end: number
}

// ── the rules (ported from internal/secrets, in order) ────────────────────

interface Candidate {
  start: number
  end: number
  repl: string
}

type RuleFinder = (input: string) => Candidate[]

const privateKeyRE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g
const openaiRE = /sk-[A-Za-z0-9_-]{10,}/g
const githubRE =
  /ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gho_[A-Za-z0-9]{10,}|ghu_[A-Za-z0-9]{10,}|ghs_[A-Za-z0-9]{10,}|ghr_[A-Za-z0-9]{10,}/g
const slackRE = /xapp-\d+-[A-Za-z0-9-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}/g
const awsRE = /AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}/g
const gitlabRE =
  /glpat-[A-Za-z0-9_-]{10,}|gloas-[A-Za-z0-9_-]{10,}|gldt-[A-Za-z0-9_-]{10,}|glrt-[A-Za-z0-9_.-]{10,}|glrtr-[A-Za-z0-9_.-]{10,}|glcbt-[A-Za-z0-9_-]{10,}|glptt-[A-Za-z0-9_-]{10,}|glft-[A-Za-z0-9_-]{10,}|glimt-[A-Za-z0-9_-]{10,}|glagent-[A-Za-z0-9_-]{10,}|glsoat-[A-Za-z0-9_-]{10,}|glffct-[A-Za-z0-9_-]{10,}|glwt-[A-Za-z0-9_-]{10,}|GR1348941[A-Za-z0-9_-]{10,}/g
const jwtRE = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){0,2}/g
const dbConnstrRE =
  /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:)([^@\s]+)(@)/g
const urlUserinfoRE = /(https?|wss?|ftp):\/\/([^/\s:@]+):([^/\s@]+)@/g
const authHeaderRE = /((?:Proxy-)?Authorization:\s*)([A-Za-z][\w.+-]*\s+)?([^\s"']+)/g
const secretHeaderRE =
  /((?:x-api-key|x-goog-api-key|api-key|apikey|x-api-token|x-auth-token|x-access-token)\s*:\s*)([^\s"']+)/g
const envAssignRE =
  /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50})(\s*=\s*)(\S+)/g
const highEntropyRE =
  /(--(?:token|password|passwd|secret|api-key|apikey|api_key|access-token|access_token|auth-token|auth_token|client-secret|client_secret|key|auth)\b)((?:[ \t]*=[ \t]*)|(?:[ \t]+))(?:'([^']{32,})'|"([^"]{32,})"|([^\s'"/]{32,}))/g

// ── masking helpers (the port's replacement half, pinned by parity tests;
//    the production mask is produced in Go at the store write) ─────────────

/** The port of redact.py's mask_secret: keep the first 4 and last 4 code
 *  points; below the floor of 12 the whole value becomes the placeholder. */
export function maskSecret(value: string): string {
  const runes = Array.from(value)
  if (runes.length < 12) return '***'
  return runes.slice(0, 4).join('') + '...' + runes.slice(-4).join('')
}

/** Strip one pair of surrounding matching quotes from a matched value, mask
 *  the inner text, and re-emit the quotes. */
function maskTokenValue(value: string): string {
  if (value.length >= 2) {
    const q = value[0]
    if ((q === "'" || q === '"') && value[value.length - 1] === q) {
      return q + maskSecret(value.slice(1, -1)) + q
    }
  }
  return maskSecret(value)
}

/** Reports whether value names a secret instead of being one: shell variable
 *  expansions ($VAR, ${VAR}), command substitutions ($(...) and `...`),
 *  programmatic env lookups and {{secret:NAME}} references. A leading digit
 *  after '$' (the "$2a$10$..." bcrypt shape) is not a variable name. */
function isReference(value: string): boolean {
  if (
    value.startsWith('{{secret:') ||
    value.startsWith('os.getenv(') ||
    value.startsWith('os.environ') ||
    value.startsWith('process.env')
  ) {
    return true
  }
  if (value === '') return false
  const first = value[0]
  if (first === '`') return true
  if (first === '$') {
    if (value.length < 2) return false
    const second = value[1]
    if (second === '{' || second === '(') return true
    const c = second
    return c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
  }
  return false
}

/** A value that names a secret has nothing to remove; a value whose opening
 *  quote is not closed inside the captured token continues past whitespace
 *  and masking the fragment would corrupt the command. */
function valueIsMaskable(value: string): boolean {
  if (value.length >= 1) {
    const q = value[0]
    if (q === "'" || q === '"') {
      if (value.length < 2 || value[value.length - 1] !== q) return false
      value = value.slice(1, -1)
    }
  }
  return !isReference(value)
}

// ── individual rule finders (mirrors secrets.go) ──────────────────────────

/** The port of the prefix-table rules with redact.py's boundary guard
 *  ((?<![A-Za-z0-9_-]) / (?![A-Za-z0-9_-])) — a prefix inside a word is not
 *  a key. RE2 lookarounds become the explicit token-char check. */
function prefixFinder(pattern: RegExp): RuleFinder {
  return (input) => {
    const out: Candidate[] = []
    for (const m of input.matchAll(pattern)) {
      const start = m.index
      const end = start + m[0].length
      if (start > 0 && isTokenChar(input[start - 1])) continue
      if (end < input.length && isTokenChar(input[end])) continue
      out.push({ start, end, repl: maskSecret(input.slice(start, end)) })
    }
    return out
  }
}

function isTokenChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch)
}

/**
 * Group offsets within one match, derived without the /d flag (the project
 * targets ES2021). The spans are ABSOLUTE input offsets, group 0 first (the
 * full match — always present). Every rule that uses this has non-repeating
 * groups in match order, so locating each group's text from the previous
 * group's end is exact — the regex engine placed it there, contiguously. A
 * group that did not participate (an unmatched alternative) is undefined.
 * The parity tests pin this derivation against the Go byte offsets.
 */
function groupSpans(m: RegExpExecArray): Array<[number, number] | undefined> {
  const spans: Array<[number, number] | undefined> = [[m.index, m.index + m[0].length]]
  let cursor = 0
  for (let i = 1; i < m.length; i++) {
    const g = m[i]
    if (g === undefined) {
      spans.push(undefined)
      continue
    }
    const rel = m[0].indexOf(g, cursor)
    spans.push([m.index + rel, m.index + rel + g.length])
    cursor = rel + g.length
  }
  return spans
}

function findPrivateKey(input: string): Candidate[] {
  const out: Candidate[] = []
  for (const m of input.matchAll(privateKeyRE)) {
    out.push({ start: m.index, end: m.index + m[0].length, repl: '[REDACTED PRIVATE KEY]' })
  }
  return out
}

function findJWT(input: string): Candidate[] {
  const out: Candidate[] = []
  for (const m of input.matchAll(jwtRE)) {
    out.push({ start: m.index, end: m.index + m[0].length, repl: maskSecret(m[0]) })
  }
  return out
}

/** protocol://user:PASSWORD@host — only the password is masked. */
function findDBConnstring(input: string): Candidate[] {
  const out: Candidate[] = []
  for (const m of input.matchAll(dbConnstrRE)) {
    const g = groupSpans(m)
    const password = input.slice(g[2]![0], g[2]![1])
    if (isReference(password)) continue
    out.push({
      start: g[0]![0],
      end: g[0]![1],
      repl: input.slice(g[1]![0], g[1]![1]) + '***' + input.slice(g[3]![0], g[3]![1]),
    })
  }
  return out
}

/** user:password@ for any web scheme — password masked as ***, user kept. */
function findURLUserinfo(input: string): Candidate[] {
  const out: Candidate[] = []
  for (const m of input.matchAll(urlUserinfoRE)) {
    const g = groupSpans(m)
    const password = input.slice(g[3]![0], g[3]![1])
    if (isReference(password)) continue
    out.push({
      start: g[0]![0],
      end: g[0]![1],
      repl: input.slice(g[1]![0], g[1]![1]) + '://' + input.slice(g[2]![0], g[2]![1]) + ':***@',
    })
  }
  return out
}

/** "[Proxy-]Authorization:" with any scheme plus the bare-credential form,
 *  and x-api-key style headers. The header name and scheme survive; the
 *  credential token is masked. */
function findAuthHeader(input: string): Candidate[] {
  const out: Candidate[] = []
  for (const m of input.matchAll(authHeaderRE)) {
    const g = groupSpans(m)
    const token = input.slice(g[3]![0], g[3]![1])
    if (isReference(token)) continue
    const scheme = g[2] ? input.slice(g[2][0], g[2][1]) : ''
    out.push({
      start: g[0]![0],
      end: g[0]![1],
      repl: input.slice(g[1]![0], g[1]![1]) + scheme + maskSecret(token),
    })
  }
  for (const m of input.matchAll(secretHeaderRE)) {
    const g = groupSpans(m)
    const value = input.slice(g[2]![0], g[2]![1])
    if (isReference(value)) continue
    out.push({
      start: g[0]![0],
      end: g[0]![1],
      repl: input.slice(g[1]![0], g[1]![1]) + maskSecret(value),
    })
  }
  return out
}

/** NAME=value assignments whose uppercase KEY contains a secret keyword. */
function findEnvAssignment(input: string): Candidate[] {
  if (!input.includes('=')) return []
  const out: Candidate[] = []
  for (const m of input.matchAll(envAssignRE)) {
    const g = groupSpans(m)
    const key = input.slice(g[1]![0], g[1]![1])
    const sep = input.slice(g[2]![0], g[2]![1])
    const value = input.slice(g[3]![0], g[3]![1])
    if (!valueIsMaskable(value)) continue
    out.push({ start: g[0]![0], end: g[0]![1], repl: key + sep + maskTokenValue(value) })
  }
  return out
}

/** High-entropy values in a credential position (a flag that names a
 *  credential, in its '=' or space-separated argument), length >= 32. */
function findHighEntropy(input: string): Candidate[] {
  const out: Candidate[] = []
  for (const m of input.matchAll(highEntropyRE)) {
    const g = groupSpans(m)
    const flag = input.slice(g[1]![0], g[1]![1])
    const sep = input.slice(g[2]![0], g[2]![1])
    let value = ''
    let quoted = ''
    if (g[3]) {
      value = input.slice(g[3][0], g[3][1])
      quoted = "'"
    } else if (g[4]) {
      value = input.slice(g[4][0], g[4][1])
      quoted = '"'
    } else if (g[5]) {
      value = input.slice(g[5][0], g[5][1])
    }
    if (isReference(value)) continue
    out.push({
      start: g[0]![0],
      end: g[0]![1],
      repl: flag + sep + quoted + maskSecret(value) + quoted,
    })
  }
  return out
}

// ── the deterministic pass (mirrors detectMatches in secrets.go) ───────────

/** Rules run in this order, and the order is the overlap priority: when two
 *  rules claim overlapping spans, the earlier rule wins and the later match
 *  is dropped whole. */
const RULES: ReadonlyArray<{ kind: SecretKind; find: RuleFinder }> = [
  { kind: 'private-key', find: findPrivateKey },
  { kind: 'openai', find: prefixFinder(openaiRE) },
  { kind: 'github-pat', find: prefixFinder(githubRE) },
  { kind: 'slack', find: prefixFinder(slackRE) },
  { kind: 'aws-access-key', find: prefixFinder(awsRE) },
  { kind: 'gitlab', find: prefixFinder(gitlabRE) },
  { kind: 'jwt', find: findJWT },
  { kind: 'db-connstring', find: findDBConnstring },
  { kind: 'url-userinfo', find: findURLUserinfo },
  { kind: 'auth-header', find: findAuthHeader },
  { kind: 'env-assignment', find: findEnvAssignment },
  { kind: 'high-entropy', find: findHighEntropy },
]

interface Match extends Candidate {
  kind: SecretKind
}

function detectMatches(input: string): Match[] {
  const kept: Match[] = []
  for (const rule of RULES) {
    for (const c of rule.find(input)) {
      if (overlapsAny(c, kept)) continue
      kept.push({ kind: rule.kind, start: c.start, end: c.end, repl: c.repl })
    }
  }
  kept.sort((a, b) => a.start - b.start || a.end - b.end)
  return kept
}

function overlapsAny(c: Candidate, kept: ReadonlyArray<Match>): boolean {
  for (const m of kept) {
    if (c.start < m.end && m.start < c.end) return true
  }
  return false
}

// ── the public API ─────────────────────────────────────────────────────────

/** Every secret-shaped region of `input`, in first-occurrence order. The
 *  port of internal/secrets.Detect, with the same rules and the same overlap
 *  policy. */
export function detectSecrets(input: string): SecretFinding[] {
  return detectMatches(input).map((m) => ({ kind: m.kind, start: m.start, end: m.end }))
}

/** The input with every detected secret replaced — the port's mirror of
 *  internal/secrets.Mask. The PRODUCTION mask is made in Go at the store
 *  write; this exists so the parity tests can pin the port against the Go
 *  golden cases byte for byte. */
export function maskSecrets(input: string): string {
  const ms = detectMatches(input)
  let out = ''
  let last = 0
  for (const m of ms) {
    out += input.slice(last, m.start) + m.repl
    last = m.end
  }
  out += input.slice(last)
  return out
}
