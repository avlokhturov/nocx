/**
 * CredentialForm — renders credential fields only.
 *
 * Renders the editable fields for a credential: name, username, auth method,
 * and the auth-specific secret field (password or key path). Does NOT render
 * any action chrome (save/cancel/delete buttons) — the parent owns the Dialog
 * footer and wires the actions.
 *
 * Props deliberately make no assumption about a container, title bar, or
 * action button placement: wave 5 hosts it in the Credentials section's
 * Dialog, wave 6 will host the same component in a dialog opened from the
 * connection form.
 */
import { Show, For, type Component } from 'solid-js'
import { TextField } from './ui/text-field'
import { Field } from './ui/field'
import { Radio } from './ui/radio'
import { createFormValidation, required } from './ui/validation'
import type { Credential, AuthMode } from './profiles'

// ── Types ────────────────────────────────────────────────────────────────

export interface CredentialFormHandle {
  valid(): boolean
  revealAll(): void
  reset(): void
  error(field: string): string | undefined
  touch(field: string): void
}
export interface CredentialFormProps {
  /** The credential being edited. The parent owns the object. */
  credential: Credential
  /** Called when a field changes. */
  onFieldChange: (key: keyof Credential, value: string) => void
  /** If auth === 'password', the password draft. Owned by the parent. */
  passwordValue: string
  onPasswordChange: (value: string) => void
  /** Ref handle for the parent to call validation methods. */
  ref?: { current: CredentialFormHandle | null }
}

const AUTH_MODES: AuthMode[] = ['password', 'publicKey', 'agent']

function authModeLabel(mode: AuthMode): string {
  switch (mode) {
    case '':
      return 'Auto'
    case 'password':
      return 'Password'
    case 'publicKey':
      return 'Public Key'
    case 'agent':
      return 'SSH Agent'
    case 'keyboardInteractive':
      return 'Keyboard Interactive'
  }
}

// ── Component ────────────────────────────────────────────────────────────

export const CredentialForm: Component<CredentialFormProps> = (props) => {
  const validation = createFormValidation({
    name: () => required('Name')(props.credential?.name ?? ''),
    username: () => required('Username')(props.credential?.username ?? ''),
    keyPath: () => {
      const c = props.credential
      if (!c || c.auth !== 'publicKey') return undefined
      return required('Private key path')(c.keyPath ?? '')
    },
  })

  const handle: CredentialFormHandle = {
    valid: () => validation.valid(),
    revealAll: () => validation.revealAll(),
    reset: () => validation.reset(),
    error: (field: string) => (validation.error as (f: string) => string | undefined)(field),
    touch: (field: string) => (validation.touch as (f: string) => void)(field),
  }

  // eslint-disable-next-line solid/reactivity
  if (props.ref) {
    // eslint-disable-next-line solid/reactivity
    props.ref.current = handle
  }

  const c = () => props.credential

  return (
    <>
      <TextField
        id="cred-name"
        label="Name"
        required
        value={c().name}
        error={validation.error('name')}
        onInput={(v) => props.onFieldChange('name', v)}
        onBlur={() => validation.touch('name')}
      />
      <TextField
        id="cred-username"
        label="Username"
        required
        value={c().username}
        error={validation.error('username')}
        onInput={(v) => props.onFieldChange('username', v)}
        onBlur={() => validation.touch('username')}
      />

      <Field for="cred-auth-method" label="Authentication Method" orientation="horizontal">
        <div class="cm-radio-group">
          <For each={AUTH_MODES}>
            {(mode) => (
              <Radio
                value={mode}
                checked={c().auth === mode}
                onChange={(v) => props.onFieldChange('auth', v)}
                name="cred-auth-mode"
                label={authModeLabel(mode)}
              />
            )}
          </For>
        </div>
      </Field>

      <Show when={c().auth === 'password'}>
        <Field
          for="cred-password"
          label="Password (stored in OS keychain)"
          orientation="horizontal"
        >
          <TextField
            id="cred-password"
            type="password"
            value={props.passwordValue}
            onInput={(v) => props.onPasswordChange(v)}
            placeholder={c().id ? 'Leave empty to keep current' : 'Enter password'}
          />
        </Field>
      </Show>

      <Show when={c().auth === 'publicKey'}>
        <TextField
          id="cred-key-path"
          label="Private Key Path"
          required
          value={c().keyPath || ''}
          error={validation.error('keyPath')}
          onInput={(v) => props.onFieldChange('keyPath', v)}
          onBlur={() => validation.touch('keyPath')}
        />
      </Show>
    </>
  )
}
