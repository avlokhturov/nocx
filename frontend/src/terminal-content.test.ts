// @vitest-environment jsdom
//
// W3 policy-wiring tests: the editor's `onSelectionEnd` seam (ADR-0010
// §Decision 2) delivers the selected text, and TerminalContent decides
// whether to copy it. This file is the regression guard for the deleted
// textarea shim: under the shim, `selectionStart`/`selectionEnd`/`value`
// read off a contenteditable are all `undefined`, so `start === end` was
// `undefined === undefined` — the early return fired and copy-on-select was
// silently dead. The mount below exercises the REAL chain (editor mouseup →
// seam → terminal-content policy → clipboard), so that bug fails here.
//
// The mount follows tabs.test.ts's pattern: the xterm renderer is mocked
// (jsdom cannot run xterm.js), the WS client fake resolves a session, and
// `tab.start()` drives TerminalContent through the same mount() a real tab
// takes. The editor is reached through the same private-field escape hatch
// editor.test.ts uses, and the selection is seeded through the CM6 view —
// the same transaction a mouse drag produces.
import { describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import {
  createRendererMock,
  makeClient,
  makeClipboard,
  makeBanner,
  type ClipboardFake,
} from './test-support/tabs-fixtures'
import { ClipboardGate } from './clipboard'
import { CommandEditor } from './editor'
import { Tab } from './tabs'
import { TerminalContent } from './terminal-content'
import { SURFACE_TERMINAL } from './tab-content'
import type { WSClient } from './ipc'

// Mock the XtermRenderer class before any imports use it (same as tabs.test.ts).
vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

/**
 * TerminalContent keeps the editor private; tests need the live instance the
 * mount created (same escape hatch editor.test.ts uses for the CM6 view).
 */
const editorOf = (content: TerminalContent): CommandEditor => {
  const withEditor = content as unknown as { editor: CommandEditor }
  return withEditor.editor
}

/** The editor's internal CM6 view — reached only to seed selections. */
const viewOf = (ed: CommandEditor): EditorView => {
  const withView = ed as unknown as { view: EditorView }
  return withView.view
}

/** Mount a real TerminalContent inside a Tab and return the live editor view. */
async function mountTerminal(clipboard: ClipboardFake = makeClipboard()): Promise<{
  view: EditorView
  ed: CommandEditor
  clipboard: ClipboardFake
  teardown: () => void
}> {
  const client = makeClient()
  // ClientFake is structurally a WSClient; the tab layer expects the real type.
  const wsClient = client as unknown as WSClient
  const content = new TerminalContent(
    wsClient,
    clipboard,
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
  await tab.start()
  await expect(content.ready).resolves.toBe(true)

  const ed = editorOf(content)
  return {
    view: viewOf(ed),
    ed,
    clipboard,
    teardown: () => {
      tab.close()
      paneParent.remove()
    },
  }
}

/** Complete a mouse selection gesture over the editor surface. */
const mouseupOn = (view: EditorView): void => {
  view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

describe('editor copy-on-select wiring (W3)', () => {
  it('a completed selection gesture copies exactly the selected text', async () => {
    const { view, ed, clipboard, teardown } = await mountTerminal()
    try {
      ed.insertText('echo hello world')
      view.dispatch({ selection: { anchor: 5, head: 10 } }) // "hello"
      mouseupOn(view)
      expect(clipboard.writeText).toHaveBeenCalledWith('hello')
      expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    } finally {
      teardown()
    }
  })

  it('a whitespace-only selection is not copied (shouldCopy policy)', async () => {
    const { view, ed, clipboard, teardown } = await mountTerminal()
    try {
      ed.insertText('   ')
      view.dispatch({ selection: { anchor: 0, head: 3 } })
      mouseupOn(view)
      expect(clipboard.writeText).not.toHaveBeenCalled()
    } finally {
      teardown()
    }
  })

  it('a rejected clipboard write is caught, not thrown', async () => {
    const clipboard = makeClipboard({
      writeText: vi.fn().mockRejectedValue(new Error('denied')),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { view, ed, teardown } = await mountTerminal(clipboard)
    try {
      ed.insertText('echo hello world')
      view.dispatch({ selection: { anchor: 5, head: 10 } })
      expect(() => mouseupOn(view)).not.toThrow()
      await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('hello'))
      await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    } finally {
      warn.mockRestore()
      teardown()
    }
  })
})
