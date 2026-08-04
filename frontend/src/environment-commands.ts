/**
 * Recognise commands that enter a new shell environment from the line the
 * user submitted (ADR-0004 §2: the renderer knows what it sent — knowledge
 * of our own output, not inspection of the byte stream).
 *
 * The recognised set is conservative by design: a missed offer is invisible
 * and cheap; a wrong one is noise on every `sleep 5`. The default for an
 * unknown command is `false` — not an environment change.
 *
 * **Grows by addition.** When a new environment-entry command is needed,
 * add it here and to the test table in environment-commands.test.ts.
 */
/** What we can honestly say about the environment a submitted line entered.
 *
 *  `label` is for a human: the destination as the user wrote it, which is
 *  the only thing we know without integration. We do NOT know the remote
 *  cwd until OSC 7 arrives, and inventing one would be worse than showing
 *  none — so a nested environment is a place with no directory until it
 *  tells us otherwise (nocx-695k.2). */
export interface EnvironmentEntry {
  /** The command family, for the tests and for future per-kind wording. */
  kind: 'ssh' | 'docker' | 'podman' | 'kubectl' | 'su' | 'sudo' | 'tmux' | 'screen' | 'nix-shell'
  /** `pi@192.168.0.93`, `docker exec …`'s container, `su bob`. */
  label: string
}

/** Strip anything that is not part of the destination: `-p 2222`, `-i key`,
 *  and the trailing remote command in `ssh host uptime`. We only ever read a
 *  line we submitted ourselves, so this is parsing our own output — never
 *  inspection of the stream (AD-6). */
function sshDestination(tokens: string[]): string {
  const takesValue = new Set([
    '-p',
    '-i',
    '-l',
    '-o',
    '-b',
    '-c',
    '-D',
    '-E',
    '-e',
    '-F',
    '-I',
    '-J',
    '-L',
    '-m',
    '-O',
    '-Q',
    '-R',
    '-S',
    '-W',
    '-w',
  ])
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (takesValue.has(t)) {
      i++
      continue
    }
    if (t.startsWith('-')) continue
    return t
  }
  return ''
}

/** The environment a submitted line enters, or null when it enters none.
 *  Returns null for anything we cannot classify confidently — a remote
 *  command (`ssh host uptime`), a redirection or a pipeline is not a place
 *  the user is now sitting in. */
export function environmentEntry(line: string): EnvironmentEntry | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  // A redirection or a pipeline means the shell is doing something with the
  // output, not handing us a new interactive environment.
  if (/[|><&;]/.test(trimmed)) return null

  const tokens = trimmed.split(/\s+/)
  const first = tokens[0]

  if (first === 'ssh') {
    const dest = sshDestination(tokens)
    if (!dest) return null
    // `ssh host uptime` runs a command and comes straight back: the token
    // after the destination means this is not an interactive login.
    const destIdx = tokens.indexOf(dest)
    if (destIdx >= 0 && destIdx < tokens.length - 1) return null
    return { kind: 'ssh', label: dest }
  }
  if (first === 'tmux') return { kind: 'tmux', label: 'tmux' }
  if (first === 'screen') return { kind: 'screen', label: 'screen' }
  if (first === 'su') return { kind: 'su', label: tokens[1] ? `su ${tokens[1]}` : 'su' }
  if (first === 'nix-shell') return { kind: 'nix-shell', label: 'nix-shell' }

  if (tokens[1] === 'exec' && (first === 'docker' || first === 'podman' || first === 'kubectl')) {
    const target = tokens.slice(2).find((t) => !t.startsWith('-'))
    return { kind: first, label: target ? `${first}:${target}` : first }
  }
  if (first === 'sudo' && (tokens[1] === '-i' || tokens[1] === '-s')) {
    return { kind: 'sudo', label: 'root' }
  }
  return null
}

export function isEnvironmentEntry(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false

  const tokens = trimmed.split(/\s+/)
  const firstWord = tokens[0]

  // Commands that always enter a new shell environment.
  if (firstWord === 'ssh') return true
  if (firstWord === 'tmux') return true
  if (firstWord === 'screen') return true
  if (firstWord === 'su') return true
  if (firstWord === 'nix-shell') return true

  // Commands where a specific subcommand enters a new environment.
  if (firstWord === 'docker' && tokens.length >= 2 && tokens[1] === 'exec') return true
  if (firstWord === 'podman' && tokens.length >= 2 && tokens[1] === 'exec') return true
  if (firstWord === 'kubectl' && tokens.length >= 2 && tokens[1] === 'exec') return true
  if (firstWord === 'sudo' && tokens.length >= 2 && (tokens[1] === '-i' || tokens[1] === '-s'))
    return true

  return false
}
