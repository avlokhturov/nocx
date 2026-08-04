/**
 * Recognise simple interactive SSH transitions from the command line
 * (nocx-atyf.3). A "go somewhere and open a shell" command — `ssh host`,
 * `ssh user@host`, `ssh -p 2222 host` — is a transition. A remote command,
 * redirection, pipeline, or non-interactive ssh is not.
 *
 * The same conservative principle as isEnvironmentEntry: a missed offer is
 * invisible and cheap; a wrong offer is noise. Unknown = false.
 */

/** Returns true when `line` is a simple interactive SSH login — the user
 *  is going somewhere and expects a shell, not running a remote command. */
export function isInteractiveTransition(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false

  const tokens = tokenize(trimmed)
  if (tokens.length < 2 || tokens[0] !== 'ssh') return false

  // A remote command, redirection or pipeline makes this non-interactive.
  for (const tok of tokens) {
    if (tok === '|' || tok === '>' || tok === '>>' || tok === '<' || tok === '2>&1') return false
  }

  // Collect the positional (non-flag) arguments after 'ssh'.
  const positional: string[] = []
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]
    // A flag that takes an argument: skip both.
    if (tok.startsWith('-') && tok !== '-' && i + 1 < tokens.length) {
      // Flags that take an argument: -p, -i, -o, -l, -e, -F, -J, -S, -w, -c, -m, -b
      // Flags that are standalone: -t, -T, -A, -X, -Y, -v, -q, -N, -f, -C, -k, -g, -G, -K, -n, -s, -4, -6, -V
      // Multi-char options: -tt, -vvv, -oFoo=bar (no space)
      const flagChar = tok[1]
      if (
        flagChar === 'p' ||
        flagChar === 'i' ||
        flagChar === 'o' ||
        flagChar === 'l' ||
        flagChar === 'e' ||
        flagChar === 'F' ||
        flagChar === 'J' ||
        flagChar === 'S' ||
        flagChar === 'w' ||
        flagChar === 'c' ||
        flagChar === 'm' ||
        flagChar === 'b'
      ) {
        i += 2
        continue
      }
      i++
      continue
    }
    positional.push(tok)
    i++
  }

  // An interactive transition is exactly: ssh + [flags] + destination, with
  // no remote command. That means exactly one positional argument (the host).
  if (positional.length !== 1) return false
  if (positional[0].startsWith('-')) return false // -V, -?, etc.

  return true
}

/**
 * Extract the destination from a simple `ssh` line. Returns the
 * user@host or host string that was typed, suitable as a consent key.
 * Call only after isInteractiveTransition returned true.
 */
export function extractDestination(line: string): string {
  const trimmed = line.trim()
  const tokens = tokenize(trimmed)

  // Walk tokens, skip 'ssh' and flags, take the first positional.
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.startsWith('-') && tok !== '-' && i + 1 < tokens.length) {
      // Skip flag + its argument if applicable.
      const flagChar = tok[1]
      if ('pioleFJSwcmb'.includes(flagChar)) {
        i += 2
        continue
      }
      i++
      continue
    }
    // Found the destination.
    return tok
  }
  return ''
}

/**
 * Build the rewritten ssh command for nocxify (nocx-pu4.6).
 *
 * Inserts `-t` (force PTY allocation) after `ssh` if not already present
 * and appends the pre-quoted launcher as the final argument. Returns null
 * when the rewrite is refused — `-T` (explicit no-PTY) or a line we cannot
 * confidently parse means the original line is sent unchanged.
 *
 * Fail-open is the invariant (ADR-0004 §1): anything uncertain about the
 * rewrite means return null. The launcher must already be shell-quoted
 * (single quotes with embedded-quote escaping) by the backend.
 */
export function buildRewrite(line: string, launcher: string): string | null {
  const trimmed = line.trim()
  const tokens = tokenize(trimmed)

  // Fail-open: if we cannot parse the line confidently, refuse.
  if (tokens.length < 2 || tokens[0] !== 'ssh') return null

  // -T means the user explicitly asked for no PTY allocation.
  // A remote command without a PTY cannot integrate, so refuse.
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === '-T') return null
  }

  // Check if -t (or -tt, -ttt etc.) is already present.
  const hasT = tokens.some((tok) => tok === '-t' || /^-t+$/.test(tok))

  // Slice the original text after "ssh" to preserve quoting around flags
  // and the destination. The tokenizer strips quotes; using the original
  // text keeps them intact.
  const afterSsh = trimmed.slice(tokens[0].length).trimStart()

  if (hasT) {
    return `ssh ${afterSsh} ${launcher}`
  }
  return `ssh -t ${afterSsh} ${launcher}`
}

/** Split a shell command line into tokens, respecting single and double
 *  quotes. Does NOT handle all shell quoting — just enough to find the
 *  destination in `ssh user@host`. */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < line.length) {
    // Skip whitespace.
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break

    let tok = ''
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i]
      i++ // skip opening quote
      while (i < line.length && line[i] !== quote) {
        if (line[i] === '\\' && i + 1 < line.length) i++
        tok += line[i++]
      }
      if (i < line.length) i++ // skip closing quote
    } else if (line[i] === '>' || line[i] === '<' || line[i] === '|') {
      // Redirection and pipe operators.
      tok = line[i]
      i++
      // Handle >> and 2>&1
      if (tok === '>' && i < line.length && line[i] === '>') {
        tok += '>'
        i++
      }
      if (tok === '2' && i < line.length && line[i + 1] === '>' && line[i + 2] === '&') {
        tok = '2>&1'
        i += 3
      }
    } else {
      while (
        i < line.length &&
        !/\s/.test(line[i]) &&
        line[i] !== '|' &&
        line[i] !== '>' &&
        line[i] !== '<'
      ) {
        tok += line[i++]
      }
    }
    tokens.push(tok)
  }
  return tokens
}
