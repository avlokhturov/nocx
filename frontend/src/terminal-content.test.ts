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
  type RendererMock,
} from './test-support/tabs-fixtures'
import { XtermRenderer } from './renderers/xterm'
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
/** Mount options. */
interface MountOpts {
  /** Append the tab's pane to document.body. The document-level keydown
   *  handler bails on a disconnected target, so tests that exercise it need
   *  the pane in the tree. Default false — the copy-on-select tests do not. */
  attachToDocument?: boolean
}

/** Mount a real TerminalContent inside a Tab and return the live editor view. */
async function mountTerminal(
  clipboard: ClipboardFake = makeClipboard(),
  opts: MountOpts = {},
): Promise<{
  view: EditorView
  ed: CommandEditor
  clipboard: ClipboardFake
  content: TerminalContent
  tab: Tab
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
  if (opts.attachToDocument) document.body.append(paneParent)
  await tab.start()
  await expect(content.ready).resolves.toBe(true)

  const ed = editorOf(content)
  return {
    view: viewOf(ed),
    ed,
    clipboard,
    content,
    tab,
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

describe('document-level keydown redirect with a block selected (W4)', () => {
  it('a printable key lands exactly one character and deselects the block', async () => {
    const { view, ed, content, tab, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const results = vi.mocked(XtermRenderer).mock.results
    const renderer = results[results.length - 1].value as RendererMock
    try {
      // jsdom does not implement Element.scrollTo (or, in some versions,
      // scrollIntoView); the controller uses both to pin the scrollback when
      // the layout changes. Real browsers have them — stub the missing DOM
      // APIs the way this suite stubs ResizeObserver, and restore after.
      // unbound-method is about calling a detached method with the wrong
      // `this`. These two are never called — they are saved so the prototype
      // can be put back in `finally`, which is the opposite concern.
      /* eslint-disable @typescript-eslint/unbound-method */
      const protoScrollTo = Element.prototype.scrollTo
      const protoScrollIntoView = Element.prototype.scrollIntoView
      /* eslint-enable @typescript-eslint/unbound-method */
      Element.prototype.scrollTo = () => {}
      Element.prototype.scrollIntoView = () => {}
      try {
        // No TabManager activated this tab, and the handler is gated on the
        // active flag: drive what setActive would have driven.
        content.setVisible(true)

        // A complete shell cycle through the renderer seam: A/B opens the
        // editor, C starts a block, D freezes it, A/B returns to a fresh prompt.
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

        // Select the block the way a user does: click it.
        const block = tab.pane.querySelector<HTMLElement>('.cmd-block')
        expect(block).not.toBeNull()
        block!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        block!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        expect(tab.pane.querySelector('.cmd-block-selected')).not.toBeNull()
        expect(ed.isVisible).toBe(true)

        // Type one printable character with focus on <body>.
        const ev = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
        document.body.dispatchEvent(ev)

        // Exactly one character in the document; the block is deselected.
        expect(view.state.doc.toString()).toBe('x')
        expect(ev.defaultPrevented).toBe(true)
        expect(tab.pane.querySelector('.cmd-block-selected')).toBeNull()
      } finally {
        Element.prototype.scrollTo = protoScrollTo
        Element.prototype.scrollIntoView = protoScrollIntoView
      }
    } finally {
      teardown()
    }
  })
})

describe('shell highlighting is actually wired (nocx-dgs)', () => {
  // Reachability, not tokenisation. shell-highlight.ts has its own tests for
  // what the tokens are; this one exists because a language layer that nothing
  // passes to the editor is a feature the product does not have. It fails if
  // the second constructor argument at the composition point is dropped.
  it('the editor the real mount builds colours shell syntax', async () => {
    const { view, ed, teardown } = await mountTerminal()
    try {
      ed.insertText('ls -la')
      const classes = [...view.contentDOM.querySelectorAll<HTMLElement>('[class^="tok-"]')].map(
        (span) => span.className,
      )
      expect(classes).toContain('tok-command')
      expect(classes).toContain('tok-flag')
    } finally {
      teardown()
    }
  })
})
