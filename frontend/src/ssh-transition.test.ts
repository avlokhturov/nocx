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
  const LAUNCHER = "'/usr/bin/env sh -c ...'"

  it('inserts -t and appends the launcher', () => {
    expect(buildRewrite('ssh pi@raspberrypi', LAUNCHER)).toBe(`ssh -t pi@raspberrypi ${LAUNCHER}`)
    expect(buildRewrite('ssh myserver', LAUNCHER)).toBe(`ssh -t myserver ${LAUNCHER}`)
  })

  it('preserves existing flags', () => {
    expect(buildRewrite('ssh -p 2222 host', LAUNCHER)).toBe(`ssh -t -p 2222 host ${LAUNCHER}`)
    expect(buildRewrite('ssh -i ~/.ssh/key user@host', LAUNCHER)).toBe(
      `ssh -t -i ~/.ssh/key user@host ${LAUNCHER}`,
    )
    expect(buildRewrite('ssh -A -X host', LAUNCHER)).toBe(`ssh -t -A -X host ${LAUNCHER}`)
  })

  it('does not double -t when already present', () => {
    expect(buildRewrite('ssh -t host', LAUNCHER)).toBe(`ssh -t host ${LAUNCHER}`)
    expect(buildRewrite('ssh -tt host', LAUNCHER)).toBe(`ssh -tt host ${LAUNCHER}`)
  })

  it('refuses -T (explicit no-PTY)', () => {
    expect(buildRewrite('ssh -T host', LAUNCHER)).toBeNull()
    expect(buildRewrite('ssh -T -A host', LAUNCHER)).toBeNull()
  })

  it('preserves quoting around flags', () => {
    expect(buildRewrite('ssh -o "StrictHostKeyChecking no" host', LAUNCHER)).toBe(
      `ssh -t -o "StrictHostKeyChecking no" host ${LAUNCHER}`,
    )
  })

  it('refuses non-ssh lines', () => {
    expect(buildRewrite('ls -la', LAUNCHER)).toBeNull()
    expect(buildRewrite('', LAUNCHER)).toBeNull()
  })
})
