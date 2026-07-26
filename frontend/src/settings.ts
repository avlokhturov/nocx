// Settings screen — generated from settings.describe declarations.
// Renders controls by declaration.control kind, grouped by declaration.section.
// A control:'secret' renders as configured/not-configured with Replace/Clear
// actions; it never renders a populated input (ADR-0011 §2).

import { log } from './log'
import { ProfileClient } from './profiles'

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
}

export class SettingsViewImpl implements SettingsView {
  private container: HTMLElement
  private client: ProfileClient
  private declarations: Declaration[] = []
  private values: Record<string, unknown> = {}
  private secretStates: Record<string, boolean> = {}
  // Tracks per-key error messages displayed inline on the control.
  private errors: Record<string, string> = {}

  constructor(container: HTMLElement, client: ProfileClient) {
    this.container = container
    this.client = client
  }

  show(): void {
    this.render()
  }

  async refresh(): Promise<void> {
    try {
      const desc = await this.client.describeSettings()
      this.declarations = (desc.declarations as Declaration[]) ?? []
      const all = await this.client.getAllSettings()
      this.values = all.values ?? {}
      // Fetch secret existence for every secret-class declaration.
      this.secretStates = {}
      for (const d of this.declarations) {
        if (d.control === 'secret') {
          try {
            const result = await this.client.secretExists(d.key)
            this.secretStates[d.key] = result.exists
          } catch {
            this.secretStates[d.key] = false
          }
        }
      }
      // Clear stale errors on refresh.
      this.errors = {}
    } catch {
      // Keep existing state on fetch failure.
    }
    this.render()
  }

  // --- render ---

  private render(): void {
    this.container.replaceChildren()

    if (this.declarations.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'st-empty'
      empty.textContent = 'No settings declared.'
      this.container.append(empty)
      return
    }

    // Group by section, preserving declaration order within each section.
    const sections = new Map<string, Declaration[]>()
    for (const d of this.declarations) {
      const list = sections.get(d.section)
      if (list) {
        list.push(d)
      } else {
        sections.set(d.section, [d])
      }
    }

    const wrapper = document.createElement('div')
    wrapper.className = 'st-view'

    for (const [section, decls] of sections) {
      const sectionEl = document.createElement('div')
      sectionEl.className = 'st-section'

      const heading = document.createElement('h2')
      heading.className = 'st-section-heading'
      heading.textContent = section
      sectionEl.append(heading)

      for (const decl of decls) {
        sectionEl.append(this.renderControl(decl))
      }

      wrapper.append(sectionEl)
    }

    this.container.append(wrapper)
  }

  private renderControl(decl: Declaration): HTMLElement {
    const row = document.createElement('div')
    row.className = 'st-row'
    row.dataset.key = decl.key

    const labelCol = document.createElement('div')
    labelCol.className = 'st-label-col'

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

    row.append(labelCol)

    const controlCol = document.createElement('div')
    controlCol.className = 'st-control-col'

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

  // --- control renderers ---

  private renderToggle(decl: Declaration): HTMLElement {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = !!this.values[decl.key]
    input.addEventListener('change', () => {
      void this.saveSetting(decl.key, input.checked)
    })
    return input
  }

  private renderText(decl: Declaration): HTMLElement {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = this.displayValue(this.values[decl.key], decl)
    input.addEventListener('change', () => {
      void this.saveSetting(decl.key, input.value)
    })
    return input
  }

  private renderNumber(decl: Declaration): HTMLElement {
    const input = document.createElement('input')
    input.type = 'number'
    input.value = this.displayValue(this.values[decl.key], decl)
    if (decl.min !== undefined) input.min = String(decl.min)
    if (decl.max !== undefined) input.max = String(decl.max)
    input.addEventListener('change', () => {
      const n = Number(input.value)
      void this.saveSetting(
        decl.key,
        isNaN(n) ? Number(this.displayValue(this.values[decl.key], decl)) : n,
      )
    })
    return input
  }

  private renderSelect(decl: Declaration): HTMLElement {
    const select = document.createElement('select')
    const current = this.displayValue(this.values[decl.key], decl)
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

  // --- actions ---

  private async saveSetting(key: string, value: unknown): Promise<void> {
    // Clear any previous error for this key before the call.
    delete this.errors[key]
    try {
      await this.client.setSetting(key, value)
    } catch (err) {
      // Validation failures arrive as JSON-RPC errors per the contract.
      this.errors[key] = (err as Error).message
    }
    // Re-render just the affected row.
    this.rerenderRow(key)
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

  /** Re-render a single control row in-place without full DOM rebuild. */
  private rerenderRow(key: string): void {
    const oldRow = this.container.querySelector<HTMLElement>(`.st-row[data-key="${key}"]`)
    if (!oldRow) return
    const decl = this.declarations.find((d) => d.key === key)
    if (!decl) return
    const newRow = this.renderControl(decl)
    oldRow.replaceWith(newRow)
  }
}
