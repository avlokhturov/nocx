// ═══════════════════════════════════════════════════════════════════════════
// SettingsContent — wraps the generated settings screen as a TabContent.
// Owns the two-pane layout (rail + content), search, section navigation,
// and deep-link support. Delegates control rendering to SettingsViewImpl.
// ═══════════════════════════════════════════════════════════════════════════

import { SettingsViewImpl, keyToDomId } from './settings'
import type { ProfileClient } from './profiles'
import type { TabHost, TabContent, ContentViewport } from './tab-content'
import { renderExportSection } from './export-section'
import type { SurfaceType, SingletonKey } from './tab-content'

// ── Registered surface constants (B.7) ─────────────────────────────────

export const SURFACE_SETTINGS: SurfaceType = 'nocx.settings' as SurfaceType
export const SINGLETON_SETTINGS: SingletonKey = 'nocx.settings' as SingletonKey

// ── Breakpoint ─────────────────────────────────────────────────────────

/** Width below which the rail stacks above the content column.
 *  Chosen so both columns remain usable: at 640 px the rail takes
 *  240 px (its clamp floor), leaving 400 px for content — enough for
 *  a 200 px (shrinkable) label column plus controls. */
const NARROW_BREAKPOINT_PX = 640

// ── SettingsContent ─────────────────────────────────────────────────────

export class SettingsContent implements TabContent {
  private container: HTMLElement | null = null
  private rail: HTMLElement | null = null
  private contentEl: HTMLElement | null = null
  private _target: HTMLElement | null = null

  private searchInput: HTMLInputElement | null = null
  private modifiedToggle: HTMLInputElement | null = null
  private sectionList: HTMLElement | null = null
  private settingsView: SettingsViewImpl | null = null
  private _disposed = false

  /** Current search query, used to re-apply filter after re-render. */
  private _query = ''

  constructor(private readonly profileClient: ProfileClient) {}

  // ── TabContent ───────────────────────────────────────────────────────

  async mount(target: HTMLElement, host: TabHost, signal: AbortSignal): Promise<void> {
    if (this._disposed || this.container) return
    if (signal.aborted) return
    this._target = target

    host.setTitle('Settings')

    const root = document.createElement('div')
    root.className = 'st-container'

    // ── Rail ──────────────────────────────────────────────────────────
    this.rail = document.createElement('nav')
    this.rail.className = 'st-rail'
    this.rail.setAttribute('aria-label', 'Settings navigation')

    // Search
    this.searchInput = document.createElement('input')
    this.searchInput.type = 'search'
    this.searchInput.className = 'st-search'
    this.searchInput.placeholder = 'Search settings…'
    this.searchInput.setAttribute('aria-label', 'Search settings')
    this.searchInput.addEventListener('input', () => {
      this._query = this.searchInput!.value
      this.applyFilter()
    })
    this.rail.append(this.searchInput)

    // Modified-only toggle
    const filterDiv = document.createElement('div')
    filterDiv.className = 'st-modified-rail'
    const filterLabel = document.createElement('label')
    filterLabel.className = 'st-modified-rail-label'
    this.modifiedToggle = document.createElement('input')
    this.modifiedToggle.type = 'checkbox'
    this.modifiedToggle.addEventListener('change', () => {
      this.settingsView?.setModifiedOnly(this.modifiedToggle!.checked)
    })
    filterLabel.append(this.modifiedToggle)
    filterLabel.append(' Modified')
    const countSpan = document.createElement('span')
    countSpan.className = 'st-modified-rail-count'
    filterLabel.append(countSpan)
    filterDiv.append(filterLabel)
    this.rail.append(filterDiv)

    // Section nav
    this.sectionList = document.createElement('ul')
    this.sectionList.className = 'st-section-nav'
    this.rail.append(this.sectionList)

    root.append(this.rail)

    // ── Content ───────────────────────────────────────────────────────
    this.contentEl = document.createElement('div')
    this.contentEl.className = 'st-content'

    this.settingsView = new SettingsViewImpl(this.contentEl, this.profileClient, undefined, () =>
      this.syncRailState(),
    )
    root.append(this.contentEl)

    // Export / backup / import section (ADR-0011 §7)
    renderExportSection(this.contentEl, this.profileClient)

    target.append(root)
    this.container = root

    await this.settingsView.refresh()
    this.syncRailState()
    this.rebuildSectionNav()
    this.applyFilter()
  }

  focus(): void {
    this.searchInput?.focus()
  }
  viewportChanged(viewport: ContentViewport): void {
    if (!this.container) return
    const narrow = viewport.width < NARROW_BREAKPOINT_PX
    this.container.classList.toggle('st-narrow', narrow)
  }

  setVisible(visible: boolean): void {
    if (this._target) {
      this._target.classList.toggle('active', visible)
    }
  }

  dispose(): void {
    this._disposed = true
    this.container?.remove()
    this.container = null
    this.rail = null
    this.contentEl = null
    this.searchInput = null
    this.modifiedToggle = null
    this.sectionList = null
    this.settingsView = null
  }

  // ── Deep link ───────────────────────────────────────────────────────

  /**
   * Scroll a setting row into view and focus its control.
   * Uses getElementById — safe for keys containing '.' (B.4/B.7 carry-forward).
   */
  scrollToKey(key: string): void {
    if (!this.contentEl) return

    // Clear the search filter so the target row is visible.
    if (this.searchInput) {
      this.searchInput.value = ''
      this._query = ''
      this.applyFilter()
    }

    const row = document.getElementById(keyToDomId(key))
    if (!row) return

    row.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // Focus the first focusable control in the row.
    const control = row.querySelector<HTMLElement>('input, select, button')
    control?.focus()

    // Brief highlight pulse.
    row.classList.add('st-row-highlight')
    row.addEventListener('animationend', () => row.classList.remove('st-row-highlight'), {
      once: true,
    })
  }

  // ── Search and filter ────────────────────────────────────────────────

  /**
   * Hide/show rows and sections based on the current search query.
   * Operates on the DOM — does not re-render, so event handlers and input
   * state survive filtering.
   */
  private applyFilter(): void {
    if (!this.contentEl) return

    const q = this._query.toLowerCase().trim()
    const rows = this.contentEl.querySelectorAll<HTMLElement>('.st-row')
    const sections = this.contentEl.querySelectorAll<HTMLElement>('.st-section')

    if (!q) {
      // Show everything.
      for (const row of rows) row.style.display = ''
      for (const sec of sections) sec.style.display = ''
      this.updateSectionNavHighlight()
      return
    }

    // Collect which sections have visible rows.
    const sectionVisible = new Map<HTMLElement, boolean>()

    for (const row of rows) {
      const match = this.rowMatchesQuery(row, q)
      row.style.display = match ? '' : 'none'

      const section = row.closest<HTMLElement>('.st-section')
      if (section) {
        sectionVisible.set(section, (sectionVisible.get(section) ?? false) || match)
      }
    }

    for (const sec of sections) {
      sec.style.display = sectionVisible.get(sec) ? '' : 'none'
    }

    this.updateSectionNavHighlight()
  }

  private rowMatchesQuery(row: HTMLElement, q: string): boolean {
    const label = row.querySelector('label')?.textContent?.toLowerCase() ?? ''
    const desc = row.querySelector('.st-description')?.textContent?.toLowerCase() ?? ''
    const key = row.dataset.key?.toLowerCase() ?? ''
    // Find the section heading by walking up.
    const section =
      row
        .closest<HTMLElement>('.st-section')
        ?.querySelector('.st-section-heading')
        ?.textContent?.toLowerCase() ?? ''

    return label.includes(q) || desc.includes(q) || key.includes(q) || section.includes(q)
  }

  // ── Section navigation ───────────────────────────────────────────────

  private rebuildSectionNav(): void {
    if (!this.sectionList || !this.settingsView) return

    this.sectionList.replaceChildren()

    const bySection = this.settingsView.getModifiedBySection()

    for (const section of this.settingsView.getSections()) {
      const li = document.createElement('li')
      li.className = 'st-section-nav-item'
      li.dataset.section = section

      const btn = document.createElement('button')
      btn.className = 'st-section-nav-link'
      btn.textContent = section
      const count = bySection.get(section)
      if (count) {
        const badge = document.createElement('span')
        badge.className = 'st-section-nav-badge'
        badge.textContent = String(count)
        btn.append(badge)
      }
      btn.addEventListener('click', () => this.scrollToSection(section))
      li.append(btn)

      this.sectionList.append(li)
    }
  }

  /** Update the rail toggle checkbox, count, and section-nav badges
   *  from the current SettingsViewImpl state.  Called via the
   *  onStateChanged callback so save/reset/filter actions all
   *  keep the rail in sync. */
  private syncRailState(): void {
    if (!this.settingsView) return
    if (this.modifiedToggle) {
      this.modifiedToggle.checked = this.settingsView.isModifiedOnly()
    }
    const count = this.settingsView.getModifiedCount()
    const countSpan = this.rail?.querySelector<HTMLElement>('.st-modified-rail-count')
    if (countSpan) {
      countSpan.textContent = count > 0 ? ' (' + count + ')' : ''
    }
    // Patch section-nav badges in-place so the highlight is preserved.
    const bySection = this.settingsView.getModifiedBySection()
    for (const item of this.sectionList?.querySelectorAll<HTMLElement>('.st-section-nav-item') ??
      []) {
      const section = item.dataset.section
      if (!section) continue
      const count = bySection.get(section)
      const badge = item.querySelector<HTMLElement>('.st-section-nav-badge')
      if (count) {
        if (badge) badge.textContent = String(count)
        else {
          const btn = item.querySelector('button')
          if (btn) {
            const newBadge = document.createElement('span')
            newBadge.className = 'st-section-nav-badge'
            newBadge.textContent = String(count)
            btn.append(newBadge)
          }
        }
      } else {
        badge?.remove()
      }
    }
  }

  private scrollToSection(section: string): void {
    if (!this.contentEl) return

    // Clear search so the section is visible.
    if (this.searchInput) {
      this.searchInput.value = ''
      this._query = ''
      this.applyFilter()
    }

    const heading = document.getElementById('st-section-' + encodeURIComponent(section))
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })

    // Highlight the nav item.
    this.updateSectionNavHighlight(section)
  }

  private updateSectionNavHighlight(activeSection?: string): void {
    if (!this.sectionList || !this.contentEl) return

    // Find the first visible section heading.
    let firstVisible: string | undefined = activeSection
    if (!firstVisible) {
      const headings = this.contentEl.querySelectorAll<HTMLElement>('.st-section-heading')
      for (const h of headings) {
        const section = h.closest<HTMLElement>('.st-section')
        if (section && section.style.display !== 'none') {
          firstVisible = h.textContent ?? undefined
          break
        }
      }
    }

    for (const item of this.sectionList.querySelectorAll<HTMLElement>('.st-section-nav-item')) {
      const match = item.dataset.section === firstVisible
      item.classList.toggle('st-section-nav-active', match)
    }
  }
}
