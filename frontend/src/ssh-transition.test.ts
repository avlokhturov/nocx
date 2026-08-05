import { describe, it, expect } from 'vitest'
import { isInteractiveTransition, extractDestination, buildRewrite } from './ssh-transition'

describe('isInteractiveTransition (nocx-atyf.3)', () => {
  it('a simple ssh to a host is interactive', () => {
    expect(isInteractiveTransition('ssh pi@192.168.0.93')).toBe(true)
    expect(isInteractiveTransition('ssh myserver')).toBe(true)
    expect(isInteractiveTransition('ssh -p 2222 host')).toBe(true)
    expect(isInteractiveTransition('ssh -i ~/.ssh/key host')).toBe(true)
    expect(isInteractiveTransition('ssh -o StrictHostKeyChecking=no host')).toBe(true)
    expect(isInteractiveTransition('ssh -tt host')).toBe(true)
    expect(isInteractiveTransition('ssh -A -X host')).toBe(true)
  })

  it('a remote command is NOT interactive', () => {
    expect(isInteractiveTransition('ssh host ls -la')).toBe(false)
    expect(isInteractiveTransition('ssh host "echo hello"')).toBe(false)
    expect(isInteractiveTransition('ssh user@host uptime')).toBe(false)
  })

  it('a pipeline is NOT interactive', () => {
    expect(isInteractiveTransition('ssh host ls | grep foo')).toBe(false)
    expect(isInteractiveTransition('echo hello | ssh host cat')).toBe(false)
  })

  it('a redirection is NOT interactive', () => {
    expect(isInteractiveTransition('ssh host ls > out.txt')).toBe(false)
    expect(isInteractiveTransition('ssh host cmd < in.txt')).toBe(false)
    expect(isInteractiveTransition('ssh host cmd 2>&1')).toBe(false)
  })

  it('non-ssh commands are not transitions', () => {
    expect(isInteractiveTransition('ls -la')).toBe(false)
    expect(isInteractiveTransition('cd /tmp')).toBe(false)
    expect(isInteractiveTransition('docker exec -it container bash')).toBe(false)
    expect(isInteractiveTransition('')).toBe(false)
  })

  it('ssh with flags only (no host argument) is not a transition', () => {
    expect(isInteractiveTransition('ssh -V')).toBe(false)
    expect(isInteractiveTransition('ssh')).toBe(false)
  })

  it('extracts the destination from a simple ssh command', () => {
    expect(extractDestination('ssh pi@192.168.0.93')).toBe('pi@192.168.0.93')
    expect(extractDestination('ssh myserver')).toBe('myserver')
    expect(extractDestination('ssh -p 2222 host')).toBe('host')
    expect(extractDestination('ssh -i key user@host')).toBe('user@host')
  })
})

describe('buildRewrite (nocx-pu4.6)', () => {
  // What the backend returns is a shell-quoted PATH, not the launcher. The
  // launcher is ~35 KB and a typed line has only the tty, whose canonical
  // buffer is 4096 bytes: the first attempt sent the payload inline and the
  // shell executed the fragments of a truncated script.
  const P = "'/home/u/.nocx/run/launcher-12345'"

  /** The shape every rewrite has: read the staged file if it is there, and
   *  otherwise run exactly what the user typed. */
  const guarded = (sshCmd: string, original: string) =>
    `if [ -s ${P} ]; then ${sshCmd} "$(cat ${P})"; else ${original}; fi`

  it('reads the staged launcher and forces a pty', () => {
    expect(buildRewrite('ssh pi@raspberrypi', P)).toBe(
      guarded('ssh -t pi@raspberrypi', 'ssh pi@raspberrypi'),
    )
    expect(buildRewrite('ssh myserver', P)).toBe(guarded('ssh -t myserver', 'ssh myserver'))
  })

  it('preserves existing flags', () => {
    expect(buildRewrite('ssh -p 2222 host', P)).toBe(
      guarded('ssh -t -p 2222 host', 'ssh -p 2222 host'),
    )
    expect(buildRewrite('ssh -i ~/.ssh/key user@host', P)).toBe(
      guarded('ssh -t -i ~/.ssh/key user@host', 'ssh -i ~/.ssh/key user@host'),
    )
    expect(buildRewrite('ssh -A -X host', P)).toBe(guarded('ssh -t -A -X host', 'ssh -A -X host'))
  })

  it('does not double -t when already present', () => {
    expect(buildRewrite('ssh -t host', P)).toBe(guarded('ssh -t host', 'ssh -t host'))
    expect(buildRewrite('ssh -tt host', P)).toBe(guarded('ssh -tt host', 'ssh -tt host'))
  })

  it('refuses -T (explicit no-PTY)', () => {
    expect(buildRewrite('ssh -T host', P)).toBeNull()
    expect(buildRewrite('ssh -T -A host', P)).toBeNull()
  })

  it('preserves quoting around flags', () => {
    expect(buildRewrite('ssh -o "StrictHostKeyChecking no" host', P)).toBe(
      guarded(
        'ssh -t -o "StrictHostKeyChecking no" host',
        'ssh -o "StrictHostKeyChecking no" host',
      ),
    )
  })

  it('refuses non-ssh lines', () => {
    expect(buildRewrite('ls -la', P)).toBeNull()
    expect(buildRewrite('', P)).toBeNull()
  })

  // The `else` branch is the whole fail-open (ADR-0004 §1). A staged file
  // that is missing, empty or unreadable must run the user's own line — never
  // `ssh host ""`, which asks sshd for an empty remote command instead of a
  // shell, and never a second ssh chained off the first one's exit status.
  it('falls back to the line the user typed, byte for byte', () => {
    const out = buildRewrite('  ssh -p 2222 pi@raspberrypi  ', P)!
    expect(out).toContain('; else ssh -p 2222 pi@raspberrypi; fi')
    expect(out).not.toContain('||')
    expect(out).not.toContain('&&')
  })

  it('never sends an empty remote command', () => {
    const out = buildRewrite('ssh host', P)!
    expect(out).not.toContain('""')
    // The guard is on the file, before anything is handed to ssh.
    expect(out.indexOf('[ -s ')).toBeLessThan(out.indexOf('ssh -t'))
  })

  // The measured ceiling. A Linux canonical line buffer is 4096 bytes
  // (N_TTY_BUF_SIZE) and 4095 was the largest that survived intact on a real
  // pty, so 4095 is the number, not 4096. The exact byte count is asserted
  // too: this line is the one thing between the user's Enter and the tty, and
  // a change that grows it belongs in a review, not in a screenshot of a
  // truncated script.
  it('produces a line the tty can carry', () => {
    const rewritten = buildRewrite('ssh pi@raspberrypi', P)!
    const bytes = new TextEncoder().encode(rewritten).byteLength
    expect(bytes).toBe(145)
    expect(bytes).toBeLessThanOrEqual(4095)
  })

  // The ceiling is enforced, not just asserted. Two copies of the path go
  // into the line and a path may be PATH_MAX (4096) on its own, so "short
  // because it is only a path" is an assumption, not a property. When the
  // line would not survive the tty, there is no rewrite to make: refuse, and
  // the user's own line goes to the pty.
  it('refuses a rewrite the tty could not carry', () => {
    const huge = `'/home/${'d'.repeat(3000)}/.nocx/run/launcher-1'`
    expect(buildRewrite('ssh host', huge)).toBeNull()
  })

  it('accepts a realistically long path', () => {
    const long = `'/Users/a-fairly-long-user-name/Library/Application Support/nocx/.nocx/run/launcher-987654'`
    const out = buildRewrite('ssh some-quite-long-hostname.internal.example.com', long)!
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(4095)
  })

  // The launcher itself must never appear in the line — that is the defect
  // this bead was reopened for. Only its path does.
  it('carries a path, never a payload', () => {
    const rewritten = buildRewrite('ssh host', P)!
    expect(rewritten).toContain(P)
    expect(rewritten).not.toContain('BASH_ENV')
    expect(rewritten).not.toContain('printf')
  })
})
