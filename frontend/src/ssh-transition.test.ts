import { describe, it, expect } from 'vitest'
import { isInteractiveTransition, extractDestination } from './ssh-transition'

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
