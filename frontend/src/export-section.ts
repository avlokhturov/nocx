// Export/backup/import section — renders below the generated settings view.
// Four modes (ADR-0011 §7), each stating what it carries and omits.
// The portable encrypted export prompts for a new passphrase with
// confirmation via inline inputs (not a Modal primitive, not prompt()).

import type { ProfileClient, ExportManifest, ConfigExport } from './profiles'

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

export function renderExportSection(container: HTMLElement, profileClient: ProfileClient): void {
  const root = document.createElement('div')
  root.className = 'st-export'

  const heading = document.createElement('h2')
  heading.className = 'st-section-heading'
  heading.textContent = 'Export / Backup / Import'
  root.appendChild(heading)

  const desc = document.createElement('p')
  desc.className = 'st-export-desc'
  desc.textContent =
    'Each mode states what it carries and what it omits. ' +
    'Private content and secrets are never included without an explicit choice.'
  root.appendChild(desc)

  const grid = document.createElement('div')
  grid.className = 'st-export-grid'

  for (const def of MODES) {
    const card = buildModeCard(def, profileClient)
    grid.appendChild(card)
  }

  root.appendChild(grid)
  container.appendChild(root)
}

// ── Mode card ─────────────────────────────────────────────────────────

function buildModeCard(def: ModeDef, pc: ProfileClient): HTMLElement {
  const card = document.createElement('div')
  card.className = 'st-export-card'

  // Header — always visible
  const header = document.createElement('div')
  header.className = 'st-export-card-header'

  const label = document.createElement('span')
  label.className = 'st-export-card-label'
  label.textContent = def.label

  const summary = document.createElement('span')
  summary.className = 'st-export-card-summary'
  summary.textContent = def.summary

  header.appendChild(label)
  header.appendChild(summary)

  // Expand button
  const toggle = document.createElement('button')
  toggle.className = 'st-export-card-toggle'
  toggle.textContent = 'Show details'
  toggle.addEventListener('click', () => {
    const expanded = card.classList.toggle('st-export-card-expanded')
    toggle.textContent = expanded ? 'Hide details' : 'Show details'
    if (expanded && !card.dataset.loaded) {
      void loadCardBody(card, def, pc)
    }
  })

  header.appendChild(toggle)
  card.appendChild(header)

  // Body — populated on first expand
  const body = document.createElement('div')
  body.className = 'st-export-card-body'
  card.appendChild(body)

  return card
}

// ── Load manifest + render body ────────────────────────────────────────

async function loadCardBody(card: HTMLElement, def: ModeDef, pc: ProfileClient): Promise<void> {
  card.dataset.loaded = '1'
  const body = card.querySelector('.st-export-card-body') as HTMLElement
  if (!body) return

  // Show spinner
  body.innerHTML = '<div class="st-export-loading">Loading mode details…</div>'

  let manifest: ExportManifest
  try {
    manifest = await pc.exportManifest(def.mode)
  } catch (e) {
    body.innerHTML = `<div class="st-export-error">Failed to load: ${String(e)}</div>`
    return
  }

  body.innerHTML = ''

  // Carries / Omits / Notes
  renderManifest(body, manifest)

  // Mode-specific action area
  const actions = document.createElement('div')
  actions.className = 'st-export-actions'
  body.appendChild(actions)

  switch (def.mode) {
    case 'config-export':
      renderConfigExportActions(actions, pc)
      break
    case 'portable-encrypted':
      renderPortableActions(actions, pc)
      break
    case 'same-machine-backup':
      renderBackupActions(actions, pc)
      break
    case 'import':
      renderImportActions(actions, pc)
      break
  }
}

// ── Manifest display ───────────────────────────────────────────────────

function renderManifest(container: HTMLElement, m: ExportManifest): void {
  const list = document.createElement('ul')
  list.className = 'st-export-manifest'

  for (const item of m.carries) {
    const li = document.createElement('li')
    li.className = 'st-export-carries'
    li.innerHTML = `<span class="st-export-check">+</span> ${escapeHtml(item)}`
    list.appendChild(li)
  }
  for (const item of m.omits) {
    const li = document.createElement('li')
    li.className = 'st-export-omits'
    li.innerHTML = `<span class="st-export-cross">−</span> ${escapeHtml(item)}`
    list.appendChild(li)
  }
  if (m.notes) {
    for (const note of m.notes) {
      const li = document.createElement('li')
      li.className = 'st-export-note'
      li.textContent = note
      list.appendChild(li)
    }
  }

  container.appendChild(list)
}

// ── Config export actions ──────────────────────────────────────────────

function renderConfigExportActions(container: HTMLElement, pc: ProfileClient): void {
  const btn = document.createElement('button')
  btn.className = 'st-export-btn'
  btn.textContent = 'Export Configuration'
  const status = appendStatus(container)

  btn.addEventListener('click', () => {
    void (async () => {
      btn.disabled = true
      status.textContent = 'Exporting…'
      try {
        const result = await pc.configExport()
        downloadJSON('nocx-config-export.json', result)
        status.textContent = 'Exported — file downloaded.'
      } catch (e) {
        status.textContent = `Export failed: ${String(e)}`
      } finally {
        btn.disabled = false
      }
    })()
  })

  container.appendChild(btn)
  container.appendChild(status)
}

// ── Portable encrypted export actions ──────────────────────────────────

function renderPortableActions(container: HTMLElement, pc: ProfileClient): void {
  // Passphrase form
  const form = document.createElement('div')
  form.className = 'st-export-passphrase-form'

  const passLabel = document.createElement('label')
  passLabel.textContent = 'New passphrase'
  passLabel.className = 'st-export-passphrase-label'

  const passInput = document.createElement('input')
  passInput.type = 'password'
  passInput.className = 'st-export-passphrase-input'
  passInput.placeholder = 'Choose a strong passphrase'
  passInput.autocomplete = 'new-password'

  const confirmLabel = document.createElement('label')
  confirmLabel.textContent = 'Confirm passphrase'
  confirmLabel.className = 'st-export-passphrase-label'

  const confirmInput = document.createElement('input')
  confirmInput.type = 'password'
  confirmInput.className = 'st-export-passphrase-input'
  confirmInput.placeholder = 'Re-enter the passphrase'
  confirmInput.autocomplete = 'new-password'

  // Show/hide toggle
  const showToggle = document.createElement('label')
  showToggle.className = 'st-export-show-toggle'
  const showCheck = document.createElement('input')
  showCheck.type = 'checkbox'
  showCheck.addEventListener('change', () => {
    const type = showCheck.checked ? 'text' : 'password'
    passInput.type = type
    confirmInput.type = type
  })
  showToggle.appendChild(showCheck)
  showToggle.appendChild(document.createTextNode(' Show passphrase'))

  // Include private content toggle
  const privateToggle = document.createElement('label')
  privateToggle.className = 'st-export-private-toggle'
  const privateCheck = document.createElement('input')
  privateCheck.type = 'checkbox'
  privateToggle.appendChild(privateCheck)
  privateToggle.appendChild(
    document.createTextNode(' Include private content (conversations, command history)'),
  )

  form.appendChild(passLabel)
  form.appendChild(passInput)
  form.appendChild(confirmLabel)
  form.appendChild(confirmInput)
  form.appendChild(showToggle)
  form.appendChild(privateToggle)

  const actions = document.createElement('div')
  actions.className = 'st-export-btn-row'

  const btn = document.createElement('button')
  btn.className = 'st-export-btn st-export-btn-primary'
  btn.textContent = 'Encrypt and Export'
  const status = appendStatus(actions)

  btn.addEventListener('click', () => {
    void (async () => {
      const pass = passInput.value
      const confirm = confirmInput.value
      if (!pass) {
        status.textContent = 'Passphrase is required.'
        return
      }
      if (pass !== confirm) {
        status.textContent = 'Passphrases do not match.'
        return
      }
      btn.disabled = true
      status.textContent = 'Encrypting…'
      try {
        const result = await pc.portableEncryptedExport(pass, privateCheck.checked)
        // result.payload is base64-encoded ciphertext; download as raw binary.
        downloadBinary('nocx-portable-export.enc', result.payload)
        status.textContent = 'Exported — file downloaded. Keep the passphrase safe.'
        passInput.value = ''
        confirmInput.value = ''
      } catch (e) {
        status.textContent = `Export failed: ${String(e)}`
      } finally {
        btn.disabled = false
      }
    })()
  })

  actions.appendChild(btn)
  actions.appendChild(status)

  container.appendChild(form)
  container.appendChild(actions)
}

// ── Backup actions ─────────────────────────────────────────────────────

function renderBackupActions(container: HTMLElement, pc: ProfileClient): void {
  const btn = document.createElement('button')
  btn.className = 'st-export-btn'
  btn.textContent = 'Show Backup Paths'
  const status = appendStatus(container)
  const details = document.createElement('pre')
  details.className = 'st-export-backup-details'
  details.style.display = 'none'

  btn.addEventListener('click', () => {
    void (async () => {
      btn.disabled = true
      status.textContent = 'Checking…'
      try {
        const result = await pc.backup()
        details.textContent = JSON.stringify(result, null, 2)
        details.style.display = 'block'
        status.textContent = ''
      } catch (e) {
        status.textContent = `Backup check failed: ${String(e)}`
        details.style.display = 'none'
      } finally {
        btn.disabled = false
      }
    })()
  })

  container.appendChild(btn)
  container.appendChild(status)
  container.appendChild(details)
}

// ── Import actions ─────────────────────────────────────────────────────

function renderImportActions(container: HTMLElement, pc: ProfileClient): void {
  // Config import — file picker
  const configSection = document.createElement('div')
  configSection.className = 'st-export-import-section'

  const configLabel = document.createElement('label')
  configLabel.textContent = 'Import from configuration export (.json)'
  configLabel.className = 'st-export-import-label'

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.json'
  fileInput.className = 'st-export-file-input'

  const configBtn = document.createElement('button')
  configBtn.className = 'st-export-btn'
  configBtn.textContent = 'Import'
  configBtn.disabled = true
  const configStatus = appendStatus(configSection)

  fileInput.addEventListener('change', () => {
    configBtn.disabled = !fileInput.files?.length
    configStatus.textContent = ''
  })

  configBtn.addEventListener('click', () => {
    void (async () => {
      const file = fileInput.files?.[0]
      if (!file) return
      configBtn.disabled = true
      configStatus.textContent = 'Importing…'
      try {
        const text = await file.text()
        const data = JSON.parse(text) as ConfigExport
        const result = await pc.importConfig(data)
        configStatus.textContent =
          `Imported ${result.profilesImported} profiles, ` +
          `${result.groupsImported} groups, ` +
          `${result.credentialsImported} credentials.` +
          (result.unresolvedCredentials?.length
            ? ` ${result.unresolvedCredentials.length} credentials need secret mapping.`
            : '')
      } catch (e) {
        configStatus.textContent = `Import failed: ${String(e)}`
      } finally {
        configBtn.disabled = false
      }
    })()
  })

  configSection.appendChild(configLabel)
  configSection.appendChild(fileInput)
  configSection.appendChild(configBtn)
  configSection.appendChild(configStatus)

  // Portable import
  const portableSection = document.createElement('div')
  portableSection.className = 'st-export-import-section'

  const portableLabel = document.createElement('label')
  portableLabel.textContent = 'Import from portable encrypted export (.enc)'
  portableLabel.className = 'st-export-import-label'

  const encFileInput = document.createElement('input')
  encFileInput.type = 'file'
  encFileInput.accept = '.enc'
  encFileInput.className = 'st-export-file-input'

  const portablePassInput = document.createElement('input')
  portablePassInput.type = 'password'
  portablePassInput.className = 'st-export-passphrase-input'
  portablePassInput.placeholder = 'Passphrase used during export'
  portablePassInput.autocomplete = 'off'

  const portableBtn = document.createElement('button')
  portableBtn.className = 'st-export-btn'
  portableBtn.textContent = 'Decrypt and Import'
  portableBtn.disabled = true
  const portableStatus = appendStatus(portableSection)

  function updatePortableBtn(): void {
    portableBtn.disabled = !encFileInput.files?.length || !portablePassInput.value
  }
  encFileInput.addEventListener('change', updatePortableBtn)
  portablePassInput.addEventListener('input', updatePortableBtn)

  portableBtn.addEventListener('click', () => {
    void (async () => {
      const file = encFileInput.files?.[0]
      if (!file) return
      portableBtn.disabled = true
      portableStatus.textContent = 'Decrypting and importing…'
      try {
        const buf = await file.arrayBuffer()
        const base64 = btoa(Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(''))
        const result = await pc.importPortable(base64, portablePassInput.value)
        portableStatus.textContent =
          `Imported ${result.profilesImported} profiles, ` +
          `${result.groupsImported} groups, ` +
          `${result.credentialsImported} credentials.` +
          (result.unresolvedCredentials?.length
            ? ` ${result.unresolvedCredentials.length} credentials need secret mapping.`
            : '')
        encFileInput.value = ''
        portablePassInput.value = ''
      } catch (e) {
        portableStatus.textContent = `Import failed: ${String(e)}`
      } finally {
        portableBtn.disabled = false
      }
    })()
  })

  portableSection.appendChild(portableLabel)
  portableSection.appendChild(encFileInput)
  portableSection.appendChild(portablePassInput)
  portableSection.appendChild(portableBtn)
  portableSection.appendChild(portableStatus)

  container.appendChild(configSection)
  container.appendChild(portableSection)
}

// ── Helpers ─────────────────────────────────────────────────────────────

function appendStatus(container: HTMLElement): HTMLElement {
  const el = document.createElement('div')
  el.className = 'st-export-status'
  container.appendChild(el)
  return el
}

function downloadJSON(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Convert a base64 string to a Uint8Array. Exported for testing. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function downloadBinary(filename: string, base64: string): void {
  const bytes = base64ToBytes(base64)
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function escapeHtml(s: string): string {
  const el = document.createElement('span')
  el.textContent = s
  return el.innerHTML
}
