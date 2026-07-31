/**
 * KeyMaterialInput — the three ways a private key can be supplied: a path, a
 * chosen file, or pasted material.
 *
 * Extracted from the connection editor, which offered the three-way input in
 * two places (profile editor and group defaults); the Secrets page is a third.
 * One vocabulary, three call sites — "path / choose a file / paste" being
 * three ways to supply one key, which is what the design spec means.
 *
 * Two of the three modes supply key MATERIAL; only 'path' supplies a path.
 *
 * 'file' used to be treated as a path picker, reading `File.path` — an
 * Electron extension that exists in neither a browser nor a Wails webview,
 * so the fallback fired every time and a bare filename like `id_ed25519`
 * was stored as if it were a path. Choosing a file reads its contents, which
 * is what the mode's name says and the only thing achievable without a
 * native dialog. The difference between it and 'material' is how the key is
 * supplied, not what is stored.
 *
 * Path mode is the one the native dialog belongs to: when `openFileDialog`
 * is provided, the path field gains a Browse action that fills it with a
 * real absolute path from the platform picker. The runtime is often absent —
 * the dev-web harness has no Wails at all — and the picker then rejects; the
 * hint says so and the field stays hand-typable.
 */
import { createSignal, Show } from 'solid-js'
import { SegmentedControl } from './ui/segmented-control'
import { TextField } from './ui/text-field'
import { Button } from './ui/button'
import { FileInput } from './ui/file-input'

export type KeyInputMode = 'path' | 'file' | 'material'

/** Two of the three modes supply key MATERIAL; only 'path' supplies a path.
 *  Spelling that out once beats repeating `mode === 'file' || mode ===
 *  'material'` at every save site and losing the reason. */
export const suppliesMaterial = (m: KeyInputMode) => m === 'material' || m === 'file'

const KEY_MODES: { value: KeyInputMode; label: string }[] = [
  { value: 'path', label: 'Path' },
  { value: 'file', label: 'Choose file' },
  { value: 'material', label: 'Paste key' },
]

export interface KeyMaterialInputProps {
  /** Element-id prefix: `<id>-path` and `<id>-text`. Call sites pass e.g.
   *  `profile-key` or `group-default-key` so the emitted ids stay
   *  `profile-key-path` / `profile-key-text` — the ids the connection
   *  editor's tests and selectors already use. */
  id: string
  mode: KeyInputMode
  onModeChange: (mode: KeyInputMode) => void
  /** Path mode. */
  pathValue: string
  onPathChange: (path: string) => void
  pathPlaceholder?: string
  /** Material mode. */
  materialValue: string
  onMaterialChange: (value: string) => void
  /** Parent-side error (e.g. invalid key material), shown under the material
   *  field. File-read failures are the component's own. */
  error?: string
  /** Fingerprint caption under a pasted key. */
  fingerprint?: string
  /** Native file picker (dialog.openFile). When present, Path mode gets a
   *  Browse action that fills the path with a real absolute path. */
  openFileDialog?: () => Promise<{ path: string }>
}

/**
 * The one mistake worth catching before the round trip: uploading `id_x.pub`
 * instead of `id_x`.
 *
 * Deliberately narrow. This does not attempt to validate a private key —
 * that is the backend's job, it has the parser, and a second opinion in the
 * renderer would be a second source of truth about what a key is. This only
 * recognises an OpenSSH PUBLIC key, which is a single line beginning with its
 * algorithm name, and says so in the words the user needs.
 */
export function publicKeyMistake(text: string): string | undefined {
  const first = text.trim().split('\n', 1)[0] ?? ''
  if (/^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-|sk-(ssh|ecdsa))/.test(first)) {
    return 'That is a public key. nocx needs the private key — the file without the .pub suffix.'
  }
  return undefined
}

export function KeyMaterialInput(props: KeyMaterialInputProps) {
  const [fileError, setFileError] = createSignal<string | undefined>(undefined)
  const [browseHint, setBrowseHint] = createSignal<string | undefined>(undefined)

  const changeMode = (value: string) => {
    setFileError(undefined)
    setBrowseHint(undefined)
    props.onModeChange(value as KeyInputMode)
  }

  // Prop reads happen in the handler bodies (event-handler scope, which
  // Solid tracks); the promise callbacks only touch values captured there.
  const browse = () => {
    if (!props.openFileDialog) return
    const open = props.openFileDialog
    const changePath = props.onPathChange
    setBrowseHint(undefined)
    void open().then(
      (result) => {
        if (result.path) changePath(result.path)
      },
      () => setBrowseHint('The native file picker is not available here. Type the path by hand.'),
    )
  }

  return (
    <>
      <SegmentedControl
        options={KEY_MODES}
        value={props.mode}
        onChange={changeMode}
        ariaLabel="Key input mode"
      />
      <Show when={props.mode === 'path'}>
        <div class="km-path-row">
          <TextField
            id={`${props.id}-path`}
            label="Private Key Path"
            value={props.pathValue}
            onInput={(value) => props.onPathChange(value)}
            placeholder={props.pathPlaceholder ?? '~/.ssh/id_ed25519'}
          />
          <Show when={props.openFileDialog}>
            <Button
              variant="default"
              onClick={browse}
              ariaLabel="Browse for a private key file"
              title="Choose a file with the system picker"
            >
              Browse…
            </Button>
          </Show>
        </div>
        <Show when={browseHint()}>
          <p class="cm-key-file-error">{browseHint()}</p>
        </Show>
      </Show>
      <Show when={props.mode === 'file'}>
        <FileInput
          accept="*"
          onChange={(file) => {
            if (!file) return
            const change = props.onMaterialChange
            setFileError(undefined)
            void file.text().then(
              (text) => {
                setFileError(publicKeyMistake(text))
                change(text)
              },
              () => setFileError('Could not read that file. Choose another, or paste the key.'),
            )
          }}
          ariaLabel="Choose private key file"
          buttonLabel="Choose file…"
        />
        {/* The read can fail — an unreadable file, a revoked permission.
            Silence there would leave the user believing a key was loaded. */}
        <Show when={fileError()}>
          <p class="cm-key-file-error">{fileError()}</p>
        </Show>
      </Show>
      {/* The parent's verdict on the material — "not a private key", and the
          like. It used to be passed only to the paste-mode TextField, so a
          file chosen in file mode that turned out to be a public key set an
          error nothing rendered: the user pressed Create and saw literally
          nothing happen. The error belongs to the material, and the material
          can arrive by any of the three routes. */}
      <Show when={props.error && props.mode !== 'material'}>
        <p class="cm-key-file-error">{props.error}</p>
      </Show>
      <Show when={props.mode === 'material'}>
        <TextField
          multiline
          id={`${props.id}-text`}
          label="Private Key"
          value={props.materialValue}
          onInput={(value) => {
            setFileError(publicKeyMistake(value))
            props.onMaterialChange(value)
          }}
          placeholder="Paste the private key content here"
          error={props.error ?? fileError()}
        />
        <Show when={props.fingerprint}>
          <span class="cm-key-fingerprint">Fingerprint: {props.fingerprint}</span>
        </Show>
      </Show>
    </>
  )
}
