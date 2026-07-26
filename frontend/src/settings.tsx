/**
 * SettingsComponent — Solid rewrite of the settings surface.
 *
 * Replaces the imperative SettingsViewImpl + SettingsContent rendering
 * (both deleted in this commit).  Domain logic stays in settings-domain.ts.
 * ExportSection is rendered as a child component — no mountExportSection.
 *
 * Two defects fixed (not preserved):
 *   - nocx-x6w9: exactly ONE search box and ONE modified filter (both in rail)
 *   - nocx-ucxl: clicking a rail section always changes the content pane
 */

import { For, Show, createSignal, createMemo, onMount, onCleanup } from 'solid-js'
import { createStore } from 'solid-js/store'

import type { ProfileClient } from './profiles'
import { SettingsObserver } from './settings-observer'
import {
  AcceptedSnapshot,
  applyAcceptedSnapshot,
  canResetSetting,
  monotonicRevisionPolicy,
  reconnectRevisionPolicy,
  recordSaveOutcome,
  type RevisionPolicy,
  type SaveOutcome,
  type SettingsMirror,
  type SettingsSnapshot,
} from './settings-domain'
import { ExportSection } from './export-section'
import { log } from './log'

// ── Stable DOM id ──────────────────────────────────────────────────────

/** Stable DOM id for a setting row, derived from the declaration key. */
export function keyToDomId(key: string): string {
  return 'st-setting-' + encodeURIComponent(key)
}

// ── Types ──────────────────────────────────────────────────────────────

export interface Declaration {
  key: string
  section: string
  label: string
  description: string
  control: 'toggle' | 'text' | 'number' | 'select' | 'secret'
  dataClass: 'publicConfig' | 'privateMetadata' | 'privateContent' | 'secretAuthenticator'
  default?: unknown
  options?: { value: string; label: string }[]
  min?: number
  max?: number
}

type LoadState = 'loading' | 'ready' | 'failed' | 'empty'

export interface SettingsComponentHandle {
  focus(): void
  scrollToKey(key: string): void
  setNarrow(narrow: boolean): void
  /** Resolves when the initial data load completes. */
  ready(): Promise<void>
}

export interface SettingsComponentProps {
  profileClient: ProfileClient
  observer?: SettingsObserver
  ref?: { current: SettingsComponentHandle | null }
}

// ── Component props ────────────────────────────────────────────────────

export interface SettingsComponentProps {
  profileClient: ProfileClient
  observer?: SettingsObserver
  ref?: { current: SettingsComponentHandle | null }
}

// ── Root component ─────────────────────────────────────────────────────

export function SettingsComponent(props: SettingsComponentProps) {
  // ── State ──────────────────────────────────────────────────────────
  const [declarations, setDeclarations] = createSignal<Declaration[]>([])
  const [values, setValues] = createStore<Record<string, unknown>>({})
  const [draftValues, setDraftValues] = createStore<Record<string, unknown>>({})
  const [overridden, setOverridden] = createSignal<Set<string>>(new Set())
  const [errors, setErrors] = createStore<Record<string, string>>({})
  const [revision, setRevision] = createSignal(0)
  const [secretStates, setSecretStates] = createStore<Record<string, boolean>>({})
  const [loadState, setLoadState] = createSignal<LoadState>('loading')
  const [searchQuery, setSearchQuery] = createSignal('')
  const [modifiedOnly, setModifiedOnly] = createSignal(false)
  const [sectionFilter, setSectionFilter] = createSignal<string | null>(null)
  const [narrow, setNarrow] = createSignal(false)

  // Element refs for keyboard shortcuts and deep link.
  let searchInputRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined

  // Promise that resolves when the initial data load finishes.
  let resolveReady: () => void
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  // ── Observer ───────────────────────────────────────────────────────
  let cleanupObserver: (() => void) | null = null

  onCleanup(() => {
    cleanupObserver?.()
  })

  function startObserver(): void {
    if (!props.observer) return
    props.observer.start(() => {
      void refresh(reconnectRevisionPolicy)
    })
    props.observer.setRevision(revision())
    // eslint-disable-next-line solid/reactivity
    cleanupObserver = () => props.observer!.stop()
  }
  // ── Data loading ───────────────────────────────────────────────────

  async function refresh(accept: RevisionPolicy = monotonicRevisionPolicy): Promise<void> {
    setLoadState('loading')
    try {
      const [desc, snap] = await Promise.all([
        props.profileClient.describeSettings(),
        props.profileClient.getSnapshot(),
      ])
      const decls = (desc.declarations as Declaration[]) ?? []
      setDeclarations(decls)

      const rawSnap: SettingsSnapshot = {
        values: snap.values ?? {},
        overridden: snap.overridden ?? [],
        revision: snap.revision ?? 0,
      }
      const accepted = accept(revision(), rawSnap)
      if (accepted) {
        const nextState = applyAcceptedSnapshot(accepted)
        applyMirror(nextState)
        props.observer?.setRevision(nextState.revision)
      }

      // Parallel secret-existence probes.
      const secretDecls = decls.filter((d) => d.control === 'secret')
      if (secretDecls.length > 0) {
        const results = await Promise.allSettled(
          secretDecls.map((d) => props.profileClient.secretExists(d.key)),
        )
        for (let i = 0; i < secretDecls.length; i++) {
          const r = results[i]
          setSecretStates(secretDecls[i].key, r.status === 'fulfilled' ? r.value.exists : false)
        }
      } else {
        for (const k of Object.keys(secretStates)) {
          setSecretStates(k, false as never)
        }
      }

      setLoadState(decls.length === 0 ? 'empty' : 'ready')
    } catch {
      setLoadState('failed')
    }
  }

  function applyMirror(m: SettingsMirror): void {
    for (const [k, v] of Object.entries(m.values)) setValues(k, v as never)
    for (const k of Object.keys(values)) {
      if (!(k in m.values)) setValues(k, undefined as never)
    }
    for (const [k, v] of Object.entries(m.draftValues)) setDraftValues(k, v as never)
    for (const k of Object.keys(draftValues)) {
      if (!(k in m.draftValues)) setDraftValues(k, undefined as never)
    }
    setOverridden(new Set(m.overridden))
    for (const [k, v] of Object.entries(m.errors)) setErrors(k, v)
    for (const k of Object.keys(errors)) {
      if (!(k in m.errors)) setErrors(k, undefined as never)
    }
    setRevision(m.revision)
  }

  function toMirror(): SettingsMirror {
    const v: Record<string, unknown> = {}
    for (const k of Object.keys(values)) v[k] = values[k]
    const dv: Record<string, unknown> = {}
    for (const k of Object.keys(draftValues)) dv[k] = draftValues[k]
    const e: Record<string, string> = {}
    for (const k of Object.keys(errors)) e[k] = errors[k]
    return {
      values: v,
      draftValues: dv,
      overridden: overridden(),
      errors: e,
      revision: revision(),
    }
  }

  onMount(() => {
    startObserver()
    void refresh().then(() => resolveReady())
  })

  // ── Derived: filtered declarations ─────────────────────────────────

  const filteredDeclarations = createMemo(() => {
    let filtered = declarations()
    const q = searchQuery().toLowerCase()
    const sf = sectionFilter()

    // Section filter (nocx-ucxl): clicking a nav item always changes content.
    if (sf !== null) {
      filtered = filtered.filter((d) => d.section === sf)
    }

    // Modified-only filter.
    if (modifiedOnly()) {
      filtered = filtered.filter((d) => d.control !== 'secret' && overridden().has(d.key))
    }

    // Search filter.
    if (q) {
      type Scored = { decl: Declaration; score: number }
      const scored: Scored[] = []
      for (const d of filtered) {
        const score = searchScore(d, q)
        if (score > 0) scored.push({ decl: d, score })
      }
      scored.sort((a, b) => b.score - a.score)
      filtered = scored.map((s) => s.decl)
    }

    return filtered
  })

  const isSearching = createMemo(() => searchQuery().length > 0)

  // ── Derived: sections ──────────────────────────────────────────────
  const sections: () => string[] = createMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const d of declarations()) {
      if (!seen.has(d.section)) {
        seen.add(d.section)
        result.push(d.section)
      }
    }
    return result
  })

  const modifiedCount = createMemo(() => {
    let count = 0
    for (const d of declarations()) {
      if (d.control !== 'secret' && overridden().has(d.key)) count++
    }
    return count
  })

  const modifiedBySection = createMemo(() => {
    const counts = new Map<string, number>()
    for (const d of declarations()) {
      if (d.control !== 'secret' && overridden().has(d.key)) {
        counts.set(d.section, (counts.get(d.section) ?? 0) + 1)
      }
    }
    return counts
  })

  // ── Visible keys set for style.display hiding ─────────────────────

  const visibleKeys: () => Set<string> = createMemo(
    () => new Set(filteredDeclarations().map((d: Declaration) => d.key)),
  )

  // ── Actions ────────────────────────────────────────────────────────

  async function saveSetting(key: string, value: unknown): Promise<void> {
    let outcome: SaveOutcome
    try {
      await props.profileClient.setSetting(key, value)
      outcome = { kind: 'accepted', value }
    } catch (err) {
      outcome = { kind: 'rejected', error: (err as Error).message, attemptedValue: value }
    }
    const nextState = recordSaveOutcome(toMirror(), key, outcome)
    applyMirror(nextState)
  }

  async function resetSetting(key: string): Promise<void> {
    setErrors(key, undefined as never)
    try {
      await props.profileClient.resetSetting(key)
      const snap = await props.profileClient.getSnapshot()
      const rawSnap: SettingsSnapshot = {
        values: snap.values ?? {},
        overridden: snap.overridden ?? [],
        revision: snap.revision ?? 0,
      }
      const accepted = AcceptedSnapshot.accept(revision(), rawSnap)
      if (accepted) {
        const nextState = applyAcceptedSnapshot(accepted)
        applyMirror(nextState)
      }
    } catch (err) {
      setErrors(key, (err as Error).message)
    }
  }

  async function saveSecret(key: string, value: string): Promise<void> {
    setErrors(key, undefined as never)
    try {
      await props.profileClient.secretSet(key, value)
      setSecretStates(key, true)
    } catch (err) {
      setErrors(key, (err as Error).message)
    }
  }

  async function deleteSecret(key: string): Promise<void> {
    setErrors(key, undefined as never)
    try {
      await props.profileClient.secretDelete(key)
      setSecretStates(key, false)
    } catch (err) {
      setErrors(key, (err as Error).message)
    }
  }

  function handleSearchInput(value: string): void {
    setSearchQuery(value)
  }

  function handleSectionClick(section: string): void {
    // Toggle section filter (nocx-ucxl): always produces a visible change.
    setSectionFilter((prev) => (prev === section ? null : section))
    // Clear search so the user sees all rows in the section.
    setSearchQuery('')
    if (searchInputRef) searchInputRef.value = ''
  }

  // ── Keyboard handler ───────────────────────────────────────────────

  function handleKeydown(e: KeyboardEvent): void {
    if (
      e.key === '/' &&
      !(
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
    ) {
      e.preventDefault()
      searchInputRef?.focus()
    }
    if (e.key === 'Escape' && searchQuery()) {
      setSearchQuery('')
      if (searchInputRef) searchInputRef.value = ''
    }
  }

  // ── Expose handle ──────────────────────────────────────────────────

  const handle: SettingsComponentHandle = {
    focus(): void {
      searchInputRef?.focus()
    },
    scrollToKey(key: string): void {
      // Clear search and section filter so the target row is visible.
      setSearchQuery('')
      setSectionFilter(null)
      if (searchInputRef) searchInputRef.value = ''

      const row = document.getElementById(keyToDomId(key))
      if (!row) return

      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const control = row.querySelector<HTMLElement>('input, select, button')
      control?.focus()

      row.classList.add('st-row-highlight')
      row.addEventListener('animationend', () => row.classList.remove('st-row-highlight'), {
        once: true,
      })
    },
    setNarrow(n: boolean): void {
      setNarrow(n)
    },
    ready(): Promise<void> {
      return readyPromise
    },
  }

  // eslint-disable-next-line solid/reactivity
  if (props.ref) {
    // eslint-disable-next-line solid/reactivity
    props.ref.current = handle
  }

  // ── Search scoring ─────────────────────────────────────────────────

  function searchScore(decl: Declaration, query: string): number {
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

  // ── Value helpers ──────────────────────────────────────────────────

  function effectiveValue(key: string): unknown {
    if (key in draftValues) return draftValues[key]
    return values[key]
  }

  function displayValue(value: unknown, decl: Declaration): string {
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

  // ── Render ─────────────────────────────────────────────────────────

  function renderDataClassIndicator(dataClass: Declaration['dataClass']): string {
    switch (dataClass) {
      case 'publicConfig':
        return 'Public'
      case 'privateMetadata':
      case 'privateContent':
        return 'Private'
      case 'secretAuthenticator':
        return 'Secret'
    }
  }

  // ── Sub-components ─────────────────────────────────────────────────

  function ProvenanceBadge(props: { decl: Declaration }) {
    // eslint-disable-next-line solid/reactivity
    const decl = props.decl
    const customized = () => overridden().has(decl.key)
    const decision = () => canResetSetting(overridden(), decl.key)

    return (
      <Show when={decl.default !== undefined}>
        <span
          classList={{
            'st-provenance': true,
            'st-customized': customized(),
            'st-default': !customized(),
          }}
        >
          {customized() ? 'Customized' : 'Default'}
          <Show when={decision().canReset}>
            <button
              class="st-reset-btn"
              title="Reset to default"
              onClick={() => void resetSetting(decl.key)}
            >
              Reset
            </button>
          </Show>
        </span>
      </Show>
    )
  }

  function SettingRow(props: { decl: Declaration; visible: boolean }) {
    // eslint-disable-next-line solid/reactivity
    const decl = props.decl
    const eff = () => effectiveValue(decl.key)
    const err = () => errors[decl.key]
    const showBreadcrumb = () => isSearching() && sectionFilter() === null

    return (
      <div
        class="st-row"
        id={keyToDomId(decl.key)}
        data-key={decl.key}
        style={props.visible ? {} : { display: 'none' }}
      >
        <div class="st-label-col">
          <Show when={showBreadcrumb()}>
            <span class="st-breadcrumb">{decl.section}</span>
          </Show>
          <label title={decl.description}>{decl.label}</label>
          <Show when={decl.description}>
            <span class="st-description">{decl.description}</span>
          </Show>
          <span class="st-data-class" title={'Storage class: ' + decl.dataClass}>
            {renderDataClassIndicator(decl.dataClass)}
          </span>
        </div>
        <div class="st-control-col">
          <Show when={decl.control === 'number'}>
            <span class="st-bounds">
              <Show when={decl.min !== undefined && decl.max !== undefined}>
                {String(decl.min)} – {String(decl.max)}
              </Show>
              <Show when={decl.min !== undefined && decl.max === undefined}>
                {'≥ ' + String(decl.min)}
              </Show>
              <Show when={decl.max !== undefined && decl.min === undefined}>
                {'≤ ' + String(decl.max)}
              </Show>
            </span>
          </Show>

          <Show when={decl.control === 'toggle'}>
            <input
              type="checkbox"
              checked={!!eff()}
              onChange={() => void saveSetting(decl.key, !eff())}
            />
          </Show>

          <Show when={decl.control === 'text'}>
            <input
              type="text"
              value={displayValue(eff(), decl)}
              onChange={(e) => void saveSetting(decl.key, e.currentTarget.value)}
            />
          </Show>

          <Show when={decl.control === 'number'}>
            <input
              type="number"
              value={displayValue(eff(), decl)}
              min={decl.min !== undefined ? String(decl.min) : undefined}
              max={decl.max !== undefined ? String(decl.max) : undefined}
              onChange={(e) => {
                const n = Number(e.currentTarget.value)
                void saveSetting(decl.key, isNaN(n) ? Number(displayValue(eff(), decl)) : n)
              }}
            />
          </Show>

          <Show when={decl.control === 'select'}>
            <select
              value={displayValue(eff(), decl)}
              onChange={(e) => void saveSetting(decl.key, e.currentTarget.value)}
            >
              <For each={decl.options ?? []}>
                {(opt) => (
                  <option value={opt.value} selected={opt.value === displayValue(eff(), decl)}>
                    {opt.label}
                  </option>
                )}
              </For>
            </select>
          </Show>

          <Show when={decl.control === 'secret'}>
            <div class="st-secret">
              <span class="st-secret-status">
                {secretStates[decl.key] ? 'Configured' : 'Not configured'}
              </span>
              <button
                class="st-secret-replace"
                onClick={() => {
                  const value = prompt(`Enter new value for "${decl.label}":`)
                  if (value === null) return
                  void saveSecret(decl.key, value)
                }}
              >
                Replace
              </button>
              <button class="st-secret-clear" onClick={() => void deleteSecret(decl.key)}>
                Clear
              </button>
            </div>
          </Show>

          <ProvenanceBadge decl={decl} />

          <Show when={err()}>
            <div class="st-error">{err()}</div>
          </Show>
        </div>
      </div>
    )
  }

  // ── Main render ────────────────────────────────────────────────────

  return (
    <div classList={{ 'st-container': true, 'st-narrow': narrow() }} onKeyDown={handleKeydown}>
      {/* ── Rail ──────────────────────────────────────────────────── */}
      <nav class="st-rail" aria-label="Settings navigation">
        {/* ONE search box (nocx-x6w9) — only in the rail. */}
        <input
          ref={searchInputRef}
          type="search"
          class="st-search"
          placeholder="Search settings…"
          aria-label="Search settings"
          value={searchQuery()}
          onInput={(e) => handleSearchInput(e.currentTarget.value)}
        />

        {/* ONE modified-only filter (nocx-x6w9) — only in the rail. */}
        <div class="st-modified-rail">
          <label class="st-modified-rail-label">
            <input
              type="checkbox"
              checked={modifiedOnly()}
              onChange={(e) => setModifiedOnly(e.currentTarget.checked)}
            />
            {' Modified'}
            <Show when={modifiedCount() > 0}>
              <span class="st-modified-rail-count">{' (' + modifiedCount() + ')'}</span>
            </Show>
          </label>
        </div>

        {/* Section nav */}
        <ul class="st-section-nav">
          <For each={sections()}>
            {(section) => {
              const count = () => modifiedBySection().get(section)
              const active = () => sectionFilter() === section
              return (
                <li
                  classList={{ 'st-section-nav-item': true, 'st-section-nav-active': active() }}
                  data-section={section}
                >
                  <button class="st-section-nav-link" onClick={() => handleSectionClick(section)}>
                    {section}
                    <Show when={count() !== undefined && count()! > 0}>
                      <span class="st-section-nav-badge">{String(count())}</span>
                    </Show>
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
      </nav>

      {/* ── Content ────────────────────────────────────────────────── */}
      <div ref={contentRef} class="st-content">
        <Show when={loadState() === 'loading'}>
          <div class="st-status st-loading">Loading settings…</div>
        </Show>

        <Show when={loadState() === 'failed'}>
          <div class="st-status st-failed">
            <span>Failed to load settings.</span>
            <button class="st-retry-btn" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        </Show>

        <Show
          when={
            loadState() === 'ready' &&
            filteredDeclarations().length === 0 &&
            declarations().length > 0
          }
        >
          <div class="st-status st-nomatch">No settings match your search.</div>
        </Show>

        {/* Render all sections; hide non-matching rows via inline style (keeps DOM elements for tests). */}
        <Show when={loadState() === 'ready'}>
          <For each={sections()}>
            {(section) => {
              const sectionDecls = () => declarations().filter((d) => d.section === section)
              const sectionVisible = () => sectionDecls().some((d) => visibleKeys().has(d.key))
              return (
                <div class="st-section" style={sectionVisible() ? {} : { display: 'none' }}>
                  <h2 class="st-section-heading" id={'st-section-' + encodeURIComponent(section)}>
                    {section}
                  </h2>
                  <For each={sectionDecls()}>
                    {(decl) => <SettingRow decl={decl} visible={visibleKeys().has(decl.key)} />}
                  </For>
                </div>
              )
            }}
          </For>
        </Show>

        {/* ExportSection as a child component (no mountExportSection). */}
        <Show when={loadState() === 'ready'}>
          <ExportSection profileClient={props.profileClient} />
        </Show>
      </div>
    </div>
  )
}
