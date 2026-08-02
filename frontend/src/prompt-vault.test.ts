// @vitest-environment jsdom
//
// The "secrets in the prompt" flow (prompt-vault.ts): the '@' trigger ->
// picker -> insert-with-replacement, and the detection -> offer -> store ->
// chip. The editor and vault are fakes; the seams they cross are real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PromptVaultController, type PromptVaultEditor, type PromptVaultDeps } from './prompt-vault'
import type { VaultClient } from './vault-client'

/** A fake editor with a real document model: applyReplacement behaves like
 *  the editor's, so the controller's edits are observable. */
class FakeEditor implements PromptVaultEditor {
  readonly root = document.createElement('div')
  doc = ''
  caret = 0
  replacements: Array<{ from: number; to: number; text: string }> = []

  getDoc(): string {
    return this.doc
  }

  getSelection(): { from: number; to: number } {
    return { from: this.caret, to: this.caret }
  }

  applyReplacement(from: number, to: number, text: string): void {
    this.replacements.push({ from, to, text })
    this.doc = this.doc.slice(0, from) + text + this.doc.slice(to)
    this.caret = from + text.length
  }

  insert(text: string): void {
    this.doc = this.doc.slice(0, this.caret) + text + this.doc.slice(this.caret)
    this.caret += text.length
  }
}

const UNSEALED = {
  state: 'unsealed',
  osKeyAvailable: false,
  osKeyCapable: false,
  hasPassphrase: true,
  autoSealMinutes: 0,
  defaultProvider: 'file',
  providers: [],
}

interface Harness {
  ctrl: PromptVaultController
  editor: FakeEditor
  vault: Record<string, ReturnType<typeof vi.fn>>
  report: ReturnType<typeof vi.fn>
  container: HTMLElement
}

function setup(
  entries: Array<{ id: string; name: string }> = [
    { id: 's1', name: 'openai-key' },
    { id: 's2', name: 'github-pat' },
  ],
): Harness {
  const editor = new FakeEditor()
  const vault = {
    status: vi.fn(() => Promise.resolve(UNSEALED)),
    inventory: vi.fn(() =>
      Promise.resolve({
        entries: entries.map((e) => ({
          ...e,
          kind: 'password',
          provider: 'file',
          ownerId: '',
          usedBy: 0,
          reachable: true,
        })),
      }),
    ),
    // The wire detector is the ONE implementation; this fake mirrors the
    // two shapes these tests exercise (a vendor-prefix token, an env
    // assignment) and the reference-span exclusion, with the same UTF-16
    // offsets the real detector would report.
    detect: vi.fn((line: string, revision: number) => {
      const findings: Array<{ kind: string; start: number; end: number }> = []
      if (!line.includes('{{secret:')) {
        const token = line.match(/sk-proj-[A-Za-z0-9]+/)
        if (token && token.index !== undefined) {
          findings.push({ kind: 'openai', start: token.index, end: token.index + token[0].length })
        }
        const env = line.match(/TOKEN=[A-Za-z0-9]+/)
        if (env && env.index !== undefined) {
          findings.push({
            kind: 'env-assignment',
            start: env.index,
            end: env.index + env[0].length,
          })
        }
      }
      return Promise.resolve({ revision, findings })
    }),
    createSecret: vi.fn(() => Promise.resolve({})),
    setup: vi.fn(() => Promise.resolve({})),
  }
  const report = vi.fn()
  const deps: PromptVaultDeps = {
    editor,
    vault: vault as unknown as VaultClient,
    report,
  }
  const ctrl = new PromptVaultController(deps)
  ctrl.mount()
  const container = editor.root
  return { ctrl, editor, vault, report, container }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const pickerRows = (c: HTMLElement): string[] =>
  [...c.querySelectorAll<HTMLElement>('.ui-floating-panel__row')].map(
    (el) => el.querySelector('.ui-collection-row__info')?.textContent ?? '',
  )

describe('PromptVaultController: the @ trigger -> picker', () => {
  it('the trigger opens the picker; picking replaces the trigger word', async () => {
    const h = setup()
    h.editor.doc = 'echo @ope'
    h.editor.caret = 9
    h.ctrl.onSecretPicker(5)
    await flush()
    expect(pickerRows(h.container)).toEqual(['openai-key', 'github-pat'])
    // ArrowDown selects the second, Enter inserts.
    h.ctrl.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    h.ctrl.handleKey(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(h.editor.replacements).toEqual([{ from: 5, to: 9, text: '{{secret:github-pat}}' }])
    expect(h.editor.doc).toBe('echo {{secret:github-pat}}')
  })

  it('the picker filters as the trigger word grows', async () => {
    const h = setup()
    h.editor.doc = 'echo @'
    h.editor.caret = 6
    h.ctrl.onSecretPicker(5)
    await flush()
    h.editor.insert('ope')
    h.ctrl.onDocChanged('echo @ope')
    expect(pickerRows(h.container)).toEqual(['openai-key'])
  })

  it('a space in the trigger word closes the picker (the word ended)', async () => {
    const h = setup()
    h.editor.doc = 'echo @'
    h.editor.caret = 6
    h.ctrl.onSecretPicker(5)
    await flush()
    h.editor.insert(' ')
    h.ctrl.onDocChanged('echo @ ')
    expect(h.ctrl.isPickerOpen).toBe(false)
  })

  it('a stale trigger inserts at the caret instead of replacing an unrelated char', async () => {
    const h = setup()
    h.editor.doc = 'echo @ope'
    h.editor.caret = 9
    h.ctrl.onSecretPicker(5)
    await flush()
    // The user deleted the '@' before picking.
    h.editor.doc = 'echo ope'
    h.editor.caret = 8
    h.ctrl.handleKey(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(h.editor.replacements).toEqual([{ from: 8, to: 8, text: '{{secret:openai-key}}' }])
  })
})

describe('PromptVaultController: the offer-to-save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a pasted key settles, the offer appears, and Store creates + replaces with a chip', async () => {
    const h = setup()
    h.editor.doc = 'curl -H "Authorization: Bearer sk-proj-abcdefghijklmnop" https://x'
    h.editor.caret = h.editor.doc.length
    h.ctrl.onDocChanged(h.editor.doc)
    await flush()
    vi.advanceTimersByTime(500)
    await flush()
    // The offer row is up, non-modal, with a suggested name.
    const offerRoot = h.container.querySelector<HTMLElement>('.ui-secret-offer')
    expect(offerRoot?.hidden).toBe(false)
    const input = offerRoot?.querySelector<HTMLInputElement>('.ui-secret-offer__name')
    expect(input?.value).toBe('openai-key')
    expect(document.activeElement).not.toBe(input) // focus stays in the prompt
    // Accept: Enter in the name field.
    input?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flush()
    expect(h.vault.createSecret).toHaveBeenCalledWith({
      name: 'openai-key',
      kind: 'password',
      value: 'sk-proj-abcdefghijklmnop',
    })
    // The literal became the reference — the chip's text.
    expect(h.editor.doc).toBe('curl -H "Authorization: Bearer {{secret:openai-key}}" https://x')
    expect(h.report).toHaveBeenCalledWith('success', expect.stringContaining('openai-key'))
    expect(offerRoot?.hidden).toBe(true)
  })

  it('a declined key is not offered again while it stays in the doc', async () => {
    const h = setup()
    h.editor.doc = 'TOKEN=abcdefghijklmnopqrstuvwxyz123456'
    h.editor.caret = h.editor.doc.length
    h.ctrl.onDocChanged(h.editor.doc)
    await flush()
    vi.advanceTimersByTime(500)
    await flush()
    const offer = h.container.querySelector<HTMLElement>('.ui-secret-offer')!
    const input = offer.querySelector<HTMLInputElement>('.ui-secret-offer__name')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(offer.hidden).toBe(true)
    // Typing more (the value still in the doc) must not re-offer it.
    h.editor.insert(' --dry-run')
    h.ctrl.onDocChanged(h.editor.doc)
    await flush()
    vi.advanceTimersByTime(500)
    await flush()
    expect(offer.hidden).toBe(true)
  })

  it('the offer hides when the value leaves the document', async () => {
    const h = setup()
    h.editor.doc = 'TOKEN=abcdefghijklmnopqrstuvwxyz123456'
    h.editor.caret = h.editor.doc.length
    h.ctrl.onDocChanged(h.editor.doc)
    await flush()
    vi.advanceTimersByTime(500)
    await flush()
    const offer = h.container.querySelector<HTMLElement>('.ui-secret-offer')!
    expect(offer.hidden).toBe(false)
    h.editor.doc = 'echo hi'
    h.editor.caret = 7
    h.ctrl.onDocChanged(h.editor.doc)
    expect(offer.hidden).toBe(true)
  })

  it('a reference name is never offered (findings inside {{secret:…}} are skipped)', async () => {
    const h = setup()
    h.editor.doc = 'curl {{secret:sk-proj-mykey}} https://x'
    h.editor.caret = h.editor.doc.length
    h.ctrl.onDocChanged(h.editor.doc)
    await flush()
    vi.advanceTimersByTime(500)
    await flush()
    expect(h.container.querySelector<HTMLElement>('.ui-secret-offer')?.hidden).toBe(true)
  })

  it('a failed store reports the error and does not re-offer in a loop', async () => {
    const h = setup()
    h.vault.createSecret.mockRejectedValue(new Error('store exploded'))
    h.editor.doc = 'TOKEN=abcdefghijklmnopqrstuvwxyz123456'
    h.editor.caret = h.editor.doc.length
    h.ctrl.onDocChanged(h.editor.doc)
    await flush()
    vi.advanceTimersByTime(500)
    await flush()
    const offer = h.container.querySelector<HTMLElement>('.ui-secret-offer')!
    const input = offer.querySelector<HTMLInputElement>('.ui-secret-offer__name')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flush()
    expect(h.report).toHaveBeenCalledWith('danger', 'store exploded')
    expect(offer.hidden).toBe(true)
    // The value is still in the doc — but it must not pop again and again.
    h.ctrl.onDocChanged(h.editor.doc)
    await flush()
    vi.advanceTimersByTime(500)
    await flush()
    expect(offer.hidden).toBe(true)
  })
})

describe('PromptVaultController: the masked-row door (the reported recall seam)', () => {
  it('reports why and opens the picker — the command stays in the line', async () => {
    const h = setup()
    h.editor.doc = 'curl -H "Authorization: Bearer sk-p...7890" https://x'
    h.editor.caret = h.editor.doc.length
    h.ctrl.onMaskedRow(1)
    await flush()
    expect(h.report).toHaveBeenCalledWith('warning', expect.stringContaining('masked secret'))
    expect(h.ctrl.isPickerOpen).toBe(true)
    expect(pickerRows(h.container)).toEqual(['openai-key', 'github-pat'])
    // The previewed (masked) command is untouched — it is the draft.
    expect(h.editor.doc).toBe('curl -H "Authorization: Bearer sk-p...7890" https://x')
  })
})

describe('PromptVaultController: reset', () => {
  it('drops every surface and the session offer memory', async () => {
    const h = setup()
    h.editor.doc = 'echo @ope'
    h.editor.caret = 9
    h.ctrl.onSecretPicker(5)
    await flush()
    expect(h.ctrl.isPickerOpen).toBe(true)
    h.ctrl.reset()
    expect(h.ctrl.isPickerOpen).toBe(false)
    h.ctrl.handleKey(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(h.editor.replacements).toEqual([])
  })
})
