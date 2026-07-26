// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsViewImpl, type Declaration } from './settings'
import { ProfileClient } from './profiles'

function mockWS(): WebSocket {
  return { addEventListener: vi.fn(), send: vi.fn() } as unknown as WebSocket
}

const TEST_DECLARATIONS: Declaration[] = [
  {
    key: 'terminal.fontSize',
    section: 'Terminal',
    label: 'Font Size',
    description: 'Terminal font size in pixels',
    control: 'number',
    dataClass: 'publicConfig',
    default: 14,
    min: 8,
    max: 48,
  },
  {
    key: 'terminal.fontFamily',
    section: 'Terminal',
    label: 'Font Family',
    description: 'CSS font-family value',
    control: 'text',
    dataClass: 'publicConfig',
    default: 'monospace',
  },
  {
    key: 'terminal.cursorStyle',
    section: 'Terminal',
    label: 'Cursor Style',
    description: 'Cursor appearance',
    control: 'select',
    dataClass: 'publicConfig',
    default: 'block',
    options: [
      { value: 'block', label: 'Block' },
      { value: 'bar', label: 'Bar' },
      { value: 'underline', label: 'Underline' },
    ],
  },
  {
    key: 'app.confirmQuit',
    section: 'Application',
    label: 'Confirm Quit',
    description: 'Show confirmation dialog before quitting',
    control: 'toggle',
    dataClass: 'publicConfig',
    default: true,
  },
  {
    key: 'ai.apiKey',
    section: 'AI',
    label: 'API Key',
    description: 'AI provider API key',
    control: 'secret',
    dataClass: 'secretAuthenticator',
    // default is absent for secrets (ADR-0011 §3)
  },
]

describe('SettingsViewImpl', () => {
  let container: HTMLDivElement
  let client: ProfileClient
  let view: SettingsViewImpl

  beforeEach(() => {
    document.body.replaceChildren()
    container = document.createElement('div')
    document.body.append(container)
    client = new ProfileClient(mockWS())
    view = new SettingsViewImpl(container, client)
  })

  // --- Section grouping ---

  it('renders sections as headings from declarations', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: {} })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    const headings = container.querySelectorAll('.st-section-heading')
    const texts = Array.from(headings).map((h) => h.textContent)
    expect(texts).toContain('Terminal')
    expect(texts).toContain('Application')
    expect(texts).toContain('AI')
    // Headings appear in declaration order (Terminal first in our list).
    expect(texts[0]).toBe('Terminal')
  })

  // --- Control rendering by kind ---

  it('renders toggle control as a checkbox', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: { 'app.confirmQuit': true } })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="app\\.confirmQuit"]')
    expect(row).toBeTruthy()
    const checkbox = row!.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox).toBeTruthy()
    expect(checkbox!.checked).toBe(true)
  })

  it('renders text control as a text input', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({
      values: { 'terminal.fontFamily': 'Fira Code' },
    })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="terminal\\.fontFamily"]')
    expect(row).toBeTruthy()
    const input = row!.querySelector<HTMLInputElement>('input[type="text"]')
    expect(input).toBeTruthy()
    expect(input!.value).toBe('Fira Code')
  })

  it('renders number control with min/max attributes', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: { 'terminal.fontSize': 18 } })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="terminal\\.fontSize"]')
    const input = row!.querySelector<HTMLInputElement>('input[type="number"]')
    expect(input).toBeTruthy()
    expect(input!.value).toBe('18')
    expect(input!.min).toBe('8')
    expect(input!.max).toBe('48')
  })

  it('renders select control with options', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({
      values: { 'terminal.cursorStyle': 'bar' },
    })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="terminal\\.cursorStyle"]')
    const select = row!.querySelector<HTMLSelectElement>('select')
    expect(select).toBeTruthy()
    expect(select!.value).toBe('bar')
    const options = Array.from(select!.querySelectorAll('option')).map((o) => ({
      value: o.value,
      label: o.textContent,
    }))
    expect(options).toHaveLength(3)
    expect(options).toContainEqual({ value: 'block', label: 'Block' })
    expect(options).toContainEqual({ value: 'bar', label: 'Bar' })
    expect(options).toContainEqual({ value: 'underline', label: 'Underline' })
  })

  // --- Value narrowing ---

  it('renders fallback when value is an object, never [object Object]', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({
      values: {
        'terminal.fontFamily': { corrupt: 'object' },
        'terminal.fontSize': { also: 'bad' },
        'terminal.cursorStyle': { wrong: 'type' },
      },
    })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    // Text: value is an object → renders default, not [object Object].
    const textInput = container.querySelector<HTMLInputElement>(
      '.st-row[data-key="terminal\\.fontFamily"] input[type="text"]',
    )
    expect(textInput).toBeTruthy()
    expect(textInput!.value).toBe('monospace')
    expect(textInput!.value).not.toContain('[object Object]')

    // Number: value is an object → renders default, not [object Object].
    const numberInput = container.querySelector<HTMLInputElement>(
      '.st-row[data-key="terminal\\.fontSize"] input[type="number"]',
    )
    expect(numberInput).toBeTruthy()
    expect(numberInput!.value).toBe('14')
    expect(numberInput!.value).not.toContain('[object Object]')

    // Select: value is an object → renders default, not [object Object].
    const select = container.querySelector<HTMLSelectElement>(
      '.st-row[data-key="terminal\\.cursorStyle"] select',
    )
    expect(select).toBeTruthy()
    expect(select!.value).toBe('block')
  })

  it('NaN fallback in renderNumber sends a number, never an object', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({
      values: { 'terminal.fontSize': { corrupt: true } },
    })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })
    const setSpy = vi.spyOn(client, 'setSetting').mockResolvedValue({ ok: true })

    await view.refresh()

    const input = container.querySelector<HTMLInputElement>(
      '.st-row[data-key="terminal\\.fontSize"] input[type="number"]',
    )
    expect(input).toBeTruthy()
    // The display value is the default (14), not the corrupt object.
    expect(input!.value).toBe('14')

    // Override the value getter to return a non-numeric string on change,
    // forcing the NaN branch in renderNumber's change handler.
    let getterCalls = 0
    Object.defineProperty(input!, 'value', {
      get() {
        // First call: renderNumber reads input.value for initial render.
        // We let the native getter handle it already happened.
        getterCalls++
        return getterCalls <= 1 ? '14' : 'not-a-number'
      },
      set() {
        /* noop — prevent jsdom from coercing */
      },
      configurable: true,
    })

    input!.dispatchEvent(new Event('change'))

    await vi.waitFor(() => {
      expect(setSpy).toHaveBeenCalled()
    })

    // The argument passed to setSetting must be a number, never the raw object.
    const callArg = setSpy.mock.calls[0][1]
    expect(typeof callArg).toBe('number')
    // displayValue returns String(14) for corrupt object + default 14,
    // then Number('14') = 14 — the NaN fallback path.
    expect(callArg).toBe(14)
  })

  // --- Secret control ---

  it('renders secret as "not configured" when secretExists returns false', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: {} })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="ai\\.apiKey"]')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('Not configured')
    // Both Replace and Clear always present (brief requirement).
    expect(row!.textContent).toContain('Replace')
    expect(row!.textContent).toContain('Clear')
  })

  it('renders secret as "configured" when secretExists returns true', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: {} })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: true })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="ai\\.apiKey"]')
    expect(row!.textContent).toContain('Configured')
    expect(row!.textContent).toContain('Replace')
    expect(row!.textContent).toContain('Clear')
  })

  it('secret control has no input element — never renders a populated value', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: {} })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: true })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="ai\\.apiKey"]')
    // No <input>, <textarea>, or any element with a .value that could contain secret material.
    const inputs = row!.querySelectorAll('input, textarea, [value]')
    expect(inputs.length).toBe(0)
  })

  it('no method on ProfileClient exposes a secret value getter', () => {
    // The client deliberately has no secretGet / getSecret / lookupSecret method.
    // Every method on ProfileClient that touches secrets is set/delete/exists only.
    const methods = Object.getOwnPropertyNames(ProfileClient.prototype).filter(
      (m) => m !== 'constructor',
    )
    const secretGetters = methods.filter(
      (m) =>
        m.toLowerCase().includes('secret') &&
        !m.toLowerCase().includes('set') &&
        !m.toLowerCase().includes('delete') &&
        !m.toLowerCase().includes('exists'),
    )
    expect(secretGetters).toHaveLength(0)
  })

  // --- Validation errors ---

  it('surfaces validation error on the offending control', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: TEST_DECLARATIONS })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({
      values: { 'terminal.fontSize': 14 },
    })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    // setSetting rejects with a validation error (JSON-RPC error per contract).
    const setSpy = vi
      .spyOn(client, 'setSetting')
      .mockRejectedValue(new Error('value must be between 8 and 48'))

    await view.refresh()

    // Simulate changing the number input to an invalid value and blurring.
    const row = container.querySelector<HTMLElement>('.st-row[data-key="terminal\\.fontSize"]')
    const input = row!.querySelector<HTMLInputElement>('input[type="number"]')!
    input.value = '999'
    input.dispatchEvent(new Event('change'))

    // Wait for the async saveSetting.
    await vi.waitFor(() => {
      expect(setSpy).toHaveBeenCalled()
    })

    // Re-query: saveSetting replaces the row via rerenderRow.
    const updatedRow = container.querySelector<HTMLElement>(
      '.st-row[data-key="terminal\\.fontSize"]',
    )
    const errorEl = updatedRow!.querySelector('.st-error')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toBe('value must be between 8 and 48')
  })

  // --- Generated from declarations ---

  it('a brand-new declaration with a novel key renders with zero frontend change', async () => {
    // This is the load-bearing acceptance criterion: if the backend adds a
    // declaration, the screen renders a working control for it with no
    // frontend change at all.  We simulate this by adding a novel declaration
    // that was not in the original set — it must render.
    const novel: Declaration = {
      key: 'editor.tabWidth',
      section: 'Editor',
      label: 'Tab Width',
      description: 'Number of spaces per tab',
      control: 'number',
      dataClass: 'publicConfig',
      default: 4,
      min: 1,
      max: 16,
    }
    const withNovel = [...TEST_DECLARATIONS, novel]

    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: withNovel })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: {} })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    const row = container.querySelector<HTMLElement>('.st-row[data-key="editor\\.tabWidth"]')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('Tab Width')
    const input = row!.querySelector<HTMLInputElement>('input[type="number"]')
    expect(input).toBeTruthy()
    expect(input!.value).toBe('4')
  })

  // --- Empty state ---

  it('shows empty state when no declarations', async () => {
    vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: [] })
    vi.spyOn(client, 'getAllSettings').mockResolvedValue({ values: {} })
    vi.spyOn(client, 'secretExists').mockResolvedValue({ exists: false })

    await view.refresh()

    expect(container.querySelector('.st-empty')).toBeTruthy()
  })
})
