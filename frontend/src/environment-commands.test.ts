import { describe, it, expect } from 'vitest'
import { environmentEntry, isEnvironmentEntry } from './environment-commands'

describe('isEnvironmentEntry', () => {
  // ── Commands that enter a new environment ──────────────────────────

  it('recognises ssh', () => {
    expect(isEnvironmentEntry('ssh user@host')).toBe(true)
    expect(isEnvironmentEntry('ssh -i key.pem user@host')).toBe(true)
    expect(isEnvironmentEntry('ssh pi@192.168.0.93')).toBe(true)
    expect(isEnvironmentEntry('  ssh user@host  ')).toBe(true)
  })

  it('recognises docker exec', () => {
    expect(isEnvironmentEntry('docker exec -it container bash')).toBe(true)
    expect(isEnvironmentEntry('docker exec container ls')).toBe(true)
  })

  it('recognises podman exec', () => {
    expect(isEnvironmentEntry('podman exec -it container bash')).toBe(true)
    expect(isEnvironmentEntry('podman exec container ls')).toBe(true)
  })

  it('recognises kubectl exec', () => {
    expect(isEnvironmentEntry('kubectl exec -it pod -- bash')).toBe(true)
    expect(isEnvironmentEntry('kubectl exec pod -- ls')).toBe(true)
  })

  it('recognises su', () => {
    expect(isEnvironmentEntry('su')).toBe(true)
    expect(isEnvironmentEntry('su -')).toBe(true)
    expect(isEnvironmentEntry('su root')).toBe(true)
  })

  it('recognises sudo -i and sudo -s', () => {
    expect(isEnvironmentEntry('sudo -i')).toBe(true)
    expect(isEnvironmentEntry('sudo -s')).toBe(true)
    expect(isEnvironmentEntry('sudo -i -u root')).toBe(true)
  })

  it('recognises nix-shell', () => {
    expect(isEnvironmentEntry('nix-shell')).toBe(true)
    expect(isEnvironmentEntry('nix-shell -p hello')).toBe(true)
  })

  it('recognises tmux', () => {
    expect(isEnvironmentEntry('tmux')).toBe(true)
    expect(isEnvironmentEntry('tmux new -s session')).toBe(true)
    expect(isEnvironmentEntry('tmux attach')).toBe(true)
  })

  it('recognises screen', () => {
    expect(isEnvironmentEntry('screen')).toBe(true)
    expect(isEnvironmentEntry('screen -S session')).toBe(true)
  })

  // ── Default: not an environment change ─────────────────────────────

  it('the default for an unknown command is false', () => {
    expect(isEnvironmentEntry('ls -la')).toBe(false)
    expect(isEnvironmentEntry('echo hello')).toBe(false)
    expect(isEnvironmentEntry('sleep 5')).toBe(false)
    expect(isEnvironmentEntry('cat /etc/hosts')).toBe(false)
    expect(isEnvironmentEntry('git status')).toBe(false)
    expect(isEnvironmentEntry('make build')).toBe(false)
    expect(isEnvironmentEntry('python')).toBe(false)
    expect(isEnvironmentEntry('node')).toBe(false)
    expect(isEnvironmentEntry('vim file.txt')).toBe(false)
    expect(isEnvironmentEntry('')).toBe(false)
  })

  // ── Partial matches: the command is NOT an environment entry ───────

  it('docker without exec is not an environment entry', () => {
    expect(isEnvironmentEntry('docker ps')).toBe(false)
    expect(isEnvironmentEntry('docker build .')).toBe(false)
    expect(isEnvironmentEntry('docker run -it ubuntu bash')).toBe(false)
  })

  it('podman without exec is not an environment entry', () => {
    expect(isEnvironmentEntry('podman ps')).toBe(false)
    expect(isEnvironmentEntry('podman build .')).toBe(false)
  })

  it('kubectl without exec is not an environment entry', () => {
    expect(isEnvironmentEntry('kubectl get pods')).toBe(false)
    expect(isEnvironmentEntry('kubectl logs pod')).toBe(false)
  })

  it('sudo without -i or -s is not an environment entry', () => {
    expect(isEnvironmentEntry('sudo ls')).toBe(false)
    expect(isEnvironmentEntry('sudo make install')).toBe(false)
  })
})

describe('environmentEntry — the destination we can name because we sent the line', () => {
  const cases: Array<[string, string | null]> = [
    ['ssh pi@192.168.0.93', 'pi@192.168.0.93'],
    ['ssh -p 2222 root@box', 'root@box'],
    ['ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no bob@h', 'bob@h'],
    // A remote command comes straight back: not a place the user is sitting in.
    ['ssh host uptime', null],
    // A redirection means the shell is doing something with the output.
    ['ssh host > out.txt', null],
    ['ssh host | tee log', null],
    ['docker exec -it web bash', 'docker:web'],
    ['kubectl exec -it pod-1 -- sh', 'kubectl:pod-1'],
    ['sudo -i', 'root'],
    ['su bob', 'su bob'],
    ['sleep 5', null],
    ['ls', null],
    ['', null],
  ]
  for (const [line, want] of cases) {
    it(`${JSON.stringify(line)} -> ${want ?? 'null'}`, () => {
      expect(environmentEntry(line)?.label ?? null).toBe(want)
    })
  }
})
