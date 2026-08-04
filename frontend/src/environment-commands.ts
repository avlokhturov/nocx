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
