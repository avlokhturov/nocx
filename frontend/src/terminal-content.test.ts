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
// The stylesheet contract assertion below reads the app CSS from disk. The
// node builtins are untyped here (@types/node is not installed), so the
// imports sit behind @ts-expect-error and the calls behind a contained
// no-unsafe disable — the same trade theme-catalogue.test.ts makes at file
// level, confined to this setup instead.
/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                      @typescript-eslint/no-unsafe-call */
// @ts-expect-error — @types/node not installed; vitest resolves at runtime
import { readFileSync } from 'node:fs'
// @ts-expect-error — @types/node not installed; vitest resolves at runtime
import { resolve } from 'node:path'

declare global {
  interface ImportMeta {
    /** Present in the vitest/vite ESM runtime; the stylesheet read needs it. */
    dirname?: string
  }
}

const srcDir = import.meta.dirname ?? resolve(new URL('.', import.meta.url).pathname)
const STYLE_ENTRY = resolve(srcDir, 'style.css')
/* eslint-enable @typescript-eslint/no-unsafe-assignment,
                       @typescript-eslint/no-unsafe-call */
import { EditorView } from '@codemirror/view'
import {
  createRendererMock,
  makeClient,
  makeClipboard,
  makeBanner,
  makeSession,
  type ClipboardFake,
  type RendererMock,
  type SessionFake,
  type ClientFake,
} from './test-support/tabs-fixtures'
import { XtermRenderer } from './renderers/xterm'
import { ClipboardGate } from './clipboard'
import { CommandEditor } from './editor'
import { Tab } from './tabs'
import { TerminalContent } from './terminal-content'
import { SURFACE_TERMINAL } from './tab-content'
import type { WSClient } from './ipc'
import { createCommandBlock } from './scrollback/blocks'
import { CommandSnapshotStore } from './command-snapshot'
import type { ScrollbackController } from './scrollback/controller'
import { pushOverlay, popOverlay } from './ui/overlay/stack'

// Mock the XtermRenderer class before any imports use it (same as tabs.test.ts).
vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

// The refusal path calls showToast, which mounts a Solid root; the
// export-section tests mock the module the same way.
vi.mock('./ui/toast', () => ({
  showToast: vi.fn(),
}))

/**
 * TerminalContent keeps the editor private; tests need the live instance the
 * mount created (same escape hatch editor.test.ts uses for the CM6 view).
 */
const editorOf = (content: TerminalContent): CommandEditor => {
  const withEditor = content as unknown as { editor: CommandEditor }
  return withEditor.editor
}

/** TerminalContent also keeps the renderer private; tests reach the live
 *  mock through the same escape hatch editorOf uses (the field is typed
 *  TerminalRenderer in the class, structurally the mock). */
const rendererOf = (content: TerminalContent): RendererMock => {
  const withRenderer = content as unknown as { renderer: RendererMock }
  return withRenderer.renderer
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
  client?: ClientFake,
): Promise<{
  view: EditorView
  ed: CommandEditor
  clipboard: ClipboardFake
  content: TerminalContent
  tab: Tab
  teardown: () => void
}> {
  const clientFake = client ?? makeClient()
  // ClientFake is structurally a WSClient; the tab layer expects the real type.
  const wsClient = clientFake as unknown as WSClient
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

describe('the editor never copies on selection (nocx-w7h.17)', () => {
  // Copy-on-select is the terminal's convention and belongs to text you can
  // only read. In the editor the same gesture means the opposite — you select
  // in order to replace — so copying there overwrote the clipboard with the
  // very text about to be deleted: the owner selected part of a header to
  // paste a key over it, and the key was gone.
  it('a completed selection gesture in the editor writes nothing to the clipboard', async () => {
    const { view, ed, clipboard, teardown } = await mountTerminal()
    try {
      ed.insertText('echo hello world')
      view.dispatch({ selection: { anchor: 5, head: 10 } }) // "hello"
      mouseupOn(view)
      expect(clipboard.writeText).not.toHaveBeenCalled()
    } finally {
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

describe('Escape with the editor visible but unfocused (focus-loss rescue)', () => {
  /** Dispatch Escape where a user's keystroke lands after clicking away —
   *  on the body, not on the editor surface. */
  const escapeOnBody = (): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev)
    return ev
  }

  it('Escape clears the draft after a click outside the editor took the focus', async () => {
    const { view, ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)
      ed.show()
      ed.insertText('ls -la')
      expect(ed.isVisible).toBe(true)

      // A click on the scrollback moves the focus off the editor surface.
      view.contentDOM.blur()
      expect(document.activeElement).not.toBe(view.contentDOM)

      const ev = escapeOnBody()
      expect(ev.defaultPrevented).toBe(true)
      expect(ed.getDoc()).toBe('')
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('Escape dismisses an open recall overlay and restores the captured draft, not clears it', async () => {
    const { view, ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    // TerminalContent keeps the session private; tests reach the live fake
    // through the same escape hatch editorOf uses.
    const withSession = content as unknown as { session: SessionFake }
    const session = withSession.session
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)
      // A real submitted command populates the history ledger.
      ed.show()
      ed.insertText('make deploy')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      expect(session.send.mock.calls.length).toBe(1)

      // A non-empty draft opens recall on Up-at-top; the overlay previews
      // the newest row into the editor.
      ed.show()
      ed.insertText('echo kept')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      )
      expect(ed.root.querySelector('.ui-floating-panel[data-variant="recall"]')).not.toBeNull()
      // The recall query crosses the control plane (nocx-rtg0.13); the
      // preview lands when the answer does.
      await vi.waitFor(() => expect(ed.getDoc()).toBe('make deploy')) // previewing the only row

      // The user clicked the scrollback while the overlay was up.
      view.contentDOM.blur()
      const ev = escapeOnBody()
      expect(ev.defaultPrevented).toBe(true)
      // The overlay dismissed and restored the captured draft — a clear
      // path would have emptied the doc and left the panel open. The panel
      // node stays mounted after close (its `dataset.open` is the
      // visibility contract, not its presence in the DOM).
      const panel = ed.root.querySelector<HTMLElement>('.ui-floating-panel[data-variant="recall"]')
      expect(panel?.dataset.open).toBe('false')
      expect(ed.getDoc()).toBe('echo kept')
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it("Escape in somebody else's text control leaves the draft alone", async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const input = document.createElement('input')
    document.body.append(input)
    try {
      content.setVisible(true)
      ed.show()
      ed.insertText('ls -la')
      input.focus()
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      input.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
      expect(ed.getDoc()).toBe('ls -la')
    } finally {
      input.remove()
      teardown()
    }
  })

  it('Escape with a modal overlay open leaves the draft alone', async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    let closed = false
    const entry = pushOverlay(() => {
      closed = true
      return true
    })
    try {
      content.setVisible(true)
      ed.show()
      ed.insertText('ls -la')
      const ev = escapeOnBody()
      // The overlay stack owns Escape while a modal is up: its own handler
      // closes the overlay (and preventDefaults); the terminal rescue
      // stands down and the draft survives.
      expect(closed).toBe(true)
      expect(ev.defaultPrevented).toBe(true)
      expect(ed.getDoc()).toBe('ls -la')
    } finally {
      popOverlay(entry)
      teardown()
    }
  })

  it('Escape with the block action menu open closes the menu, not the draft', async () => {
    const { view, ed, content, tab, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const results = vi.mocked(XtermRenderer).mock.results
    const renderer = results[results.length - 1].value as RendererMock
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)
      // A completed shell cycle paints a frozen block with its ⋮ button.
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

      ed.insertText('ls -la')
      const overflowBtn = tab.pane.querySelector<HTMLElement>('.cmd-overflow-btn')
      expect(overflowBtn).not.toBeNull()
      overflowBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(document.querySelector('.cmd-overflow-menu')).not.toBeNull()

      // The pane's focus bounce returned focus to the editor on the click;
      // a click on the scrollback then moves it to <body>, menu still open.
      view.contentDOM.blur()
      expect(document.activeElement).not.toBe(view.contentDOM)
      const ev = escapeOnBody()
      // The menu's own document listener closes it; the rescue stood down
      // and the draft survives.
      expect(document.querySelector('.cmd-overflow-menu')).toBeNull()
      expect(ev.defaultPrevented).toBe(false)
      expect(ed.getDoc()).toBe('ls -la')
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('Escape clears the draft when focus is parked in the live grid', async () => {
    const { ed, content, tab, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    let gridInput: HTMLTextAreaElement | null = null
    try {
      content.setVisible(true)
      ed.show()
      const live = tab.pane.querySelector<HTMLElement>('.xterm-live-container')
      expect(live).not.toBeNull()
      // xterm's real hidden input lives inside the live container; while
      // the editor is up the grid is read-only dead space, so focus parked
      // there must be rescued like a click on the scrollback.
      gridInput = document.createElement('textarea')
      live!.appendChild(gridInput)
      ed.insertText('ls -la')
      gridInput.focus()
      expect(document.activeElement).toBe(gridInput)

      const ev = escapeOnBody()
      expect(ev.defaultPrevented).toBe(true)
      expect(ed.getDoc()).toBe('')
    } finally {
      gridInput?.remove()
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

describe('recall overlay is actually wired (nocx-w7h.4)', () => {
  /** Dispatch a keydown exactly where a user's keystroke lands. */
  const key = (view: EditorView, init: KeyboardEventInit): void => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    )
  }

  // Reachability + the acceptance that the v4 rule inverted (nocx-w7h.5):
  // navigating previews the command INTO the editor, and Enter executes what
  // you can see through the NORMAL submit path — the same one a typed Enter
  // takes — with nothing bypassed. The command text reaches the PTY via the
  // renderer's paste handoff and the trailing '\r' via the session, so both
  // are asserted: a second, parallel route would look different.
  it('Enter in the recall overlay executes the previewed command through the normal submit path', async () => {
    const { view, ed, content, teardown } = await mountTerminal(makeClipboard())
    const session = (content as unknown as { session: SessionFake }).session
    const renderer = rendererOf(content)
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)
      // A real command through the real submit path populates the ledger.
      ed.show()
      ed.insertText('make deploy')
      key(view, { key: 'Enter' }) // the one legitimate send
      expect(session.send.mock.calls.length).toBe(1)
      const sentBefore = session.send.mock.calls.length
      // The send payload is a string; String() gives the linter a typed value
      // without assuming the exact wire bytes (the '\r' the shell target
      // appends today could legitimately change).
      const sentShape = String(session.send.mock.calls[sentBefore - 1][0])

      // The submit cleared the editor; Up at the empty prompt opens recall.
      key(view, { key: 'ArrowUp' })
      expect(ed.root.querySelector('.ui-floating-panel[data-variant="recall"]')).not.toBeNull()
      // The recall query crosses the control plane (nocx-rtg0.13); the
      // preview lands when the answer does.
      await vi.waitFor(() => expect(ed.getDoc()).toBe('make deploy')) // previewing the only row

      key(view, { key: 'Enter' }) // accept — executes the previewed command
      // One more send, and it is the SAME wire shape as the typed submit:
      // the command went through the renderer paste handoff, '\r' through the
      // session. No second route exists to assert against.
      expect(session.send.mock.calls.length).toBe(sentBefore + 1)
      expect(session.send).toHaveBeenLastCalledWith(sentShape)
      // `paste` is a method declaration on TerminalRenderer, so referencing it
      // detached trips unbound-method; the mock property type does not.
      const pasteMock = renderer as unknown as { paste: ReturnType<typeof vi.fn> }
      expect(pasteMock.paste).toHaveBeenLastCalledWith('make deploy')
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })
})

describe('paste with focus on a frozen block (nocx-w7h.9)', () => {
  it('Cmd/Ctrl+V redirects to the editor, deselects the block, and never reaches the session', async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const session = (content as unknown as { session: SessionFake }).session
    const scrollback = (content as unknown as { scrollback: ScrollbackController }).scrollback
    try {
      content.setVisible(true)
      ed.show()
      // A real frozen block, appended to the real scrollback DOM. The
      // onSelect wires the same way BlockManager.freezeBlock wires it — into
      // the manager's selection state, so deselectBlocks() knows about it.
      const manager = scrollback.blockManager as unknown as {
        _onBlockSelected(id: number): void
        _onBlockDeselected(id: number): void
      }
      const block = createCommandBlock(
        1,
        'ls',
        '~',
        '',
        '<span class="term-line">out</span>',
        10,
        0,
        'success',
        () => scrollback.scrollbackInner,
        (bid, sel) => {
          if (sel) manager._onBlockSelected(bid)
          else manager._onBlockDeselected(bid)
        },
        new CommandSnapshotStore(),
      )
      scrollback.scrollbackInner.appendChild(block)
      // Click the block (mousedown + mouseup without movement) → selected.
      block.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      block.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      expect(block.classList.contains('cmd-block-selected')).toBe(true)

      const sentBefore = session.send.mock.calls.length
      // Cmd/Ctrl+V lands on the block, bubbles to the document-level rescue.
      const ev = new KeyboardEvent('keydown', {
        key: 'v',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      block.dispatchEvent(ev)
      // The editor owns the paste now: focus moved, block deselected, and
      // nothing was sent to the session (jsdom cannot run the native paste;
      // the inserted text is verified in a real browser).
      expect(document.activeElement !== null && ed.root.contains(document.activeElement)).toBe(true)
      expect(block.classList.contains('cmd-block-selected')).toBe(false)
      expect(session.send.mock.calls.length).toBe(sentBefore)
      expect(ev.defaultPrevented).toBe(false) // native paste still runs
    } finally {
      teardown()
    }
  })
})

describe('vault references in the prompt (ADR-0021, the renderer half)', () => {
  it('an unresolved reference is NOT sent: the draft stays and the editor stays up', async () => {
    // The real submit seam: Enter -> beforeSubmit -> planSubmit ->
    // vault.resolveLine -> the editor keeps the draft on a refusal.
    const client = makeClient()
    const callMock = client.call
    callMock.mockImplementation((method: string, params: unknown) => {
      if (method === 'vault.resolveLine') {
        const req = params as { line?: string }
        const line = typeof req?.line === 'string' ? req.line : ''
        return Promise.resolve({ line, refs: [{ name: 'nope', resolved: false }] })
      }
      return Promise.reject(new Error('no store wired (fake)'))
    })
    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const withSession = content as unknown as { session: SessionFake }
    try {
      content.setVisible(true)
      ed.show()
      ed.insertText('curl {{secret:nope}} https://api')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      // The verdict is async (references resolve over the wire): drain the
      // chain, then assert the refusal.
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(withSession.session.send).not.toHaveBeenCalled()
      // The draft is intact and the editor is still up — nothing was lost.
      expect(ed.getDoc()).toBe('curl {{secret:nope}} https://api')
      expect(ed.isVisible).toBe(true)
    } finally {
      teardown()
    }
  })
})

describe('the live prompt says where Enter will land (nocx-3779)', () => {
  /**
   * Mount a real TerminalContent over an SSH session (alias path: no saved
   * profile, host+user resolved through ~/.ssh/config), the same mount a
   * real SSH tab takes. The chip assertions below must pass through this
   * seam — a pure editor test could not catch a second derivation of the
   * host string.
   */
  async function mountSshTerminal(): Promise<{
    ed: CommandEditor
    content: TerminalContent
    tab: Tab
    teardown: () => void
  }> {
    const clientFake = makeClient({
      openSSHSessionByHost: vi.fn(() => Promise.resolve(makeSession())),
    } as unknown as Partial<ClientFake>)
    const wsClient = clientFake as unknown as WSClient
    const content = new TerminalContent(
      wsClient,
      makeClipboard(),
      new ClipboardGate(),
      makeBanner(),
      null,
      () => {},
      { profileId: '', host: '192.168.0.57', user: 'root' },
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
    document.body.append(paneParent)
    await tab.start()
    await expect(content.ready).resolves.toBe(true)
    return {
      ed: editorOf(content),
      content,
      tab,
      teardown: () => {
        tab.close()
        paneParent.remove()
      },
    }
  }

  /** jsdom lacks scrollTo/scrollIntoView; the scrollback controller calls
   *  both when blocks are created and the layout changes. */
  function stubScroll(): () => void {
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

  it('an SSH prompt shows the same location chip the block header shows', async () => {
    const { ed, content, tab, teardown } = await mountSshTerminal()
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      const renderer = rendererOf(content)
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
      expect(ed.isVisible).toBe(true)
      const chip = tab.pane.querySelector<HTMLElement>('.nocx-editor-location')
      expect(chip).not.toBeNull()
      expect(chip!.style.display).not.toBe('none')
      expect(chip!.textContent).toBe('root@192.168.0.57')

      // Run a command to completion: the frozen block header must carry the
      // SAME string — one derivation, routed to both chips.
      marker('C')
      marker('D', 0, 0)
      const headerLoc = tab.pane.querySelector<HTMLElement>('.cmd-header-location')
      expect(headerLoc?.textContent).toBe('root@192.168.0.57')
      expect(chip!.textContent).toBe(headerLoc!.textContent)

      // And the next prompt still shows it.
      marker('A')
      marker('B')
      expect(ed.isVisible).toBe(true)
      expect(chip!.textContent).toBe('root@192.168.0.57')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('a local session grows no location chip, in the prompt or the block header', async () => {
    const { ed, content, tab, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      const renderer = rendererOf(content)
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
      expect(ed.isVisible).toBe(true)
      const chip = tab.pane.querySelector<HTMLElement>('.nocx-editor-location')
      expect(chip).not.toBeNull()
      expect(chip!.style.display).toBe('none')
      expect(chip!.textContent).toBe('')

      marker('C')
      marker('D', 0, 0)
      expect(tab.pane.querySelector('.cmd-header-location')).toBeNull()
    } finally {
      restoreScroll()
      teardown()
    }
  })
})

describe('in-band integration (nocx-ynsx)', () => {
  // The plan shape the backend serves; the assertions only ever compare
  // against this fixture, never against a field the test invented.
  const plan = {
    wrapper:
      'saved=$(stty -g); NOCX_IB_SRC=$(mktemp) && stty raw -echo && printf "\\033]1337;NOCX_IB_READY\\a" && sed -n "/^NOCX_IB_EOF$/q;p" > "$NOCX_IB_SRC"; stty "$saved"',
    payload: '# nocx in-band integration — dispatcher\n# nocx-ib-complete\n',
    terminator: 'NOCX_IB_EOF',
  }

  const clientWithPlan = (): ClientFake => makeClient({ call: vi.fn().mockResolvedValue(plan) })

  /** Drive the machine to a trusted owned prompt the way markers do. */
  const trustedPrompt = (renderer: RendererMock): void => {
    renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
    renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
  }

  const sessionSend = (content: TerminalContent): ReturnType<typeof vi.fn> => {
    const withSession = content as unknown as { session: SessionFake }
    return withSession.session.send
  }

  it('refuses outside a trusted prompt and types nothing', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPlan())
    try {
      content.setVisible(true)
      const send = sessionSend(content)
      // Fresh mount: RAW, untrusted, unowned.
      content.integrateShell()
      expect(send).not.toHaveBeenCalled()
    } finally {
      teardown()
    }
  })

  it('a trusted but unowned prompt is refused too', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPlan())
    try {
      content.setVisible(true)
      const renderer = rendererOf(content)
      // A alone: PROMPT_READY, trusted, but NOT owned (ADR-0006 §4).
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      const send = sessionSend(content)
      content.integrateShell()
      expect(send).not.toHaveBeenCalled()
    } finally {
      teardown()
    }
  })

  it('streams the payload only after READY and restores the draft byte-for-byte', async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPlan())
    try {
      content.setVisible(true)
      const renderer = rendererOf(content)
      trustedPrompt(renderer)
      ed.insertText('echo half-typed')
      const draft = ed.getDoc()

      content.integrateShell()
      const send = sessionSend(content)
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(plan.wrapper + '\r'))
      // The lease hides the editor while the wrapper runs.
      expect(ed.isVisible).toBe(false)

      // No user byte interleaves: a printable key at document level is
      // swallowed at capture phase, never sent to the pty.
      const key = new KeyboardEvent('keydown', { key: 'x', cancelable: true, bubbles: true })
      document.dispatchEvent(key)
      expect(key.defaultPrevented).toBe(true)
      expect(send.mock.calls.every((call) => call[0] !== 'x')).toBe(true)

      // READY proves raw -echo is on: only now does the payload flow.
      renderer._fireInBandReady()
      expect(send).toHaveBeenCalledWith(plan.payload + plan.terminator + '\n')

      // The next A completes the attempt; B re-shows the editor with the
      // byte-for-byte draft.
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      await vi.waitFor(() => expect(ed.isVisible).toBe(true))
      expect(ed.getDoc()).toBe(draft)
    } finally {
      teardown()
    }
  })

  it('Esc cancels via the terminator and restores the draft', async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPlan())
    try {
      content.setVisible(true)
      const renderer = rendererOf(content)
      trustedPrompt(renderer)
      ed.insertText('echo keep me')
      const draft = ed.getDoc()

      content.integrateShell()
      const send = sessionSend(content)
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(plan.wrapper + '\r'))
      renderer._fireInBandReady()
      expect(send).toHaveBeenCalledWith(plan.payload + plan.terminator + '\n')

      // Esc sends the terminator alone — the pty-test cancel shape — and
      // the shell's own `stty "$saved"` restore runs on the other end.
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }),
      )
      expect(send).toHaveBeenCalledWith('\n' + plan.terminator + '\n')
      // No marker followed, so the machine still declares ownership: the
      // editor comes straight back with the byte-for-byte draft.
      await vi.waitFor(() => expect(ed.isVisible).toBe(true))
      expect(ed.getDoc()).toBe(draft)
    } finally {
      teardown()
    }
  })

  it('a failed plan fetch releases the lease and types nothing', async () => {
    const client = makeClient({ call: vi.fn().mockRejectedValue(new Error('backend down')) })
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      content.setVisible(true)
      trustedPrompt(rendererOf(content))
      ed.insertText('echo safe')
      const draft = ed.getDoc()

      content.integrateShell()
      const send = sessionSend(content)
      await vi.waitFor(() => expect(ed.isVisible).toBe(true))
      expect(send).not.toHaveBeenCalled()
      expect(ed.getDoc()).toBe(draft)
    } finally {
      teardown()
    }
  })
})

/**
 * Extract the body of the first top-level rule whose selector contains
 * `className` as a whole class. Brace-matched, so nested blocks (media
 * queries) cannot truncate the body. Returns null when no rule matches.
 */
function extractRuleBlock(css: string, className: string): string | null {
  const re = new RegExp(`\\.${className}(?![\\w-])`)
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) return null
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    if (depth !== 0) return null
    if (re.test(css.slice(i, open))) return css.slice(open + 1, j - 1)
    i = j
  }
  return null
}

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '')

// The SSH block header regression (nocx-a44m): the cwd chip used to park in
// the dead centre of the header because `.cmd-header-chips` separated its
// children with `justify-content: space-between` — right for two children
// (a local block is [cwd, right]) and wrong for three (an SSH block adds the
// location chip, and three children space evenly). Fixed in 30014e3 by
// pushing the right group out with its own `margin-left: auto`, which behaves
// identically for any child count. jsdom computes no layout, so these
// assertions pin what jsdom CAN see: the DOM order that expresses the intent
// ("cwd left, duration and exit right"), and the stylesheet's structural
// contract that turns that order into position without assuming a count.
describe('the SSH block header keeps cwd left and duration/exit right (nocx-a44m)', () => {
  const container = (): HTMLElement => document.createElement('div')
  const store = (): CommandSnapshotStore => new CommandSnapshotStore()
  const noop = (): void => {}

  it('orders an SSH block header location, cwd, then the right group', () => {
    const el = createCommandBlock(
      1,
      'deploy',
      '/srv/www',
      'user@server', // location — the chip that made the header three children
      '<span class="term-line">done</span>',
      1200,
      0,
      'success',
      container,
      noop,
      store(),
    )
    const chips = el.querySelector('.cmd-header-chips')
    expect(chips).not.toBeNull()
    const loc = chips?.querySelector('.cmd-header-location')
    const cwd = chips?.querySelector('.cmd-header-cwd')
    const right = chips?.querySelector('.cmd-header-right')
    expect(loc).not.toBeNull()
    expect(cwd).not.toBeNull()
    expect(right).not.toBeNull()

    const order = [...(chips as HTMLElement).children]
    expect(order.indexOf(loc as HTMLElement)).toBeLessThan(order.indexOf(cwd as HTMLElement))
    expect(order.indexOf(cwd as HTMLElement)).toBeLessThan(order.indexOf(right as HTMLElement))

    // The right group holds what belongs on the right: duration and exit.
    expect(right?.querySelector('.cmd-header-duration')).not.toBeNull()
    expect(right?.querySelector('.cmd-header-exit-ok')).not.toBeNull()
  })

  it('keeps cwd before the right group on a local block too', () => {
    const el = createCommandBlock(
      1,
      'ls',
      '~',
      '',
      '<span class="term-line">file</span>',
      42,
      0,
      'success',
      container,
      noop,
      store(),
    )
    const chips = el.querySelector('.cmd-header-chips')
    const cwd = chips?.querySelector('.cmd-header-cwd')
    const right = chips?.querySelector('.cmd-header-right')
    expect(cwd).not.toBeNull()
    expect(right).not.toBeNull()
    const order = [...(chips as HTMLElement).children]
    expect(order.indexOf(cwd as HTMLElement)).toBeLessThan(order.indexOf(right as HTMLElement))
  })

  it('the stylesheet pushes the right group with its own auto margin, not space-between', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const css: string = readFileSync(STYLE_ENTRY, 'utf8')
    const chips = stripComments(extractRuleBlock(css, 'cmd-header-chips') ?? '')
    const right = stripComments(extractRuleBlock(css, 'cmd-header-right') ?? '')
    expect(chips).not.toBe('')
    expect(right).not.toBe('')

    // space-between assumes exactly two children; the location chip made the
    // SSH header three. The container must not distribute, and the right
    // group must carry its own auto margin — the mechanism that behaves
    // identically for any child count (nocx-a44m).
    expect(chips).not.toMatch(/justify-content\s*:\s*(space-between|space-around|space-evenly)/)
    expect(right).toMatch(/margin-left\s*:\s*auto/)
  })
})

// The command editor's chrome row has the same latent class as the SSH
// header above: `justify-content: space-between` is only correct for exactly
// two children (left group + clock), and the row must not break if a third
// joins it. Same fix, same contract assertion: the row does not distribute,
// and the clock — the right-edge element — carries its own auto margin
// (nocx-a44m).
describe('the command editor chrome pins the clock to the right edge without distributing (nocx-a44m)', () => {
  it('the stylesheet gives the clock its own auto margin, not space-between on the row', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const css: string = readFileSync(STYLE_ENTRY, 'utf8')
    const chrome = stripComments(extractRuleBlock(css, 'nocx-editor-chrome') ?? '')
    const time = stripComments(extractRuleBlock(css, 'nocx-editor-time') ?? '')
    expect(chrome).not.toBe('')
    expect(time).not.toBe('')

    expect(chrome).not.toMatch(/justify-content\s*:\s*(space-between|space-around|space-evenly)/)
    expect(time).toMatch(/margin-left\s*:\s*auto/)
  })
})
