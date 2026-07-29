import { Dispatcher } from './dispatcher'

// Profile/group models + IPC client for the connection manager.
// Mirrors the backend internal/profile package (nocx-fxs.1) and the
// JSON-RPC control-plane methods wired in nocx-fxs.5.

// AuthMode controls which auth buckets are tried (null=Auto with full
// fallback-chain; a specific value restricts which buckets are attempted).
export type AuthMode = '' | 'password' | 'publicKey' | 'agent' | 'keyboardInteractive'

export interface BehaviorOnSessionEnd {
  value: 'auto' | 'keep' | 'reconnect' | 'close'
}

// Base holds the generic profile fields shared by all profile types.
export interface Base {
  id: string
  type: string
  name: string
  group?: string
  icon?: string
  color?: string
  disableDynamicTitle?: boolean
  behaviorOnSessionEnd?: 'auto' | 'keep' | 'reconnect' | 'close'
  weight?: number
  isBuiltin?: boolean
  isTemplate?: boolean
}

export interface SSHProfileOptions {
  host: string
  port?: number
  // Link to a Credential (УЗ) by ID. If set, user/auth/keyPath come from the credential.
  // If empty, user/auth below are used directly (legacy/quick-connect).
  credentialId?: string
  // Override fields (used only if credentialId is empty)
  user?: string
  auth?: AuthMode
  // Note: passwords/keys are NEVER stored here — they live in the Credential's keychain entry.
  keepaliveInterval?: number
  keepaliveCountMax?: number
  readyTimeout?: number
  jumpHost?: string // Profile name or ID of the jump server
  jumpPort?: number // Jump server port
  jumpUser?: string // Jump server username (resolved from credential)
  jumpPassword?: string // Jump server password (resolved from credential store)
  jumpAuthMode?: AuthMode // Jump server auth mode
  agentForward?: boolean
  canBeJumpServer?: boolean // Whether this profile can be used as a jump server
}

export interface SSHProfile extends Base {
  options: SSHProfileOptions
}

export interface ProfileGroup {
  id: string
  parentGroupId?: string
  name: string
  description?: string
  defaults?: Record<string, unknown>
  order?: number
  color?: string
  icon?: string
}

// Credential is a reusable authentication identity (nocx-УЗ).
// Stored separately from connections so multiple connections can share it.
export interface Credential {
  id: string
  name: string // Display name (e.g. "work-github", "prod-server")
  username: string
  auth: AuthMode // Auth method: password, publicKey, agent, keyboardInteractive
  // Secret depends on auth method:
  // - password: the password (stored in OS keychain, not here)
  // - publicKey: path to private key or vault:// URL
  // - agent/keyboardInteractive: not needed
  keyPath?: string // Only for publicKey auth
}

// TreeNode is a ProfileGroup with its children resolved — the output of
// buildGroupTree.
export interface TreeNode extends ProfileGroup {
  children: TreeNode[]
}

// buildGroupTree turns a flat group list into a nested tree via parentGroupId.
// Orphaned groups (parent not found) become roots.
export function buildGroupTree(groups: ProfileGroup[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  for (const g of groups) {
    map.set(g.id, { ...g, children: [] })
  }

  for (const g of groups) {
    const node = map.get(g.id)!
    if (g.parentGroupId && map.has(g.parentGroupId)) {
      map.get(g.parentGroupId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

// resolveGroupPath walks the parent chain returning breadcrumb names
// (root first, leaf last). Cycle-guarded at 32 levels.
export function resolveGroupPath(groups: ProfileGroup[], id: string): string[] {
  const map = new Map(groups.map((g) => [g.id, g]))
  const path: string[] = []
  let current: ProfileGroup | undefined = map.get(id)
  let guard = 0
  while (current && guard < 32) {
    path.unshift(current.name)
    current = current.parentGroupId ? map.get(current.parentGroupId) : undefined
    guard++
  }
  return path
}

// parseQuickConnect parses "ssh://user@host:port", "user@host:port", "user@host",
// "host", "[host]:port" into a sparse SSHProfile (quick-connect entry).
export function parseQuickConnect(query: string): SSHProfile {
  let user = ''
  let host = ''
  let port = 22
  let rest = query.trim()

  // Strip ssh:// prefix — accept "ssh://user@host:port" as well as "user@host:port"
  const SSH_SCHEME = 'ssh://'
  if (rest.slice(0, SSH_SCHEME.length).toLowerCase() === SSH_SCHEME) {
    rest = rest.slice(SSH_SCHEME.length)
  }

  if (rest.startsWith('[')) {
    // IPv6: [::1]:port or [::1]
    const closeBracket = rest.indexOf(']')
    if (closeBracket === -1) {
      host = rest
    } else {
      host = rest.slice(1, closeBracket)
      if (rest[closeBracket + 1] === ':') {
        port = parseInt(rest.slice(closeBracket + 2), 10) || 22
      }
    }
  } else {
    // IPv4 or hostname
    const atIdx = rest.lastIndexOf('@')
    if (atIdx !== -1) {
      user = rest.slice(0, atIdx)
      rest = rest.slice(atIdx + 1)
    }
    const colonIdx = rest.lastIndexOf(':')
    if (colonIdx !== -1) {
      host = rest.slice(0, colonIdx)
      port = parseInt(rest.slice(colonIdx + 1), 10) || 22
    } else {
      host = rest
    }
  }

  return {
    id: '',
    type: 'ssh',
    name: host,
    options: { host, port, user: user || undefined },
  }
}

// newProfileID creates a namespaced profile id client-side for display while
// the user fills the form. On save the profile is sent to the backend, which
// either uses it or generates its own.
export function newProfileID(type: string, name: string): string {
  const safe =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'unnamed'
  return `prof:${type}:${safe}`
}

// ── Effective profile types (wire format from profiles.effective) ──────────

// EffectiveSourceKind is a closed enum — switch on this, never parse id/label.
export type EffectiveSourceKind =
  'profile' | 'group' | 'credential' | 'sshConfig' | 'global' | 'default'

// FieldSourceDTO is the provenance source in the wire format.
export interface FieldSourceDTO {
  kind: EffectiveSourceKind
  id: string
  label: string
}

// EffectiveFieldDTO is the per-field wire representation.
export interface EffectiveFieldDTO {
  value: unknown
  source: FieldSourceDTO
}

// EffectiveProfileDTO is the per-profile wire representation.
export interface EffectiveProfileDTO {
  id: string
  fields: Record<string, EffectiveFieldDTO>
}

// EffectiveBatchResponse is the response from profiles.effective.
export interface EffectiveBatchResponse {
  profiles: EffectiveProfileDTO[]
  errors?: { id: string; error: string }[]
}

// ── Group impact types (wave 6 — nocx-uxs5) ──────────────────────────
//
// Returned by groups.impact — computed on the backend so inheritance
// is correctly reflected. The frontend renders what the backend answers.

/** One field that would change for a profile under a proposed group change. */
export interface FieldDiff {
  field: string
  oldValue: unknown
  newValue: unknown
  dangerous: boolean
}

/** Effective-field diff for one profile. */
export interface ProfileImpact {
  profileId: string
  profileName: string
  diffs: FieldDiff[]
}

/** What happens to children when a group is deleted. */
export interface DeleteImpact {
  action: string // "promote_to_root" | "refuse"
  reason: string // human-readable explanation
  affectedGroupIds?: string[] // child groups that would be reparented
}

/** Response from groups.impact. */
export interface GroupImpactResponse {
  dangerous: boolean
  affectedProfiles?: ProfileImpact[]
  deleteImpact?: DeleteImpact
}
// PatchParams is the request for profiles.patch.
export interface PatchParams {
  id: string
  set?: Record<string, unknown>
  unset?: string[]
}

// ProfileClient is the JSON-RPC client for profile/group/credential CRUD.
// It speaks the control-plane methods wired in nocx-fxs.5 (AD-1).
// RPC dispatch is delegated to a shared Dispatcher so request-ID allocation
// and response correlation are owned in one place.
export class ProfileClient {
  constructor(private dispatcher: Dispatcher) {}

  private call<T>(method: string, params: unknown): Promise<T> {
    return this.dispatcher.call<T>(method, params)
  }

  listProfiles(): Promise<SSHProfile[]> {
    return this.call('profiles.list', {})
  }
  createProfile(p: SSHProfile): Promise<SSHProfile> {
    return this.call('profiles.create', p)
  }
  updateProfile(p: SSHProfile): Promise<SSHProfile> {
    return this.call('profiles.update', p)
  }
  deleteProfile(id: string): Promise<boolean> {
    return this.call('profiles.delete', { id })
  }

  listGroups(): Promise<ProfileGroup[]> {
    return this.call('groups.list', {})
  }
  createGroup(g: ProfileGroup): Promise<ProfileGroup> {
    return this.call('groups.create', g)
  }
  updateGroup(g: ProfileGroup): Promise<ProfileGroup> {
    return this.call('groups.update', g)
  }
  deleteGroup(id: string): Promise<boolean> {
    return this.call('groups.delete', { id })
  }

  /** groups.impact — preview the effect of a proposed group change or delete. */
  groupImpact(params: {
    group?: ProfileGroup
    deleteGroupId?: string
  }): Promise<GroupImpactResponse> {
    return this.call('groups.impact', params)
  }

  /** groups.apply — atomically apply one or more group changes. */
  groupApply(groups: ProfileGroup[]): Promise<ProfileGroup[]> {
    return this.call('groups.apply', groups)
  }

  /** profiles.moveImpact — preview the effect of moving profile(s) to a new group. */
  moveImpact(params: {
    profileIds: string[]
    targetGroupId: string
  }): Promise<GroupImpactResponse> {
    return this.call('profiles.moveImpact', params)
  }

  importTabby(configYAML: string): Promise<number> {
    return this.call('profiles.importTabby', { config: configYAML })
  }

  // Credential CRUD (УЗ — reusable authentication identities)
  listCredentials(): Promise<Credential[]> {
    return this.call('credentials.list', {})
  }
  createCredential(c: Credential): Promise<Credential> {
    return this.call('credentials.create', c)
  }
  updateCredential(c: Credential): Promise<Credential> {
    return this.call('credentials.update', c)
  }
  deleteCredential(id: string): Promise<boolean> {
    return this.call('credentials.delete', { id })
  }

  // Password storage (OS keychain) — keyed by credential ID
  savePassword(credentialId: string, password: string): Promise<boolean> {
    return this.call('credentials.savePassword', { credentialId, password })
  }
  deletePassword(credentialId: string): Promise<boolean> {
    return this.call('credentials.deletePassword', { credentialId })
  }
  hasPassword(credentialId: string): Promise<boolean> {
    return this.call('credentials.hasPassword', { credentialId })
  }

  // Credential usage query — which profiles (by resolved inheritance) use each credential.
  credentialUsage(): Promise<{ usage: CredentialUsage[] }> {
    return this.call('credentials.usage', {})
  }

  // ── Effective profile resolution (profiles.effective / profiles.patch) ──

  // ── Session and probe methods (wave 6 — nocx-uxs5) ─────────────────────

  /** sessions.status — live + last-used state for a batch of profile IDs. */
  sessionStatus(profileIds: string[]): Promise<{ statuses: Record<string, SessionStatus> }> {
    return this.call('sessions.status', { profileIds })
  }

  /** connections.test — probe one profile, return typed outcome. */
  connectionTest(profileId: string): Promise<ConnectionTestResult> {
    return this.call('connections.test', { profileId })
  }

  // loadEffective resolves one or more profiles to their effective values
  // with per-field provenance. Batch: pass several IDs in one call.
  loadEffective(ids: string[]): Promise<EffectiveBatchResponse> {
    return this.call('profiles.effective', { ids })
  }

  // patchProfile applies atomic set/unset operations to a profile and returns
  // its new effective entry. Use set for overrides, unset to revert to inherited.
  patchProfile(params: PatchParams): Promise<EffectiveProfileDTO> {
    return this.call('profiles.patch', params)
  }

  // Settings RPC (nocx-9m5 / STORE-5b).  No secret value ever appears in a
  // response — secrets go through secretSet/secretDelete/secretExists only.
  describeSettings(): Promise<{ declarations: unknown[] }> {
    return this.call('settings.describe', {})
  }
  getSnapshot(): Promise<{
    values: Record<string, unknown>
    overridden: string[]
    revision: number
  }> {
    return this.call('settings.getSnapshot', {})
  }
  setSetting(key: string, value: unknown): Promise<{ ok: true }> {
    return this.call('settings.set', { key, value })
  }
  resetSetting(key: string): Promise<{ ok: true }> {
    return this.call('settings.reset', { key })
  }
  secretSet(key: string, value: string): Promise<{ ok: true }> {
    return this.call('settings.secretSet', { key, value })
  }
  secretDelete(key: string): Promise<{ ok: true }> {
    return this.call('settings.secretDelete', { key })
  }
  secretExists(key: string): Promise<{ exists: boolean }> {
    return this.call('settings.secretExists', { key })
  }
  // ── Export/backup/import RPC methods ──────────────────────────────────

  exportManifest(mode: string): Promise<ExportManifest> {
    return this.call('export.manifest', { mode })
  }

  configExport(): Promise<ConfigExport> {
    return this.call('export.configExport', {})
  }

  portableEncryptedExport(
    passphrase: string,
    includePrivateContent?: boolean,
  ): Promise<PortableEncryptedExport> {
    return this.call('export.portableEncrypted', {
      passphrase,
      includePrivateContent: includePrivateContent ?? false,
    })
  }

  backup(): Promise<BackupManifest> {
    return this.call('export.backup', {})
  }

  importConfig(data: ConfigExport): Promise<ImportResult> {
    return this.call('export.import', { data })
  }

  importPortable(payloadBase64: string, passphrase: string): Promise<ImportResult> {
    return this.call('export.portableImport', { payload: payloadBase64, passphrase })
  }
}

// ── Credential usage types ────────────────────────────────────────────────
//
// Returned by credentials.usage — resolved on the backend so inheritance is
// correctly reflected (a credential used through a group default is still "in
// use", and the frontend should not attempt to compute it).
export interface CredentialUsage {
  credentialId: string
  profiles: ProfileRef[]
}

export interface ProfileRef {
  profileId: string
  profileName: string
  source: 'profile' | 'group' | 'global' // 'group' and 'global' = inherited
  groupId?: string
  groupName?: string
}

// ── Sessions and probe types (wave 6 — nocx-uxs5) ────────────────────────

/** Closed-enum outcome from connections.test. */
export type ProbeOutcome =
  'accepted' | 'rejected' | 'unreachable' | 'host-key-problem' | 'needs-interactive'

/** Result of a single-profile credential probe. */
export interface ConnectionTestResult {
  outcome: ProbeOutcome
  detail?: string
}

/** Session state for one profile ID from sessions.status. */
export interface SessionStatus {
  live: boolean
  lastUsed?: string
}

// ── Export/backup/import types (ADR-0011 §7) ─────────────────────────────

export interface ExportManifest {
  mode: string
  carries: string[]
  omits: string[]
  notes?: string[]
}

export interface ConfigExport {
  profiles: SSHProfile[]
  groups: ProfileGroup[]
  credentials: Credential[]
  settings?: Record<string, unknown>
}

export interface PortableEncryptedExport {
  payload: string // base64-encoded NaCl secretbox ciphertext
  includePrivateContent?: boolean
}

export interface BackupManifest {
  mode: string
  configDir: string
  contentDbPath?: string
  contentDbAbsent: boolean
  secretsStatement: string
  carries: string[]
  omits: string[]
}

export interface ImportResult {
  profilesImported: number
  groupsImported: number
  credentialsImported: number
  unresolvedCredentials?: Credential[]
}
