// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { publicKeyMistake } from './key-material-input'

// Uploading `id_ed25519.pub` instead of `id_ed25519` is the mistake this
// catches, and it is the one a user actually made: the backend answered "not a
// valid private key: ssh: no key found", the renderer logged it and showed
// nothing, and Create looked inert.
describe('publicKeyMistake', () => {
  it.each([
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA user@host',
    'ssh-rsa AAAAB3NzaC1yc2EAAAA user@host',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNh user@host',
    'sk-ssh-ed25519@openssh.com AAAAG3NrLXNz user@host',
  ])('recognises %s as a public key and says which file is wanted', (line) => {
    const msg = publicKeyMistake(line)
    expect(msg).toBeDefined()
    expect(msg).toContain('.pub')
  })

  it('leaves a private key alone', () => {
    expect(
      publicKeyMistake(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----',
      ),
    ).toBeUndefined()
  })

  // It must not become a second opinion about what a private key is — the
  // backend has the parser. Anything that is not recognisably a public key
  // passes through to it, including nonsense.
  it('does not judge anything else', () => {
    expect(publicKeyMistake('')).toBeUndefined()
    expect(publicKeyMistake('not a key at all')).toBeUndefined()
    expect(
      publicKeyMistake('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'),
    ).toBeUndefined()
  })

  it('reads only the first line, so a key with a public half pasted after it still passes', () => {
    expect(
      publicKeyMistake(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\nssh-ed25519 AAAA',
      ),
    ).toBeUndefined()
  })
})
