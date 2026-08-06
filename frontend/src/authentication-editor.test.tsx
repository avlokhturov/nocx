// @vitest-environment jsdom
import { render, cleanup, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthenticationEditor } from './authentication-editor'

// The password action is ONE control, and the editor used to draw it twice.
//
// AuthenticationEditor renders AuthMethodEditor, which shows `passwordAction`
// whenever the method is Password; then, below it, the editor shows the SAME
// element again under its own "Type a new one" / "Use existing secret" choice.
// Both branches were live at once, so a user picking Password saw two
// identical "Set Password" buttons under two "Password" labels, and Playwright
// saw two elements for one accessible name (nocx-azxe.6).
//
// Which one is right is not a toss-up: the two-way choice is the newer
// surface and the only one that can offer "use a secret the vault already
// has", so the action belongs inside it. The other is what it replaced.

afterEach(cleanup)

const noop = () => {}

function renderPasswordEditor() {
  render(() => (
    <AuthenticationEditor
      id="test-auth"
      username="someone"
      onUsernameChange={noop}
      auth="password"
      onAuthChange={noop}
      passwordSecrets={[]}
      passwordSecret={undefined}
      onPasswordSecretChange={noop}
      passwordAction={<button type="button">Set Password</button>}
      publicKeyAction={<button type="button">Choose Key</button>}
    />
  ))
}

describe('AuthenticationEditor', () => {
  it('draws the password action exactly once', () => {
    renderPasswordEditor()
    expect(screen.getAllByRole('button', { name: 'Set Password' })).toHaveLength(1)
  })

  it('puts the password action under the "type a new one" choice', () => {
    renderPasswordEditor()

    // "Type a new one" is the default when no secret is bound, and the action
    // is offered there.
    expect(screen.getAllByRole('button', { name: 'Set Password' })).toHaveLength(1)

    // Switching to "Use existing secret" takes the action away — the user is
    // choosing a stored row, not typing one. If the action were still drawn by
    // AuthMethodEditor as well, it would survive this and the two surfaces
    // would disagree about what the user asked for.
    screen.getByRole('radio', { name: 'Use existing secret' }).click()
    expect(screen.queryByRole('button', { name: 'Set Password' })).toBeNull()
  })

  it('draws the public key action exactly once', () => {
    render(() => (
      <AuthenticationEditor
        id="test-auth"
        username="someone"
        onUsernameChange={noop}
        auth="publicKey"
        onAuthChange={noop}
        passwordSecrets={[]}
        passwordSecret={undefined}
        onPasswordSecretChange={vi.fn()}
        passwordAction={<button type="button">Set Password</button>}
        publicKeyAction={<button type="button">Choose Key</button>}
      />
    ))
    expect(screen.getAllByRole('button', { name: 'Choose Key' })).toHaveLength(1)
  })
})
