// @vitest-environment jsdom
//
// The receipt round's acceptance tests at the COMPOSED surface
// (terminal-content): a user submits a command carrying a credential, the
// history.record ack attaches the receipt to THAT frozen block, they save,
// and the whole flow survives expiry, failure and the floating-host
// mutual-exclusion rule. The renderer is mocked; the seams the user
// reaches — the editor, the markers, the ack — are real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import {
  createRendererMock,
  makeClient,
  makeClipboard,
  makeBanner,
  type RendererMock,
  type SessionFake,
  type ClientFake,
} from './test-support/tabs-fixtures'
import { ClipboardGate } from './clipboard'
import { CommandEditor } from './editor'
import { Tab } from './tabs'
import { TerminalContent } from './terminal-content'
import { SURFACE_TERMINAL } from './tab-content'
import type { WSClient } from './ipc'
import { unresolvedRedactionField } from './unresolved-redactions'
import { clearToasts, toasts } from './ui/toast'

vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

const editorOf = (content: TerminalContent): CommandEditor =>
  (content as unknown as { editor: CommandEditor }).editor
const rendererOf = (content: TerminalContent): RendererMock =>
  (content as unknown as { renderer: RendererMock }).renderer
const viewOf = (ed: CommandEditor): EditorView => (ed as unknown as { view: EditorView }).view
const sessionOf = (content: TerminalContent): SessionFake =>
  (content as unknown as { session: SessionFake }).session

/** The history.record ack the backend would send for a credential-carrying
 *  command: one masked openai segment, one capture, the masked command. */
function ack(
  overrides: Partial<{
    maskedCount: number
    maskedKinds: string[]
    entryId: string
    redactions: Array<{ kind: string; start: number; end: number; prefix: string; suffix: string }>
    maskedCommand: string
    captures: Array<Record<string, unknown>>
  }> = {},
): Record<string, unknown> {
  return {
    maskedCount: 1,
    maskedKinds: ['openai'],
    entryId: '7',
    redactions: [{ kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' }],
    maskedCommand: 'curl -H "Authorization: Bearer sk-p...7890" https://api',
    captures: [
      {
        id: 'cap_1',
        entryId: '7',
        redaction: { kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' },
        suggestedName: 'openrouter.ai',
        ttlMs: 30_000,
      },
    ],
    ...overrides,
  }
}

const COMMAND = 'curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://api'

interface Mounted {
  view: EditorView
  ed: CommandEditor
  content: TerminalContent
  tab: Tab
  teardown: () => void
}

async function mountTerminal(client: ClientFake, attachToDocument = true): Promise<Mounted> {
  const content = new TerminalContent(
    client as unknown as WSClient,
    makeClipboard(),
    new ClipboardGate(),
    makeBanner(),
    null,
    () => {},
  )
  const tab = new Tab(
    content,
    {
      surfaceType: SURFACE_TERMINAL,
      singletonKey: null,
      restoreDescriptor: { type: 'local' },
      supportsAttention: true,
      defaultTitle: 'Terminal',
    },
    99,
  )
  const paneParent = document.createElement('div')
  paneParent.append(tab.pane)
  if (attachToDocument) document.body.append(paneParent)
  const restoreScrolling = stubScrolling()
  await tab.start()
  await expect(content.ready).resolves.toBe(true)
  const ed = editorOf(content)
  return {
    view: viewOf(ed),
    ed,
    content,
    tab,
    teardown: () => {
      restoreScrolling()
      tab.close()
      paneParent.remove()
    },
  }
}

/** jsdom has no scrollTo/scrollIntoView; the scrollback calls both on
 *  every command cycle. Stub them for the duration of a test, the same way
 *  the existing terminal-content tests do. */
function stubScrolling(): () => void {
  /* eslint-disable @typescript-eslint/unbound-method */
  const protoScrollTo = Element.prototype.scrollTo
  const protoScrollIntoView = Element.prototype.scrollIntoView
  /* eslint-enable @typescript-eslint/unbound-method */
  Element.prototype.scrollTo = () => {}
  Element.prototype.scrollIntoView = () => {}
  return () => {
    Element.prototype.scrollTo = protoScrollTo
    Element.prototype.scrollIntoView = protoScrollIntoView
  }
}

/** Drive a complete command cycle through the real marker seam. */
function runCommand(
  renderer: RendererMock,
  content: TerminalContent,
  ed: CommandEditor,
  text: string,
): void {
  content.setVisible(true)
  ed.show()
  ed.insertText(text)
  ed.root.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  const marker = (kind: 'A' | 'B' | 'C' | 'D', line = 0, exitCode?: number): void =>
    renderer._fireCommandMarker({
      kind,
      line,
      col: 0,
      buffer: 'normal',
      ...(exitCode === undefined ? {} : { exitCode }),
    })
  marker('A')
  marker('B')
  marker('C')
  marker('D', 0, 0)
  marker('A')
  marker('B')
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useRealTimers()
  clearToasts()
})

describe('the receipt attaches to the frozen block', () => {
  it('a command carrying a credential produces a receipt INSIDE that block, and nothing above the prompt', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.resolve(ack())
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { view, ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()

      const receipt = tab.pane.querySelector<HTMLElement>('.ui-block-receipt')
      expect(receipt).not.toBeNull()
      // The receipt is INSIDE the block element...
      const block = receipt!.closest('.cmd-block')
      expect(block).not.toBeNull()
      // ...and there is no element for it above the prompt or inside the
      // floating host (the editor root owns the floating surfaces).
      expect(ed.root.querySelector('.ui-block-receipt')).toBeNull()
      expect(ed.root.querySelector('.ui-floating-panel[data-open="true"]')).toBeNull()
      // The block shows what was recorded: the masked command with a chip.
      expect(block!.querySelectorAll('.ui-secret-chip[data-redaction-start]').length).toBe(1)
      expect(block!.getAttribute('data-recorded-command')).toBe(
        'curl -H "Authorization: Bearer sk-p...7890" https://api',
      )
      void view
    } finally {
      teardown()
    }
  })

  it('a dropped history.record ack produces no receipt and no terminal error', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.reject(new Error('socket dropped'))
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      expect(tab.pane.querySelector('.ui-block-receipt')).toBeNull()
      // The editor still works: a fresh command submits.
      ed.show()
      ed.insertText('echo ok')
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await flush()
      expect(ed.getDoc()).toBe('')
    } finally {
      teardown()
    }
  })

  it('focus stays in the editor after the receipt appears: a keystroke goes into the document', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.resolve(ack())
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { view, ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      expect(tab.pane.querySelector('.ui-block-receipt')).not.toBeNull()
      // The receipt did not steal focus: nothing inside it is focused, and
      // a keystroke goes into the document.
      expect(document.activeElement?.closest('.ui-block-receipt')).toBeNull()
      ed.focus()
      ed.insertText('x')
      expect(view.state.doc.toString()).toBe('x')
    } finally {
      teardown()
    }
  })

  it('two credentials in one command produce one receipt with two rows and a "Save 2" primary action', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') {
        return Promise.resolve(
          ack({
            maskedCount: 2,
            maskedKinds: ['openai', 'jwt'],
            maskedCommand:
              'curl -H "Authorization: Bearer sk-p...7890" https://api?token=eyJ...abc',
            redactions: [
              { kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' },
              { kind: 'jwt', start: 61, end: 70, prefix: 'eyJ', suffix: 'abc' },
            ],
            captures: [
              {
                id: 'cap_1',
                entryId: '7',
                redaction: { kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' },
                suggestedName: 'openrouter.ai',
                ttlMs: 30_000,
              },
              {
                id: 'cap_2',
                entryId: '7',
                redaction: { kind: 'jwt', start: 61, end: 70, prefix: 'eyJ', suffix: 'abc' },
                suggestedName: 'jwt-token',
                ttlMs: 30_000,
              },
            ],
          }),
        )
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      const receipt = tab.pane.querySelector<HTMLElement>('.ui-block-receipt')!
      expect(receipt.querySelectorAll('.ui-block-receipt__row').length).toBe(2)
      expect(receipt.querySelector('.ui-block-receipt__primary')?.textContent).toBe('Save 2')
    } finally {
      teardown()
    }
  })

  it("hovering a row emphasises that row's chip in the block, and only that one", async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') {
        return Promise.resolve(
          ack({
            maskedCount: 2,
            maskedKinds: ['openai', 'jwt'],
            maskedCommand:
              'curl -H "Authorization: Bearer sk-p...7890" https://api?token=eyJ...abc',
            redactions: [
              { kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' },
              { kind: 'jwt', start: 61, end: 70, prefix: 'eyJ', suffix: 'abc' },
            ],
            captures: [
              {
                id: 'cap_1',
                entryId: '7',
                redaction: { kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' },
                suggestedName: 'openrouter.ai',
                ttlMs: 30_000,
              },
              {
                id: 'cap_2',
                entryId: '7',
                redaction: { kind: 'jwt', start: 61, end: 70, prefix: 'eyJ', suffix: 'abc' },
                suggestedName: 'jwt-token',
                ttlMs: 30_000,
              },
            ],
          }),
        )
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      const block = tab.pane.querySelector<HTMLElement>('.cmd-block')!
      const chips = block.querySelectorAll<HTMLElement>('.ui-secret-chip[data-redaction-start]')
      expect(chips.length).toBe(2)
      const rows = tab.pane.querySelectorAll<HTMLElement>('.ui-block-receipt__row')
      rows[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      expect(chips[0].classList.contains('ui-secret-chip--emphasised')).toBe(true)
      expect(chips[1].classList.contains('ui-secret-chip--emphasised')).toBe(false)
      rows[0].dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
      expect(chips[0].classList.contains('ui-secret-chip--emphasised')).toBe(false)
    } finally {
      teardown()
    }
  })

  it('⇧⌘S moves focus into the receipt; Escape returns it to the editor', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.resolve(ack())
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { view, ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      const input = tab.pane.querySelector<HTMLInputElement>(
        '.ui-block-receipt .ui-text-field__input',
      )!
      expect(input).not.toBeNull()
      const probe = document.createElement('input')
      probe.setAttribute('type', 'text')
      input.parentElement!.appendChild(probe)
      probe.focus()
      probe.remove()
      ed.focus()
      ed.focus()
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      expect(document.activeElement).toBe(input)
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
      // Focus returned to the editor: the next keystroke lands in the doc.
      expect(ed.root.contains(document.activeElement)).toBe(true)
      ed.insertText('y')
      expect(view.state.doc.toString()).toBe('y')
    } finally {
      teardown()
    }
  })

  it('⌘S from the editor performs the receipt primary action', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.resolve(ack())
      if (method === 'secrets.captureSave') {
        return Promise.resolve({ name: 'openrouter.ai' })
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { view, ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      ed.focus()
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      await flush()
      expect(client.call).toHaveBeenCalledWith('secrets.captureSave', {
        captureId: 'cap_1',
        name: 'openrouter.ai',
      })
      // The row saved cleanly: the receipt is gone (the toast said so).
      expect(tab.pane.querySelector('.ui-block-receipt')).toBeNull()
    } finally {
      teardown()
    }
  })
})

describe('the receipt save semantics', () => {
  it('a DIFFERENT name in the captureSave response is the one displayed and used', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.resolve(ack())
      if (method === 'secrets.captureSave') {
        return Promise.resolve({ name: 'openrouter.ai-2' })
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      tab.pane.querySelector<HTMLButtonElement>('.ui-block-receipt__primary')!.click()
      await flush()
      // The row is gone — saved under the RESPONSE name, which the toast
      // displayed (the toast store is the product's message surface).
      expect(tab.pane.querySelector('.ui-block-receipt')).toBeNull()
      const last = toasts()[toasts().length - 1]
      expect(last?.message).toContain('openrouter.ai-2')
    } finally {
      teardown()
    }
  })

  it('partial: true reports honestly and a retry of the SAME capture id completes it — never a second secret', async () => {
    const client = makeClient()
    let saveCalls = 0
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.resolve(ack())
      if (method === 'secrets.captureSave') {
        saveCalls++
        if (saveCalls === 1) {
          return Promise.resolve({ name: 'openrouter.ai', partial: true, error: 'rewrite failed' })
        }
        return Promise.resolve({ name: 'openrouter.ai' })
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      const primary = tab.pane.querySelector<HTMLButtonElement>('.ui-block-receipt__primary')!
      primary.click()
      await flush()
      // Honest partial: the row stays with its message; the secret exists.
      expect(tab.pane.querySelector('.ui-block-receipt__row')).not.toBeNull()
      expect(tab.pane.querySelector('.ui-block-receipt__row-error')?.textContent).toContain(
        'rewrite is still owed',
      )
      // Retry: the SAME capture id, and never a vault.createSecret.
      primary.click()
      await flush()
      const saveParams: unknown[] = client.call.mock.calls
        .filter((c) => c[0] === 'secrets.captureSave')
        .map((c) => c[1] as unknown)
      expect(saveParams).toEqual([
        { captureId: 'cap_1', name: 'openrouter.ai' },
        { captureId: 'cap_1', name: 'openrouter.ai' },
      ])
      expect(client.call.mock.calls.some((c) => c[0] === 'vault.createSecret')).toBe(false)
      expect(tab.pane.querySelector('.ui-block-receipt')).toBeNull()
    } finally {
      teardown()
    }
  })

  it('a rejecting captureSave reports and leaves the row', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') return Promise.resolve(ack())
      if (method === 'secrets.captureSave') return Promise.reject(new Error('expired'))
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      await flush()
      tab.pane.querySelector<HTMLButtonElement>('.ui-block-receipt__primary')!.click()
      await flush()
      expect(tab.pane.querySelector('.ui-block-receipt__row')).not.toBeNull()
      expect(tab.pane.querySelector('.ui-block-receipt__row-error')?.textContent).toContain(
        'try again',
      )
    } finally {
      teardown()
    }
  })

  it('after ttlMs the receipt retires itself with the honest line and no actions', async () => {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.record') {
        return Promise.resolve(
          ack({
            captures: [
              {
                id: 'cap_1',
                entryId: '7',
                redaction: { kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' },
                suggestedName: 'openrouter.ai',
                ttlMs: 50,
              },
            ],
          }),
        )
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    const { ed, content, tab, teardown } = await mountTerminal(client)
    try {
      runCommand(rendererOf(content), content, ed, COMMAND)
      // The receipt's expiry timer must be born under the fake clock: arm
      // fake timers AFTER the submit (the ack resolves on the flush below,
      // constructing the receipt under the fake clock), then advance.
      vi.useFakeTimers()
      await flush()
      expect(tab.pane.querySelector('.ui-block-receipt__primary')).not.toBeNull()
      await vi.advanceTimersByTimeAsync(120)
      const receipt = tab.pane.querySelector<HTMLElement>('.ui-block-receipt')!
      expect(receipt.querySelector('.ui-block-receipt__expired')).not.toBeNull()
      expect(receipt.textContent).toContain('no longer held')
      expect(receipt.querySelector('button')).toBeNull()
    } finally {
      vi.useRealTimers()
      teardown()
    }
  })
})

describe('a recalled masked row refuses to run and opens resolution', () => {
  const maskedEntry = {
    id: 'row_1',
    command: 'curl -H "Authorization: Bearer sk-p...7890" https://api',
    cwd: '~',
    host: '',
    status: 'success',
    maskedCount: 1,
    maskedKinds: ['openai'],
    redactions: [{ kind: 'openai', start: 31, end: 42, prefix: 'sk-p', suffix: '7890' }],
    endedAt: 1_750_000_000_000,
    startedAt: 1_749_999_999_000,
    exitCode: 0,
    trusted: true,
  }

  function maskedClient(): ClientFake {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'history.query') {
        return Promise.resolve({
          entries: [maskedEntry],
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
        })
      }
      if (method === 'vault.status') {
        return Promise.resolve({ state: 'unsealed', osKeyCapable: true, defaultProvider: 'file' })
      }
      if (method === 'fs.complete') {
        return Promise.resolve({ candidates: [] })
      }
      if (method === 'history.query') {
        return Promise.resolve({
          entries: [
            {
              id: 'row_1',
              command: 'echo hello',
              cwd: '~',
              host: '',
              status: 'success',
              maskedCount: 0,
              maskedKinds: [],
              endedAt: 1_750_000_000_000,
            },
          ],
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
        })
      }
      if (method === 'vault.inventory') {
        return Promise.resolve({
          entries: [
            {
              id: 'row_1',
              name: 'openrouter.ai',
              kind: 'password',
              provider: 'file',
              ownerId: '',
              usedBy: 0,
              reachable: true,
            },
          ],
        })
      }
      if (method === 'vault.resolveLine') {
        return Promise.resolve({ line: 'resolved-line', refs: [] })
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    return client
  }

  it('renders the unresolved chip and refuses to submit: the draft survives and resolution opens', async () => {
    const client = maskedClient()
    const { view, ed, content, teardown } = await mountTerminal(client)
    try {
      content.setVisible(true)
      ed.show()
      // Open recall (Up at the empty prompt); the preview registers the
      // redaction spans as unresolved chips.
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      )
      await vi.waitFor(() => expect(ed.getDoc()).toBe(maskedEntry.command))
      const spans = view.state.field(unresolvedRedactionField)
      expect(spans).toEqual([{ from: 31, to: 42, kind: 'openai' }])

      const session = sessionOf(content)
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await flush()
      // Refused: nothing sent, the draft survives, the picker opened on
      // the first chip.
      expect(session.send).not.toHaveBeenCalled()
      expect(ed.getDoc()).toBe(maskedEntry.command)
      expect(ed.root.querySelector('.ui-floating-panel[data-variant="secret"]')).not.toBeNull()

      // Resolve: pick the live secret — the span is replaced by the
      // reference, the chip flips from unresolved to resolved.
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await flush()
      expect(ed.getDoc()).toBe(
        'curl -H "Authorization: Bearer {{secret:openrouter.ai}}" https://api',
      )
      expect(view.state.field(unresolvedRedactionField)).toEqual([])

      // Now Enter runs the command.
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await flush()
      expect(session.send).toHaveBeenCalled()
    } finally {
      teardown()
    }
  })
})

describe('one floating host, mutually exclusive modes', () => {
  function exclusiveClient(): ClientFake {
    const client = makeClient()
    client.call.mockImplementation((method: string) => {
      if (method === 'vault.status') {
        return Promise.resolve({ state: 'unsealed', osKeyCapable: true, defaultProvider: 'file' })
      }
      if (method === 'vault.inventory') {
        return Promise.resolve({
          entries: [
            {
              id: 'row_1',
              name: 'openrouter.ai',
              kind: 'password',
              provider: 'file',
              ownerId: '',
              usedBy: 0,
              reachable: true,
            },
          ],
        })
      }
      return Promise.reject(new Error('no wire handler (fake)'))
    })
    return client
  }

  const openPanels = (ed: CommandEditor): string[] =>
    [...ed.root.querySelectorAll<HTMLElement>('.ui-floating-panel[data-open="true"]')].map(
      (el) => el.dataset.variant ?? '',
    )

  it('opening recall closes the picker and the completion dropdown', async () => {
    const client = exclusiveClient()
    const { view, ed, content, teardown } = await mountTerminal(client)
    try {
      content.setVisible(true)
      ed.show()
      // '@' TYPED (the editor's onSecretPicker fires on the keydown, not
      // on a programmatic insert).
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: '@', bubbles: true, cancelable: true }),
      )
      await vi.waitFor(() => expect(openPanels(ed)).toContain('secret'))
      // Ctrl+R opens recall: the picker closes (never two at once).
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true, cancelable: true }),
      )
      await vi.waitFor(() => expect(openPanels(ed)).toContain('recall'))
      expect(openPanels(ed)).not.toContain('secret')
      expect(openPanels(ed)).not.toContain('completion')
    } finally {
      teardown()
    }
  })

  it('opening the picker closes the completion dropdown', async () => {
    const client = exclusiveClient()
    const { view, ed, content, teardown } = await mountTerminal(client)
    try {
      content.setVisible(true)
      ed.show()
      // A line to complete, then Tab opens the dropdown with the history
      // row.
      ed.insertText('echo ')
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
      await vi.waitFor(() => expect(openPanels(ed)).toContain('completion'))
      // '@' at a word start opens the picker and closes completion.
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: '@', bubbles: true, cancelable: true }),
      )
      await vi.waitFor(() => expect(openPanels(ed)).toContain('secret'))
      expect(openPanels(ed)).not.toContain('completion')
    } finally {
      teardown()
    }
  })
})
