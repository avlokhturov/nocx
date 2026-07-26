// Settings screen — generated from settings.describe declarations.
// Renders controls by declaration.control kind, grouped by declaration.section.
// A control:'secret' renders as configured/not-configured with Replace/Clear
// actions; it never renders a populated input (ADR-0011 §2).
//
// State is derived from typed declarations + snapshot.  No literal setting
// key appears anywhere in this file.
//
// Row DOM ids: keyToDomId(key) = 'st-setting-' + encodeURIComponent(key).
// encodeURIComponent does NOT escape '.', so st-setting-clipboard.osc52Suppressed
// is a valid HTML5 id but splits into id + class inside a raw CSS selector.
// Use getElementById or CSS.escape — never querySelector('#' + id).

import { log } from './log'
import { ProfileClient } from './profiles'
import { SettingsObserver } from './settings-observer'
import {
  AcceptedSnapshot,
  applyAcceptedSnapshot,
  canResetSetting,
  recordSaveOutcome,
  type SaveOutcome,
  type SettingsMirror,
  type SettingsSnapshot,
} from './settings-domain'

/** Stable DOM id for a setting row, derived from the declaration key.
 *
 *  Keys are opaque strings — assertValidKey in Go checks only non-empty and
 *  uniqueness — so the character set is unconstrained. encodeURIComponent is
 *  injective: every distinct key maps to a distinct id. Dots, underscores and
 *  hyphens pass through as-is (valid in HTML5 ids); everything else is
 *  percent-encoded, which is also valid.
 *
 *  It does NOT escape '.', so use getElementById or CSS.escape — never a raw
 *  querySelector('#' + id), where 'st-setting-a.b' parses as id plus class. */
export function keyToDomId(key: string): string {
  return 'st-setting-' + encodeURIComponent(key)
}

export interface Declaration {
  key: string
  section: string
  label: string
  description: string
  control: 'toggle' | 'text' | 'number' | 'select' | 'secret'
  dataClass: 'publicConfig' | 'privateMetadata' | 'privateContent' | 'secretAuthenticator'
  // default is absent for control:'secret' (ADR-0011 §3 / RPC contract).
  default?: unknown
  options?: { value: string; label: string }[]
  min?: number
  max?: number
}

export interface SettingsView {
  show(): void
  refresh(): Promise<void>
  /** Current declarations, as returned by the last successful refresh. */
  getDeclarations(): Declaration[]
  /** Unique sections in declaration order. */
  getSections(): string[]
  /** Toggle modified-only filter.  Calls render() so the view reflects the
   *  new filter state immediately. */
  setModifiedOnly(val: boolean): void
  /** Whether the modified-only filter is currently active. */
  isModifiedOnly(): boolean
  /** Count of overridden, non-secret declarations. */
  getModifiedCount(): number
  /** Per-section counts of overridden, non-secret declarations. */
  getModifiedBySection(): ReadonlyMap<string, number>
}

const enum LoadState {
  Loading = 'loading',
  Ready = 'ready',
  Failed = 'failed',
  Empty = 'empty',
}
export class SettingsViewImpl implements SettingsView {
  private container: HTMLElement
  private client: ProfileClient
  private observer: SettingsObserver | null
  private declarations: Declaration[] = []
  private values: Record<string, unknown> = {}
  private draftValues: Record<string, unknown> = {}
  private secretStates: Record<string, boolean> = {}
  // Tracks per-key error messages displayed inline on the control.
  private errors: Record<string, string> = {}
  // Provenance: keys that have a stored override (A.2 from foundation design).
  private overridden: Set<string> = new Set()
  private revision = 0
  // Key → rendered row element.  Replaces CSS-selector interpolation of the
  // raw key (which is an unconstrained character set — dots break selectors).
  private rowMap: Map<string, HTMLElement> = new Map()
  private searchQuery = ''
  private modifiedOnly = false
  private onStateChanged?: () => void
  private loadState: LoadState = LoadState.Loading
  // Bound handler so we can remove the listener.
  private boundKeydown: (e: KeyboardEvent) => void
  // Bound refresh: observer calls this on notification or reconnect (resync).
  private boundRefresh: () => Promise<void>

  constructor(
    container: HTMLElement,
    client: ProfileClient,
    observer?: SettingsObserver,
    onStateChanged?: () => void,
  ) {
    this.container = container
    this.client = client
    this.observer = observer ?? null
    this.onStateChanged = onStateChanged
    this.boundKeydown = this.handleKeydown.bind(this)
    this.boundRefresh = () => this.refresh('resync')
    this.container.addEventListener('keydown', this.boundKeydown)
    if (this.observer) {
      this.observer.start(() => {
        void this.boundRefresh()
      })
    }
  }

  // ── domain state bridge ──────────────────────────────────────────────
  /** Build a SettingsMirror from the current instance state. */
  private toMirror(): SettingsMirror {
    return {
      values: this.values,
      draftValues: this.draftValues,
      overridden: this.overridden,
      errors: this.errors,
      revision: this.revision,
    }
  }

  /** Replace instance state from a SettingsMirror. */
  private fromMirror(m: SettingsMirror): void {
    this.values = m.values
    this.draftValues = m.draftValues
    this.overridden = m.overridden
    this.errors = m.errors
    this.revision = m.revision
  }

  getDeclarations(): Declaration[] {
    return [...this.declarations]
  }

  getSections(): string[] {
    const seen = new Set<string>()
    const sections: string[] = []
    for (const d of this.declarations) {
      if (!seen.has(d.section)) {
        seen.add(d.section)
        sections.push(d.section)
      }
    }
    return sections
  }

  // ── modified-only filter ────────────────────────────────────────────

  setModifiedOnly(val: boolean): void {
    if (this.modifiedOnly === val) return
    this.modifiedOnly = val
    this.render()
  }

  isModifiedOnly(): boolean {
    return this.modifiedOnly
  }

  getModifiedCount(): number {
    let count = 0
    for (const d of this.declarations) {
      if (d.control !== 'secret' && this.overridden.has(d.key)) count++
    }
    return count
  }

  getModifiedBySection(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>()
    for (const d of this.declarations) {
      if (d.control !== 'secret' && this.overridden.has(d.key)) {
        counts.set(d.section, (counts.get(d.section) ?? 0) + 1)
      }
    }
    return counts
  }

  show(): void {
    this.render()
  }

  async refresh(mode: 'normal' | 'resync' = 'normal'): Promise<void> {
    this.loadState = LoadState.Loading
    this.render()
    try {
      const [desc, snap] = await Promise.all([
        this.client.describeSettings(),
        this.client.getSnapshot(),
      ])
      this.declarations = (desc.declarations as Declaration[]) ?? []

      // Apply the snapshot through the revision policy gate
      // (AcceptedSnapshot — authority-encoded type from settings-domain).
      const rawSnap: SettingsSnapshot = {
        values: snap.values ?? {},
        overridden: snap.overridden ?? [],
        revision: snap.revision ?? 0,
      }
      const accepted =
        mode === 'resync'
          ? AcceptedSnapshot.reset(rawSnap)
          : AcceptedSnapshot.accept(this.revision, rawSnap)
      if (accepted) {
        const nextState = applyAcceptedSnapshot(this.toMirror(), accepted)
        this.fromMirror(nextState)
        this.observer?.setRevision(nextState.revision)
      }

      // Parallelise secret-existence probes (fixes nocx-jwkw sequential loop).
      const secretDecls = this.declarations.filter((d) => d.control === 'secret')
      if (secretDecls.length > 0) {
        const results = await Promise.allSettled(
          secretDecls.map((d) => this.client.secretExists(d.key)),
        )
        this.secretStates = {}
        for (let i = 0; i < secretDecls.length; i++) {
          const r = results[i]
          this.secretStates[secretDecls[i].key] = r.status === 'fulfilled' ? r.value.exists : false
        }
      } else {
        this.secretStates = {}
      }

      this.loadState = this.declarations.length === 0 ? LoadState.Empty : LoadState.Ready
    } catch {
      // RPC failure — keep any prior state for a retry but surface the error.
      this.loadState = LoadState.Failed
    }
    this.render()
  }

  // --- render ---

  private render(): void {
    this.container.replaceChildren()
    this.rowMap.clear()

    switch (this.loadState) {
      case LoadState.Loading:
        this.renderStatus('st-loading', 'Loading settings\u2026')
        return
      case LoadState.Failed:
        this.renderFailed()
        this.onStateChanged?.()
        return
      case LoadState.Empty:
        this.renderStatus('st-empty', 'No settings declared.')
        this.onStateChanged?.()
        return
    }

    // filtered = declarations ∩ modifiedOnly ∩ searchQuery
    let filtered = this.declarations
    if (this.modifiedOnly) {
      filtered = filtered.filter((d) => d.control !== 'secret' && this.overridden.has(d.key))
    }
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase()
      // Score every declaration, keep those with a positive score, then
      // sort by score descending (exact match > substring).  Declaration
      // order is the stable tie-break: earlier in the declarations array
      // wins when scores are equal.
      type Scored = { decl: Declaration; score: number }
      const scored: Scored[] = []
      for (const d of filtered) {
        const score = this.searchScore(d, q)
        if (score > 0) scored.push({ decl: d, score })
      }
      scored.sort((a, b) => b.score - a.score)
      filtered = scored.map((s) => s.decl)
    }

    if (this.declarations.length > 0 && filtered.length === 0) {
      this.renderStatus('st-nomatch', 'No settings match your search.')
      this.onStateChanged?.()
      return
    }

    const wrapper = document.createElement('div')
    wrapper.className = 'st-view'

    // Search bar
    wrapper.append(this.renderSearchBar())
    // Modified-only filter bar
    wrapper.append(this.renderFilterBar())

    // Group by section, preserving declaration order within each section.
    const sections = new Map<string, Declaration[]>()
    for (const d of filtered) {
      const list = sections.get(d.section)
      if (list) list.push(d)
      else sections.set(d.section, [d])
    }

    for (const [section, decls] of sections) {
      const sectionEl = document.createElement('div')
      sectionEl.className = 'st-section'

      const heading = document.createElement('h2')
      heading.className = 'st-section-heading'
      heading.id = 'st-section-' + encodeURIComponent(section)
      heading.textContent = section
      sectionEl.append(heading)
      for (const decl of decls) {
        const row = this.renderControl(decl)
        sectionEl.append(row)
        this.rowMap.set(decl.key, row)
      }

      wrapper.append(sectionEl)
    }

    this.container.append(wrapper)
    this.onStateChanged?.()
  }

  private renderStatus(className: string, text: string): void {
    const el = document.createElement('div')
    el.className = 'st-status ' + className
    el.textContent = text
    this.container.append(el)
  }

  private renderFailed(): void {
    const el = document.createElement('div')
    el.className = 'st-status st-failed'
    const msg = document.createElement('span')
    msg.textContent = 'Failed to load settings.'
    el.append(msg)
    const retry = document.createElement('button')
    retry.className = 'st-retry-btn'
    retry.textContent = 'Retry'
    retry.addEventListener('click', () => {
      void this.refresh()
    })
    el.append(retry)
    this.container.append(el)
  }

  private renderSearchBar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'st-search'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'st-search-input'
    input.placeholder = 'Search settings\u2026'
    input.value = this.searchQuery
    input.setAttribute('aria-label', 'Search settings')
    input.addEventListener('input', () => {
      this.searchQuery = input.value
      this.render()
    })
    bar.append(input)
    return bar
  }

  private renderFilterBar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'st-filter-bar'
    const modifiedCount = this.declarations.filter(
      (d) => d.control !== 'secret' && this.overridden.has(d.key),
    ).length
    const label = document.createElement('label')
    label.className = 'st-filter-label'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = this.modifiedOnly
    checkbox.addEventListener('change', () => {
      this.setModifiedOnly(checkbox.checked)
    })
    label.append(checkbox)
    label.append(' Modified only (' + String(modifiedCount) + ')')
    bar.append(label)
    return bar
  }

  /** Returns 2 for an exact normalized label or key match, 1 for a
   *  substring match in any searchable field, and 0 for no match.
   *  Ranking: exact > substring, tie-broken by declaration order. */
  private searchScore(decl: Declaration, query: string): number {
    const q = query.toLowerCase()
    if (decl.label.toLowerCase() === q || decl.key.toLowerCase() === q) return 2
    if (decl.label.toLowerCase().includes(q)) return 1
    if (decl.description.toLowerCase().includes(q)) return 1
    if (decl.section.toLowerCase().includes(q)) return 1
    if (decl.key.toLowerCase().includes(q)) return 1
    if (decl.options) {
      for (const opt of decl.options) {
        if (opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q)) return 1
      }
    }
    return 0
  }

  private renderControl(decl: Declaration): HTMLElement {
    const row = document.createElement('div')
    row.className = 'st-row'
    row.id = keyToDomId(decl.key)
    row.dataset.key = decl.key

    const labelCol = document.createElement('div')
    labelCol.className = 'st-label-col'

    // When searching, show the section as a breadcrumb so the user can
    // orient each result.
    if (this.searchQuery) {
      const crumb = document.createElement('span')
      crumb.className = 'st-breadcrumb'
      crumb.textContent = decl.section
      labelCol.append(crumb)
    }

    const label = document.createElement('label')
    label.textContent = decl.label
    label.title = decl.description
    labelCol.append(label)

    if (decl.description) {
      const desc = document.createElement('span')
      desc.className = 'st-description'
      desc.textContent = decl.description
      labelCol.append(desc)
    }

    // dataClass privacy/storage indicator — generated from the declaration.
    labelCol.append(this.renderDataClass(decl))

    row.append(labelCol)

    const controlCol = document.createElement('div')
    controlCol.className = 'st-control-col'

    // Declared bound display for numbers (visible range, not only HTML attrs).
    if (decl.control === 'number') {
      controlCol.append(this.renderBounds(decl))
    }

    switch (decl.control) {
      case 'toggle':
        controlCol.append(this.renderToggle(decl))
        break
      case 'text':
        controlCol.append(this.renderText(decl))
        break
      case 'number':
        controlCol.append(this.renderNumber(decl))
        break
      case 'select':
        controlCol.append(this.renderSelect(decl))
        break
      case 'secret':
        controlCol.append(this.renderSecret(decl))
        break
    }

    // Provenance badge + Reset (non-secret only; secrets have no default).
    if (decl.control !== 'secret' && decl.default !== undefined) {
      controlCol.append(this.renderProvenance(decl))
    }

    // Show any existing error for this key.
    if (this.errors[decl.key]) {
      const errEl = document.createElement('div')
      errEl.className = 'st-error'
      errEl.textContent = this.errors[decl.key]
      controlCol.append(errEl)
    }

    row.append(controlCol)
    return row
  }

  /**
   * Returns the effective value for a setting key: draft (rejected input) if
   * present, else the committed value. Never falls through to the default —
   * callers combine this with displayValue when needed.
   */
  private effectiveValue(key: string): unknown {
    if (key in this.draftValues) return this.draftValues[key]
    return this.values[key]
  }

  /**
   * Returns a safe display string for a setting value.
   *
   * Narrows the unknown value to the primitive expected by the control
   * kind (string for text/select, number for number). Falls back to the
   * declared default, then to a zero value. Logs a warning when the
   * value or default is a non-null unexpected type — a backend contract
   * violation.
   */
  private displayValue(value: unknown, decl: Declaration): string {
    const def = decl.default

    if (decl.control === 'number') {
      if (typeof value === 'number' && !isNaN(value)) return String(value)
      if (typeof def === 'number' && !isNaN(def)) {
        if (value !== undefined && value !== null) {
          log.warn('nocx: unexpected type for setting', {
            key: decl.key,
            got: typeof value,
            expected: 'number',
          })
        }
        return String(def)
      }
      if (value !== undefined && value !== null) {
        log.warn('nocx: unusable value and default for setting', {
          key: decl.key,
          got: typeof value,
          defaultType: typeof def,
        })
      }
      return '0'
    }

    // text, select
    if (typeof value === 'string') return value
    if (typeof def === 'string') {
      if (value !== undefined && value !== null) {
        log.warn('nocx: unexpected type for setting', {
          key: decl.key,
          got: typeof value,
          expected: 'string',
        })
      }
      return def
    }
    if (value !== undefined && value !== null) {
      log.warn('nocx: unusable value and default for setting', {
        key: decl.key,
        got: typeof value,
        defaultType: typeof def,
      })
    }
    return ''
  }

  // --- derived state helpers ---

  /** Customized is PROVENANCE: key is in the overridden set.  Not a
   *  value-vs-default comparison — an override that happens to equal the
   *  current default is still Customized (it pins the value against future
   *  default changes, which is what export depends on). */

  // --- control renderers ---

  private renderToggle(decl: Declaration): HTMLElement {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = !!this.effectiveValue(decl.key)
    input.addEventListener('change', () => {
      void this.saveSetting(decl.key, input.checked)
    })
    return input
  }

  private renderText(decl: Declaration): HTMLElement {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = this.displayValue(this.effectiveValue(decl.key), decl)
    input.addEventListener('change', () => {
      void this.saveSetting(decl.key, input.value)
    })
    return input
  }

  private renderNumber(decl: Declaration): HTMLElement {
    const input = document.createElement('input')
    input.type = 'number'
    const eff = this.effectiveValue(decl.key)
    input.value = this.displayValue(eff, decl)
    if (decl.min !== undefined) input.min = String(decl.min)
    if (decl.max !== undefined) input.max = String(decl.max)
    input.addEventListener('change', () => {
      const n = Number(input.value)
      void this.saveSetting(
        decl.key,
        isNaN(n) ? Number(this.displayValue(this.effectiveValue(decl.key), decl)) : n,
      )
    })
    return input
  }

  private renderSelect(decl: Declaration): HTMLElement {
    const select = document.createElement('select')
    const current = this.displayValue(this.effectiveValue(decl.key), decl)
    for (const opt of decl.options ?? []) {
      const option = document.createElement('option')
      option.value = opt.value
      option.textContent = opt.label
      option.selected = opt.value === current
      select.append(option)
    }
    select.addEventListener('change', () => {
      void this.saveSetting(decl.key, select.value)
    })
    return select
  }

  private renderSecret(decl: Declaration): HTMLElement {
    // A secret declaration renders as status + Replace/Clear actions.
    // There is never a populated input — no API returns secret values
    // (ADR-0011 §2, settings-rpc-contract).
    const wrapper = document.createElement('div')
    wrapper.className = 'st-secret'

    const status = document.createElement('span')
    status.className = 'st-secret-status'
    const configured = this.secretStates[decl.key] === true
    status.textContent = configured ? 'Configured' : 'Not configured'
    wrapper.append(status)

    const replaceBtn = document.createElement('button')
    replaceBtn.className = 'st-secret-replace'
    replaceBtn.textContent = 'Replace'
    replaceBtn.addEventListener('click', () => {
      const value = prompt(`Enter new value for "${decl.label}":`)
      if (value === null) return // user cancelled
      void this.saveSecret(decl.key, value)
    })
    wrapper.append(replaceBtn)

    const clearBtn = document.createElement('button')
    clearBtn.className = 'st-secret-clear'
    clearBtn.textContent = 'Clear'
    clearBtn.addEventListener('click', () => {
      void this.deleteSecret(decl.key)
    })
    wrapper.append(clearBtn)

    return wrapper
  }

  // --- provenance & reset ---

  private renderProvenance(decl: Declaration): HTMLElement {
    const span = document.createElement('span')
    const decision = canResetSetting(this.overridden, decl.key, true)
    const customized = decision.canReset
    span.className = customized ? 'st-provenance st-customized' : 'st-provenance st-default'
    span.textContent = customized ? 'Customized' : 'Default'

    if (customized) {
      const resetBtn = document.createElement('button')
      resetBtn.className = 'st-reset-btn'
      resetBtn.textContent = 'Reset'
      resetBtn.title = 'Reset to default'
      resetBtn.addEventListener('click', () => {
        void this.resetSetting(decl.key)
      })
      span.append(' ', resetBtn)
    }

    return span
  }

  // --- dataClass indicator ---

  private dataClassLabel(dc: Declaration['dataClass']): string {
    switch (dc) {
      case 'publicConfig':
        return 'Public'
      case 'privateMetadata':
      case 'privateContent':
        return 'Private'
      case 'secretAuthenticator':
        return 'Secret'
    }
  }

  private renderDataClass(decl: Declaration): HTMLElement {
    const span = document.createElement('span')
    span.className = 'st-data-class'
    span.textContent = this.dataClassLabel(decl.dataClass)
    span.title = 'Storage class: ' + decl.dataClass
    return span
  }

  // --- bound display for numbers ---

  private renderBounds(decl: Declaration): HTMLElement {
    const span = document.createElement('span')
    span.className = 'st-bounds'
    if (decl.min !== undefined && decl.max !== undefined) {
      span.textContent = String(decl.min) + ' \u2013 ' + String(decl.max)
    } else if (decl.min !== undefined) {
      span.textContent = '\u2265 ' + String(decl.min)
    } else if (decl.max !== undefined) {
      span.textContent = '\u2264 ' + String(decl.max)
    }
    return span
  }

  // --- keyboard ---

  private handleKeydown(e: KeyboardEvent): void {
    // '/' focuses search when not already in a form control.
    if (
      e.key === '/' &&
      !(
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
    ) {
      e.preventDefault()
      const input = this.container.querySelector<HTMLInputElement>('.st-search-input')
      input?.focus()
    }
    // Escape clears search.
    if (e.key === 'Escape' && this.searchQuery) {
      this.searchQuery = ''
      this.render()
    }
  }

  // --- actions ---

  private async saveSetting(key: string, value: unknown): Promise<void> {
    let outcome: SaveOutcome
    try {
      await this.client.setSetting(key, value)
      outcome = { kind: 'accepted', value }
    } catch (err) {
      outcome = { kind: 'rejected', error: (err as Error).message, attemptedValue: value }
    }
    const nextState = recordSaveOutcome(this.toMirror(), key, outcome)
    this.fromMirror(nextState)
    this.rerenderRow(key)
  }

  private async resetSetting(key: string): Promise<void> {
    delete this.errors[key]
    try {
      await this.client.resetSetting(key)
      // Refetch the snapshot — it goes through the revision policy gate
      // like any incoming snapshot.
      const snap = await this.client.getSnapshot()
      const rawSnap: SettingsSnapshot = {
        values: snap.values ?? {},
        overridden: snap.overridden ?? [],
        revision: snap.revision ?? 0,
      }
      const accepted = AcceptedSnapshot.accept(this.revision, rawSnap)
      if (accepted) {
        const nextState = applyAcceptedSnapshot(this.toMirror(), accepted)
        this.fromMirror(nextState)
      }
    } catch (err) {
      this.errors[key] = (err as Error).message
    }
    this.render()
  }

  private async saveSecret(key: string, value: string): Promise<void> {
    delete this.errors[key]
    try {
      await this.client.secretSet(key, value)
      this.secretStates[key] = true
    } catch (err) {
      this.errors[key] = (err as Error).message
    }
    this.rerenderRow(key)
  }

  private async deleteSecret(key: string): Promise<void> {
    delete this.errors[key]
    try {
      await this.client.secretDelete(key)
      this.secretStates[key] = false
    } catch (err) {
      this.errors[key] = (err as Error).message
    }
    this.rerenderRow(key)
  }

  /** Re-render a single control row in-place without full DOM rebuild.
   *  Uses a key→element map instead of CSS selector interpolation:
   *  keys may contain dots, which break querySelector. */
  private rerenderRow(key: string): void {
    // Instance-scoped map, not getElementById: Settings now lives in a tab that
    // can be closed and reopened, so a detached row from a previous mount could
    // still answer a document-wide id lookup. The keyToDomId ids stay on the
    // rows for deep links.
    const oldRow = this.rowMap.get(key)
    if (!oldRow) return
    const decl = this.declarations.find((d) => d.key === key)
    if (!decl) return
    const newRow = this.renderControl(decl)
    oldRow.replaceWith(newRow)
    this.rowMap.set(key, newRow)
  }

  // --- test support: the two private helpers below exist only so tests can
  //     assert the internal invariants without reflection.  They are never
  //     called by production code. ---

  /** Exposed for tests: is key currently in the overridden set? */
  _isCustomizedForTest(key: string): boolean {
    return this.overridden.has(key)
  }

  /** Exposed for tests: what is the current load state? */
  _loadStateForTest(): string {
    return this.loadState
  }
}
