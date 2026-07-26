/**
 * Export/backup/import section — Solid component mounted inside the settings
 * content pane.  Replaces the imperative DOM-building predecessor (519 → 0).
 * Four modes (ADR-0011 §7), each stating what it carries and omits.
 * The portable encrypted export prompts for a new passphrase with
 * confirmation via inline inputs (not a Modal primitive, not prompt()).
 */

import { For, Show, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import type { ProfileClient, ExportManifest, ConfigExport } from './profiles'
import { downloadJSON, downloadBinary } from './export-utils'

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

function ManifestDisplay(props: { manifest: ExportManifest }) {
  return (
    <ul class="st-export-manifest">
      <For each={props.manifest.carries}>
        {(item) => (
          <li class="st-export-carries">
            <span class="st-export-check">+</span> {item}
          </li>
        )}
      </For>
      <For each={props.manifest.omits}>
        {(item) => (
          <li class="st-export-omits">
            <span class="st-export-cross">−</span> {item}
          </li>
        )}
      </For>
      <Show when={props.manifest.notes}>
        <For each={props.manifest.notes}>{(note) => <li class="st-export-note">{note}</li>}</For>
      </Show>
    </ul>
  )
}

// ── Status line helper ─────────────────────────────────────────────────

function StatusLine(props: { message: string }) {
  return <div class="st-export-status">{props.message}</div>
}

// ── Config export actions ───────────────────────────────────────────────

function ConfigExportActions(props: { profileClient: ProfileClient }) {
  const [status, setStatus] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const handleClick = () => {
    setBusy(true)
    setStatus('Exporting…')
    props.profileClient
      .configExport()
      .then(
        (result) => {
          downloadJSON('nocx-config-export.json', result)
          setStatus('Exported — file downloaded.')
        },
        (e) => {
          setStatus(`Export failed: ${String(e)}`)
        },
      )
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <>
      <button class="st-export-btn" disabled={busy()} onClick={handleClick}>
        Export Configuration
      </button>
      <StatusLine message={status()} />
    </>
  )
}

// ── Portable encrypted export actions ─────────────────────────────────

function PortableEncryptedActions(props: { profileClient: ProfileClient }) {
  const [passphrase, setPassphrase] = createSignal('')
  const [confirm, setConfirm] = createSignal('')
  const [showPasswords, setShowPasswords] = createSignal(false)
  const [includePrivate, setIncludePrivate] = createSignal(false)
  const [status, setStatus] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const handleEncrypt = () => {
    const pass = passphrase()
    const conf = confirm()
    if (!pass) {
      setStatus('Passphrase is required.')
      return
    }
    if (pass !== conf) {
      setStatus('Passphrases do not match.')
      return
    }
    setBusy(true)
    setStatus('Encrypting…')
    props.profileClient
      .portableEncryptedExport(pass, includePrivate())
      .then(
        (result) => {
          downloadBinary('nocx-portable-export.enc', result.payload)
          setStatus('Exported — file downloaded. Keep the passphrase safe.')
          setPassphrase('')
          setConfirm('')
        },
        (e) => {
          setStatus(`Export failed: ${String(e)}`)
        },
      )
      .finally(() => {
        setBusy(false)
      })
  }

  const inputType = () => (showPasswords() ? 'text' : 'password')

  return (
    <>
      <div class="st-export-passphrase-form">
        <label class="st-export-passphrase-label">New passphrase</label>
        <input
          type={inputType()}
          class="st-export-passphrase-input"
          placeholder="Choose a strong passphrase"
          autocomplete="new-password"
          value={passphrase()}
          onInput={(e) => setPassphrase(e.currentTarget.value)}
        />
        <label class="st-export-passphrase-label">Confirm passphrase</label>
        <input
          type={inputType()}
          class="st-export-passphrase-input"
          placeholder="Re-enter the passphrase"
          autocomplete="new-password"
          value={confirm()}
          onInput={(e) => setConfirm(e.currentTarget.value)}
        />
        <label class="st-export-show-toggle">
          <input
            type="checkbox"
            checked={showPasswords()}
            onChange={(e) => setShowPasswords(e.currentTarget.checked)}
          />{' '}
          Show passphrase
        </label>
        <label class="st-export-private-toggle">
          <input
            type="checkbox"
            checked={includePrivate()}
            onChange={(e) => setIncludePrivate(e.currentTarget.checked)}
          />{' '}
          Include private content (conversations, command history)
        </label>
      </div>
      <div class="st-export-btn-row">
        <button
          class="st-export-btn st-export-btn-primary"
          disabled={busy()}
          onClick={handleEncrypt}
        >
          Encrypt and Export
        </button>
        <StatusLine message={status()} />
      </div>
    </>
  )
}

// ── Backup actions ──────────────────────────────────────────────────────

function BackupActions(props: { profileClient: ProfileClient }) {
  const [status, setStatus] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [paths, setPaths] = createSignal('')
  const [pathsVisible, setPathsVisible] = createSignal(false)

  const handleShow = () => {
    setBusy(true)
    setStatus('Checking…')
    props.profileClient
      .backup()
      .then(
        (result) => {
          setPaths(JSON.stringify(result, null, 2))
          setPathsVisible(true)
          setStatus('')
        },
        (e) => {
          setStatus(`Backup check failed: ${String(e)}`)
          setPathsVisible(false)
        },
      )
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <>
      <button class="st-export-btn" disabled={busy()} onClick={handleShow}>
        Show Backup Paths
      </button>
      <StatusLine message={status()} />
      <Show when={pathsVisible()}>
        <pre class="st-export-backup-details">{paths()}</pre>
      </Show>
    </>
  )
}

// ── Import actions ──────────────────────────────────────────────────────

function ImportActions(props: { profileClient: ProfileClient }) {
  const [configFile, setConfigFile] = createSignal<File | null>(null)
  const [configStatus, setConfigStatus] = createSignal('')
  const [configBusy, setConfigBusy] = createSignal(false)
  const [encFile, setEncFile] = createSignal<File | null>(null)
  const [portablePass, setPortablePass] = createSignal('')
  const [portableStatus, setPortableStatus] = createSignal('')
  const [portableBusy, setPortableBusy] = createSignal(false)

  const handleConfigImport = () => {
    const file = configFile()
    if (!file) return
    const pc = props.profileClient
    setConfigBusy(true)
    setConfigStatus('Importing…')
    file
      .text()
      .then((text) => {
        const data = JSON.parse(text) as ConfigExport
        return pc.importConfig(data)
      })
      .then((result) => {
        const parts: string[] = [
          `Imported ${result.profilesImported} profiles,`,
          `${result.groupsImported} groups,`,
          `${result.credentialsImported} credentials.`,
        ]
        if (result.unresolvedCredentials?.length) {
          parts.push(` ${result.unresolvedCredentials.length} credentials need secret mapping.`)
        }
        setConfigStatus(parts.join(' '))
      })
      .catch((e) => {
        setConfigStatus(`Import failed: ${String(e)}`)
      })
      .finally(() => {
        setConfigBusy(false)
      })
  }

  const handlePortableImport = () => {
    const file = encFile()
    if (!file) return
    const pass = portablePass()
    const pc = props.profileClient
    setPortableBusy(true)
    setPortableStatus('Decrypting and importing…')
    file
      .arrayBuffer()
      .then((buf) => {
        const base64 = btoa(Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(''))
        return pc.importPortable(base64, pass)
      })
      .then((result) => {
        const parts: string[] = [
          `Imported ${result.profilesImported} profiles,`,
          `${result.groupsImported} groups,`,
          `${result.credentialsImported} credentials.`,
        ]
        if (result.unresolvedCredentials?.length) {
          parts.push(` ${result.unresolvedCredentials.length} credentials need secret mapping.`)
        }
        setPortableStatus(parts.join(' '))
        setEncFile(null)
        setPortablePass('')
      })
      .catch((e) => {
        setPortableStatus(`Import failed: ${String(e)}`)
      })
      .finally(() => {
        setPortableBusy(false)
      })
  }

  return (
    <>
      <div class="st-export-import-section">
        <label class="st-export-import-label">Import from configuration export (.json)</label>
        <input
          type="file"
          accept=".json"
          class="st-export-file-input"
          onChange={(e) => setConfigFile(e.currentTarget.files?.[0] ?? null)}
        />
        <button
          class="st-export-btn"
          disabled={configBusy() || !configFile()}
          onClick={handleConfigImport}
        >
          Import
        </button>
        <StatusLine message={configStatus()} />
      </div>
      <div class="st-export-import-section">
        <label class="st-export-import-label">Import from portable encrypted export (.enc)</label>
        <input
          type="file"
          accept=".enc"
          class="st-export-file-input"
          onChange={(e) => setEncFile(e.currentTarget.files?.[0] ?? null)}
        />
        <input
          type="password"
          class="st-export-passphrase-input"
          placeholder="Passphrase used during export"
          autocomplete="off"
          value={portablePass()}
          onInput={(e) => setPortablePass(e.currentTarget.value)}
        />
        <button
          class="st-export-btn"
          disabled={portableBusy() || !encFile() || !portablePass()}
          onClick={handlePortableImport}
        >
          Decrypt and Import
        </button>
        <StatusLine message={portableStatus()} />
      </div>
    </>
  )
}

// ── Mode card ────────────────────────────────────────────────────────────

function ModeCard(props: { def: ModeDef; profileClient: ProfileClient }) {
  const [expanded, setExpanded] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [manifest, setManifest] = createSignal<ExportManifest | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const loadManifest = () => {
    setLoading(true)
    props.profileClient
      .exportManifest(props.def.mode)
      .then(
        (m) => {
          setManifest(m)
          setLoaded(true)
        },
        (e) => {
          setError(`Failed to load: ${String(e)}`)
        },
      )
      .finally(() => {
        setLoading(false)
      })
  }

  const handleToggle = () => {
    const now = expanded()
    setExpanded(!now)
    if (!now && !loaded() && !loading()) {
      loadManifest()
    }
  }

  return (
    <div class="st-export-card" classList={{ 'st-export-card-expanded': expanded() }}>
      <div class="st-export-card-header">
        <span class="st-export-card-label">{props.def.label}</span>
        <span class="st-export-card-summary">{props.def.summary}</span>
        <button class="st-export-card-toggle" onClick={handleToggle}>
          {expanded() ? 'Hide details' : 'Show details'}
        </button>
      </div>
      <div class="st-export-card-body">
        <Show when={loading()}>
          <div class="st-export-loading">Loading mode details…</div>
        </Show>
        <Show when={error() !== null && !loading()}>
          <div class="st-export-error">{error()}</div>
        </Show>
        <Show when={manifest() !== null && !loading()}>
          <ManifestDisplay manifest={manifest()!} />
          <div class="st-export-actions">
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
          </div>
        </Show>
      </div>
    </div>
  )
}

// ── Root component ───────────────────────────────────────────────────────

export function ExportSection(props: { profileClient: ProfileClient }) {
  return (
    <div class="st-export">
      <h2 class="st-section-heading">Export / Backup / Import</h2>
      <p class="st-export-desc">
        Each mode states what it carries and what it omits. Private content and secrets are never
        included without an explicit choice.
      </p>
      <div class="st-export-grid">
        <For each={MODES}>
          {(def) => <ModeCard def={def} profileClient={props.profileClient} />}
        </For>
      </div>
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
