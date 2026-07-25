// Connection Manager — full-page view (Tabby-style, not a left sidebar).
// Opened via a "Connections" button in the tab bar. Shows the profile list
// on the left, form/edit panel on the right. Form exposes ALL SSH settings
// (host/port/user/auth/keys/keepalive/jumpHost/agentForward). Import from
// Tabby button reads a config.yml and merges profiles.

import {
  type ProfileClient,
  type SSHProfile,
  type ProfileGroup,
  type AuthMode,
  type Credential,
  buildGroupTree,
  resolveGroupPath,
  newProfileID,
} from './profiles'
import { Log } from '../wailsjs/go/main/WailsApp'

// ConnectionManagerView is the injectable interface — tests can stub the DOM.
export interface ConnectionManagerView {
  show(): void
  refresh(): Promise<void>
  onConnect?: (profile: SSHProfile) => void
}

export class ConnectionManagerViewImpl implements ConnectionManagerView {
  private container: HTMLElement
  private client: ProfileClient
  private profiles: SSHProfile[] = []
  private groups: ProfileGroup[] = []
  private credentials: Credential[] = []
  private selectedID = ''
  private editing: SSHProfile | null = null
  private editingCredential: Credential | null = null

  onConnect?: (profile: SSHProfile) => void

  constructor(container: HTMLElement, client: ProfileClient) {
    this.container = container
    this.client = client
  }

  show(): void {
    this.render()
  }

  async refresh(): Promise<void> {
    try {
      this.profiles = (await this.client.listProfiles()) ?? []
      this.groups = (await this.client.listGroups()) ?? []
      this.credentials = (await this.client.listCredentials()) ?? []
    } catch (err) {
      this.profiles = this.profiles ?? []
      this.groups = this.groups ?? []
      this.credentials = this.credentials ?? []
    }
    // Don't clobber an in-progress form — if the user clicked "+ New" or
    // "Saved credentials" while we were loading, keep their form open.
    if (this.editing === null && this.selectedID === '' && this.editingCredential === null) {
      this.render()
    }
  }

  // --- render ---

  private render(): void {
    Log('nocx: render() called, profiles: ' + this.profiles.length + ', editing: ' + (this.editing?.name || 'null'))
    if (!this.container) {
      return
    }
    
    try {
      this.container.replaceChildren()

      // Header with action buttons.
      const header = document.createElement('div')
      header.className = 'cm-header'

      const title = document.createElement('h1')
      title.textContent = 'Connections'
      header.append(title)

      const importBtn = document.createElement('button')
      importBtn.textContent = 'Import from Tabby'
      importBtn.title = 'Import SSH profiles from a Tabby config.yml'
      importBtn.onclick = () => {
        this.handleImport()
      }
      header.append(importBtn)

      const credBtn = document.createElement('button')
      credBtn.textContent = 'Saved credentials'
      credBtn.title = 'Manage saved passwords (keychain)'
      credBtn.onclick = () => {
        this.showCredentialsPanel()
      }
      header.append(credBtn)

      const newBtn = document.createElement('button')
      newBtn.className = 'cm-primary'
      newBtn.textContent = '+ New connection'
      newBtn.onclick = () => {
        this.startNewProfile()
      }
      header.append(newBtn)

      this.container.append(header)

      const body = document.createElement('div')
      body.className = 'cm-body'

      // List panel.
      body.append(this.renderList())

      // Form panel.
      const formPanel = document.createElement('div')
      formPanel.className = 'cm-form-panel'
      
      if (this.editingCredential) {
        formPanel.append(this.renderCredentialForm(this.editingCredential))
      } else if (this.editing) {
        formPanel.append(this.renderForm(this.editing))
      } else if (this.selectedID) {
        const p = this.profiles.find((x) => x.id === this.selectedID)
        if (p) {
          formPanel.append(this.renderForm(p))
        } else {
          formPanel.append(this.renderEmpty())
        }
      } else {
        formPanel.append(this.renderEmpty())
      }
      body.append(formPanel)

      this.container.append(body)
    } catch (err) {
      throw err
    }
  }

  private renderList(): HTMLElement {
    const list = document.createElement('div')
    list.className = 'cm-list'

    // Credentials section
    if (this.credentials.length > 0) {
      const credHeader = document.createElement('div')
      credHeader.className = 'cm-group-header'
      credHeader.textContent = 'Saved Credentials'
      list.append(credHeader)
      for (const cred of this.credentials) {
        list.append(this.renderCredentialListItem(cred))
      }
    }

    // Profiles section
    if (this.profiles.length === 0 && this.credentials.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'cm-list-empty'
      empty.textContent = 'No connections yet.\nClick "+ New connection" to add one.'
      list.append(empty)
      return list
    }

    // Build grouped list.
    const tree = buildGroupTree(this.groups)
    for (const node of tree) {
      list.append(this.renderGroupSection(node))
    }

    // Ungrouped.
    const ungrouped = this.profiles.filter(
      (p) => !p.group || !this.groups.some((g) => g.id === p.group),
    )
    if (ungrouped.length > 0) {
      const header = document.createElement('div')
      header.className = 'cm-group-header'
      header.textContent = 'Connections'
      list.append(header)
      for (const p of ungrouped) {
        list.append(this.renderListItem(p, []))
      }
    }
    return list
  }

  private renderCredentialListItem(cred: Credential): HTMLElement {
    const item = document.createElement('div')
    item.className = 'cm-item'
    if (this.editingCredential?.id === cred.id) item.classList.add('cm-selected')
    item.addEventListener('click', () => {
      this.selectedID = ''
      this.editing = null
      this.editingCredential = { ...cred }
      this.render()
    })

    const info = document.createElement('div')
    info.className = 'cm-item-info'
    const name = document.createElement('div')
    name.className = 'cm-item-name'
    name.textContent = cred.name
    const meta = document.createElement('div')
    meta.className = 'cm-item-meta'
    meta.textContent = `${cred.username} • ${authModeLabel(cred.auth)}`
    info.append(name, meta)
    item.append(info)
    return item
  }

  private renderGroupSection(group: import('./profiles').TreeNode): HTMLElement {
    const section = document.createElement('div')
    const header = document.createElement('div')
    header.className = 'cm-group-header'
    header.textContent = group.name
    section.append(header)
    for (const p of this.profiles.filter((p) => p.group === group.id)) {
      section.append(this.renderListItem(p, resolveGroupPath(this.groups, group.id)))
    }
    for (const child of group.children) {
      section.append(this.renderGroupSection(child))
    }
    return section
  }

  private renderListItem(p: SSHProfile, _groupPath: string[]): HTMLElement {
    void _groupPath
    Log('nocx: renderListItem id: ' + p.id + ', jumpHost: ' + p.options.jumpHost)
    const item = document.createElement('div')
    item.className = 'cm-item'
    if (p.id === this.selectedID) item.classList.add('cm-selected')
    item.addEventListener('click', () => {
      Log('nocx: profile clicked. id=' + p.id + ', jumpHost=' + p.options.jumpHost)
      this.selectedID = p.id
      this.editing = null
      this.editingCredential = null
      this.render()
    })
    item.addEventListener('dblclick', async () => {
      // Double-click: quick connect
      await this.quickConnect(p)
    })

    const info = document.createElement('div')
    info.className = 'cm-item-info'
    const name = document.createElement('div')
    name.className = 'cm-item-name'
    name.textContent = p.name
    const meta = document.createElement('div')
    meta.className = 'cm-item-meta'
    const port = p.options.port || 22
    meta.textContent = `${p.options.user || '?'}@${p.options.host}:${port}`
    info.append(name, meta)
    item.append(info)
    
    // Quick connect button
    const connectBtn = document.createElement('button')
    connectBtn.className = 'cm-quick-connect'
    connectBtn.textContent = 'SSH'
    connectBtn.title = 'Quick connect'
    connectBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      await this.quickConnect(p)
    })
    item.append(connectBtn)
    
    return item
  }

  private async quickConnect(p: SSHProfile): Promise<void> {
    const profileToConnect = this.cloneProfile(p)
    
    // Resolve credential if credentialId is set
    if (profileToConnect.options.credentialId) {
      const cred = this.credentials.find(c => c.id === profileToConnect.options.credentialId)
      if (cred) {
        profileToConnect.options.user = cred.username
        profileToConnect.options.auth = cred.auth
        
        // Load password from credential store
        try {
          const password = await this.client.lookupPassword(cred.id)
          if (password) {
            ;(profileToConnect.options as any).password = password
          }
        } catch (err) {
          Log('Failed to load password:' + ": " + err)
        }
      }
    }
    
    // Resolve jump host credentials if jumpHost is set
    if (profileToConnect.options.jumpHost) {
      const jumpProfile = this.profiles.find(p => p.id === profileToConnect.options.jumpHost)
      if (jumpProfile) {
        // Use jump profile's host and port as the actual jump host
        ;(profileToConnect.options as any).jumpHost = jumpProfile.options.host
        ;(profileToConnect.options as any).jumpPort = jumpProfile.options.port
        
        // Resolve jump host credential
        if (jumpProfile.options.credentialId) {
          const jumpCred = this.credentials.find(c => c.id === jumpProfile.options.credentialId)
          if (jumpCred) {
            ;(profileToConnect.options as any).jumpUser = jumpCred.username
            ;(profileToConnect.options as any).jumpAuthMode = jumpCred.auth
            
            // Load jump host password
            try {
              const jumpPassword = await this.client.lookupPassword(jumpCred.id)
              if (jumpPassword) {
                ;(profileToConnect.options as any).jumpPassword = jumpPassword
              }
            } catch (err) {
              Log('Failed to load jump host password:' + ": " + err)
            }
          }
        } else {
          // Use inline credentials from jump profile
          ;(profileToConnect.options as any).jumpUser = jumpProfile.options.user
          ;(profileToConnect.options as any).jumpAuthMode = jumpProfile.options.auth
        }
      }
    }
    
    this.onConnect?.(profileToConnect)
  }

  private renderEmpty(): HTMLElement {
    const div = document.createElement('div')
    div.style.color = '#565f89'
    div.style.fontSize = '13px'
    div.style.padding = '32px'
    div.textContent = 'Select a connection to edit, or click "+ New connection" to create one.'
    return div
  }

  // --- form (all SSH settings) ---

  private renderForm(profile: SSHProfile): HTMLElement {
    Log('nocx: renderForm called for profile: ' + profile.name + ', id: ' + profile.id)
    const form = document.createElement('div')
    form.className = 'cm-form'

    const isNew = profile.id === '' || !this.profiles.some(p => p.id === profile.id)

    // Basic section.
    const basic = document.createElement('div')
    basic.className = 'cm-form-section'
    const basicTitle = document.createElement('h2')
    basicTitle.textContent = 'Basic'
    basic.append(basicTitle)

    basic.append(
      this.textField('Name', profile.name, 'text', (v) => {
        profile.name = v
        if (!profile.id) profile.id = newProfileID('ssh', v)
      }),
    )
    basic.append(
      this.textField('Host', profile.options.host, 'text', (v) => {
        profile.options.host = v
      }),
    )
    basic.append(
      this.numberField('Port', profile.options.port || 22, (v) => {
        profile.options.port = v
      }),
    )

    // Credential selector.
    const credField = document.createElement('div')
    credField.className = 'cm-field'
    const credLabel = document.createElement('label')
    credLabel.textContent = 'Credential (УЗ)'
    const credSelect = document.createElement('select')
    credSelect.style.width = '100%'
    credSelect.style.padding = '6px'
    credSelect.style.background = '#1f2335'
    credSelect.style.border = '1px solid #2a2b3d'
    credSelect.style.borderRadius = '4px'
    credSelect.style.color = '#c0caf5'

    const noneOption = document.createElement('option')
    noneOption.value = ''
    noneOption.textContent = '— None (specify below) —'
    credSelect.append(noneOption)

    for (const cred of this.credentials) {
      const option = document.createElement('option')
      option.value = cred.id
      option.textContent = `${cred.name} (${cred.username})`
      option.selected = profile.options.credentialId === cred.id
      credSelect.append(option)
    }

    credSelect.addEventListener('change', () => {
      profile.options.credentialId = credSelect.value
      this.rerenderForm(profile)
    })

    credField.append(credLabel, credSelect)
    basic.append(credField)

    // If no credential selected, show inline user/auth fields.
    if (!profile.options.credentialId) {
      basic.append(
        this.textField('User', profile.options.user || '', 'text', (v) => {
          profile.options.user = v
        }),
      )
    }

    form.append(basic)

    // Auth section (only if no credential selected).
    if (!profile.options.credentialId) {
      const auth = document.createElement('div')
      auth.className = 'cm-form-section'
      const authTitle = document.createElement('h2')
      authTitle.textContent = 'Authentication (override)'
      auth.append(authTitle)

      const authHint = document.createElement('div')
      authHint.style.color = '#565f89'
      authHint.style.fontSize = '12px'
      authHint.style.marginBottom = '12px'
      authHint.textContent = 'Tip: Create a Credential above to reuse auth settings across connections.'
      auth.append(authHint)

      // Auth mode radio group.
      const authField = document.createElement('div')
      authField.className = 'cm-field'
      const authLabel = document.createElement('label')
      authLabel.textContent = 'Method'
      const radioGroup = document.createElement('div')
      radioGroup.className = 'cm-radio-group'
      for (const mode of [
        '',
        'password',
        'publicKey',
        'agent',
        'keyboardInteractive',
      ] as AuthMode[]) {
        const lbl = document.createElement('label')
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = 'auth-mode'
        radio.value = mode
        radio.checked = (profile.options.auth ?? '') === mode
        radio.addEventListener('change', () => {
          profile.options.auth = mode
          this.rerenderForm(profile)
        })
        lbl.append(radio, document.createTextNode(authModeLabel(mode)))
        radioGroup.append(lbl)
      }
      authField.append(authLabel, radioGroup)
      auth.append(authField)

      form.append(auth)
    } else {
      // Show which credential is selected.
      const credInfo = document.createElement('div')
      credInfo.className = 'cm-form-section'
      const cred = this.credentials.find((c) => c.id === profile.options.credentialId)
      if (cred) {
        const info = document.createElement('div')
        info.style.padding = '12px'
        info.style.background = 'rgba(122, 162, 247, 0.1)'
        info.style.borderRadius = '6px'
        info.style.color = '#c0caf5'
        info.innerHTML = `
          <strong>Using Credential:</strong> ${cred.name}<br>
          <small>Username: ${cred.username} | Auth: ${authModeLabel(cred.auth)}</small>
        `
        credInfo.append(info)
      }
      form.append(credInfo)
    }

    // Advanced section.
    const adv = document.createElement('div')
    adv.className = 'cm-form-section'
    const advTitle = document.createElement('h2')
    advTitle.textContent = 'Advanced'
    adv.append(advTitle)
    adv.append(
      this.numberField('Keepalive interval (ms)', profile.options.keepaliveInterval || 0, (v) => {
        profile.options.keepaliveInterval = v
      }),
    )
    adv.append(
      this.numberField('Keepalive count max', profile.options.keepaliveCountMax || 0, (v) => {
        profile.options.keepaliveCountMax = v
      }),
    )
    adv.append(
      this.numberField('Ready timeout (ms)', profile.options.readyTimeout || 0, (v) => {
        profile.options.readyTimeout = v
      }),
    )
    
    // Jump host selector - dropdown of profiles with canBeJumpServer=true
    const jumpHostField = document.createElement('div')
    jumpHostField.className = 'cm-field'
    const jumpHostLabel = document.createElement('label')
    jumpHostLabel.textContent = 'Jump server'
    const jumpHostSelect = document.createElement('select')
    jumpHostSelect.style.width = '100%'
    jumpHostSelect.style.padding = '6px'
    jumpHostSelect.style.background = '#1f2335'
    jumpHostSelect.style.border = '1px solid #2a2b3d'
    jumpHostSelect.style.borderRadius = '4px'
    jumpHostSelect.style.color = '#c0caf5'
    
    const jumpNoneOption = document.createElement('option')
    jumpNoneOption.value = ''
    jumpNoneOption.textContent = '— None —'
    jumpHostSelect.append(jumpNoneOption)
    
    // Get profiles that can be jump servers
    const jumpServerProfiles = this.profiles.filter(p => p.options.canBeJumpServer)
    Log('nocx: jumpServerProfiles: ' + jumpServerProfiles.map(p => p.id + ':' + p.name).join(', '))
    Log('nocx: current jumpHost: ' + profile.options.jumpHost)
    for (const p of jumpServerProfiles) {
      const option = document.createElement('option')
      option.value = p.id
      option.textContent = p.name
      option.selected = profile.options.jumpHost === p.id
      jumpHostSelect.append(option)
    }
    
    jumpHostSelect.addEventListener('change', () => {
      profile.options.jumpHost = jumpHostSelect.value
    })
    
    jumpHostField.append(jumpHostLabel, jumpHostSelect)
    adv.append(jumpHostField)
    
    adv.append(
      this.checkboxField('Agent forward', profile.options.agentForward ?? false, (v) => {
        profile.options.agentForward = v
      }),
    )
    
    adv.append(
      this.checkboxField('Can be used as jump server', profile.options.canBeJumpServer ?? false, (v) => {
        profile.options.canBeJumpServer = v
      }),
    )
    
    form.append(adv)

    // Actions.
    const actions = document.createElement('div')
    actions.className = 'cm-form-actions'

    const connectBtn = document.createElement('button')
    connectBtn.className = 'cm-connect'
    connectBtn.textContent = 'Connect'
    connectBtn.addEventListener('click', async () => {
      Log('nocx: Connect button clicked, jumpHost: ' + profile.options.jumpHost)
      const profileToConnect = this.cloneProfile(profile)
      
      // Resolve credential if credentialId is set
      if (profileToConnect.options.credentialId) {
        const cred = this.credentials.find(c => c.id === profileToConnect.options.credentialId)
        if (cred) {
          profileToConnect.options.user = cred.username
          profileToConnect.options.auth = cred.auth
          
          // Load password from credential store
          try {
            const password = await this.client.lookupPassword(cred.id)
            if (password) {
              ;(profileToConnect.options as any).password = password
            }
          } catch (err) {
            Log('Failed to load password:' + ": " + err)
          }
        }
      }
      
      // Resolve jump host credentials if jumpHost is set
      if (profileToConnect.options.jumpHost) {
        const jumpProfile = this.profiles.find(p => p.id === profileToConnect.options.jumpHost)
        if (jumpProfile) {
          // Use jump profile's host and port as the actual jump host
          ;(profileToConnect.options as any).jumpHost = jumpProfile.options.host
          ;(profileToConnect.options as any).jumpPort = jumpProfile.options.port
          
          // Resolve jump host credential
          if (jumpProfile.options.credentialId) {
            const jumpCred = this.credentials.find(c => c.id === jumpProfile.options.credentialId)
            if (jumpCred) {
              ;(profileToConnect.options as any).jumpUser = jumpCred.username
              ;(profileToConnect.options as any).jumpAuthMode = jumpCred.auth
              
              // Load jump host password
              try {
                const jumpPassword = await this.client.lookupPassword(jumpCred.id)
                if (jumpPassword) {
                  ;(profileToConnect.options as any).jumpPassword = jumpPassword
                }
              } catch (err) {
                Log('Failed to load jump host password:' + ": " + err)
              }
            }
          } else {
            // Use inline credentials from jump profile
            ;(profileToConnect.options as any).jumpUser = jumpProfile.options.user
            ;(profileToConnect.options as any).jumpAuthMode = jumpProfile.options.auth
          }
        }
      }
      
      this.onConnect?.(profileToConnect)
    })
    actions.append(connectBtn)

    const saveBtn = document.createElement('button')
    saveBtn.className = 'cm-save'
    saveBtn.textContent = isNew ? 'Create' : 'Save'
    saveBtn.addEventListener('click', () => {
      Log('nocx: saveBtn clicked, isNew: ' + isNew + ', profile.id: ' + profile.id)
      void this.saveProfile(profile)
    })
    actions.append(saveBtn)

    if (!isNew) {
      const delBtn = document.createElement('button')
      delBtn.className = 'cm-danger'
      delBtn.textContent = 'Delete'
      delBtn.addEventListener('click', () => void this.deleteProfile(profile))
      actions.append(delBtn)
    }
    form.append(actions)

    return form
  }

  // Re-render just the form panel (preserves the list).
  private rerenderForm(profile: SSHProfile): void {
    this.editing = profile
    const formPanel = this.container.querySelector('.cm-form-panel')
    if (formPanel) {
      formPanel.replaceChildren(this.renderForm(profile))
    }
  }

  // --- form field helpers ---

  private textField(
    label: string,
    value: string,
    _type: string,
    onChange: (v: string) => void,
  ): HTMLElement {
    return this.inputField(label, value, 'text', (v) => onChange(v))
  }

  private numberField(label: string, value: number, onChange: (v: number) => void): HTMLElement {
    return this.inputField(label, String(value), 'number', (v) => {
      const n = parseInt(v, 10)
      onChange(isNaN(n) ? 0 : n)
    })
  }

  private inputField(
    label: string,
    value: string,
    type: string,
    onChange: (v: string) => void,
  ): HTMLElement {
    const field = document.createElement('div')
    field.className = 'cm-field'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const input = document.createElement('input')
    input.type = type
    input.value = value
    input.addEventListener('input', () => onChange(input.value))
    field.append(lbl, input)
    return field
  }

  private checkboxField(
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ): HTMLElement {
    const field = document.createElement('div')
    field.className = 'cm-field'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = checked
    input.addEventListener('change', () => onChange(input.checked))
    field.append(lbl, input)
    return field
  }

  // --- actions ---

  private startNewProfile(): void {
    const profile: SSHProfile = {
      id: '',
      type: 'ssh',
      name: 'New connection',
      options: { host: '', port: 22, user: '', auth: '' },
    }
    this.selectedID = ''
    this.editing = profile
    this.render()
    const nameInput = this.container.querySelector<HTMLInputElement>(
      '.cm-form-panel input[type="text"]',
    )
    nameInput?.focus()
    nameInput?.select()
  }

  // showCredentialsPanel opens a form to create/edit a Credential (УЗ).
  // Credentials are reusable authentication identities: name + username + auth method + secret.
  // They are separate from connections — multiple connections can share one credential.
  private showCredentialsPanel(cred?: Credential): void {
    this.selectedID = ''
    this.editing = null
    const credential: Credential = cred ?? {
      id: '',
      name: '',
      username: '',
      auth: '',
    }
    this.editingCredential = { ...credential }
    this.render()
  }

  private renderCredentialForm(credential: Credential): HTMLElement {
    const form = document.createElement('div')
    form.className = 'cm-form'

    const isNew = credential.id === ''

    const section = document.createElement('div')
    section.className = 'cm-form-section'
    const h2 = document.createElement('h2')
    h2.textContent = isNew ? 'New Credential (УЗ)' : 'Edit Credential'
    section.append(h2)

    section.append(
      this.textField('Name', credential.name, 'text', (v) => {
        credential.name = v
        if (!credential.id) credential.id = `cred:${v}:${Date.now()}`
      }),
    )
    section.append(
      this.textField('Username', credential.username, 'text', (v) => {
        credential.username = v
      }),
    )

    // Auth method radio group.
    const authField = document.createElement('div')
    authField.className = 'cm-field'
    const authLabel = document.createElement('label')
    authLabel.textContent = 'Authentication Method'
    const radioGroup = document.createElement('div')
    radioGroup.className = 'cm-radio-group'
    for (const mode of ['password', 'publicKey', 'agent'] as AuthMode[]) {
      const lbl = document.createElement('label')
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'cred-auth-mode'
      radio.value = mode
      radio.checked = credential.auth === mode
      radio.addEventListener('change', () => {
        credential.auth = mode
        this.rerenderCredentialForm(credential)
      })
      lbl.append(radio, document.createTextNode(authModeLabel(mode)))
      radioGroup.append(lbl)
    }
    authField.append(authLabel, radioGroup)
    section.append(authField)

    // Password field — visible when auth is password.
    if (credential.auth === 'password') {
      const pwField = document.createElement('div')
      pwField.className = 'cm-field'
      const pwLabel = document.createElement('label')
      pwLabel.textContent = 'Password (stored in OS keychain)'
      const pwInput = document.createElement('input')
      pwInput.type = 'password'
      pwInput.placeholder = credential.id ? 'Leave empty to keep current' : 'Enter password'
      pwField.append(pwLabel, pwInput)
      section.append(pwField)

      // Store reference for save handler
      ;(form as any)._passwordInput = pwInput
    }

    // Private key field — visible when auth is publicKey.
    if (credential.auth === 'publicKey') {
      section.append(
        this.textField('Private Key Path', credential.keyPath || '', 'text', (v) => {
          credential.keyPath = v
        }),
      )
    }

    // Optional host binding.
    section.append(
      this.textField('Bind to Host (optional)', credential.host || '', 'text', (v) => {
        credential.host = v
      }),
    )
    if (credential.host) {
      section.append(
        this.numberField('Port', credential.port || 22, (v) => {
          credential.port = v
        }),
      )
    }

    form.append(section)

    const actions = document.createElement('div')
    actions.className = 'cm-form-actions'
    const saveBtn = document.createElement('button')
    saveBtn.className = 'cm-save'
    saveBtn.textContent = isNew ? 'Create Credential' : 'Save Credential'
    saveBtn.addEventListener('click', () => void this.saveCredential(credential, form))
    actions.append(saveBtn)

    if (!isNew) {
      const delBtn = document.createElement('button')
      delBtn.className = 'cm-danger'
      delBtn.textContent = 'Delete Credential'
      delBtn.addEventListener('click', () => void this.deleteCredential(credential))
      actions.append(delBtn)
    }

    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', () => {
      this.editingCredential = null
      this.render()
    })
    actions.append(cancelBtn)

    form.append(actions)

    return form
  }

  private rerenderCredentialForm(credential: Credential): void {
    this.editingCredential = credential
    const formPanel = this.container.querySelector('.cm-form-panel')
    if (formPanel) {
      formPanel.replaceChildren(this.renderCredentialForm(credential))
    }
  }

  private async saveCredential(credential: Credential, form: HTMLElement): Promise<void> {
    if (!credential.name || !credential.username) {
      Log('Name and username are required')
      return
    }

    try {
      await this.client.createCredential(credential)

      // Save password to keychain if auth is password and password was entered.
      if (credential.auth === 'password') {
        const pwInput = (form as any)._passwordInput as HTMLInputElement
        if (pwInput && pwInput.value) {
          await this.client.savePassword(credential.id, pwInput.value)
        }
      }

      this.editingCredential = null
      await this.refresh()
    } catch (err) {
      Log('Failed to save: ' + (err as Error).message)
    }
  }

  private async deleteCredential(credential: Credential): Promise<void> {
    if (!confirm(`Delete credential "${credential.name}"?`)) return
    try {
      await this.client.deleteCredential(credential.id)
      this.editingCredential = null
      await this.refresh()
    } catch (err) {
      // Silent fail
    }
  }

  private async saveProfile(profile: SSHProfile): Promise<void> {
    Log('nocx: saveProfile called. id=' + profile.id + ', jumpHost=' + profile.options.jumpHost)
    if (!profile.id) {
      profile.id = newProfileID('ssh', profile.name)
    }
    try {
      await this.client.createProfile(profile)
      Log(`nocx: profile saved successfully. id=${profile.id}`)
      this.selectedID = profile.id
      this.editing = null
      await this.refresh()
    } catch (err) {
      Log(`Failed to save: ${(err as Error).message}`)
    }
  }

  private async deleteProfile(profile: SSHProfile): Promise<void> {
    if (!confirm(`Delete "${profile.name}"?`)) return
    try {
      await this.client.deleteProfile(profile.id)
      this.selectedID = ''
      this.editing = null
      await this.refresh()
    } catch (err) {
      // Silent fail
    }
  }

  private handleImport(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.yml,.yaml'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void file.text().then((text) =>
        this.client
          .importTabby(text)
          .then((count) => {
            Log(`Imported ${count} SSH profiles from Tabby config`)
            return this.refresh()
          })
          .catch((err: unknown) => {
            Log('Import failed: ' + (err as Error).message)
          }),
      )
    })
    input.click()
  }

  private cloneProfile(p: SSHProfile): SSHProfile {
    return JSON.parse(JSON.stringify(p)) as SSHProfile
  }
}

function authModeLabel(mode: AuthMode): string {
  switch (mode) {
    case '':
      return 'Auto'
    case 'password':
      return 'Password'
    case 'publicKey':
      return 'Public Key'
    case 'agent':
      return 'Agent'
    case 'keyboardInteractive':
      return 'Keyboard Interactive'
  }
}
