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
import { createSignal, type Component } from 'solid-js'
import { AuthMethodEditor } from './authentication-editor'
import { PasswordEditor } from './password-editor'
import { Button } from './ui/button'
import { TextField } from './ui/text-field'
import { Field } from './ui/field'
import { createFormValidation, required } from './ui/validation'
import type { Credential } from './profiles'

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

// ── Component ────────────────────────────────────────────────────────────

export const CredentialForm: Component<CredentialFormProps> = (props) => {
  const [passwordOpen, setPasswordOpen] = createSignal(false)
  const validation = createFormValidation({
    name: () => required('Name')(props.credential?.name ?? ''),
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
        value={c().username}
        onInput={(v) => props.onFieldChange('username', v)}
        placeholder="Your local username"
      />

      <AuthMethodEditor
        id="credential-auth"
        auth={c().auth}
        onAuthChange={(value) => props.onFieldChange('auth', value ?? '')}
        passwordAction={
          <>
            <Field for="credential-password-action" label="Password">
              <div class="credential-secret-action">
                <span class="credential-secret-description">
                  {props.passwordValue
                    ? 'Password ready to save'
                    : c().id
                      ? 'Stored in the system keychain'
                      : 'No password set'}
                </span>
                <div class="credential-secret-actions">
                  <Button variant="default" onClick={() => setPasswordOpen(true)}>
                    {props.passwordValue || c().id ? 'Change Password' : 'Set Password'}
                  </Button>
                </div>
              </div>
            </Field>
            <PasswordEditor
              open={passwordOpen()}
              value={props.passwordValue}
              prompt={`Password for ${c().username || c().name || 'credential'}`}
              onClose={() => setPasswordOpen(false)}
              onSave={props.onPasswordChange}
            />
          </>
        }
        publicKeyAction={
          <TextField
            id="cred-key-path"
            label="Private Key Path"
            required
            value={c().keyPath || ''}
            error={validation.error('keyPath')}
            onInput={(v) => props.onFieldChange('keyPath', v)}
            onBlur={() => validation.touch('keyPath')}
          />
        }
      />
    </>
  )
}
