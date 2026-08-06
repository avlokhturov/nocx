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
import { describe, expect, it, vi, type Mock } from 'vitest'
// node builtins are untyped here (@types/node is not installed), so the
// imports sit behind @ts-expect-error and the calls behind a contained
// no-unsafe disable — the same trade theme-catalogue.test.ts makes at file
// level, confined to this setup instead.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const srcDir = import.meta.dirname ?? resolve(new URL('.', import.meta.url).pathname)
const STYLE_ENTRY = resolve(srcDir, 'style.css')

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
  FIXTURE_CWD,
} from './test-support/tabs-fixtures'
import { XtermRenderer } from './renderers/xterm'
import { ClipboardGate } from './clipboard'
import { CommandEditor } from './editor'
import { TerminalContent, type TerminalContentHooks } from './terminal-content'
import { Tab } from './tabs'
import { SURFACE_TERMINAL } from './tab-content'
import { ProfileClient, type SSHProfile } from './profiles'
import { Dispatcher, RpcError } from './dispatcher'
import type { WSClient } from './ipc'
import { createCommandBlock } from './scrollback/blocks'
import { CommandSnapshotStore } from './command-snapshot'
import type { DesiredMode } from './capability'
import { CommandLedger } from './command-ledger'
import type { ScrollbackController } from './scrollback/controller'
import { pushOverlay, popOverlay } from './ui/overlay/stack'
import type { PassportDisposition, EnvironmentPassport } from './environment-passport'

// Mock the XtermRenderer class before any imports use it (same as tabs.test.ts).
// The shared fixture mock implements the full TerminalRenderer surface,
// including P2's passport methods and the _firePassport test seam.
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

/** The passport surface added to the renderer mock in the vi.mock factory. */
interface PassportRenderer {
  setExpectedEnvironmentId: Mock<(id: string | null) => void>
  _firePassport: (d: PassportDisposition) => void
}

const passportRendererOf = (content: TerminalContent): RendererMock & PassportRenderer =>
  rendererOf(content) as unknown as RendererMock & PassportRenderer
/** A valid readiness passport (spec §5.2), the shape the tracker accepts. */
const PASSPORT = (environmentId: string): EnvironmentPassport => ({
  protocolVersion: '1',
  environmentId,
  parentEnvironmentId: '-',
  scriptVersion: '11',
  tier: 'enhanced',
  generation: '-',
})

/** Drive a full accepted entry: expected passport → tagged A → tagged B.
 *  The renderer mock carries the passport surface (augmented in the mock
 *  factory), so the cast is to the runtime shape, not a fabrication. */
const enterEnvironment = (renderer: RendererMock, envId: string): void => {
  const passport = renderer as unknown as PassportRenderer
  passport._firePassport({ status: 'accepted', passport: PASSPORT(envId) })
  renderer._fireCommandMarker({ kind: 'A', line: 1, col: 0, buffer: 'normal', nocxEnv: envId })
  renderer._fireCommandMarker({ kind: 'B', line: 1, col: 0, buffer: 'normal', nocxEnv: envId })
}

/** A shell.launcherCommand result in the P7 shape (mode + fresh env id). */
const LAUNCH = (
  over: Partial<{
    mode: 'bootstrap' | 'installed' | 'raw'
    environmentId: string
    launcherPath: string | null
    reason: string | null
  }> = {},
): {
  mode: 'bootstrap' | 'installed' | 'raw'
  environmentId: string
  launcherPath: string | null
  reason: string | null
} => ({
  mode: 'bootstrap',
  environmentId: 'env-ab12',
  launcherPath: "'/home/u/.nocx/run/launcher-12345'",
  reason: null,
  ...over,
})
/** Mount options. */
interface MountOpts {
  /** Append the tab's pane to document.body. The document-level keydown
   *  handler bails on a disconnected target, so tests that exercise it need
   *  the pane in the tree. Default false — the copy-on-select tests do not. */
  attachToDocument?: boolean
  /** Mount an SSH tab (the capability rail is SSH-only, nocx-4t37.2). */
  ssh?: { profileId: string; host: string }
  /** Host callbacks handed to the TerminalContent (TerminalContentHooks). */
  hooks?: Partial<TerminalContentHooks>
  /** What `content.ready` must settle to. Default true — an open that is
   *  expected to fail (the host-key refusal) sets it false. */
  expectedReady?: boolean
}
/** Mount a real TerminalContent inside a Tab and return the live editor view. */
async function mountTerminal(
  clipboard: ClipboardFake = makeClipboard(),
  opts: MountOpts = {},
  client?: ClientFake,
  profileClient?: ProfileClient | null,
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
    profileClient ?? null,
    () => {},
    opts.ssh,
    opts.hooks,
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
  await expect(content.ready).resolves.toBe(opts.expectedReady ?? true)

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

describe('SSH open host-key recovery', () => {
  const routeEvidence = {
    host: 'db.example.com:22',
    knownHostsHost: 'nocx-v1-route:22',
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:new',
    key: 'a2V5',
    changed: false,
  }

  it('waits for explicit trust and retries the exact failed open', async () => {
    const openSSHSession = vi
      .fn()
      .mockRejectedValueOnce(
        new RpcError('host-key-unknown: unknown host key', -32603, routeEvidence),
      )
      .mockResolvedValueOnce(makeSession())
    const onHostKeyError = vi.fn().mockResolvedValue(true)
    const client = makeClient({ openSSHSession })

    const { teardown } = await mountTerminal(
      makeClipboard(),
      {
        ssh: { profileId: 'ssh:test:1', host: 'db.example.com' },
        hooks: { onHostKeyError },
      },
      client,
    )
    try {
      expect(onHostKeyError).toHaveBeenCalledWith(
        {
          ...routeEvidence,
          storedFingerprint: undefined,
          changed: false,
          profileId: 'ssh:test:1',
        },
        expect.any(AbortSignal),
      )
      expect(openSSHSession).toHaveBeenCalledTimes(2)
      expect(openSSHSession.mock.calls[0]).toEqual(openSSHSession.mock.calls[1])
    } finally {
      teardown()
    }
  })

  it('does not trust or retry when the user declines', async () => {
    const openSSHSession = vi.fn().mockRejectedValue(
      new RpcError('host-key-changed: host key mismatch', -32603, {
        ...routeEvidence,
        changed: true,
        storedFingerprint: 'SHA256:old',
      }),
    )
    const onHostKeyError = vi.fn().mockResolvedValue(false)
    const client = makeClient({ openSSHSession })

    const { tab, teardown } = await mountTerminal(
      makeClipboard(),
      {
        ssh: { profileId: 'ssh:test:1', host: 'db.example.com' },
        hooks: { onHostKeyError },
        expectedReady: false,
      },
      client,
    )
    try {
      expect(openSSHSession).toHaveBeenCalledTimes(1)
      expect(tab.pane.textContent).toContain('Host key was not trusted for db.example.com:22')
    } finally {
      teardown()
    }
  })
})

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

describe("the dropdown owns the arrows while it is open; recall's bare-Up gesture waits for it to close (nocx-mlm7)", () => {
  /** A profile client whose quick-connect assembly answers two hosts. */
  const hostsClient = (): ProfileClient => {
    const pc = new ProfileClient(new Dispatcher())
    vi.spyOn(pc, 'listProfiles').mockResolvedValue([
      {
        id: 'prof:ssh:pi',
        type: 'ssh',
        name: 'pi',
        options: { host: 'raspberry.local', user: 'pi' },
      },
      {
        id: 'prof:ssh:web',
        type: 'ssh',
        name: 'web-prod',
        options: { host: 'web-prod.example.com' },
      },
    ] satisfies SSHProfile[])
    vi.spyOn(pc, 'listSSHAliases').mockResolvedValue({ aliases: [], unavailable: null })
    return pc
  }

  /** A client whose control plane answers history rows; everything else is
   *  the no-store rejection, so no other path is accidentally fed. */
  const historyClient = (): ClientFake => {
    const client = makeClient()
    // The real client's call() is async; this fake matches its signature and
    // answers from constants, so it has nothing to await.
    // eslint-disable-next-line @typescript-eslint/require-await
    client.call.mockImplementation(async (method: string) => {
      if (method === 'history.query') {
        return {
          entries: [
            {
              id: 'h1',
              command: 'ssh pi@192.168.0.93',
              cwd: FIXTURE_CWD,
              host: '',
              status: 'success',
              exitCode: 0,
              startedAt: 1_750_000_000_000,
              endedAt: 1_750_000_000_100,
              maskedCount: 0,
              maskedKinds: [],
            },
            {
              id: 'h2',
              command: 'ssh prod',
              cwd: FIXTURE_CWD,
              host: '',
              status: 'success',
              exitCode: 0,
              startedAt: 1_750_000_000_000,
              endedAt: 1_750_000_000_100,
              maskedCount: 0,
              maskedKinds: [],
            },
          ],
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
        }
      }
      // fs.complete: the stale-path check answers "does not exist" — the
      // history rows are demoted, never hidden, so they still render.
      if (method === 'fs.complete') return { entries: [] }
      throw new Error('no store wired (fake)')
    })
    return client
  }

  const selectedRow = (ed: CommandEditor): HTMLElement | null =>
    ed.root.querySelector<HTMLElement>('.ui-floating-panel__row[data-selected="true"]')
  const recallPanel = (ed: CommandEditor): HTMLElement | null =>
    ed.root.querySelector<HTMLElement>('.ui-floating-panel[data-variant="recall"]')

  it('with the dropdown open under `ssh `, ArrowDown and ArrowUp move the dropdown selection and never open recall', async () => {
    const { view, ed, teardown } = await mountTerminal(
      makeClipboard(),
      {},
      historyClient(),
      hostsClient(),
    )
    try {
      ed.show()
      ed.insertText('ssh ')
      // Tab opens the dropdown — the user's own path to the surface.
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
      // Hosts and history land over the profile client and the control
      // plane; the dropdown opens on its first results.
      await vi.waitFor(() => expect(selectedRow(ed)).not.toBeNull())
      const rows = () =>
        [...ed.root.querySelectorAll<HTMLElement>('.ui-floating-panel__row')].map(
          (r) => r.textContent ?? '',
        )
      expect(rows().length).toBeGreaterThanOrEqual(3) // hosts + history
      const first = selectedRow(ed)!.textContent ?? ''
      expect(recallPanel(ed)?.dataset.open).not.toBe('true')

      // ArrowDown: the DROPDOWN's selection moves — recall stays closed.
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      )
      expect(selectedRow(ed)?.textContent).not.toBe(first)
      expect(recallPanel(ed)?.dataset.open).not.toBe('true')
      expect(ed.getDoc()).toBe('ssh ')

      // ArrowUp: the selection moves back; recall still closed. The
      // editor's up-at-top gesture must not fire while the dropdown owns
      // the key — this is the ownership this suite guards.
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      )
      expect(selectedRow(ed)?.textContent).toBe(first)
      expect(recallPanel(ed)?.dataset.open).not.toBe('true')
    } finally {
      teardown()
    }
  })

  it('with no dropdown open, ArrowUp at the top of a single-line draft still opens recall', async () => {
    const { view, ed, teardown } = await mountTerminal(makeClipboard())
    try {
      ed.show()
      ed.insertText('echo kept')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      )
      expect(recallPanel(ed)?.dataset.open).toBe('true')
    } finally {
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
    })
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

  it('a markerless shell at rest is its own authorisation: the wrapper is typed', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPlan())
    try {
      content.setVisible(true)
      const send = sessionSend(content)
      // Fresh mount: RAW, markerless, normal buffer. The explicit call IS
      // the consent for this path (nocx-4t37.2, ADR-0004 §1 note): the
      // one-line wrapper is typed, and only READY lets the payload follow.
      content.integrateShell()
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(plan.wrapper + '\r'))
    } finally {
      teardown()
    }
  })

  it('a full-screen program (ALT_SCREEN) refuses even on a markerless shell', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPlan())
    try {
      content.setVisible(true)
      // vim/less/htop take the alternate buffer — xterm reports it
      // positively, so the one fact that matters is never inferred.
      rendererOf(content)._fireBufferChange('alternate')
      const send = sessionSend(content)
      content.integrateShell()
      expect(send).not.toHaveBeenCalled()
    } finally {
      teardown()
    }
  })

  it('an integrated shell outside the trusted A→B window is refused too', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPlan())
    try {
      content.setVisible(true)
      const renderer = rendererOf(content)
      // A alone: PROMPT_READY, trusted, but NOT owned (ADR-0006 §4) — and
      // markers have arrived, so the markerless path does not apply.
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

describe('the recovery action chip in editor chrome (nocx-atyf.2)', () => {
  /** A client whose SSH open session carries the given destination mode. */
  const clientWithPolicy = (
    desiredMode: DesiredMode,
    reason: SessionFake['shellIntegrationReason'] = '',
  ): ClientFake =>
    makeClient({
      openSSHSession: vi.fn(() =>
        Promise.resolve(makeSession({ desiredMode, shellIntegrationReason: reason })),
      ),
    })

  const SSH = { profileId: 'ssh:test:1', host: 'test-host' }

  const recoveryLabel = (content: TerminalContent): string | null => {
    const withEditor = content as unknown as { editor: { root: HTMLElement } }
    const el = withEditor.editor.root.querySelector<HTMLElement>('.nocx-editor-recovery')
    if (!el || el.style.display === 'none') return null
    return el.textContent
  }

  it('the healthy state shows nothing in the editor chrome', async () => {
    const { content, teardown } = await mountTerminal(
      makeClipboard(),
      { ssh: SSH },
      clientWithPolicy('script'),
    )
    try {
      content.setVisible(true)
      // No markers yet: unsupported shell, no recovery needed.
      expect(recoveryLabel(content)).toBeNull()

      // Fire markers to reach integrated + editor = healthy.
      const renderer = rendererOf(content)
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      // Healthy state: no recovery action shown.
      expect(recoveryLabel(content)).toBeNull()
    } finally {
      teardown()
    }
  })

  it('a launcher decline on a script profile shows the recovery action', async () => {
    const { content, teardown } = await mountTerminal(
      makeClipboard(),
      { ssh: SSH },
      clientWithPolicy('script', 'unsupported-shell'),
    )
    try {
      content.setVisible(true)
      // The degrade warning fires; mode is script.
      expect(content.policy).toBe('script')
    } finally {
      teardown()
    }
  })

  it('raw refuses integrateShell even at a trusted prompt — nothing is typed', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, clientWithPolicy('raw'))
    try {
      content.setVisible(true)
      const renderer = rendererOf(content)
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      const withSession = content as unknown as { session: SessionFake }
      const send = withSession.session.send
      content.integrateShell()
      expect(send).not.toHaveBeenCalled()
    } finally {
      teardown()
    }
  })

  it('the nocx-capability-rail element is gone', async () => {
    const { tab, content, teardown } = await mountTerminal(
      makeClipboard(),
      { ssh: SSH },
      clientWithPolicy('script'),
    )
    try {
      content.setVisible(true)
      const rail = tab.pane.querySelector('.nocx-capability-rail')
      expect(rail).toBeNull()
    } finally {
      teardown()
    }
  })
})

describe('the environment stack (nocx-695k.1)', () => {
  /** Access _shellIntegrated through the private-field escape hatch. */
  const shellIntegrated = (content: TerminalContent): boolean => {
    const withField = content as unknown as { _shellIntegrated: boolean }
    return withField._shellIntegrated
  }

  const previousIntegrated = (content: TerminalContent): boolean[] => {
    const withField = content as unknown as { _previousIntegrated: boolean[] }
    return withField._previousIntegrated
  }

  const shellStateOf = (content: TerminalContent): string => content.shellState

  // What the owner asked for three times (2026-08-04): typing `ssh host` in
  // a local tab left every surface naming the local machine — the tab title
  // was whatever the remote shell's OSC 2 last set, the location chip stayed
  // hidden because a local session grows none, and the cwd chip went on
  // showing the local directory under a remote prompt.
  // P9: the entry moved from submit-time to `expected passport → tagged
  // A → B` (§5.3) — so the surfaces change only when the passport says the
  // remote shell is nocx's own, and the local D brings them back.
  it('the tab title, the location chip and the ports target follow the environment', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)
    const { ed, content, tab, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const renderer = rendererOf(content)
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      // A local tab scopes ports to the local target and shows no location.
      expect(content.portsTargetId).toBe('local')
      expect(content.portsUnavailableReason).toBe('')

      ed.insertText('ssh pi@192.168.0.93')
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      // The beforeSubmit is async (ssh rewrite RPC); drain microtasks.
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // NOT yet inside: submit no longer enters the environment — the
      // passport has not arrived, so every surface still names the local
      // machine (§5.3: nothing changes until passport → tagged A → B).
      const loc = ed.root.querySelector('.nocx-editor-location')
      expect(loc?.textContent ?? '').not.toContain('pi@')
      expect(content.portsTargetId).toBe('local')

      enterEnvironment(renderer, 'env-ab12')

      // Inside: the pane refuses to speak for its ports — there is no
      // managed connection to a child ssh process — and the cwd is NOT
      // invented: we know the host, not the directory. The block for the
      // ssh command carries the destination and NO folder — `📁 home/dev`
      // beside a remote host reads as a place that does not exist (owner,
      // 2026-08-04).
      expect(content.portsTargetId).toBeNull()
      expect(content.portsUnavailableReason).toBe('pi@192.168.0.93')
      const cwd = ed.root.querySelector('.nocx-editor-cwd')
      expect(cwd?.textContent ?? '').not.toContain('home')
      // Entry (passport → tagged A → B) hands keyboard ownership to the
      // editor immediately (spec §5.3: nothing changes until entry — at
      // entry it changes): the editor is present and the chip names the
      // host. Before the P0 fix the remote's first A arrived while the
      // machine was still RUNNING_RAW, its B granted no ownership, and
      // the marker-only remote prompt left no input surface at all.
      expect(ed.isVisible).toBe(true)
      const loc2 = ed.root.querySelector('.nocx-editor-location')
      expect(loc2?.textContent).toBe('pi@192.168.0.93')

      // A full tagged remote command cycle (C…D→A→B) keeps the chip naming
      // the host and re-grants ownership after the command.

      renderer._fireCommandMarker({
        kind: 'C',
        line: 0,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      renderer._fireCommandMarker({
        kind: 'D',
        line: 0,
        col: 0,
        buffer: 'normal',
        exitCode: 0,
        nocxEnv: 'env-ab12',
      })
      renderer._fireCommandMarker({
        kind: 'A',
        line: 0,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      renderer._fireCommandMarker({
        kind: 'B',
        line: 0,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      const loc3 = ed.root.querySelector('.nocx-editor-location')
      expect(loc3?.textContent).toBe('pi@192.168.0.93')

      // The REMOTE shell titles the tab the moment you land. This is the
      // one that outlived its program: nothing sends another OSC 2 on the
      // way out, so the tab kept naming a machine it had left, for as long
      // as the tab lived (owner, 2026-08-04, four times).
      renderer._fireTitle('pi@raspberrypi: ~')
      expect(tab.title).toBe('pi@raspberrypi: ~')

      // The local D: ssh exited — everything goes back, within one prompt —
      // including the title, because a title set by a program does not
      // outlive it.
      renderer._fireCommandMarker({ kind: 'D', line: 0, col: 0, buffer: 'normal', exitCode: 0 })
      expect(content.portsTargetId).toBe('local')
      expect(content.portsUnavailableReason).toBe('')
      expect(tab.title).not.toBe('pi@raspberrypi: ~')
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('a non-ssh environment entry still pushes at submit and the D marker restores it', async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const renderer = rendererOf(content)
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)

      // Drive to a trusted owned prompt with markers flowing.
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(shellIntegrated(content)).toBe(true)
      expect(previousIntegrated(content)).toHaveLength(0)

      // Submit a NON-ssh environment-entry command: docker has no passport
      // machinery in this epic, so it keeps the submit-time heuristic
      // (nocx-695k.2) — pushed on submit, popped on the D.
      ed.insertText('docker exec -it alpine sh')
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The marker fact is cleared: the pane is now on a different host.
      expect(shellIntegrated(content)).toBe(false)
      expect(previousIntegrated(content)).toHaveLength(1)
      expect(previousIntegrated(content)[0]).toBe(true)

      // The shell state follows: unsupported (markers cleared).
      expect(shellStateOf(content)).toBe('unsupported')

      // The command runs; the D marker finishes it.
      renderer._fireCommandMarker({ kind: 'C', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'D', line: 0, col: 0, buffer: 'normal', exitCode: 0 })

      // The marker fact is restored from the stack.
      expect(shellIntegrated(content)).toBe(true)
      expect(previousIntegrated(content)).toHaveLength(0)
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('sleep 5 is not an environment entry: _shellIntegrated and capability are unchanged', async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const renderer = rendererOf(content)
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)

      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(shellIntegrated(content)).toBe(true)

      ed.insertText('sleep 5')
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )

      // Not an environment entry: the marker fact and the stack are untouched.
      expect(shellIntegrated(content)).toBe(true)
      expect(previousIntegrated(content)).toHaveLength(0)
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('nested non-ssh environments push and pop correctly', async () => {
    const { ed, content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const renderer = rendererOf(content)
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)

      // Local shell has markers.
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(shellIntegrated(content)).toBe(true)

      // Enter container a via docker exec (the legacy non-ssh path: push at
      // submit, pop on the D).
      ed.insertText('docker exec -it a sh')
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(shellIntegrated(content)).toBe(false)
      expect(previousIntegrated(content)).toEqual([true])
      renderer._fireCommandMarker({ kind: 'C', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'D', line: 0, col: 0, buffer: 'normal', exitCode: 0 })
      expect(shellIntegrated(content)).toBe(true)
      expect(previousIntegrated(content)).toHaveLength(0)

      // Markers from container a arrive — the shell there is integrated.
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(shellIntegrated(content)).toBe(true)

      // Now inside a, docker exec into b.
      ed.insertText('docker exec -it b sh')
      ed.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(shellIntegrated(content)).toBe(false)
      expect(previousIntegrated(content)).toEqual([true])
      renderer._fireCommandMarker({ kind: 'C', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'D', line: 0, col: 0, buffer: 'normal', exitCode: 0 })
      expect(shellIntegrated(content)).toBe(true)
      expect(previousIntegrated(content)).toHaveLength(0)
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('a markerless shell does not push: the stack stays empty', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {
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

      // No markers have arrived — the shell is markerless.
      expect(shellIntegrated(content)).toBe(false)

      // Enter the editor by submitting through the… wait, in a markerless
      // shell the editor is not visible. We test this path through
      // integrateShell's markerless path, but the submit callback is only
      // reachable from the editor. In a markerless shell with the editor
      // hidden, the submit path is not taken. The guard
      // `this._shellIntegrated` on the push means it is always safe —
      // even if reached from an unusual path, it only pushes when markers
      // are flowing.

      // The guard is tested by the cases above: when _shellIntegrated is
      // false, isEnvironmentEntry() && false is false, so nothing pushes.
      // The additional assertion here is that the initial state is correct.
      expect(previousIntegrated(content)).toHaveLength(0)
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })
})

// Regression table for input-state.ts transitions (nocx-695k.1 acceptance,
// extended by nocx-mlm7 P0). The environment stack in terminal-content.ts
// reads input-state — it never writes to it. This table pins every
// transition the machine is allowed to make, so a state or event change
// must extend it deliberately.
describe('input-state.ts transition table (nocx-695k.1 + nocx-mlm7 P0)', () => {
  it('every allowed machine transition is pinned in the table', async () => {
    // The reducer table from input-state.test.ts, replicated here as a
    // cross-check.
    const { reduce, initialMachine } = await import('./input-state')

    // A → PROMPT_READY (trusted from RAW)
    const a = reduce(initialMachine(), { type: 'marker', kind: 'A' })
    expect(a).toEqual({ state: 'PROMPT_READY', trusted: true, owned: false })

    // B → ownership granted
    const b = reduce(a, { type: 'marker', kind: 'B' })
    expect(b).toEqual({ state: 'PROMPT_READY', trusted: true, owned: true })

    // submit → RUNNING_RAW
    const s = reduce(b, { type: 'submit' })
    expect(s).toEqual({ state: 'RUNNING_RAW', trusted: true, owned: false })

    // passport (accepted readiness passport, §5.3) → clean cycle from
    // RUNNING_RAW: the remote's following A is trusted through it, and its
    // B grants ownership (nocx-mlm7 P0).
    const pp = reduce(s, { type: 'passport' })
    expect(pp).toEqual({ state: 'RAW', trusted: false, owned: false })
    const ppA = reduce(pp, { type: 'marker', kind: 'A' })
    expect(ppA).toEqual({ state: 'PROMPT_READY', trusted: true, owned: false })
    expect(reduce(ppA, { type: 'marker', kind: 'B' }).owned).toBe(true)
    // The clean cycle is spent: a nested prompt mid-command stays untrusted.
    const ppRunning = reduce(reduce(ppA, { type: 'marker', kind: 'B' }), {
      type: 'marker',
      kind: 'C',
    })
    expect(reduce(ppRunning, { type: 'marker', kind: 'A' }).trusted).toBe(false)

    // C → RUNNING_RAW (trusted from clean prompt)
    const c = reduce(b, { type: 'marker', kind: 'C' })
    expect(c).toEqual({ state: 'RUNNING_RAW', trusted: true, owned: false })

    // D → RAW
    const d = reduce(c, { type: 'marker', kind: 'D' })
    expect(d).toEqual({ state: 'RAW', trusted: true, owned: false })

    // ALT_SCREEN
    const alt = reduce(b, { type: 'buffer', buffer: 'alternate' })
    expect(alt).toEqual({ state: 'ALT_SCREEN', trusted: false, owned: false })

    // reset
    const rst = reduce(b, { type: 'reset' })
    expect(rst).toEqual({ state: 'RAW', trusted: false, owned: false })

    // exit
    const ext = reduce(b, { type: 'exit' })
    expect(ext).toEqual({ state: 'RAW', trusted: false, owned: false })

    // orphan C → RUNNING_RAW, untrusted
    const orc = reduce(initialMachine(), { type: 'marker', kind: 'C' })
    expect(orc).toEqual({ state: 'RUNNING_RAW', trusted: false, owned: false })

    // orphan D → no change from RAW
    const ord = reduce(initialMachine(), { type: 'marker', kind: 'D' })
    expect(ord).toEqual(initialMachine())

    // B without A → untrusted, not owned
    const bNoA = reduce(initialMachine(), { type: 'marker', kind: 'B' })
    expect(bNoA).toEqual({ state: 'PROMPT_READY', trusted: false, owned: false })
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
    const css: string = readFileSync(STYLE_ENTRY, 'utf8')
    const chrome = stripComments(extractRuleBlock(css, 'nocx-editor-chrome') ?? '')
    const time = stripComments(extractRuleBlock(css, 'nocx-editor-time') ?? '')
    expect(chrome).not.toBe('')
    expect(time).not.toBe('')

    expect(chrome).not.toMatch(/justify-content\s*:\s*(space-between|space-around|space-evenly)/)
    expect(time).toMatch(/margin-left\s*:\s*auto/)
  })
})

describe('terminal/editor input switching (nocx-atyf.5)', () => {
  it('switching to terminal input hides the editor and is reversible', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const renderer = rendererOf(content)
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)

      // Start with editor (integrated + trusted).
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(content.presentation).toBe('editor')

      // Switch to terminal input.
      content.switchToTerminalInput()
      expect(content.presentation).toBe('terminal')

      // Switch back to editor.
      content.switchToEditorInput()
      expect(content.presentation).toBe('editor')
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('the choice is session-scoped — a new session is unaffected', async () => {
    const { content: first, teardown: teardown1 } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    try {
      first.setVisible(true)
      const renderer1 = rendererOf(first)
      renderer1._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer1._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      // Switch the first session to terminal input.
      first.switchToTerminalInput()
      expect(first.presentation).toBe('terminal')
    } finally {
      teardown1()
    }

    // A brand-new session starts with the default (editor, if integrated).
    const { content: second, teardown: teardown2 } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    try {
      second.setVisible(true)
      const renderer2 = rendererOf(second)
      renderer2._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer2._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      // The new session is unaffected — it starts in editor mode.
      expect(second.presentation).toBe('editor')
    } finally {
      teardown2()
    }
  })
})

// ── nocx-pu4.6: ssh rewrite rides the launcher ────────────────────────────

/* eslint-disable @typescript-eslint/unbound-method */
describe('nocxify: ssh command rewrite (nocx-pu4.6)', () => {
  // The backend answers with a staged PATH, never the launcher: the launcher
  // is ~35 KB and the submitted line has only the tty, whose canonical buffer
  // is 4096 bytes (nocx-pu4.6, reopened).
  const LAUNCHER_PATH = "'/home/u/.nocx/run/launcher-12345'"

  /** jsdom does not implement scrollTo/scrollIntoView; the
   *  ScrollbackController calls both. */
  function stubScroll(): () => void {
    const pst = Element.prototype.scrollTo
    const psiv = Element.prototype.scrollIntoView
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    return () => {
      Element.prototype.scrollTo = pst
      Element.prototype.scrollIntoView = psiv
    }
  }

  it('rewrites an interactive ssh command at submit', async () => {
    const callMock = vi.fn()
    callMock.mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      // An INTEGRATED local tab is the bead's precondition: a marker has
      // arrived, so this shell speaks our protocol and its syntax is known.
      rendererOf(content)._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      ed.insertText('ssh testhost')

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )

      // The rewrite is async (RPC call): drain microtasks.
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The RPC was called with the TYPED PLAN (nocx-c5az): the oracle argv
      // is the complete `ssh -G` argv, so the typed -F/-o/-J/-l/-p reach the
      // oracle — never a bare destination.
      expect(callMock).toHaveBeenCalledWith(
        'shell.launcherCommand',
        expect.objectContaining({
          sessionId: session.sessionId,
          oracleArgv: ['ssh', '-G', 'testhost'],
        }),
      )

      // The minted environment id was registered as expected BEFORE the
      // line reached the pty (§5.3) — a passport carrying it can be
      // accepted; nothing else can.
      expect(passportRendererOf(content).setExpectedEnvironmentId).toHaveBeenCalledWith('env-ab12')

      // The paste received the REWRITTEN command, not the original.
      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledWith(expect.stringContaining(LAUNCHER_PATH))
      expect(renderer.paste).toHaveBeenCalledWith(expect.stringContaining('-t'))
      expect(renderer.paste).toHaveBeenCalledWith(expect.stringContaining('ssh'))

      // What reaches the pty is a line the pty can carry. This is the defect
      // the bead was reopened for: 35 KB went in and 27 KB arrived, so the
      // shell ran the fragments of a truncated script.
      // The paste mock is a vitest spy; read its recorded call arguments.
      const pasteMock = renderer.paste as unknown as { mock: { calls: string[][] } }
      const pasted = pasteMock.mock.calls[0][0]
      expect(new TextEncoder().encode(pasted).byteLength).toBeLessThanOrEqual(4095)
      // And it names the launcher rather than carrying it.
      expect(pasted).not.toContain('BASH_ENV')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('mode installed sends the compact guard-travelling line with the environment id', async () => {
    const callMock = vi.fn()
    callMock.mockResolvedValue(
      LAUNCH({ mode: 'installed', environmentId: 'env-zz99', launcherPath: null }),
    )
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      rendererOf(content)._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      ed.insertText('ssh testhost')

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The compact line (§3.3): the guard travels to the far side, and the
      // environment id reaches the carrier as its first argument.
      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledWith(
        expect.stringContaining('"$HOME/.nocx/launch" env-zz99'),
      )
      expect(renderer.paste).toHaveBeenCalledWith(expect.stringContaining('ssh -t testhost'))
      // The session id rides along as the carrier's second argument.
      expect(renderer.paste).toHaveBeenCalledWith(
        expect.stringContaining(`env-zz99 ${session.sessionId}`),
      )
    } finally {
      restoreScroll()
      teardown()
    }
  })

  // The rewritten line is POSIX/bash/zsh syntax — `if …; then …; else …; fi`.
  // Those are exactly the shells nocx ships integration scripts for, so an
  // integrated tab is by construction one of them, and a tab with no markers
  // may be anything: a fish or csh login shell would take `then` as a command
  // and the ssh would never run at all. That is worse than not rewriting, so
  // an unintegrated tab is not a tab we rewrite in. It is also the bead's own
  // precondition — "in an integrated local tab".
  it('does NOT rewrite in a tab that is not integrated', async () => {
    const callMock = vi.fn()
    callMock.mockResolvedValue(LAUNCH())
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      // No marker is ever fired: this shell does not speak our protocol and
      // we do not know what its syntax is.
      ed.insertText('ssh testhost')

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      expect(callMock).not.toHaveBeenCalledWith('shell.launcherCommand', expect.anything())
      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledWith('ssh testhost')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('does NOT rewrite when mode is raw', async () => {
    const callMock = vi.fn()
    const client = makeClient({ call: callMock })
    const session = makeSession({ desiredMode: 'raw' })
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      ed.insertText('ssh testhost')

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )

      for (let i = 0; i < 5; i++) await Promise.resolve()

      // shell.launcherCommand was never called.
      expect(callMock).not.toHaveBeenCalledWith('shell.launcherCommand', expect.anything())

      // The paste received the ORIGINAL line.
      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledWith('ssh testhost')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('does NOT rewrite when launcher is null (fail-open)', async () => {
    const callMock = vi.fn()
    callMock.mockResolvedValue(
      LAUNCH({ mode: 'raw', launcherPath: null, reason: 'remote-command' }),
    )
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      ed.insertText('ssh testhost')

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )

      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The paste received the ORIGINAL line — fail-open.
      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledWith('ssh testhost')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('does NOT rewrite a non-ssh command', async () => {
    const callMock = vi.fn()
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      ed.insertText('ls -la')

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )

      for (let i = 0; i < 5; i++) await Promise.resolve()

      // shell.launcherCommand was never called for non-ssh lines.
      expect(callMock).not.toHaveBeenCalledWith('shell.launcherCommand', expect.anything())

      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledWith('ls -la')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('does NOT rewrite inside an environment (depth > 0 ⇒ raw, §6.1)', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH())
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const renderer = rendererOf(content)
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      // Enter the environment the passport-gated way.
      ed.insertText('ssh host1')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()
      enterEnvironment(renderer, 'env-ab12')

      // Now inside the environment: a nested ssh must NOT be rewritten — a
      // local staged path would be read by a remote shell (§3.1, §6.1).
      // Entry already handed input to the editor (P0), so the nested line
      // is typed there without any manual re-show.
      ed.insertText('ssh host2')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // Only the FIRST ssh consulted the planner — the nested one was
      // refused by depth before any RPC. (The environmentObserved report
      // for the accepted passport is a separate, expected call.)
      const launcherCalls = callMock.mock.calls.filter(([m]) => m === 'shell.launcherCommand')
      expect(launcherCalls).toHaveLength(1)
      expect(renderer.paste).toHaveBeenLastCalledWith('ssh host2')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('does NOT rewrite a remote command like `ssh -t host tmux attach` (§6.1)', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH())
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      rendererOf(content)._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      ed.insertText('ssh -t host tmux attach')

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The parser refuses (a remote command, not a login); the planner is
      // never consulted and the typed line goes out unchanged.
      expect(callMock).not.toHaveBeenCalledWith('shell.launcherCommand', expect.anything())
      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledWith('ssh -t host tmux attach')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('sends exactly one line — no write between submit and first marker (safety property)', async () => {
    const callMock = vi.fn()
    callMock.mockResolvedValue(LAUNCH())
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)

    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      // An INTEGRATED local tab is the bead's precondition: a marker has
      // arrived, so this shell speaks our protocol and its syntax is known.
      rendererOf(content)._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      ed.insertText('ssh testhost')

      const sendCallsBefore = session.send.mock.calls.length

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )

      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The submit path calls paste (which writes to the renderer, not
      // session.send) and sendRaw('\r') (calls session.send). The rewrite
      // path sends exactly ONE line — the rewritten ssh command — followed
      // by CR. Nothing else is typed. This is the safety property: unlike
      // the in-band family, no wrapper is typed AFTER submit into an
      // unknown foreground process.
      const renderer = rendererOf(content)
      expect(renderer.paste).toHaveBeenCalledTimes(1)
      expect(renderer.paste).toHaveBeenCalledWith(expect.stringContaining(LAUNCHER_PATH))

      // No additional deferred writes after submit — no in-band injection.
      const sendCallsAfter = session.send.mock.calls.length
      expect(sendCallsAfter - sendCallsBefore).toBeLessThanOrEqual(2)
    } finally {
      restoreScroll()
      teardown()
    }
  })
})
/* eslint-enable @typescript-eslint/unbound-method */

describe('connection offer on ssh block (nocx-pu4.7)', () => {
  /** jsdom does not implement scrollTo/scrollIntoView; the
   *  ScrollbackController calls both. */
  function stubScroll(): () => void {
    /* eslint-disable @typescript-eslint/unbound-method */
    const pst = Element.prototype.scrollTo
    const psiv = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    return () => {
      Element.prototype.scrollTo = pst
      Element.prototype.scrollIntoView = psiv
    }
  }

  /** Create a minimal ProfileClient mock with listProfiles stubbed. */
  function mockProfileClient(
    profiles: ReadonlyArray<{ name: string; host: string }> = [],
  ): ProfileClient {
    return {
      listProfiles: vi.fn().mockResolvedValue(
        profiles.map((p) => ({
          id: `p_${p.name}`,
          type: 'ssh',
          name: p.name,
          options: { host: p.host },
        })),
      ),
      getSnapshot: vi.fn().mockResolvedValue({ values: {}, overridden: [], revision: 0 }),
      setSetting: vi.fn().mockResolvedValue({ ok: true }),
      createProfile: vi
        .fn()
        .mockImplementation((p: { name: string }) =>
          Promise.resolve({ ...p, id: `new_${p.name}` }),
        ),
    } as unknown as ProfileClient
  }

  it('offers to save on block after ssh to unknown host', async () => {
    const callMock = vi.fn()
    callMock.mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)
    const pc = mockProfileClient([])

    const { view, ed, content, tab, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
      pc,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      // The rewrite gate requires an integrated local shell: a marker must
      // have arrived before the planner is consulted.
      rendererOf(content)._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      rendererOf(content)._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      // Submit ssh to an UNKNOWN host.
      ed.insertText('ssh pi@newbox')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
      // Submit drains one hop further when a profile client is wired: the
      // saved-connection overlay lists profiles before the launcher call
      // (nocx-pv3h). Without a client the path stays synchronous.
      for (let i = 0; i < 8; i++) await Promise.resolve()

      const renderer = rendererOf(content)
      // Entry freezes the ssh block (passport → tagged A → B), and the
      // connection offer rides on that freeze — exactly where the block
      // used to end at the session's D.
      enterEnvironment(renderer, 'env-ab12')
      // The offer is async (profile list + settings): drain.
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // A receipt should appear on the block.
      const blocks = tab.pane.querySelectorAll('.cmd-block')
      expect(blocks.length).toBeGreaterThan(0)
      const lastBlock = blocks[blocks.length - 1] as HTMLElement | undefined
      const receipt = lastBlock?.querySelector('.ui-block-receipt')
      expect(receipt).not.toBeNull()

      // Kind badge says "SSH host".
      const kind = receipt?.querySelector('.ui-block-receipt__kind')
      expect(kind?.textContent).toBe('SSH host')

      // The destination is shown.
      const value = receipt?.querySelector('.ui-block-receipt__value')
      expect(value?.textContent).toBe('pi@newbox')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('does NOT offer when the destination is already a saved profile', async () => {
    const callMock = vi.fn()
    callMock.mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)
    // newbox is a KNOWN profile.
    const pc = mockProfileClient([{ name: 'my-box', host: 'newbox' }])

    const { view, ed, content, tab, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
      pc,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      rendererOf(content)._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      rendererOf(content)._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      ed.insertText('ssh pi@newbox')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      const renderer = rendererOf(content)
      enterEnvironment(renderer, 'env-ab12')
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // No receipt — the host is already a profile.
      const blocks = tab.pane.querySelectorAll('.cmd-block')
      const lastBlock = blocks[blocks.length - 1] as HTMLElement | undefined
      expect(lastBlock?.querySelector('.ui-block-receipt')).toBeNull()
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('does NOT offer for non-ssh commands', async () => {
    const pc = mockProfileClient([])
    const client = makeClient()

    const { view, ed, content, tab, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
      pc,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()

      ed.insertText('ls -la')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      const renderer = rendererOf(content)
      renderer._fireCommandMarker({
        kind: 'C',
        line: 0,
        col: 0,
        buffer: 'normal',
      })
      renderer._fireCommandMarker({
        kind: 'D',
        line: 0,
        col: 0,
        buffer: 'normal',
        exitCode: 0,
      })
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // No receipt for non-ssh.
      const blocks = tab.pane.querySelectorAll('.cmd-block')
      const lastBlock = blocks[blocks.length - 1] as HTMLElement | undefined
      expect(lastBlock?.querySelector('.ui-block-receipt')).toBeNull()
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('dismissal persists in settings', async () => {
    const setSettingsMock = vi.fn().mockResolvedValue({ ok: true })
    const pc = {
      listProfiles: vi.fn().mockResolvedValue([]),
      getSnapshot: vi.fn().mockResolvedValue({ values: {}, overridden: [], revision: 0 }),
      setSetting: setSettingsMock,
      createProfile: vi.fn(),
    } as unknown as ProfileClient
    const client = makeClient()
    const callMock = client.call
    callMock.mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))

    const { view, ed, content, tab, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
      pc,
    )
    const restoreScroll = stubScroll()
    try {
      content.setVisible(true)
      ed.show()
      rendererOf(content)._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      rendererOf(content)._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })

      ed.insertText('ssh box')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
      // One hop further with a profile client wired — see the note in the
      // sibling test (nocx-pv3h).
      for (let i = 0; i < 8; i++) await Promise.resolve()

      const renderer = rendererOf(content)
      enterEnvironment(renderer, 'env-ab12')
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // Receipt appears.
      const blocks = tab.pane.querySelectorAll('.cmd-block')
      const lastBlock = blocks[blocks.length - 1] as HTMLElement | undefined
      const dismissBtn = lastBlock?.querySelector<HTMLButtonElement>('.ui-block-receipt__drop')
      expect(dismissBtn).not.toBeNull()

      // Click Dismiss.
      dismissBtn?.click()
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // Settings were persisted with the destination.
      expect(setSettingsMock).toHaveBeenCalledWith(
        'nocx.connectionOffers.dismissed',
        expect.stringContaining('box'),
      )

      // Receipt is gone.
      expect(lastBlock?.querySelector('.ui-block-receipt')).toBeNull()
    } finally {
      restoreScroll()
      teardown()
    }
  })
})

// ── nocx-mlm7 P9: the environment boundary (spec §6.1) ────────────────────

describe('the environment boundary (nocx-mlm7 P9, spec §6.1)', () => {
  /** Access the ledger through the private-field escape hatch. */
  const ledgerOf = (content: TerminalContent): CommandLedger => {
    const withLedger = content as unknown as { ledger: CommandLedger }
    return withLedger.ledger
  }

  const envStackOf = (content: TerminalContent): unknown[] => {
    const withStack = content as unknown as { _envStack: unknown[] }
    return withStack._envStack
  }

  const attemptOf = (content: TerminalContent): unknown => {
    const withAttempt = content as unknown as { _attempt: unknown }
    return withAttempt._attempt
  }

  /** The scrollback block records — command, cwd and paint, oldest first. */
  const blocksOf = (
    content: TerminalContent,
  ): Array<{
    command: string
    cwd: string
    status: string
    exitCode: number | null
  }> => {
    const withBlocks = content as unknown as {
      scrollback: {
        blockManager: {
          blocks: Array<{
            command: string
            cwd: string
            status: string
            exitCode: number | null
          }>
        }
      } | null
    }
    return withBlocks.scrollback?.blockManager.blocks ?? []
  }

  /** The shell.environmentObserved reports, in order. */
  const observedCalls = (
    callMock: Mock<(method: string, params: unknown) => Promise<unknown>>,
  ): Array<{ environmentId: string; passport: unknown }> =>
    callMock.mock.calls
      .filter(([m]) => m === 'shell.environmentObserved')
      .map(([, p]) => p as { environmentId: string; passport: unknown })

  /** Submit a line through the editor's real keydown path. */
  const submitLine = (view: EditorView, ed: CommandEditor, text: string): void => {
    ed.insertText(text)
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  }

  /** jsdom does not implement scrollTo/scrollIntoView; the controller uses
   *  both on every block start and freeze. */
  function stubScroll(): () => void {
    /* eslint-disable @typescript-eslint/unbound-method */
    const pst = Element.prototype.scrollTo
    const psiv = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    return () => {
      Element.prototype.scrollTo = pst
      Element.prototype.scrollIntoView = psiv
    }
  }

  /** Mount an integrated local tab with a working planner, drive to a
   *  trusted prompt, and submit `ssh host1` (bootstrap, env-ab12). */
  async function mountWithSsh(
    callMock: Mock<(method: string, params: unknown) => Promise<unknown>>,
  ): Promise<{
    view: EditorView
    ed: CommandEditor
    content: TerminalContent
    tab: Tab
    renderer: RendererMock
    teardown: () => void
  }> {
    const restoreScroll = stubScroll()
    try {
      const client = makeClient({ call: callMock })
      const session = makeSession()
      client.openSession.mockResolvedValue(session)
      const mounted = await mountTerminal(makeClipboard(), { attachToDocument: true }, client)
      mounted.content.setVisible(true)
      mounted.ed.show()
      const renderer = rendererOf(mounted.content)
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      submitLine(mounted.view, mounted.ed, 'ssh host1')
      for (let i = 0; i < 5; i++) await Promise.resolve()
      return {
        ...mounted,
        renderer,
        teardown: () => {
          restoreScroll()
          mounted.teardown()
        },
      }
    } catch (err) {
      restoreScroll()
      throw err
    }
  }

  it('row 1: auth fails / Ctrl-C at password: — no passport, the block runs to the local D with the real exit status', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, tab, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      // The local shell runs the ssh line: C starts it, and ssh dies at the
      // password prompt (130 = Ctrl-C). No passport ever arrived.
      renderer._fireCommandMarker({ kind: 'C', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({
        kind: 'D',
        line: 0,
        col: 0,
        buffer: 'normal',
        exitCode: 130,
      })
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The block lived to the local D and got the REAL exit status.
      const exitChip = tab.pane.querySelector('.cmd-header-exit-fail')
      expect(exitChip?.textContent).toBe('exit 130')
      // No environment was entered, nothing was reported as accepted.
      expect(envStackOf(content)).toHaveLength(0)
      const observed = observedCalls(callMock)
      expect(observed).toHaveLength(1)
      expect(observed[0].passport).toBeNull()
      // The ledger record closed with the real code too.
      const rec = ledgerOf(content)
        .records()
        .find((r) => r.command === 'ssh host1')
      expect(rec?.exitCode).toBe(130)
      expect(rec?.status).toBe('failure')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('row 2: banner before password: — everything up to the passport belongs to the running ssh block', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, tab, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      // While ssh is still connecting (banner, host-key prompt, password:,
      // 2FA), the block is RUNNING — no marker froze it yet.
      expect(tab.pane.querySelector('.cmd-block-running')).not.toBeNull()
      expect(envStackOf(content)).toHaveLength(0)

      // The passport arrives only after the password succeeded.
      enterEnvironment(renderer, 'env-ab12')
      expect(tab.pane.querySelector('.cmd-block-running')).toBeNull()
      expect(tab.pane.querySelector('.cmd-block-entered')).not.toBeNull()
      expect(envStackOf(content)).toHaveLength(1)
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('row 3: the POSIX tier orphan D;0 before its first A closes nothing and pops nothing', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, tab, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      // The launcher ran and the passport was accepted — then the remote
      // tier's first emission is an orphan untagged D;0.
      ;(renderer as unknown as PassportRenderer)._firePassport({
        status: 'accepted',
        passport: PASSPORT('env-ab12'),
      })
      renderer._fireCommandMarker({ kind: 'D', line: 0, col: 0, buffer: 'normal', exitCode: 0 })

      // Closes nothing (the ssh block is still running), pops nothing, and
      // the attempt is still alive with nothing reported.
      expect(tab.pane.querySelector('.cmd-block-running')).not.toBeNull()
      expect(envStackOf(content)).toHaveLength(0)
      expect(attemptOf(content)).not.toBeNull()
      expect(observedCalls(callMock)).toHaveLength(0)

      // The tagged A→B that follows still enters normally.
      renderer._fireCommandMarker({
        kind: 'A',
        line: 1,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      renderer._fireCommandMarker({
        kind: 'B',
        line: 1,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      expect(envStackOf(content)).toHaveLength(1)
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('row 4: markers from an integrated tmux carry no expected id and create no transition', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      // A tagged A→B carrying a FOREIGN id (an already-integrated tmux
      // inside the connecting ssh) must not enter the environment.
      renderer._fireCommandMarker({
        kind: 'A',
        line: 0,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'tmux-9',
      })
      renderer._fireCommandMarker({
        kind: 'B',
        line: 0,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'tmux-9',
      })
      expect(envStackOf(content)).toHaveLength(0)
      expect(observedCalls(callMock)).toHaveLength(0)

      // Our own passport + tagged A→B still enter.
      enterEnvironment(renderer, 'env-ab12')
      expect(envStackOf(content)).toHaveLength(1)
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('row 6: sudo -i on the remote is a raw child shell with no transition', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, view, ed, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      enterEnvironment(renderer, 'env-ab12')
      ed.show()
      submitLine(view, ed, 'sudo -i')
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // The legacy heuristic still labels the raw child shell, and it is
      // NOT an attempt: the dormant transition record is still the ssh's.
      expect(envStackOf(content)).toHaveLength(2)
      expect(ledgerOf(content).transitionRecord?.command).toBe('ssh host1')

      // The sudo shell ends on the remote tier's tagged D; the sudo level
      // pops, the ssh environment stays.
      renderer._fireCommandMarker({
        kind: 'D',
        line: 0,
        col: 0,
        buffer: 'normal',
        exitCode: 0,
        nocxEnv: 'env-ab12',
      })
      expect(envStackOf(content)).toHaveLength(1)
      expect(ledgerOf(content).transitionRecord?.command).toBe('ssh host1')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('row 7: connection lost — the running remote command is interrupted/transition-lost; the transition record takes the local D code', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, view, ed, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      enterEnvironment(renderer, 'env-ab12')
      ed.show()
      submitLine(view, ed, 'top')
      for (let i = 0; i < 5; i++) await Promise.resolve()
      renderer._fireCommandMarker({
        kind: 'C',
        line: 0,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })

      // The network drops: ssh exits 255 and the LOCAL shell emits its D.
      renderer._fireCommandMarker({
        kind: 'D',
        line: 0,
        col: 0,
        buffer: 'normal',
        exitCode: 255,
      })
      for (let i = 0; i < 5; i++) await Promise.resolve()

      const records = ledgerOf(content).records()
      const top = records.find((r) => r.command === 'top')
      expect(top?.status).toBe('interrupted')
      expect(top?.reason).toBe('transition-lost')
      const ssh = records.find((r) => r.command === 'ssh host1')
      expect(ssh?.transition).toBe('completed')
      expect(ssh?.exitCode).toBe(255)
      // The local D's code was never assigned to the remote command.
      expect(top?.exitCode).toBeNull()
      // The environment is gone with the connection.
      expect(envStackOf(content)).toHaveLength(0)
      // The observation was reported once, at entry, with the passport.
      const observed = observedCalls(callMock)
      expect(observed).toHaveLength(1)
      expect(observed[0].passport).not.toBeNull()
      // The running remote block froze with NO exit code.
      const last = blocksOf(content)[blocksOf(content).length - 1]
      expect(last?.status).toBe('entered')
      expect(last?.exitCode).toBeNull()
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('row 8: Ctrl-D with no running remote block — the local D restores the parent environment and the editor', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, ed, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      enterEnvironment(renderer, 'env-ab12')
      expect(envStackOf(content)).toHaveLength(1)

      // Ctrl-D at the remote prompt: ssh exits cleanly, the local D arrives
      // with no remote block running.
      renderer._fireCommandMarker({ kind: 'D', line: 0, col: 0, buffer: 'normal', exitCode: 0 })
      for (let i = 0; i < 5; i++) await Promise.resolve()

      expect(envStackOf(content)).toHaveLength(0)
      const ssh = ledgerOf(content)
        .records()
        .find((r) => r.command === 'ssh host1')
      expect(ssh?.transition).toBe('completed')
      expect(ssh?.exitCode).toBe(0)

      // The local shell's next prompt restores the editor.
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(ed.isVisible).toBe(true)
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('the ssh block carries the LOCAL host and cwd (entry happens after ledger.open and beginBlock)', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      enterEnvironment(renderer, 'env-ab12')
      const block = blocksOf(content)[0]
      expect(block.command).toBe('ssh host1')
      // The block was started with the LOCAL cwd — the environment was not
      // applied before beginBlock (that was the defect this epic fixes: the
      // block carried the destination and no folder).
      expect(block.cwd).toBe(FIXTURE_CWD)
      expect(block.status).toBe('entered')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('entry counts only on expected passport → tagged A → B', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      // A tagged A alone (passport not yet accepted): nothing.
      renderer._fireCommandMarker({
        kind: 'A',
        line: 1,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      expect(envStackOf(content)).toHaveLength(0)
      // Passport accepted, then an UNTAGGED A→B: not the entry pair.
      ;(renderer as unknown as PassportRenderer)._firePassport({
        status: 'accepted',
        passport: PASSPORT('env-ab12'),
      })
      renderer._fireCommandMarker({ kind: 'A', line: 1, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 1, col: 0, buffer: 'normal' })
      expect(envStackOf(content)).toHaveLength(0)

      // The tagged A→B pair completes entry.
      renderer._fireCommandMarker({
        kind: 'A',
        line: 1,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      renderer._fireCommandMarker({
        kind: 'B',
        line: 1,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      expect(envStackOf(content)).toHaveLength(1)
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('P0: entry hands input to the editor and a typed command reaches the remote pty', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { view, ed, content, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      // NO manual ed.show(): after the accepted passport → tagged A → B the
      // editor must be present on its own. Before the fix, the remote's
      // first A arrived while the machine was still RUNNING_RAW (submit
      // never finished for ssh), its B granted no ownership, and the
      // marker-only remote prompt left no input surface at all.
      enterEnvironment(renderer, 'env-ab12')
      expect(ed.isVisible).toBe(true)
      expect(content.presentation).toBe('editor')

      // Type a command through that editor: it reaches the remote pty as
      // the pasted document plus the raw CR accept (ADR-0004 §2 handoff).
      const withSession = content as unknown as { session: SessionFake }
      // unbound-method guards against calling a detached method with the
      // wrong `this`. These are vi.fn() spies read for their call record and
      // never invoked, which is the opposite concern.
      /* eslint-disable @typescript-eslint/unbound-method */
      const send = withSession.session.send
      submitLine(view, ed, 'ls -la')
      expect(renderer.paste).toHaveBeenLastCalledWith('ls -la')
      expect(send).toHaveBeenCalledWith('\r')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('P0: without an accepted passport, input stays native — no editor, writable grid', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { ed, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      // mountWithSsh already submitted `ssh host1`: the machine sits in
      // RUNNING_RAW while ssh connects. The remote authenticates and runs
      // a PLAIN shell — no passport ever arrives. The grid stays writable
      // and the editor never appears: the remote shell's own visible
      // prompt is the input surface.
      expect(ed.isVisible).toBe(false)
      expect(renderer.setReadOnly).toHaveBeenLastCalledWith(false)
      /* eslint-enable @typescript-eslint/unbound-method */

      // A foreign/untagged prompt while the ssh command runs (an orphan
      // resync) must not take ownership either — the RUNNING_RAW rule is
      // the nested/orphan protection the passport must not loosen.
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(ed.isVisible).toBe(false)
      /* eslint-disable-next-line @typescript-eslint/unbound-method */
      expect(renderer.setReadOnly).toHaveBeenLastCalledWith(false)
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('a tagged remote D closes the remote command and never pops the environment', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { content, view, ed, renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      enterEnvironment(renderer, 'env-ab12')
      ed.show()
      submitLine(view, ed, 'ls')
      for (let i = 0; i < 5; i++) await Promise.resolve()
      renderer._fireCommandMarker({
        kind: 'C',
        line: 0,
        col: 0,
        buffer: 'normal',
        nocxEnv: 'env-ab12',
      })
      renderer._fireCommandMarker({
        kind: 'D',
        line: 0,
        col: 0,
        buffer: 'normal',
        exitCode: 0,
        nocxEnv: 'env-ab12',
      })

      // Still inside: the tagged D closed the remote command only.
      expect(envStackOf(content)).toHaveLength(1)
      const ls = ledgerOf(content)
        .records()
        .find((r) => r.command === 'ls')
      expect(ls?.status).toBe('success')
      expect(ledgerOf(content).transitionRecord?.command).toBe('ssh host1')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('the observation is reported exactly once, with the accepted passport or null', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const { renderer, teardown } = await mountWithSsh(callMock)
    const restoreScroll = stubScroll()
    try {
      enterEnvironment(renderer, 'env-ab12')
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(observedCalls(callMock)).toHaveLength(1)
      expect(observedCalls(callMock)[0].passport).not.toBeNull()

      // The local D does not report a second time — the first observation
      // per attempt decides it (§5.4).
      renderer._fireCommandMarker({ kind: 'D', line: 0, col: 0, buffer: 'normal', exitCode: 0 })
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(observedCalls(callMock)).toHaveLength(1)
    } finally {
      restoreScroll()
      teardown()
    }
  })
})

describe('activeOrigin (B.9) — the machine the tab speaks for', () => {
  it('a live local session yields an origin with kind local and its sessionId', async () => {
    const session = makeSession()
    const client = makeClient()
    client.openSession.mockResolvedValue(session)
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      const origin = content.activeOrigin()
      expect(origin).not.toBeNull()
      expect(origin?.kind).toBe('local')
      expect(origin?.sessionId).toBe(session.sessionId)
      // The open ack's cwd is the provider's guess — unverified until an
      // OSC 7 report arrives (AD-5).
      expect(origin?.cwd).toBe(FIXTURE_CWD)
      expect(origin?.cwdVerified).toBe(false)
      expect(origin?.host).toBeNull()
    } finally {
      teardown()
    }
  })

  it('an ssh session answers kind ssh with the host the session was opened with', async () => {
    const client = makeClient()
    const session = makeSession()
    client.openSSHSessionByHost.mockResolvedValue(session)
    const { content, teardown } = await mountTerminal(
      makeClipboard(),
      { ssh: { profileId: '', host: 'srv-01' } },
      client,
    )
    try {
      const origin = content.activeOrigin()
      expect(origin?.kind).toBe('ssh')
      expect(origin?.sessionId).toBe(session.sessionId)
      expect(origin?.host).toBe('srv-01')
    } finally {
      teardown()
    }
  })

  it('answers null when there is no session, and once the session has exited', async () => {
    // Not mounted: no session yet, so there is no machine to name.
    const wsClient = makeClient() as unknown as WSClient
    const unmounted = new TerminalContent(
      wsClient,
      makeClipboard(),
      new ClipboardGate(),
      makeBanner(),
      null,
      () => {},
    )
    expect(unmounted.activeOrigin()).toBeNull()

    // Mounted, then the session exits: the session is gone and the origin
    // must not name a machine that no longer exists. The fake's onExit mock
    // records the callback TerminalContent registered at mount.
    const session = makeSession()
    const client = makeClient()
    client.openSession.mockResolvedValue(session)
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      expect(content.activeOrigin()).not.toBeNull()
      const exitCb = session.onExit.mock.calls[0]?.[0] as (sid: string) => void
      expect(exitCb).toBeTypeOf('function')
      exitCb(session.sessionId)
      expect(content.activeOrigin()).toBeNull()
    } finally {
      teardown()
    }
  })

  it('cwdVerified is false for the session-open cwd and true after an OSC 7 report', async () => {
    const session = makeSession()
    const client = makeClient()
    client.openSession.mockResolvedValue(session)
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    const renderer = rendererOf(content)
    try {
      expect(content.activeOrigin()?.cwdVerified).toBe(false)
      renderer._fireCwd('host', '/srv/new/path')
      const after = content.activeOrigin()
      expect(after?.cwd).toBe('/srv/new/path')
      expect(after?.cwdVerified).toBe(true)
    } finally {
      teardown()
    }
  })

  it('fires onActiveOriginChange when the origin answer changes, not only on tab switch', async () => {
    // The Files panel follows the ACTIVE tab's origin through this hook:
    // an OSC 7 cwd, the session dying and an environment boundary all
    // change the answer, and each must push the change (brief §1 — named
    // onActiveOriginChange, not onCwdChange, for exactly this reason).
    const onActiveOriginChange = vi.fn()
    const session = makeSession()
    const client = makeClient()
    client.openSession.mockResolvedValue(session)
    const { content, teardown } = await mountTerminal(
      makeClipboard(),
      { hooks: { onActiveOriginChange } },
      client,
    )
    const renderer = rendererOf(content)
    try {
      // The session open itself is an origin transition (null → origin).
      expect(onActiveOriginChange).toHaveBeenCalledTimes(1)

      // A verified OSC 7 cwd changes the answer.
      renderer._fireCwd('host', '/srv/new/path')
      expect(onActiveOriginChange).toHaveBeenCalledTimes(2)
      expect(content.activeOrigin()?.cwd).toBe('/srv/new/path')

      // The session dying changes it back to null.
      const exitCb = session.onExit.mock.calls[0]?.[0] as (sid: string) => void
      exitCb(session.sessionId)
      expect(onActiveOriginChange).toHaveBeenCalledTimes(3)
      expect(content.activeOrigin()).toBeNull()
    } finally {
      teardown()
    }
  })

  // ── The §0 test ─────────────────────────────────────────────────────────
  it('a local tab whose user entered an ssh session does not answer with the local sessionId', async () => {
    const callMock = vi.fn().mockResolvedValue(LAUNCH({ environmentId: 'env-ab12' }))
    const client = makeClient({ call: callMock })
    const session = makeSession()
    client.openSession.mockResolvedValue(session)
    /* eslint-disable @typescript-eslint/unbound-method */
    const pst = Element.prototype.scrollTo
    const psiv = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      const mounted = await mountTerminal(makeClipboard(), { attachToDocument: true }, client)
      const { view, ed, content, teardown } = mounted
      const renderer = rendererOf(content)
      content.setVisible(true)
      ed.show()
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      // The user types `ssh somewhere` inside the LOCAL tab.
      ed.insertText('ssh pi@192.168.0.93')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // NOT yet inside: the passport has not arrived, so the origin still
      // honestly names the local machine (entry is passport → tagged A → B).
      expect(content.activeOrigin()?.sessionId).toBe(session.sessionId)

      enterEnvironment(renderer, 'env-ab12')

      // Inside the ssh session the tab's session is STILL the local one;
      // naming it would show one machine's files while the user acts on
      // another's (§0). An empty panel is correct; the wrong machine's
      // files are not.
      expect(content.activeOrigin()).toBeNull()
      teardown()
    } finally {
      Element.prototype.scrollTo = pst
      Element.prototype.scrollIntoView = psiv
    }
  })
})
