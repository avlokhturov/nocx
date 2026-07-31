// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { KeyMaterialInput, publicKeyMistake } from './key-material-input'

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

// One message about the material, not a stack of them. Choosing a .pub used to
// render "That is a public key…" and "not a valid private key: ssh: no key
// found" one above the other, plus a toast — the same news three times, and
// the two the eye lands on first were the least useful.
describe('KeyMaterialInput error reporting', () => {
  function renderWith(error: string | undefined) {
    return render(() => (
      <KeyMaterialInput
        id="k"
        mode="file"
        onModeChange={() => {}}
        pathValue=""
        onPathChange={() => {}}
        materialValue=""
        onMaterialChange={() => {}}
        error={error}
      />
    ))
  }

  it('shows the parent verdict when nothing local was found', async () => {
    const { container } = renderWith('not a valid private key: ssh: no key found')
    await Promise.resolve()
    const shown = container.querySelectorAll('.cm-key-file-error')
    expect(shown.length).toBe(1)
    expect(shown[0].textContent).toContain('ssh: no key found')
  })

  it('shows exactly one message, never two', async () => {
    const { container } = renderWith('not a valid private key: ssh: no key found')
    const native = container.querySelector('.ui-file-input__native') as HTMLInputElement
    const file = new File(['ssh-ed25519 AAAAC3 user@host'], 'id.pub', { type: 'text/plain' })
    Object.defineProperty(native, 'files', { value: [file], configurable: true })
    fireEvent.change(native)

    await vi.waitFor(() => {
      const shown = container.querySelectorAll('.cm-key-file-error')
      expect(shown.length).toBe(1)
      // And it is the local one, which names the file the user wants.
      expect(shown[0].textContent).toContain('.pub')
    })
  })
})
