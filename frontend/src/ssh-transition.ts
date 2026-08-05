/**
 * Recognise simple interactive SSH transitions from the command line and
 * produce a typed plan for the backend (nocx-atyf.3, nocx-c5az, nocx-sxdd).
 *
 * "Go somewhere and open a shell" — `ssh host`, `ssh user@host`,
 * `ssh -p 2222 host` — is a transition. A remote command, redirection,
 * pipeline, or non-interactive ssh is not.
 *
 * The same conservative principle as isEnvironmentEntry: a missed offer is
 * invisible and cheap; a wrong offer is noise. Unknown = refusal. The current
 * tokenizer does not understand full shell grammar, and that admission is a
 * refusal rather than a guess (nocx-mlm7 P4): anything the local shell would
 * expand ($VAR, backticks, unquoted backslash, history `!`, globs, braces) or
 * treat as grammar (| & ; < > ( ), comments) means the `ssh -G` oracle would
 * answer about a different argv than the one that runs — so the rewrite is
 * refused and the typed bytes go to the pty unchanged.
 */

/** Why a typed line is refused. Each refusal means: send the typed bytes. */
export type SshRefusalReason =
  | 'not-ssh'
  | 'no-destination'
  | 'remote-command'
  | 'shell-operator'
  | 'unparseable'
  | 'unknown-option'
  | 'double-dash'
  | 'no-pty'
  | 'no-shell'
  | 'background'
  | 'stdio-forward'
  | 'dynamic-forward'
  | 'control-command'
  | 'config-query'
  | 'non-interactive-forward'
  | 'inside-environment'

/** One accepted option, exactly as typed. */
export interface SshOption {
  /** The option letter, e.g. 'p'. For a cluster the letter that takes the value. */
  letter: string
  /** The option token exactly as typed: '-p', '-p2222', '-tt', '-vAp2222'. */
  token: string
  /** The value, unquoted, exactly as typed; null for a standalone flag. */
  value: string | null
  /** The value token exactly as typed when it was a separate token (`2222`
   *  for `-p 2222`); null when the value was attached (`-p2222`) or the
   *  option is standalone. */
  valueToken: string | null
}

/**
 * A typed ssh plan — the value the renderer hands the backend instead of a
 * bare destination (nocx-c5az). P7 consumes it: `oracleArgv` is the complete
 * argv for the `ssh -G` oracle, `options`/`destination` are the parsed parts
 * for the installed-fact identity key.
 */
export interface SshPlan {
  kind: 'plan'
  /** The submitted line, trimmed, verbatim — the else-branch text. */
  typedLine: string
  /** The destination positional, unquoted, exactly as typed. */
  destination: string
  /** Every accepted option in typed order. */
  options: SshOption[]
  /** Complete argv for the `ssh -G` oracle, ready to exec:
   *  ['ssh', '-G', ...options, destination]. Option tokens pass through as
   *  typed; getopt parses clusters and attached values identically to the
   *  real ssh. */
  oracleArgv: string[]
}

export interface SshRefusal {
  kind: 'refusal'
  typedLine: string
  reason: SshRefusalReason
}

export type SshTransition = SshPlan | SshRefusal

export function isSshPlan(t: SshTransition): t is SshPlan {
  return t.kind === 'plan'
}

/** OpenSSH options that take an argument (ssh(1) OPTIONS). */
const VALUE_LETTERS: Record<string, true> = {
  b: true,
  c: true,
  D: true,
  E: true,
  e: true,
  F: true,
  I: true,
  i: true,
  J: true,
  L: true,
  l: true,
  m: true,
  O: true,
  o: true,
  p: true,
  Q: true,
  R: true,
  w: true,
  S: true,
  W: true,
}

/** OpenSSH options that are standalone flags. */
const FLAG_LETTERS: Record<string, true> = {
  '4': true,
  '6': true,
  A: true,
  a: true,
  C: true,
  f: true,
  G: true,
  g: true,
  K: true,
  k: true,
  M: true,
  N: true,
  n: true,
  q: true,
  s: true,
  T: true,
  t: true,
  V: true,
  v: true,
  X: true,
  x: true,
  Y: true,
  y: true,
}

/**
 * The environment id minted per attempt (§5.3 of the delivery-modes spec):
 * the passport charset `[A-Za-z0-9._-]{1,64}`, which is also exactly what is
 * safe to splice into the single-quoted remote command of the installed form.
 */
const ENVIRONMENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/** The largest line a canonical-mode tty carries intact. The kernel's buffer
 *  is N_TTY_BUF_SIZE = 4096; measured on a real Linux pty, 4095 bytes on one
 *  line survive and 8000 already lose data, so the usable ceiling is 4095. */
const MAX_CANONICAL_LINE = 4095

/**
 * Classify a submitted line into a plan or a refusal.
 *
 * `environmentDepth > 0` (a remote environment) ⟹ refusal: a local staged
 * path would be read by a remote shell, so this epic builds no rewrite inside
 * one (§6.1).
 *
 * Option values are literal. A `$`, backtick, unquoted backslash, `!`, `*`,
 * `?` or `{` outside single quotes is shell expansion the renderer cannot
 * resolve, so the oracle would see a different argv than the shell builds —
 * that is the refusal, not a guess. `~` is allowed: the local shell and
 * `ssh -G` expand it identically, so the oracle stays faithful.
 */
export function planSsh(line: string, environmentDepth: number): SshTransition {
  const trimmed = line.trim()
  if (environmentDepth > 0) {
    return { kind: 'refusal', typedLine: trimmed, reason: 'inside-environment' }
  }
  if (trimmed === '') {
    return { kind: 'refusal', typedLine: trimmed, reason: 'not-ssh' }
  }
  if (trimmed.includes('\n')) {
    // A second line would become a second command after the splice.
    return { kind: 'refusal', typedLine: trimmed, reason: 'unparseable' }
  }

  // Tokenize first so a non-ssh line reports 'not-ssh' rather than whatever
  // its grammar contains. The tokenizer is tolerant; the scanner below is the
  // validator.
  const tokens = tokenize(trimmed)
  if (tokens[0] !== 'ssh') {
    return { kind: 'refusal', typedLine: trimmed, reason: 'not-ssh' }
  }
  // The first token must be the literal word `ssh` at position 0 — a quoted
  // `"ssh"` would corrupt the raw splice that the wrapper builders rely on.
  if (!/^ssh(?:\s|$)/.test(trimmed)) {
    return { kind: 'refusal', typedLine: trimmed, reason: 'unparseable' }
  }

  const grammar = scanForGrammar(trimmed)
  if (grammar !== null) {
    return { kind: 'refusal', typedLine: trimmed, reason: grammar }
  }

  const parsed = parseOptions(tokens)
  if (parsed.refusal !== null) {
    return { kind: 'refusal', typedLine: trimmed, reason: parsed.refusal }
  }

  // The refusal cascade. -L/-R are refused only when they build a
  // non-interactive session (with -N or -f); the rest are refused outright.
  const { letters, options, positionals } = parsed
  if ((letters.has('L') || letters.has('R')) && (letters.has('N') || letters.has('f'))) {
    return { kind: 'refusal', typedLine: trimmed, reason: 'non-interactive-forward' }
  }
  if (letters.has('T')) return { kind: 'refusal', typedLine: trimmed, reason: 'no-pty' }
  if (letters.has('N')) return { kind: 'refusal', typedLine: trimmed, reason: 'no-shell' }
  if (letters.has('f')) return { kind: 'refusal', typedLine: trimmed, reason: 'background' }
  if (letters.has('W')) return { kind: 'refusal', typedLine: trimmed, reason: 'stdio-forward' }
  if (letters.has('D')) return { kind: 'refusal', typedLine: trimmed, reason: 'dynamic-forward' }
  if (letters.has('O')) return { kind: 'refusal', typedLine: trimmed, reason: 'control-command' }
  if (letters.has('G') || letters.has('Q')) {
    return { kind: 'refusal', typedLine: trimmed, reason: 'config-query' }
  }

  if (positionals.length === 0 || positionals[0] === '') {
    return { kind: 'refusal', typedLine: trimmed, reason: 'no-destination' }
  }
  if (positionals.length > 1) {
    return { kind: 'refusal', typedLine: trimmed, reason: 'remote-command' }
  }
  const destination = positionals[0]

  const oracleArgv: string[] = ['ssh', '-G']
  for (const opt of options) {
    oracleArgv.push(opt.token)
    if (opt.valueToken !== null) oracleArgv.push(opt.valueToken)
  }
  oracleArgv.push(destination)

  return { kind: 'plan', typedLine: trimmed, destination, options, oracleArgv }
}

interface ParsedArgs {
  options: SshOption[]
  positionals: string[]
  /** Every option letter seen, for the refusal cascade. */
  letters: Set<string>
  refusal: SshRefusalReason | null
}

/** Walk the tokens after 'ssh' with getopt semantics: flags cluster, a
 *  value-taking letter consumes the rest of the token or the next token. */
function parseOptions(tokens: string[]): ParsedArgs {
  const options: SshOption[] = []
  const positionals: string[] = []
  const letters = new Set<string>()
  let refusal: SshRefusalReason | null = null

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '--') {
      refusal = 'double-dash'
      break
    }
    if (tok === '-') {
      refusal = 'unparseable'
      break
    }
    if (tok.startsWith('-') && tok.length > 1) {
      let value: string | null = null
      let valueToken: string | null = null
      let valueLetter: string | null = null
      let j = 1
      while (j < tok.length) {
        const letter = tok[j]
        if (FLAG_LETTERS[letter]) {
          letters.add(letter)
          j++
          continue
        }
        if (VALUE_LETTERS[letter]) {
          letters.add(letter)
          valueLetter = letter
          const rest = tok.slice(j + 1)
          if (rest.length > 0) {
            value = rest
          } else {
            if (i + 1 >= tokens.length) {
              // A value-taking option with no value left: refuse rather than
              // guess what ssh would have done.
              refusal = 'unparseable'
              break
            }
            i++
            value = tokens[i]
            valueToken = tokens[i]
          }
          break
        }
        refusal = 'unknown-option'
        break
      }
      if (refusal !== null) break
      options.push({ letter: valueLetter ?? tok[1], token: tok, value, valueToken })
      continue
    }
    positionals.push(tok)
  }

  return { options, positionals, letters, refusal }
}

/**
 * Scan the raw line, outside quotes, for shell grammar the tokenizer cannot
 * parse confidently. Returns the refusal reason, or null when the line is
 * safe. Single quotes make bytes literal; double quotes still expand `$`,
 * backticks, `\` and `!`, so those refuse inside double quotes too.
 */
function scanForGrammar(line: string): SshRefusalReason | null {
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < line.length && line[i] !== quote) {
        if (
          quote === '"' &&
          (line[i] === '$' || line[i] === '`' || line[i] === '\\' || line[i] === '!')
        ) {
          return 'unparseable'
        }
        i++
      }
      if (i >= line.length) return 'unparseable' // unterminated quote
      i++
      continue
    }
    if (c === '|' || c === '&' || c === ';' || c === '<' || c === '>' || c === '(' || c === ')') {
      return 'shell-operator'
    }
    if (
      c === '$' ||
      c === '`' ||
      c === '!' ||
      c === '\\' ||
      c === '*' ||
      c === '?' ||
      c === '{' ||
      c === '}'
    ) {
      return 'unparseable'
    }
    if (c === '#') {
      // A word-start # is a comment; spliced into the wrapper it would
      // swallow the appended payload, so the whole line refuses.
      return 'unparseable'
    }
    // Word: everything else is literal (including `~`, `[`, `]`, `%`, `=`,
    // `:` — an IPv6 destination like 'user@[fe80::1]%eth0' must survive).
    while (
      i < line.length &&
      !/\s/.test(line[i]) &&
      !'|&;<>()$`!\\*?{}#'.includes(line[i]) &&
      line[i] !== "'" &&
      line[i] !== '"'
    ) {
      i++
    }
  }
  return null
}

/** Split a validated line into unquoted tokens. Quotes are removed; single
 *  quotes keep their bytes literal. Call only after scanForGrammar passed. */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break
    let tok = ''
    while (i < line.length) {
      const c = line[i]
      if (/\s/.test(c)) break
      if (c === "'" || c === '"') {
        const quote = c
        i++
        while (i < line.length && line[i] !== quote) {
          tok += line[i]
          i++
        }
        i++ // closing quote — the scanner guaranteed one
        continue
      }
      tok += c
      i++
    }
    tokens.push(tok)
  }
  return tokens
}

/** Returns true when `line` is a simple interactive SSH login — the user
 *  is going somewhere and expects a shell, not running a remote command.
 *  Kept for environment-commands.ts; the plan is the same answer, richer. */
export function isInteractiveTransition(line: string): boolean {
  return planSsh(line, 0).kind === 'plan'
}

/**
 * Extract the destination from a simple `ssh` line. Returns the
 * user@host or host string that was typed, suitable as a consent key.
 * Call only after isInteractiveTransition returned true.
 */
export function extractDestination(line: string): string {
  const plan = planSsh(line, 0)
  return plan.kind === 'plan' ? plan.destination : ''
}

/**
 * Build the rewritten ssh command for nocxify (nocx-pu4.6, nocx-sxdd) —
 * the bootstrap form of §3.2: the launcher travels in a staged local file
 * because the canonical tty line is capped at 4096 bytes, read by the local
 * shell at execution time, handed to ssh through argv (bounded by ARG_MAX).
 *
 *     if [ -s '<path>' ]; then ssh -t <flags> <dest> "$(cat '<path>'; rm -f '<path>')"; else <original>; fi
 *
 * `-t` is required: a remote command otherwise gets no pty.
 *
 * Fail-open is the invariant (ADR-0004 §1), stated twice. Here: `-T` (explicit
 * no-PTY), a non-interactive form, or a line we cannot confidently parse
 * returns null and the original goes to the pty. And in the line itself:
 * `[ -s … ]` means a staged file that is missing, empty or unreadable runs
 * exactly what the user typed. The `else` branch is deliberately not `||` —
 * chaining off the exit status would open a SECOND connection every time the
 * integrated ssh exited non-zero.
 *
 * Consume-once (nocx-sxdd): `rm -f '<path>'` sits INSIDE the command
 * substitution, so the file is read and removed before ssh is even spawned
 * and the branch's status stays ssh's own — `ssh …; rm -f P` would report
 * `rm`'s success and destroy the 255 a dropped connection must deliver.
 * Recalling the rewritten line from the shell's own history with Ctrl-R takes
 * the else branch instead of bootstrapping again. The file outliving its
 * command is the defect; `stage.go` stays a safety net for abandoned files.
 *
 * `launcherPath` must already be shell-quoted by the backend.
 */
export function buildRewrite(
  line: string,
  launcherPath: string,
  environmentDepth = 0,
): string | null {
  const plan = planSsh(line, environmentDepth)
  if (plan.kind !== 'plan') return null
  return buildBootstrapRewrite(plan, launcherPath)
}

/** The typed argv after 'ssh', verbatim — quotes and all, so the wrapper the
 *  shell re-parses is byte-for-byte what the user wrote. */
function rawAfterSsh(plan: SshPlan): string {
  return plan.typedLine.slice('ssh'.length).trimStart()
}

/** `ssh -t <raw>` unless the user already asked for a pty (-t, -tt, …). */
function integratedSsh(plan: SshPlan, raw: string): string {
  const hasT = plan.options.some((o) => /^-t+$/.test(o.token))
  return hasT ? `ssh ${raw}` : `ssh -t ${raw}`
}

/**
 * The bootstrap wrapper of §3.2 for an already-accepted plan: the staged
 * launcher is read at execution time and consumed by the run (nocx-sxdd).
 * Returns null when the line would not survive the 4095-byte tty ceiling.
 *
 *     if [ -s '<path>' ]; then ssh -t <flags> <dest> "$(cat '<path>'; rm -f '<path>')"; else <typed>; fi
 *
 * The removal lives INSIDE the command substitution, not after the ssh:
 * `ssh …; rm -f P` would make `rm`'s success the branch's exit status and
 * destroy the 255 a dropped connection must deliver (130 on Ctrl-C, the
 * remote code on `exit`). Inside `$(cat P; rm -f P)` the payload has already
 * been read, the file is consumed before ssh is even spawned, and the branch
 * status stays ssh's own.
 */
export function buildBootstrapRewrite(plan: SshPlan, launcherPath: string): string | null {
  const integrated = integratedSsh(plan, rawAfterSsh(plan))
  const rewritten =
    `if [ -s ${launcherPath} ]; then ${integrated} "$(cat ${launcherPath}; rm -f ${launcherPath})"; ` +
    `else ${plan.typedLine}; fi`

  // The ceiling this whole design exists to respect, enforced rather than
  // assumed. The line carries two copies of the path, and a path can be
  // PATH_MAX (4096) by itself, so "it is only a path, it must be short" is
  // not a property. If it would not survive the line discipline there is no
  // rewrite to make.
  if (new TextEncoder().encode(rewritten).byteLength > MAX_CANONICAL_LINE) return null
  return rewritten
}

/**
 * The installed-host form of §3.3, generated when the bundle is committed on
 * the far side:
 *
 *     ssh -t <flags> <dest> 'if [ -x "$HOME/.nocx/launch" ]; then exec "$HOME/.nocx/launch" <environment-id>; else exec "${SHELL:-/bin/sh}" -l; fi'
 *
 * The guard travels inside the remote command because the only machine whose
 * `~/.nocx` is in question is the far one — a local `[ -x ~/.nocx/launch ]`
 * test asks this machine about that host, and on a developer's box it answers
 * about nocx's own local staging directory. There is no local guard and no
 * local `else` branch; ssh is called unconditionally.
 *
 * The remote command is single-quoted so the LOCAL shell passes it as one
 * argv element and leaves `$HOME` and `$SHELL` unexpanded for the FAR shell.
 * The remote `else` covers the one case the launch script cannot cover — its
 * own absence — by exec'ing a native login shell, which is what ssh would
 * have provided without a command.
 *
 * `environmentId` must match the passport charset (§5.2); anything else is
 * refused by returning null.
 */
export function buildInstalledRewrite(plan: SshPlan, environmentId: string): string | null {
  if (!ENVIRONMENT_ID_RE.test(environmentId)) return null
  const integrated = integratedSsh(plan, rawAfterSsh(plan))
  const remote =
    `if [ -x "$HOME/.nocx/launch" ]; then exec "$HOME/.nocx/launch" ${environmentId}; ` +
    `else exec "\${SHELL:-/bin/sh}" -l; fi`
  const rewritten = `${integrated} '${remote}'`

  if (new TextEncoder().encode(rewritten).byteLength > MAX_CANONICAL_LINE) return null
  return rewritten
}
