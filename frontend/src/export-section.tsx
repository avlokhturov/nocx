/**
 * Export/backup/import section — Solid component mounted inside the settings
 * content pane.  Replaces the imperative DOM-building predecessor (519 → 0).
 * Four modes (ADR-0011 §7), each stating what it carries and omits.
 * The portable encrypted export prompts for a new passphrase with
 * confirmation via inline TextFields (not a Modal primitive, not prompt()).
 *
 * State: local createStores per sub-component. Nothing here is shared state —
 * these are per-operation busy flags and form drafts (nocx-imkb.5).
 */

import { For, Show, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { render } from 'solid-js/web'
import type { ProfileClient, ExportManifest, ConfigExport, SSHConfigImportResult } from './profiles'
import { log } from './log'
import { downloadJSON, downloadBinary } from './export-utils'
import { PageSection } from './ui/page-section'
import { Button } from './ui/button'
import { TextField } from './ui/text-field'
import { Checkbox } from './ui/checkbox'
import { FileInput } from './ui/file-input'
import { Field } from './ui/field'
import { Stack } from './ui/stack'
import { MarkerList, type MarkerListItem } from './ui/marker-list'
import { CodeBlock } from './ui/code-block'
import { showToast } from './ui/toast'
// ── Mode definitions ────────────────────────────────────────────────────

type Mode = 'config-export' | 'portable-encrypted' | 'same-machine-backup' | 'import'

interface ModeDef {
  mode: Mode
  label: string
  summary: string
}

const MODES: ModeDef[] = [
  {
    mode: 'config-export',
    label: 'Configuration Export',
    summary: 'Profiles, groups, credential metadata, and settings',
  },
  {
    mode: 'portable-encrypted',
    label: 'Portable Encrypted Export',
    summary: 'Configuration encrypted under a new passphrase',
  },
  {
    mode: 'same-machine-backup',
    label: 'Same-Machine Backup',
    summary: 'File paths to copy; secrets stay in the OS keychain',
  },
  {
    mode: 'import',
    label: 'Import',
    summary: 'Restore a configuration export into this machine',
  },
]

// ── Manifest display ────────────────────────────────────────────────────

/**
 * What a mode carries, omits and warns about, as one MarkerList.
 *
 * This was six `.st-export-*` classes declaring their own type size, colour and
 * glyph per stance — a private vocabulary for the page's main content, which is
 * how it drifted two steps below the text around it. The stances are the kit
 * component's tones now, and this function only shapes the data.
 */
function ManifestDisplay(props: { manifest: ExportManifest }) {
  const items = (): MarkerListItem[] => [
    ...props.manifest.carries.map((text) => ({ text, tone: 'included' as const })),
    ...props.manifest.omits.map((text) => ({ text, tone: 'excluded' as const })),
    ...(props.manifest.notes ?? []).map((text) => ({ text, tone: 'note' as const })),
  ]
  return <MarkerList items={items()} />
}

// ── Config export actions ───────────────────────────────────────────────
//
// Outcomes are toasts, not an inline status line. Each action used to render a
// `.st-export-status` div under itself, which held a line of empty space on every
// section forever and shoved the controls below it down the moment anything was
// said. The in-flight state is on the button (disabled) where the user is already
// looking, and the result — which is the part worth interrupting for — arrives as
// a notification. Failures are raised at `danger`, which is sticky: an error the
// user was not looking at is an error they never saw.

function ConfigExportActions(props: { profileClient: ProfileClient }) {
  const [state, setState] = createStore({ busy: false })

  const handleClick = () => {
    setState('busy', true)
    props.profileClient
      .configExport()
      .then(
        (result) => {
          downloadJSON('nocx-config-export.json', result)
          showToast({ level: 'success', message: 'Exported — file downloaded' })
        },
        (e) => {
          showToast({ level: 'danger', message: `Export failed: ${String(e)}` })
        },
      )
      .finally(() => {
        setState('busy', false)
      })
  }
  return (
    <Button variant="default" disabled={state.busy} onClick={handleClick}>
      Export Configuration
    </Button>
  )
}

// ── Portable encrypted export actions ─────────────────────────────────

function PortableEncryptedActions(props: { profileClient: ProfileClient }) {
  const [state, setState] = createStore({
    passphrase: '',
    confirm: '',
    showPasswords: false,
    includePrivate: false,
    busy: false,
  })

  const handleEncrypt = () => {
    const pass = state.passphrase
    const conf = state.confirm
    if (!pass) {
      showToast({ level: 'warning', message: 'Passphrase is required' })
      return
    }
    if (pass !== conf) {
      showToast({ level: 'warning', message: 'Passphrases do not match' })
      return
    }
    setState('busy', true)
    props.profileClient
      .portableEncryptedExport(pass, state.includePrivate)
      .then(
        (result) => {
          downloadBinary('nocx-portable-export.enc', result.payload)
          showToast({
            level: 'success',
            message: 'Exported — file downloaded. Keep the passphrase safe',
          })
          setState('passphrase', '')
          setState('confirm', '')
        },
        (e) => {
          showToast({ level: 'danger', message: `Export failed: ${String(e)}` })
        },
      )
      .finally(() => {
        setState('busy', false)
      })
  }

  const inputType = () => (state.showPasswords ? 'text' : 'password')

  return (
    <Stack gap="default">
      <TextField
        label="New passphrase"
        type={inputType()}
        placeholder="Choose a strong passphrase"
        value={state.passphrase}
        onInput={(v) => setState('passphrase', v)}
      />
      <TextField
        label="Confirm passphrase"
        type={inputType()}
        placeholder="Re-enter the passphrase"
        value={state.confirm}
        onInput={(v) => setState('confirm', v)}
      />
      <Checkbox
        checked={state.showPasswords}
        onChange={(v) => setState('showPasswords', v)}
        label="Show passphrase"
      />
      <Checkbox
        checked={state.includePrivate}
        onChange={(v) => setState('includePrivate', v)}
        label="Include private content (conversations, command history)"
      />
      <Button variant="default" disabled={state.busy} onClick={handleEncrypt}>
        Encrypt and Export
      </Button>
    </Stack>
  )
}

// ── Backup actions ──────────────────────────────────────────────────────

function BackupActions(props: { profileClient: ProfileClient }) {
  const [state, setState] = createStore({
    busy: false,
    paths: '',
    pathsVisible: false,
  })

  const handleShow = () => {
    setState('busy', true)
    props.profileClient
      .backup()
      .then(
        (result) => {
          setState('paths', JSON.stringify(result, null, 2))
          setState('pathsVisible', true)
        },
        (e) => {
          showToast({ level: 'danger', message: `Backup check failed: ${String(e)}` })
          setState('pathsVisible', false)
        },
      )
      .finally(() => {
        setState('busy', false)
      })
  }
  return (
    <>
      <Button variant="default" disabled={state.busy} onClick={handleShow}>
        Show Backup Paths
      </Button>
      <Show when={state.pathsVisible}>
        <CodeBlock ariaLabel="Backup paths">{state.paths}</CodeBlock>
      </Show>
    </>
  )
}

// ── Import actions ──────────────────────────────────────────────────────

function ImportActions(props: { profileClient: ProfileClient }) {
  const [state, setState] = createStore({
    configFile: null as File | null,
    configBusy: false,
    encFile: null as File | null,
    portablePass: '',
    portableBusy: false,
    tabbyFile: null as File | null,
    tabbyBusy: false,
    sshBusy: false,
  })

  /**
   * An import that leaves credentials unmapped has half-succeeded, and the half
   * that failed needs the user to do something about it — so it is raised as a
   * sticky warning rather than a success that scrolls away in four seconds.
   */
  const reportImport = (result: {
    profilesImported: number
    groupsImported: number
    credentialsImported: number
    unresolvedCredentials?: unknown[]
  }) => {
    const summary =
      `Imported ${result.profilesImported} profiles, ` +
      `${result.groupsImported} groups, ${result.credentialsImported} credentials`
    const unresolved = result.unresolvedCredentials?.length ?? 0
    if (unresolved > 0) {
      showToast({
        level: 'warning',
        duration: 0,
        message: `${summary} — ${unresolved} credentials need secret mapping`,
      })
      return
    }
    showToast({ level: 'success', message: summary })
  }

  const handleConfigImport = () => {
    const file = state.configFile
    if (!file) return
    const pc = props.profileClient
    setState('configBusy', true)
    file
      .text()
      .then((text) => {
        const data = JSON.parse(text) as ConfigExport
        return pc.importConfig(data)
      })
      .then(reportImport)
      .catch((e) => {
        showToast({ level: 'danger', message: `Import failed: ${String(e)}` })
      })
      .finally(() => {
        setState('configBusy', false)
      })
  }

  const handlePortableImport = () => {
    const file = state.encFile
    if (!file) return
    const pass = state.portablePass
    const pc = props.profileClient
    setState('portableBusy', true)
    file
      .arrayBuffer()
      .then((buf) => {
        const base64 = btoa(Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(''))
        return pc.importPortable(base64, pass)
      })
      .then((result) => {
        reportImport(result)
        setState('encFile', null)
        setState('portablePass', '')
      })
      .catch((e) => {
        showToast({ level: 'danger', message: `Import failed: ${String(e)}` })
      })
      .finally(() => {
        setState('portableBusy', false)
      })
  }

  const handleTabbyImport = () => {
    const file = state.tabbyFile
    if (!file) return
    const pc = props.profileClient
    setState('tabbyBusy', true)
    file
      .text()
      .then((text) => pc.importTabby(text))
      .then((count) => {
        log.info('Imported SSH profiles from Tabby config', { count })
        setState('tabbyFile', null)
        showToast({
          level: 'success',
          message: `Imported ${count} connections from the Tabby config`,
        })
      })
      .catch((e) => {
        showToast({ level: 'danger', message: `Tabby import failed: ${String(e)}` })
      })
      .finally(() => {
        setState('tabbyBusy', false)
      })
  }

  const handleSSHConfigImport = () => {
    const pc = props.profileClient
    setState('sshBusy', true)
    pc.importSSHConfig()
      .then((result: SSHConfigImportResult) => {
        const { profilesImported, skipped } = result
        if (profilesImported === 0 && skipped === 0) {
          showToast({ level: 'info', message: 'No SSH config aliases to import' })
        } else if (skipped > 0) {
          showToast({
            level: 'warning',
            duration: 0,
            message:
              `Imported ${profilesImported} SSH config profiles, ` +
              `${skipped} skipped (name or host already saved)`,
          })
        } else {
          showToast({
            level: 'success',
            message: `Imported ${profilesImported} SSH config profiles`,
          })
        }
      })
      .catch((e: unknown) => {
        showToast({ level: 'danger', message: `SSH config import failed: ${String(e)}` })
      })
      .finally(() => {
        setState('sshBusy', false)
      })
  }
  return (
    // `loose` outside, `default` inside — the three import blocks are independent
    // of each other, the controls within one are not. That distinction is the
    // whole reason Stack has two steps rather than one.
    <Stack gap="loose">
      <Stack gap="default">
        <Field for="config-file" label="Import from configuration export (.json)">
          <FileInput id="config-file" accept=".json" onChange={(f) => setState('configFile', f)} />
        </Field>
        <Button
          variant="default"
          disabled={state.configBusy || !state.configFile}
          onClick={handleConfigImport}
        >
          Import
        </Button>
      </Stack>
      <Stack gap="default">
        <Field for="enc-file" label="Import from portable encrypted export (.enc)">
          <FileInput id="enc-file" accept=".enc" onChange={(f) => setState('encFile', f)} />
        </Field>
        <Field for="portable-pass" label="Passphrase">
          <TextField
            id="portable-pass"
            type="password"
            placeholder="Passphrase used during export"
            value={state.portablePass}
            onInput={(v) => setState('portablePass', v)}
          />
        </Field>
        <Button
          variant="default"
          disabled={state.portableBusy || !state.encFile || !state.portablePass}
          onClick={handlePortableImport}
        >
          Decrypt and Import
        </Button>
      </Stack>
      <Stack gap="default">
        <Field for="tabby-config-file" label="Import from Tabby config (.yml/.yaml)">
          <FileInput
            id="tabby-config-file"
            accept=".yml,.yaml"
            onChange={(f) => setState('tabbyFile', f)}
          />
        </Field>
        <Button
          variant="default"
          disabled={state.tabbyBusy || !state.tabbyFile}
          onClick={handleTabbyImport}
        >
          Import
        </Button>
      </Stack>
      <Stack gap="default">
        <p class="ui-export-desc">
          Creates saved copies of your ~/.ssh/config aliases as nocx profiles. This is a one-off,
          detached copy — changes to ~/.ssh/config after import are not synced. Profiles whose name
          or host already exist are skipped.
        </p>
        <Button
          variant="default"
          disabled={state.sshBusy}
          onClick={handleSSHConfigImport}
          data-testid="import-ssh-config"
        >
          Import from ~/.ssh/config
        </Button>
      </Stack>
    </Stack>
  )
}

// ── Mode card ────────────────────────────────────────────────────────────

/**
 * One export mode, rendered open.
 *
 * These used to be collapsed behind a "Show details" button, which asked the
 * user to click four times to compare four modes whose whole purpose is to be
 * compared — each states what it carries and what it omits, and that statement
 * was the thing being hidden. Now that Export is a page of its own rather than
 * a block appended under the settings list, there is room to show them.
 */
function ModeCard(props: { def: ModeDef; profileClient: ProfileClient }) {
  const [state, setState] = createStore({
    loading: false,
    manifest: null as ExportManifest | null,
    error: null as string | null,
  })

  const loadManifest = () => {
    setState('loading', true)
    props.profileClient
      .exportManifest(props.def.mode)
      .then(
        (m) => {
          setState('manifest', m)
        },
        (e) => {
          setState('error', `Failed to load: ${String(e)}`)
        },
      )
      .finally(() => {
        setState('loading', false)
      })
  }

  onMount(loadManifest)

  return (
    <PageSection id={'st-export-' + props.def.mode} title={props.def.label}>
      <p class="st-export-card-summary">{props.def.summary}</p>
      {/* Stack, not a div with margins: the manifest and the actions are stacked
          kit content, and the gaps between them belong to Stack. They used to be
          a `margin-bottom` on the list plus a `margin-top` on the actions, which
          is two surfaces' worth of spacing decisions stacked on top of
          PageSection's own gap. */}
      <Stack gap="default">
        <Show when={state.loading}>
          <div class="st-export-loading">Loading mode details…</div>
        </Show>
        <Show when={state.error !== null && !state.loading}>
          <div class="st-export-error">{state.error}</div>
        </Show>
        <Show when={state.manifest !== null && !state.loading}>
          <ManifestDisplay manifest={state.manifest!} />
          <Show when={props.def.mode === 'config-export'}>
            <ConfigExportActions profileClient={props.profileClient} />
          </Show>
          <Show when={props.def.mode === 'portable-encrypted'}>
            <PortableEncryptedActions profileClient={props.profileClient} />
          </Show>
          <Show when={props.def.mode === 'same-machine-backup'}>
            <BackupActions profileClient={props.profileClient} />
          </Show>
          <Show when={props.def.mode === 'import'}>
            <ImportActions profileClient={props.profileClient} />
          </Show>
        </Show>
      </Stack>
    </PageSection>
  )
}

// ── Root component ───────────────────────────────────────────────────────

/**
 * The Export / Backup / Import page.
 *
 * **No `primary` button anywhere on this page, deliberately.** The kit's rule is
 * at most one primary per section, and applying it literally here gave two of the
 * four sections an accent-filled button and two a plain one — which made peer
 * sections look unlike each other while distinguishing nothing the user can act
 * on. Primary emphasis exists to point at one action among several on a screen;
 * this page is a list of four independent operations with no ranking between
 * them, plus a file picker and a disclosure inside them. The consistent look IS
 * the correct look, so every action here is `default`.
 *
 * No wrapping PageSection of its own: this is a page in the settings rail now,
 * and the rail entry already names it. Wrapping would put the same words twice
 * on the same screen and nest a section inside a section.
 */
export function ExportSection(props: { profileClient: ProfileClient }) {
  return (
    <div class="ui-export">
      <p class="ui-export-desc">
        Each mode states what it carries and what it omits. Private content and secrets are never
        included without an explicit choice.
      </p>
      <For each={MODES}>{(def) => <ModeCard def={def} profileClient={props.profileClient} />}</For>
    </div>
  )
}

// ── Island mount, for imperative callers only ───────────────────────────
// The settings surface is still imperative, so it cannot place <ExportSection/>
// as a child; it has to open a Solid root inside one of its elements. That is
// what this is — a mounting boundary, not a compatibility shim, and it goes
// when the settings surface migrates and renders the component directly.
//
// It returns the disposer deliberately. render() hands back the only way to
// tear the root down, and dropping it leaves effects alive on nodes the caller
// has already removed from the document.

export function mountExportSection(
  container: HTMLElement,
  profileClient: ProfileClient,
): () => void {
  return render(() => <ExportSection profileClient={profileClient} />, container)
}
