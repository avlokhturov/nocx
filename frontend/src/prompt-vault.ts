// PromptVaultController — the "secrets in the prompt" flow, composed in
// terminal-content.ts. Owns three seams and nothing else:
//
//   1. The picker ('@' at a word start, the owner's trigger). The '@'
//      lands in the line; the controller captures the trigger position and
//      replaces the trigger word with `{{secret:NAME}}` on pick. The picker
//      is PASSIVE: typing continues into the line and the controller pushes
//      the trigger word's continuation into the picker's filter on every
//      document change (space and no-match close it — see secret-picker.ts).
//   2. The offer-to-save: detectSecrets (the TS port of internal/secrets)
//      over the line while it is still ours; a detected key is offered a
//      store into the vault under a suggested name, and on accept the
//      literal is replaced by its reference, which renders as the chip.
//      Non-modal: the row is ignorable and typing continues (the owner's
//      decision). A decline marks the value declined for the session — "the
//      masked text is served everywhere else and that is the whole policy"
//      (the owner's decision, 2026-08-02: no sensitivity flag, no
//      suppression machinery).
//   3. The recall seam (reported, not implemented here): a masked history
//      row must not run silently. The coordinator's onMaskedRun hook in
//      recall.ts calls back into the host, which opens THIS picker — the
//      second door into the vault (ADR-0021's consequence, the brief's item
//      5).
//
// The resolve-at-submit half lives in submit.ts (planSubmit) — the host's
// submit action runs it through the editor's beforeSubmit seam.
import { detectSecrets, maskSecret, type SecretKind, type SecretFinding } from './secret-detect'
import { findReferences } from './secret-reference'
import { SecretPicker } from './ui/secret-picker'
import { SecretOffer } from './ui/secret-offer'
import type { VaultClient } from './vault-client'

/** The minimal editor surface the controller drives. CommandEditor
 *  satisfies it; tests substitute a fake. */
export interface PromptVaultEditor {
  root: HTMLElement
  getDoc(): string
  getSelection(): { from: number; to: number }
  applyReplacement(from: number, to: number, text: string): void
}

export interface PromptVaultDeps {
  editor: PromptVaultEditor
  vault: VaultClient
  /** Surface an outcome where the user is looking (a toast). */
  report(level: 'info' | 'success' | 'warning' | 'danger', message: string): void
  /** The picker's setup offer was activated and the machine has no OS key:
   *  the vault layer owns the setup dialog, so this hook raises it. Wired
   *  by the host through TabManager to vaultController.openSetup. */
  requestSetupDialog?: () => void
}

/** How long a detected key must settle before the offer row appears — a
 *  paste lands as one burst, and the row must not flash mid-paste. */
const OFFER_SETTLE_MS = 500

/** The human word for a detected kind — the offer's badge. */
const KIND_LABELS: Record<SecretKind, string> = {
  openai: 'OpenAI key',
  'github-pat': 'GitHub token',
  slack: 'Slack token',
  'aws-access-key': 'AWS access key',
  gitlab: 'GitLab token',
  jwt: 'JWT',
  'private-key': 'Private key',
  'url-userinfo': 'URL password',
  'db-connstring': 'Database password',
  'auth-header': 'API key',
  'env-assignment': 'Environment secret',
  'high-entropy': 'API key',
}

/** The suggested vault name for a detected kind, and the env-key case: the
 *  KEY of OPENAI_API_KEY=… is the natural name. */
function suggestName(kind: SecretKind, findingText: string): string {
  if (kind === 'env-assignment') {
    const key = findingText.split('=')[0]?.trim()
    if (key) return key.toLowerCase().replace(/_/g, '-')
  }
  switch (kind) {
    case 'openai':
      return 'openai-key'
    case 'github-pat':
      return 'github-pat'
    case 'jwt':
      return 'jwt-token'
    case 'private-key':
      return 'private-key'
    case 'db-connstring':
      return 'db-password'
    case 'url-userinfo':
      return 'url-password'
    default:
      return 'api-key'
  }
}

/** A name is a reference NAME (ADR-0016): braces are structural in
 *  `{{secret:NAME}}`, so they cannot ride a name. Spaces are legal. */
function sanitizeName(name: string): string {
  return name.replace(/[{}]/g, '').trim()
}

/** The RPC reason codes the offer can meet, in the vault's own words
 *  (REASON_MESSAGES in vault.tsx is the full map; these two are the ones a
 *  store-from-the-prompt can hit). */
function storeErrorMessage(err: unknown): string {
  const data = (err as { data?: { reason?: string } } | null)?.data
  if (data?.reason === 'vault-sealed') return 'The vault is locked.'
  if (data?.reason === 'vault-uninitialized') return 'Protection has not been set up yet.'
  return err instanceof Error ? err.message : String(err)
}

interface OfferTarget {
  finding: SecretFinding
  value: string
}

export class PromptVaultController {
  private readonly picker: SecretPicker
  private readonly offer: SecretOffer
  /** The position the '@' trigger landed at; the picker's replacement range
   *  starts here. Null while no trigger is live. */
  private triggerPos: number | null = null
  /** The finding the offer is currently showing (or about to show). */
  private offerTarget: OfferTarget | null = null
  /** Values already declined (or whose store failed) this session: keyed by
   *  `${kind}:${value}`, never re-offered while they stay in the doc. */
  private readonly declined = new Set<string>()
  private settleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: PromptVaultDeps) {
    this.picker = new SecretPicker(
      {
        status: () => deps.vault.status(),
        list: () => deps.vault.inventory().then((i) => i.entries),
        requestUnseal: () => deps.vault.inventory().then(() => undefined),
        requestSetup: () => this.setupVault(),
      },
      { onInsert: (name) => this.insertReference(name) },
    )
    this.offer = new SecretOffer({
      onStore: (name) => this.store(name),
      onDismiss: () => this.dismissOffer(),
    })
  }

  get isPickerOpen(): boolean {
    return this.picker.isOpen
  }

  /** Mount the two surfaces into the editor root (they float above it). */
  mount(): void {
    this.picker.mount(this.deps.editor.root)
    this.offer.mount(this.deps.editor.root)
  }

  /** '@' fired at a word start (the editor's onSecretPicker). Capture the
   *  trigger and open the picker. */
  onSecretPicker(triggerPos: number): void {
    this.triggerPos = triggerPos
    void this.picker.open()
  }

  /** Every user-driven document change: drive the offer and the picker's
   *  passive filter. */
  onDocChanged(text: string): void {
    this.updateOffer(text)
    this.updatePickerFilter(text)
  }

  /** The arbiter's turn (after recall, before completion). */
  handleKey(e: KeyboardEvent): boolean {
    return this.picker.handleKey(e)
  }

  /** The recall seam (item 5, reported — recall.ts is the coordinator's):
   *  Enter landed on a masked history row and must not run silently. The
   *  command stays in the line as the preview; say why, and open the picker
   *  — the second door into the vault, and the one people will actually
   *  walk through. The coordinator wires its onMaskedRun hook to this. */
  onMaskedRow(maskedCount: number): void {
    this.deps.report(
      'warning',
      maskedCount === 1
        ? 'This command contains a masked secret — it cannot run as written. Pick a live secret to substitute.'
        : `This command contains ${maskedCount} masked secrets — it cannot run as written. Pick a live secret to substitute.`,
    )
    void this.picker.open()
  }

  /** The line is gone (submit, Esc, Ctrl-C): drop every surface and the
   *  session's offer memory. Wired by the host to the editor's
   *  onDocCleared. */
  reset(): void {
    this.picker.close()
    this.offer.hide()
    this.offerTarget = null
    this.triggerPos = null
    this.declined.clear()
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }

  destroy(): void {
    this.reset()
    this.picker.destroy()
    this.offer.destroy()
  }

  // ── the picker's insert seam ─────────────────────────────────────────────

  private insertReference(name: string): void {
    const triggerPos = this.triggerPos
    this.triggerPos = null
    const safeName = sanitizeName(name)
    if (safeName === '') return
    const reference = `{{secret:${safeName}}}`
    const doc = this.deps.editor.getDoc()
    const caret = this.deps.editor.getSelection().from
    if (
      triggerPos === null ||
      triggerPos >= doc.length ||
      doc[triggerPos] !== '@' ||
      caret < triggerPos
    ) {
      // The trigger is gone or the caret moved away: insert at the caret
      // rather than replacing an unrelated character.
      this.deps.editor.applyReplacement(caret, caret, reference)
      return
    }
    this.deps.editor.applyReplacement(triggerPos, caret, reference)
  }

  // ── the picker's passive filter ──────────────────────────────────────────

  private updatePickerFilter(text: string): void {
    if (!this.picker.isOpen) return
    const triggerPos = this.triggerPos
    if (triggerPos === null) return
    const caret = this.deps.editor.getSelection().from
    if (triggerPos >= text.length || text[triggerPos] !== '@' || caret < triggerPos) {
      this.picker.close()
      return
    }
    // The trigger word's continuation IS the filter. Whitespace and no-match
    // close the panel (secret-picker.setFilter).
    this.picker.setFilter(text.slice(triggerPos + 1, caret))
  }

  // ── the offer-to-save ────────────────────────────────────────────────────

  private updateOffer(text: string): void {
    const references = findReferences(text)
    // A reference's NAME is not a secret: findings inside a reference span
    // are never offered (the backend shares the blind spot — a name that
    // LOOKS like a vendor key is masked inside the reference; reported).
    const findings = detectSecrets(text).filter(
      (f) => !references.some((r) => f.start >= r.from && f.end <= r.to),
    )

    // The currently-offered finding: hide when its value left the doc.
    if (this.offerTarget !== null) {
      const stillThere = findings.some(
        (f) => text.slice(f.start, f.end) === this.offerTarget!.value,
      )
      if (!stillThere) this.dismissOffer()
    }

    if (this.offerTarget !== null) return

    // The timer is a DEBOUNCE — it waits for the typing to stop — and it must
    // therefore restart on every change and re-detect when it fires.
    //
    // It used to be armed once, by the first change that produced a finding,
    // and then to look for that same finding by re-slicing the CURRENT
    // document at the OLD offsets. That works for a paste, which is one
    // change, and fails for everything typed: by the time it fires the value
    // has grown from `sk-proj-abc` to the whole key, the stale slice matches
    // nothing, and the offer never appears at all. A key you TYPE is the case
    // that must work — the one you paste is already on the clipboard.
    if (!findings.some((f) => !this.declined.has(`${f.kind}:${text.slice(f.start, f.end)}`))) {
      return
    }
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      // Re-detect: what the timer promised is "the user has stopped typing",
      // never "this exact span is still there".
      const doc = this.deps.editor.getDoc()
      const refs = findReferences(doc)
      const current = detectSecrets(doc).find(
        (f) =>
          !refs.some((r) => f.start >= r.from && f.end <= r.to) &&
          !this.declined.has(`${f.kind}:${doc.slice(f.start, f.end)}`),
      )
      if (!current) return
      const value = doc.slice(current.start, current.end)
      this.offerTarget = { finding: current, value }
      this.offer.show({
        kindLabel: KIND_LABELS[current.kind],
        suggestedName: suggestName(current.kind, value),
        // What will actually be stored, masked. The detector could have taken
        // the wrong boundaries — a trailing quote in, a last character out —
        // and a wrong value is a secret that fails days later for no visible
        // reason. head-4/tail-4 is exactly where a boundary error shows.
        maskedValue: maskSecret(value),
      })
    }, OFFER_SETTLE_MS)
  }

  private dismissOffer(): void {
    if (this.offerTarget !== null) {
      this.declined.add(`${this.offerTarget.finding.kind}:${this.offerTarget.value}`)
      this.offerTarget = null
    }
    this.offer.hide()
  }

  /** The offer's Store: create the secret under the given name, then
   *  replace the literal with its reference. */
  private async store(name: string): Promise<void> {
    const target = this.offerTarget
    if (!target) return
    const safeName = sanitizeName(name)
    if (safeName === '') {
      this.deps.report('danger', 'Enter a name for the secret')
      return
    }
    try {
      await this.deps.vault.createSecret({
        name: safeName,
        kind: 'password',
        value: target.value,
      })
    } catch (err) {
      // Declined-for-now: the value stays in the line and must not re-offer
      // in a loop on the next keystroke.
      this.declined.add(`${target.finding.kind}:${target.value}`)
      this.offerTarget = null
      this.offer.hide()
      this.deps.report('danger', storeErrorMessage(err))
      return
    }
    this.offerTarget = null
    this.offer.hide()
    // The span may have shifted while the offer was up: prefer the recorded
    // span when its text still matches, else the first occurrence.
    const doc = this.deps.editor.getDoc()
    let at = -1
    if (doc.slice(target.finding.start, target.finding.end) === target.value) {
      at = target.finding.start
    } else {
      at = doc.indexOf(target.value)
    }
    if (at === -1) {
      this.deps.report('danger', 'The key is no longer in the line')
      return
    }
    this.deps.editor.applyReplacement(at, at + target.value.length, `{{secret:${safeName}}}`)
    this.deps.report('success', `Stored "${safeName}" in the vault.`)
  }

  /** The picker's setup offer: silent setup when the OS key is capable;
   *  otherwise the host's seam raises the setup dialog (the vault layer
   *  owns it). The vault's setup with a passphrase cannot be asked from the
   *  prompt — that would be a modal the passive contract forbids. */
  private async setupVault(): Promise<boolean> {
    const status = await this.deps.vault.status()
    if (status.state !== 'uninitialized') return false
    if (status.osKeyCapable) {
      await this.deps.vault.setup({})
      return false
    }
    if (this.deps.requestSetupDialog) {
      this.deps.requestSetupDialog()
      return true
    }
    throw new Error('vault-setup-requires-passphrase')
  }
}
