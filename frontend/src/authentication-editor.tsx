import { Show, createMemo, type Component, type JSX } from 'solid-js'
import { AUTH_SEGMENTS } from './auth-methods'
import type { AuthMode, Credential } from './profiles'
import { Field } from './ui/field'
import { IconButton } from './ui/icon-button'
import { PlusIcon } from './ui/icons'
import { SegmentedControl } from './ui/segmented-control'
import { Select, type SelectOption } from './ui/select'
import { Stack } from './ui/stack'
import { TextField } from './ui/text-field'

const INHERIT_AUTH = '__inherit__'

export interface AuthenticationEditorProps {
  id: string
  credentials: Credential[]
  credentialId?: string
  onCredentialChange: (value: string | undefined) => void
  onCreateCredential?: () => void
  username?: string
  onUsernameChange: (value: string | undefined) => void
  auth?: AuthMode
  onAuthChange: (value: AuthMode | undefined) => void
  inherit?: boolean
  passwordAction?: JSX.Element
  publicKeyAction?: JSX.Element
  credentialSuffix?: JSX.Element
  authSuffix?: JSX.Element
  /** Draft of the selected credential for inline editing. */
  credentialDraft?: Credential
  /** Called when an inline credential field changes. */
  onCredentialDraftChange?: (draft: Credential) => void
  /** How many connections use the selected credential. */
  credentialUsage?: number
}

export interface AuthMethodEditorProps {
  id: string
  auth?: AuthMode
  onAuthChange: (value: AuthMode | undefined) => void
  inherit?: boolean
  passwordAction?: JSX.Element
  publicKeyAction?: JSX.Element
  suffix?: JSX.Element
}

/** Method selection and method-specific controls shared by every auth form. */
export const AuthMethodEditor: Component<AuthMethodEditorProps> = (props) => {
  const options = createMemo(() =>
    props.inherit
      ? [
          { value: INHERIT_AUTH, label: 'Inherit', title: 'Not set — inherit from parent' },
          ...AUTH_SEGMENTS,
        ]
      : AUTH_SEGMENTS,
  )

  return (
    <>
      <Field for={`${props.id}-method`} label="Method">
        <SegmentedControl
          options={options()}
          value={props.inherit && props.auth === undefined ? INHERIT_AUTH : (props.auth ?? '')}
          onChange={(value) =>
            props.onAuthChange(value === INHERIT_AUTH ? undefined : (value as AuthMode))
          }
          ariaLabel="Authentication method"
        />
      </Field>
      {props.suffix}
      <Show when={props.auth === 'password'}>{props.passwordAction}</Show>
      <Show when={props.auth === 'publicKey'}>{props.publicKeyAction}</Show>
    </>
  )
}

/**
 * The SSH authentication source editor shared by connections and groups.
 *
 * UI primitives remain in ui/. This component owns the domain rule that a
 * Credential answers username and method together, so manual authentication
 * controls must not compete with it.
 */
export const AuthenticationEditor: Component<AuthenticationEditorProps> = (props) => {
  const credentialOptions = createMemo((): SelectOption[] =>
    props.credentials.map((credential) => ({
      value: credential.id,
      label: credential.username ? `${credential.name} (${credential.username})` : credential.name,
    })),
  )
  const selectedCredential = createMemo(() =>
    props.credentials.find((credential) => credential.id === props.credentialId),
  )
  return (
    <Stack>
      <Field for={`${props.id}-credential`} label="Credential">
        <div class="cm-field-row">
          <Select
            value={props.credentialId ?? ''}
            onChange={(value) => props.onCredentialChange(value || undefined)}
            options={credentialOptions()}
            placeholder={
              props.inherit
                ? '\u2014 Not set (inherit) \u2014'
                : '\u2014 None (specify below) \u2014'
            }
          />
          <Show when={props.onCreateCredential}>
            <IconButton
              size="md"
              ariaLabel="New credential"
              title="Create a new credential"
              onClick={() => props.onCreateCredential?.()}
            >
              <PlusIcon />
            </IconButton>
          </Show>
          {props.credentialSuffix}
        </div>
      </Field>
      <Show
        when={selectedCredential()}
        fallback={
          <>
            <TextField
              id={`${props.id}-user`}
              label="User"
              value={props.username ?? ''}
              placeholder={
                props.inherit
                  ? '\u2014 Not set (inherit) \u2014'
                  : '\u2014 Your local username \u2014'
              }
              onInput={(value) => props.onUsernameChange(value || undefined)}
            />
            <AuthMethodEditor
              id={props.id}
              auth={props.auth}
              onAuthChange={props.onAuthChange}
              inherit={props.inherit}
              passwordAction={props.passwordAction}
              publicKeyAction={props.publicKeyAction}
              suffix={props.authSuffix}
            />
          </>
        }
      >
        {(credential) => {
          const draft = () => props.credentialDraft ?? credential()
          return (
            <>
              <TextField
                id={`${props.id}-cred-name`}
                label="Name"
                required
                value={draft().name}
                onInput={(v) => props.onCredentialDraftChange?.({ ...draft(), name: v })}
              />
              <TextField
                id={`${props.id}-cred-user`}
                label="Username"
                value={draft().username}
                onInput={(v) => props.onCredentialDraftChange?.({ ...draft(), username: v })}
              />
              <AuthMethodEditor
                id={`${props.id}-cred-auth`}
                auth={draft().auth}
                onAuthChange={(value) =>
                  props.onCredentialDraftChange?.({ ...draft(), auth: value ?? '' })
                }
                passwordAction={props.passwordAction}
                publicKeyAction={props.publicKeyAction}
                suffix={props.authSuffix}
              />
              <Show when={credential().keyFingerprint}>
                <p class="cm-key-fingerprint">Key fingerprint: {credential().keyFingerprint}</p>
              </Show>
              <Show when={props.credentialUsage !== undefined}>
                <p class="cm-credential-usage">
                  Used by {props.credentialUsage} connection
                  {(props.credentialUsage ?? 0) === 1 ? '' : 's'}
                </p>
              </Show>
            </>
          )
        }}
      </Show>
    </Stack>
  )
}
