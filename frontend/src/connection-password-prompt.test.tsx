// @vitest-environment jsdom
/**
 * ConnectionPasswordPrompt tests — the renderer half of the connection-
 * password ask. What a user can do: see a prompt that NAMES which
 * connection and account it is asking about (nocx-s8jn), type a password,
 * choose to remember it or not, or cancel — and each decision is reported
 * back over the wire with the ask's requestId.
 *
 * unbound-method guards against calling a detached method with the wrong
 * `this`; the assertions below read vi.fn() spies for their call record and
 * never invoke them, which is the opposite concern.
 */
/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, fireEvent } from '@solidjs/testing-library'
import { ConnectionPasswordPrompt } from './connection-password-prompt'
import type { ProfileClient } from './profiles'

const ASK = {
  requestId: 'rid-1',
  connection: 'prod-web',
  user: 'deploy',
  host: 'web.example.com',
  reason: 'no password is stored for this connection',
}

function fakeClient(overrides?: Partial<ProfileClient>): ProfileClient {
  return {
    passwordResolved: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as ProfileClient
}

describe('ConnectionPasswordPrompt', () => {
  afterEach(cleanup)

  it('names the connection and the account, and shows why it is asking', () => {
    const client = fakeClient()
    const { container } = render(() => (
      <ConnectionPasswordPrompt open ask={ASK} client={client} onDone={() => {}} />
    ))
    // The title names the CONNECTION; the body names the account (user@host)
    // and the reason — a bare "enter password" box is the failure this
    // prompt exists to prevent (nocx-s8jn).
    const title = container.querySelector('.ui-prompt__title')
    expect(title?.textContent).toBe('Password for prod-web')
    expect(container.textContent).toContain('deploy@web.example.com')
    expect(container.textContent).toContain('no password is stored for this connection')
    expect(container.querySelector('.ui-prompt[data-placement="top-sheet"]')).toBeTruthy()
  })

  it('submits the password with remember=false by default — use once, store nothing', async () => {
    const client = fakeClient()
    const onDone = vi.fn()
    const { container } = render(() => (
      <ConnectionPasswordPrompt open ask={ASK} client={client} onDone={onDone} />
    ))
    const input = container.querySelector('#connection-password') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'hunter2' } })
    const connect = Array.from(container.querySelectorAll('.ui-button')).find((b) =>
      b.textContent?.includes('Connect'),
    )!
    fireEvent.click(connect)

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(client.passwordResolved).toHaveBeenCalledWith({
      requestId: 'rid-1',
      outcome: 'submitted',
      password: 'hunter2',
      remember: false,
    })
  })

  it('submits remember=true when the switch is on — store as a vault secret', async () => {
    const client = fakeClient()
    const onDone = vi.fn()
    const { container } = render(() => (
      <ConnectionPasswordPrompt open ask={ASK} client={client} onDone={onDone} />
    ))
    const input = container.querySelector('#connection-password') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'hunter2' } })
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)
    const connect = Array.from(container.querySelectorAll('.ui-button')).find((b) =>
      b.textContent?.includes('Connect'),
    )!
    fireEvent.click(connect)

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(client.passwordResolved).toHaveBeenCalledWith({
      requestId: 'rid-1',
      outcome: 'submitted',
      password: 'hunter2',
      remember: true,
    })
  })

  // eslint-disable-next-line @typescript-eslint/require-await
  it('declines to submit an empty password', async () => {
    const client = fakeClient()
    const { container } = render(() => (
      <ConnectionPasswordPrompt open ask={ASK} client={client} onDone={() => {}} />
    ))
    const connect = Array.from(container.querySelectorAll('.ui-button')).find((b) =>
      b.textContent?.includes('Connect'),
    )!
    fireEvent.click(connect)
    expect(container.textContent).toContain('Enter the password')
    expect(client.passwordResolved).not.toHaveBeenCalled()
  })

  it('cancelling reports the cancellation — the connection fails with the user’s reason', async () => {
    const client = fakeClient()
    const onDone = vi.fn()
    const { container } = render(() => (
      <ConnectionPasswordPrompt open ask={ASK} client={client} onDone={onDone} />
    ))
    const cancel = Array.from(container.querySelectorAll('.ui-button')).find((b) =>
      b.textContent?.includes('Cancel'),
    )!
    fireEvent.click(cancel)
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(client.passwordResolved).toHaveBeenCalledWith({
      requestId: 'rid-1',
      outcome: 'cancelled',
    })
  })
})
