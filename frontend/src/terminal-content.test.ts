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
import { ClipboardGate } from './clipboard'
import { CommandEditor } from './editor'
import { CommandLedger } from './command-ledger'
import { TerminalContent, type TerminalContentHooks } from './terminal-content'
import { Tab } from './tabs'
import { SURFACE_TERMINAL } from './tab-content'
import { LifecycleKernel, shouldShowEditor } from './lifecycle/state'
import { ProfileClient, type SSHProfile } from './profiles'
import { Dispatcher, RpcError } from './dispatcher'
import type { WSClient } from './ipc'
import { createCommandBlock } from './scrollback/blocks'
import { CommandSnapshotStore } from './command-snapshot'
import type { DesiredMode } from './capability'
import type { ScrollbackController } from './scrollback/controller'
import { pushOverlay, popOverlay } from './ui/overlay/stack'

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

it('a focused interactive control keeps its keys — the typing rescue stands down (nocx-nak2)', async () => {
  const { view, ed, content, teardown } = await mountTerminal(makeClipboard(), {
    attachToDocument: true,
  })
  try {
    content.setVisible(true)
    ed.show()
    expect(ed.isVisible).toBe(true)

    // A button outside the terminal (the sidebar, say) has the focus —
    // the state a user reaches by tabbing, where Space must activate the
    // button, not type into the prompt.
    const probe = document.createElement('button')
    probe.textContent = 'probe'
    document.body.appendChild(probe)
    probe.focus()
    expect(document.activeElement).toBe(probe)

    const ev = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev)

    // The rescue stood down: focus stayed on the button, nothing landed in
    // the prompt, and nothing was preventDefaulted (the rescue is
    // focus-only — the native insertion would not have been cancelled).
    expect(document.activeElement).toBe(probe)
    expect(view.state.doc.toString()).toBe('')
    expect(ev.defaultPrevented).toBe(false)
    probe.remove()
  } finally {
    teardown()
  }
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

  it('an SSH prompt shows the location chip the block header would carry', async () => {
    const { content, tab, teardown } = await mountSshTerminal()
    try {
      content.setVisible(true)
      // The chip is fed at session open from ONE derivation
      // (this.locationLine()); no stream marker may change it (ADR-0024 §1).
      const chip = tab.pane.querySelector<HTMLElement>('.nocx-editor-location')
      expect(chip).not.toBeNull()
      expect(chip!.style.display).not.toBe('none')
      expect(chip!.textContent).toBe('root@192.168.0.57')
      // The block header never appears in the severed product: blocks are
      // a completion projection with no stream (or app) trigger.
      expect(tab.pane.querySelector('.cmd-header-location')).toBeNull()
    } finally {
      teardown()
    }
  })

  it('a local session grows no location chip', async () => {
    const { content, tab, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    try {
      content.setVisible(true)
      const chip = tab.pane.querySelector<HTMLElement>('.nocx-editor-location')
      expect(chip).not.toBeNull()
      expect(chip!.style.display).toBe('none')
      expect(chip!.textContent).toBe('')
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

// Regression table for the two-axis lifecycle kernel (ADR-0024 §6). The
// authority axis moves only on published facts; the buffer axis is a
// renderer-owned presentation fact; no stream marker, submit or passport
// event can reach the reducer. This table pins every transition the kernel
// is allowed to make, so a state or event change must extend it
// deliberately.
describe('lifecycle kernel transition table (ADR-0024 §6)', () => {
  const promptReady = { lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 } as const

  it('every allowed kernel transition is pinned in the table', () => {
    const k = new LifecycleKernel()
    // Native: a conventional terminal, raw input, no ownership.
    expect(k.state.kind).toBe('native')
    expect(shouldShowEditor(k.state)).toBe(false)

    // buffer alternate → the buffer axis moves; ownership never follows.
    k.setBuffer('alternate')
    expect(k.buffer).toBe('alternate')
    expect(k.state.kind).toBe('native')
    expect(shouldShowEditor(k.state)).toBe(false)

    // buffer normal → back; still no ownership.
    k.setBuffer('normal')
    expect(k.buffer).toBe('normal')
    expect(k.state.kind).toBe('native')

    // reset → Native from any state, buffer restored.
    k.setBuffer('alternate')
    k.applyFact(promptReady)
    expect(shouldShowEditor(k.state)).toBe(true)
    k.reset()
    expect(k.state.kind).toBe('native')
    expect(k.buffer).toBe('normal')
    expect(shouldShowEditor(k.state)).toBe(false)

    // No marker, submit or passport event exists on the kernel
    // (compile-time proof; never invoked, so the @ts-expect-error is the
    // point and no runtime TypeError follows).
    const noStreamPath = (): void => {
      // @ts-expect-error ADR-0024 §1: the marker event is deleted.
      k.applyMarker('A') // eslint-disable-line @typescript-eslint/no-unsafe-call -- ADR-0024 §1: no stream input exists
      // @ts-expect-error ADR-0024 §1: the submit event is deleted.
      k.submit('echo hi') // eslint-disable-line @typescript-eslint/no-unsafe-call -- ADR-0024 §1
      // @ts-expect-error ADR-0024 §1: the passport event is deleted.
      k.applyPassport('636;...') // eslint-disable-line @typescript-eslint/no-unsafe-call -- ADR-0024 §1
    }
    void noStreamPath
  })
})

describe('the lifecycle fact wires editor ownership (ADR-0024 §6)', () => {
  it('a prompt_ready fact shows the editor and a native fact hides it — through the dispatcher seam', async () => {
    const client = makeClient()
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      const ed = editorOf(content)
      // The kernel starts Native: a conventional terminal, editor hidden.
      expect(ed.isVisible).toBe(false)
      // The LifecycleClient subscribed through the fake dispatcher.
      const subscribe = client.dispatcher.subscribe
      expect(subscribe).toHaveBeenCalledWith('lifecycle.changed', expect.any(Function))
      const handler = subscribe.mock.calls[0][1] as (params: unknown) => void
      // An authenticated prompt_ready fact for a live domain gives the
      // editor the keyboard.
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      expect(ed.isVisible).toBe(true)
      // A native fact revokes it again.
      handler({ lane: 'lane-1', lifecycle: 'native' })
      expect(ed.isVisible).toBe(false)
    } finally {
      teardown()
    }
  })
})

describe('the restoration episode (ADR-0024 decision 8)', () => {
  const LOST_WITH_RECOVERY = {
    lane: 'lane-1',
    lifecycle: 'lost',
    recovery: { fence: 'ab'.repeat(32), generation: 'ab'.repeat(32) },
  } as const
  const WRONG_FENCE = 'cd'.repeat(32)

  it('a lost fact with a recovery contract suppresses the restore-editor action across the whole span', async () => {
    const client = makeClient()
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      const ed = editorOf(content)
      const subscribe = client.dispatcher.subscribe
      const handler = subscribe.mock.calls[0][1] as (params: unknown) => void
      const setAction = vi.spyOn(ed, 'setRecoveryAction')

      // The interval: from the lost fact until the acknowledgement lands,
      // the session is neither an authenticated terminal nor advertised as
      // a usable conventional one — no editor may be offered at any point
      // inside it.
      handler(LOST_WITH_RECOVERY)
      const calls = setAction.mock.calls
      const last = calls[calls.length - 1]
      expect(last).toBeDefined()
      expect(last[0]).toBeNull() // the action is suppressed, never offered
      // A native fact ends the episode (the ack landed; the backend
      // published the transition).
      handler({ lane: 'lane-1', lifecycle: 'native' })
    } finally {
      teardown()
    }
  })

  it('only the exact pre-provisioned fence is acknowledged, once, with the session id and generation', async () => {
    const client = makeClient()
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      const renderer = rendererOf(content)
      const subscribe = client.dispatcher.subscribe
      const handler = subscribe.mock.calls[0][1] as (params: unknown) => void
      const call = client.dispatcher.call
      handler(LOST_WITH_RECOVERY)

      // A wrong fence — a hostile byte, a different episode — changes
      // nothing: the renderer never pattern-matches, it matches the nonce.
      renderer._fireRecoveryFence(WRONG_FENCE)
      expect(call).not.toHaveBeenCalledWith('lifecycle.recoverAck', expect.anything())

      // The shell's one-shot fence (the exact pre-provisioned nonce)
      // triggers exactly one acknowledgement, carrying only the session id
      // and the generation — nothing else.
      renderer._fireRecoveryFence(LOST_WITH_RECOVERY.recovery.fence)
      renderer._fireRecoveryFence(LOST_WITH_RECOVERY.recovery.fence) // a repeat sighting must not double-ack
      const sid = client._sessions[0].sessionId
      expect(call).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenCalledWith('lifecycle.recoverAck', {
        sessionId: sid,
        generation: LOST_WITH_RECOVERY.recovery.generation,
      })
    } finally {
      teardown()
    }
  })

  it('a refused acknowledgement keeps the pending guard: no editor is offered until the episode ends', async () => {
    const client = makeClient()
    client.dispatcher.call = vi.fn().mockRejectedValue(new Error('session is not open'))
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      const ed = editorOf(content)
      const subscribe = client.dispatcher.subscribe
      const handler = subscribe.mock.calls[0][1] as (params: unknown) => void
      const setAction = vi.spyOn(ed, 'setRecoveryAction')
      handler(LOST_WITH_RECOVERY)
      rendererOf(content)._fireRecoveryFence(LOST_WITH_RECOVERY.recovery.fence)
      await Promise.resolve()
      await Promise.resolve()
      // The refusal left the episode pending: the action stays suppressed.
      const calls = setAction.mock.calls
      const last = calls[calls.length - 1]
      expect(last[0]).toBeNull()
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
  it('no stream sequence can flip the presentation to editor — it is always terminal', async () => {
    const { content, teardown } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    const renderer = rendererOf(content)
    try {
      content.setVisible(true)
      // Even a full marker cycle cannot reach 'editor': the presentation
      // axis is severed (ADR-0024 §1) — no ownership, no editor.
      renderer._fireCommandMarker({ kind: 'A', line: 0, col: 0, buffer: 'normal' })
      renderer._fireCommandMarker({ kind: 'B', line: 0, col: 0, buffer: 'normal' })
      expect(content.presentation).toBe('terminal')
      // The user gestures still exist and leave the presentation alone.
      content.switchToTerminalInput()
      expect(content.presentation).toBe('terminal')
      content.switchToEditorInput()
      expect(content.presentation).toBe('terminal')
    } finally {
      teardown()
    }
  })

  it('the choice is session-scoped — every session starts terminal', async () => {
    const { content: first, teardown: teardown1 } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    try {
      first.setVisible(true)
      first.switchToTerminalInput()
      expect(first.presentation).toBe('terminal')
    } finally {
      teardown1()
    }

    // A brand-new session starts with the same default.
    const { content: second, teardown: teardown2 } = await mountTerminal(makeClipboard(), {
      attachToDocument: true,
    })
    try {
      second.setVisible(true)
      expect(second.presentation).toBe('terminal')
    } finally {
      teardown2()
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
})

describe('the projections consume the kernel through the composition root (ADR-0024 §5–§7, bead nocx-u7uh.7)', () => {
  /** The lifecycle fact handler TerminalContent registered on the fake
   *  dispatcher — the wire seam tests deliver authenticated facts through. */
  function factHandler(client: ClientFake): (p: unknown) => void {
    const subscribe = client.dispatcher.subscribe
    expect(subscribe).toHaveBeenCalledWith('lifecycle.changed', expect.any(Function))
    return subscribe.mock.calls[0][1] as (p: unknown) => void
  }

  it('the native escape holds through a later prompt_ready fact — the input router (ADR-0024 §6)', async () => {
    const client = makeClient()
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      const ed = editorOf(content)
      const handler = factHandler(client)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      expect(ed.isVisible).toBe(true)
      // The user's own escape: the editor hides, keys route raw.
      content.switchToTerminalInput()
      expect(ed.isVisible).toBe(false)
      // A native fact and ANOTHER authenticated prompt must not undo the
      // escape — the latch is the user's, the authority stays the kernel's.
      handler({ lane: 'lane-1', lifecycle: 'native' })
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      expect(ed.isVisible).toBe(false)
      // The explicit switch back restores the editor at the authenticated prompt.
      content.switchToEditorInput()
      expect(ed.isVisible).toBe(true)
    } finally {
      teardown()
    }
  })

  it('the capability rail reports the kernel state — integrated only from an authenticated prompt', async () => {
    const client = makeClient()
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      // The kernel starts Native: a conventional terminal, unsupported.
      expect(content.shellState).toBe('unsupported')
      const handler = factHandler(client)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      expect(content.shellState).toBe('integrated')
      handler({ lane: 'lane-1', lifecycle: 'lost' })
      expect(content.shellState).toBe('lost')
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd2', epoch: 2 })
      expect(content.shellState).toBe('integrated')
    } finally {
      teardown()
    }
  })

  it('a submitted command freezes its block and persists history from the authenticated completion', async () => {
    const client = makeClient()
    const callMock = client.call
    callMock.mockImplementation((method: string) => {
      if (method === 'history.record') {
        return Promise.resolve({
          maskedCount: 0,
          maskedKinds: [],
          entryId: 'e1',
          redactions: [],
          captures: [],
          maskedCommand: 'make',
        })
      }
      return Promise.reject(new Error('no store wired (fake)'))
    })
    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    const handler = factHandler(client)
    const withScrollback = content as unknown as { scrollback: ScrollbackController }
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    const protoScrollIntoView = Element.prototype.scrollIntoView
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    Element.prototype.scrollIntoView = () => {}
    try {
      content.setVisible(true)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      expect(ed.isVisible).toBe(true)
      ed.insertText('make')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      // The app-owned submit opened a ledger record and a running block.
      expect(withScrollback.scrollback.blockManager.blocks).toHaveLength(1)
      expect(withScrollback.scrollback.blockManager.blocks[0].status).toBe('running')

      // The published attempt: the shell start attaches, then completes.
      handler({
        lane: 'lane-1',
        lifecycle: 'running',
        domain: 'd1',
        epoch: 1,
        attempt: { id: 'att-1', state: 'open', origin: 'app', command: 'make' },
      })
      // The published running fact must NOT tear the block model down: the
      // pane stays in the running layout with the block visible. It used to
      // call setUnstructured unconditionally here, which put the pane back
      // into the full-pane conventional grid on every fact — the block was
      // in the DOM but hidden (inner-fullscreen-mode), so a live session
      // showed a flat stream with no block, no freeze, no exit status
      // (nocx-u7uh.25).
      expect(withScrollback.scrollback.mode).toBe('running')
      expect(
        withScrollback.scrollback.scrollbackInner.classList.contains('inner-fullscreen-mode'),
      ).toBe(false)
      handler({
        lane: 'lane-1',
        lifecycle: 'running',
        domain: 'd1',
        epoch: 1,
        attempt: {
          id: 'att-1',
          state: 'completed',
          exitCode: 0,
          fence: 'a'.repeat(64),
          completedAt: '2026-08-08T12:00:02Z',
        },
      })

      // The block froze with the authenticated status.
      const frozen = withScrollback.scrollback.blockManager.blocks[0]
      expect(frozen.status).toBe('success')
      expect(frozen.exitCode).toBe(0)
      expect(frozen.attemptId).toBe('att-1')
      expect(withScrollback.scrollback.blockManager.runningBlock).toBeNull()

      // History persisted the app-owned text, authorized by the attempt.
      const recordCall = callMock.mock.calls.find((c) => c[0] === 'history.record')
      expect(recordCall).toBeTruthy()
      const params = recordCall![1] as { command: string; status: string; exitCode: number }
      expect(params.command).toBe('make')
      expect(params.status).toBe('success')
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      Element.prototype.scrollIntoView = protoScrollIntoView
      teardown()
    }
  })

  it('a desynchronized or lost domain keeps the conventional unstructured grid (ADR-0024 §4, §9)', async () => {
    const client = makeClient()
    const { content, teardown } = await mountTerminal(makeClipboard(), {}, client)
    try {
      const handler = factHandler(client)
      const withScrollback = content as unknown as { scrollback: ScrollbackController }
      // The kernel starts Native: a conventional terminal, full-pane grid.
      expect(withScrollback.scrollback.mode).toBe('unstructured')
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      // A desynchronized domain is not live (decision 9): its terminal
      // stays visible and the block model never takes over — the pane is
      // the conventional unstructured grid, blocks hidden.
      handler({ lane: 'lane-1', lifecycle: 'desynchronized', domain: 'd1', epoch: 1 })
      expect(withScrollback.scrollback.mode).toBe('unstructured')
      expect(
        withScrollback.scrollback.scrollbackInner.classList.contains('inner-fullscreen-mode'),
      ).toBe(true)
      // Loss is conventional too: the grid stays, the block model stays out.
      handler({ lane: 'lane-1', lifecycle: 'lost' })
      expect(withScrollback.scrollback.mode).toBe('unstructured')
    } finally {
      teardown()
    }
  })

  it('the grid turns writable when the command starts — raw input is never dropped (nocx-u7uh.23)', async () => {
    const client = makeClient()
    const { content, ed, view, teardown } = await mountTerminal(makeClipboard(), {}, client)
    /* eslint-disable @typescript-eslint/unbound-method */
    const protoScrollTo = Element.prototype.scrollTo
    /* eslint-enable @typescript-eslint/unbound-method */
    Element.prototype.scrollTo = () => {}
    try {
      const renderer = rendererOf(content)
      // The typed interface says setReadOnly(boolean); the mock clears its
      // call history — reached through a cast, like the existing tests do.
      const readOnlyMock = (renderer as unknown as { setReadOnly: ReturnType<typeof vi.fn> })
        .setReadOnly
      const handler = factHandler(client)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      expect(ed.isVisible).toBe(true)
      expect(readOnlyMock).toHaveBeenLastCalledWith(true)
      readOnlyMock.mockClear()

      // The atomic handoff: the editor hides ITSELF at commit, and the
      // submit callback makes the grid writable in the SAME synchronous
      // step the bytes go out — keys typed before the running fact lands
      // must reach the pty, never be dropped (the u7uh.23 vanish).
      ed.insertText('read x')
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      expect(ed.isVisible).toBe(false)
      expect(readOnlyMock).toHaveBeenLastCalledWith(false)

      // The published attempt opens the running interval; the sync keeps
      // the grid writable — a program waiting on stdin (read, ssh, less)
      // is fed by raw keys with no editor and no input surface lost.
      handler({
        lane: 'lane-1',
        lifecycle: 'running',
        domain: 'd1',
        epoch: 1,
        attempt: { id: 'att-1', state: 'open', origin: 'app', command: 'read x' },
      })
      expect(ed.isVisible).toBe(false)
      expect(readOnlyMock).toHaveBeenLastCalledWith(false)
      // The completion closes the interval, and back at the prompt the
      // editor returns and the grid locks again.
      handler({
        lane: 'lane-1',
        lifecycle: 'running',
        domain: 'd1',
        epoch: 1,
        attempt: {
          id: 'att-1',
          state: 'completed',
          exitCode: 0,
          fence: 'a'.repeat(64),
          completedAt: '2026-08-08T12:00:02Z',
        },
      })
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      expect(ed.isVisible).toBe(true)
      expect(readOnlyMock).toHaveBeenLastCalledWith(true)
    } finally {
      Element.prototype.scrollTo = protoScrollTo
      teardown()
    }
  })
})

describe('the editor submit opens the attempt before the pty write (ADR-0024 §5, nocx-u7uh.18)', () => {
  /** The lifecycle fact handler TerminalContent registered on the fake
   *  dispatcher — the wire seam tests deliver authenticated facts through. */
  function factHandler(client: ClientFake): (p: unknown) => void {
    const subscribe = client.dispatcher.subscribe
    expect(subscribe).toHaveBeenCalledWith('lifecycle.changed', expect.any(Function))
    return subscribe.mock.calls[0][1] as (p: unknown) => void
  }

  /** Dispatch a keydown exactly where a user's keystroke lands. */
  const key = (view: EditorView, init: KeyboardEventInit): void => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    )
  }

  /** jsdom does not implement scrollTo/scrollIntoView; the block model
   *  calls them on submit. Stub them for the duration — the same trade the
   *  projections tests make. Returns the restore. */
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
  it('a submit at a live prompt opens the attempt with the app-owned text BEFORE the pty write', async () => {
    const client = makeClient()
    const submitAttempt = client.dispatcher.call
    // Promise.withResolvers needs ES2024 and this project targets ES2021, so
    // the resolver is captured via the executor form (the codebase pattern).
    let resolveAttempt!: (v: unknown) => void
    const attemptPromise = new Promise<unknown>((done) => {
      resolveAttempt = done
    })
    submitAttempt.mockImplementation(() => attemptPromise)
    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    // The escape hatch TerminalContent keeps `session` private (the
    // editorOf/rendererOf pattern).
    const withSession = content as unknown as { session: SessionFake }
    const session = withSession.session
    const withScrollback = content as unknown as { scrollback: ScrollbackController }
    const handler = factHandler(client)
    const restoreScroll = stubScrolling()
    try {
      content.setVisible(true)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      ed.show()
      ed.insertText('make deploy')
      key(view, { key: 'Enter' })

      // The attempt-open call went out synchronously at submit, with the
      // app-owned text, cwd and host — and the pty write has NOT happened.
      // The ordering is asserted, not assumed: the backend emits the
      // running fact INSIDE SubmitAttempt, so the bytes must wait for the
      // answer or the shell's start could open a second attempt first.
      expect(submitAttempt).toHaveBeenCalledWith('lifecycle.submitAttempt', {
        domain: 'd1',
        command: 'make deploy',
        cwd: FIXTURE_CWD,
        host: '',
      })
      expect(session.send).not.toHaveBeenCalled()
      // The running block opened at submit, before any fact could arrive —
      // the published running fact always finds the block it binds to.
      expect(withScrollback.scrollback.blockManager.blocks).toHaveLength(1)

      // The backend answers: only now do the bytes go out.
      resolveAttempt({
        id: 'att-9',
        domain: 'd1',
        state: 'open',
        command: 'make deploy',
        cwd: FIXTURE_CWD,
        host: '',
        origin: 'app',
        startedAt: '2026-08-08T12:00:00Z',
      })
      await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(1))
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('the attempt receives the reference-intact record line, never the resolved send line', async () => {
    const client = makeClient()
    // vault.resolveLine goes over the WSClient seam (client.call); the
    // attempt-open goes over the dispatcher (client.dispatcher.call).
    client.call.mockImplementation((method: string) => {
      if (method === 'vault.resolveLine') {
        return Promise.resolve({
          line: 'make --token=SECRETVALUE',
          refs: [{ name: 'TOKEN', resolved: true }],
        })
      }
      return Promise.reject(new Error('no store wired (fake)'))
    })
    const submitAttempt = client.dispatcher.call
    // Promise.withResolvers needs ES2024 and this project targets ES2021, so
    // the resolver is captured via the executor form (the codebase pattern).
    let resolveAttempt!: (v: unknown) => void
    const attemptPromise = new Promise<unknown>((done) => {
      resolveAttempt = done
    })
    submitAttempt.mockImplementation(() => attemptPromise)
    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    // The escape hatch TerminalContent keeps `session` private (the
    // editorOf/rendererOf pattern).
    const withSession = content as unknown as { session: SessionFake }
    const session = withSession.session
    const renderer = rendererOf(content)
    const handler = factHandler(client)
    const restoreScroll = stubScrolling()
    try {
      content.setVisible(true)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      ed.show()
      ed.insertText('make --token={{secret:TOKEN}}')
      key(view, { key: 'Enter' })

      // The line with references resolves first (ADR-0021); the attempt
      // then opens with the RECORD line — reference intact (decision 5's
      // privacy rule) — while the RESOLVED line goes to the pty and
      // nowhere else.
      await vi.waitFor(() =>
        expect(submitAttempt).toHaveBeenCalledWith('lifecycle.submitAttempt', {
          domain: 'd1',
          command: 'make --token={{secret:TOKEN}}',
          cwd: FIXTURE_CWD,
          host: '',
        }),
      )
      expect(session.send).not.toHaveBeenCalled()
      resolveAttempt({
        id: 'att-10',
        domain: 'd1',
        state: 'open',
        command: 'make --token={{secret:TOKEN}}',
        cwd: FIXTURE_CWD,
        host: '',
        origin: 'app',
        startedAt: '2026-08-08T12:00:00Z',
      })
      await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(1))
      const pasteMock = renderer as unknown as { paste: ReturnType<typeof vi.fn> }
      expect(pasteMock.paste).toHaveBeenCalledWith('make --token=SECRETVALUE')
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('a submit with no live domain opens no attempt — the terminal stays conventional', async () => {
    const client = makeClient()
    const submitAttempt = client.dispatcher.call
    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    // The escape hatch TerminalContent keeps `session` private (the
    // editorOf/rendererOf pattern).
    const withSession = content as unknown as { session: SessionFake }
    const session = withSession.session
    const restoreScroll = stubScrolling()
    try {
      content.setVisible(true)
      // No fact was delivered: the kernel is Native, the session is a
      // conventional terminal.
      ed.show()
      ed.insertText('make deploy')
      key(view, { key: 'Enter' })

      // The write goes out on the synchronous path and no attempt-open call
      // was ever made — nothing is fabricated for a conventional terminal.
      expect(submitAttempt).not.toHaveBeenCalled()
      expect(session.send).toHaveBeenCalledTimes(1)
    } finally {
      restoreScroll()
      teardown()
    }
  })

  it('an empty line is a bare newline: no attempt, no ledger record, but the shell still gets its newline', async () => {
    const client = makeClient()
    const submitAttempt = client.dispatcher.call
    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    // The escape hatch TerminalContent keeps `session` private (the
    // editorOf/rendererOf pattern).
    const withSession = content as unknown as { session: SessionFake }
    const session = withSession.session
    const withLedger = content as unknown as { ledger: CommandLedger }
    const handler = factHandler(client)
    try {
      content.setVisible(true)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      ed.show()
      key(view, { key: 'Enter' }) // empty draft

      // A bare newline is not an execution: no attempt-open call, no ledger
      // record (CommandLedger.open refuses empty commands), no crash — and
      // the shell still receives its newline.
      expect(submitAttempt).not.toHaveBeenCalled()
      expect(withLedger.ledger.records()).toHaveLength(0)
      expect(session.send).toHaveBeenCalledTimes(1)
    } finally {
      teardown()
    }
  })

  it('a refused attempt never swallows the command: the bytes still go out', async () => {
    const client = makeClient()
    client.dispatcher.call.mockRejectedValue(new RpcError('lifecycle: no prompt is ready', -32602))
    const { view, ed, content, teardown } = await mountTerminal(
      makeClipboard(),
      { attachToDocument: true },
      client,
    )
    // The escape hatch TerminalContent keeps `session` private (the
    // editorOf/rendererOf pattern).
    const withSession = content as unknown as { session: SessionFake }
    const session = withSession.session
    const handler = factHandler(client)
    const restoreScroll = stubScrolling()
    try {
      content.setVisible(true)
      handler({ lane: 'lane-1', lifecycle: 'prompt_ready', domain: 'd1', epoch: 1 })
      ed.show()
      ed.insertText('make deploy')
      key(view, { key: 'Enter' })

      // Fail-open: the domain lost its prompt between the last fact and the
      // Enter, the attempt was refused — and the command still runs.
      await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(1))
    } finally {
      restoreScroll()
      teardown()
    }
  })
})
