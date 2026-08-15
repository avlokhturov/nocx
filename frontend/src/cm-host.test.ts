// @vitest-environment jsdom
//
// CM host tests — the ownership contract from the git-manager design §5.4:
// read-only enforcement, caller extensions appended after the host's, setDoc
// as the one document writer, and disposal on both paths (explicit dispose()
// and AbortSignal). Everything is asserted through the DOM and the public
// methods — the underlying EditorView is the host's private property.
//
// The host has two modes and one lifecycle (nocx-gjnr): ReadOnlyHost is the
// file viewer's and the diff's, EditableHost is the snippet body editor's.
// The read-only tests below are the reason the modes are one module — an
// editable sibling built beside it would have been a second construction of
// the same view, free to drift on the theme, the disposal and the facets.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { EditableHost, ReadOnlyHost } from './cm-host'

// CM6 renders each line as a div.cm-line (no newline text nodes), so a raw
// textContent read collapses lines. Joining the line divs reconstructs the
// document exactly, including a trailing empty line for a final newline.
const docText = (parent: HTMLElement): string =>
  Array.from(parent.querySelectorAll('.cm-line'))
    .map((el) => el.textContent ?? '')
    .join('\n')

interface Mounted {
  host: ReadOnlyHost
  parent: HTMLElement
  controller: AbortController
}

function mountHost(extensions: Extension[] = []): Mounted {
  const host = new ReadOnlyHost()
  const parent = document.createElement('div')
  document.body.append(parent)
  const controller = new AbortController()
  host.mount(parent, controller.signal, extensions)
  return { host, parent, controller }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ReadOnlyHost — read-only enforcement', () => {
  it('no keystroke can reach the document, even through caller extensions that try to re-enable editing', () => {
    const { host, parent } = mountHost([
      // A hostile caller extension attempting to defeat the host: the host's
      // facets come first in the extension array and CM6 resolves them by
      // precedence with the first value winning, so this cannot win.
      EditorState.readOnly.of(false),
      EditorView.editable.of(true),
    ])
    host.setDoc('frozen\ncontent\n')

    const contentEl = parent.querySelector('.cm-content') as HTMLElement
    // The structural guarantees: not an editable region, declared read-only.
    expect(contentEl.getAttribute('contenteditable')).toBe('false')
    expect(contentEl.getAttribute('aria-readonly')).toBe('true')

    const key = (init: KeyboardEventInit): void => {
      contentEl.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      )
    }
    key({ key: 'a' })
    key({ key: 'Enter' })
    key({ key: 'Backspace' })
    key({ key: 'x', ctrlKey: true })

    expect(docText(parent)).toBe('frozen\ncontent\n')
    host.dispose()
  })

  it('caller extensions are appended after the host and take effect', () => {
    const { host, parent } = mountHost([
      EditorView.editorAttributes.of({ class: 'caller-extension-marker' }),
    ])
    host.setDoc('text')

    expect(parent.querySelector('.cm-editor')?.classList.contains('caller-extension-marker')).toBe(
      true,
    )
    expect(docText(parent)).toBe('text')
    host.dispose()
  })
})

describe('ReadOnlyHost — document replacement', () => {
  it('setDoc replaces the whole document, never appending', () => {
    const { host, parent } = mountHost()
    host.setDoc('first')
    host.setDoc('second')

    expect(docText(parent)).toBe('second')
    host.dispose()
  })
})

describe('ReadOnlyHost — disposal', () => {
  it('dispose() destroys the view and is idempotent', () => {
    const { host, parent } = mountHost()
    host.setDoc('text')
    expect(parent.querySelector('.cm-editor')).not.toBeNull()

    host.dispose()
    // EditorView.destroy removes its element from the document.
    expect(parent.querySelector('.cm-editor')).toBeNull()

    // A second dispose, and post-dispose setDoc/focus, are inert.
    host.dispose()
    host.setDoc('late')
    host.focus()
    expect(docText(parent)).toBe('')
  })

  it('aborting the signal destroys the view', () => {
    const { host, parent, controller } = mountHost()
    host.setDoc('text')
    expect(parent.querySelector('.cm-editor')).not.toBeNull()

    controller.abort()
    expect(parent.querySelector('.cm-editor')).toBeNull()

    // A second abort and an explicit dispose afterwards are no-ops.
    controller.abort()
    host.dispose()
  })

  it('a signal already aborted at mount mounts nothing and leaks no view', () => {
    const host = new ReadOnlyHost()
    const parent = document.createElement('div')
    document.body.append(parent)
    const controller = new AbortController()
    controller.abort()

    host.mount(parent, controller.signal)
    expect(parent.querySelector('.cm-editor')).toBeNull()
    host.dispose()
  })
})

describe('EditableHost — the editable mode of the same host', () => {
  it('takes typed input the read-only mode refuses, and reports the document', () => {
    const host = new EditableHost()
    const parent = document.createElement('div')
    document.body.append(parent)
    const controller = new AbortController()
    host.mount(parent, controller.signal)
    host.setDoc('start')

    const contentEl = parent.querySelector('.cm-content') as HTMLElement
    expect(contentEl.getAttribute('contenteditable')).toBe('true')
    expect(contentEl.getAttribute('aria-readonly')).toBe(null)

    // What the read-only mode's own test proves cannot happen: keystrokes
    // reach an editable region. jsdom does not emulate contenteditable
    // input, so the assertion is the structural one above plus the
    // document seam the surface actually saves from.
    expect(host.doc()).toBe('start')
    expect(docText(parent)).toBe('start')

    host.dispose()
  })

  it('reports every document change to the caller, so a draft never lags the field', () => {
    const seen: string[] = []
    const host = new EditableHost()
    const parent = document.createElement('div')
    document.body.append(parent)
    const controller = new AbortController()
    host.mount(parent, controller.signal, [], (text) => seen.push(text))

    host.setDoc('one')
    host.setDoc('two')

    // setDoc is a document change like any other, and the listener is how
    // the surface's draft signal follows the field: a surface that only
    // read doc() on Save would write what it last set rather than what the
    // person typed.
    expect(seen).toEqual(['one', 'two'])
    host.dispose()
  })

  it('doc() is empty before mount and after dispose, never a stale document', () => {
    const host = new EditableHost()
    expect(host.doc()).toBe('')
    const parent = document.createElement('div')
    document.body.append(parent)
    const controller = new AbortController()
    host.mount(parent, controller.signal)
    host.setDoc('text')
    host.dispose()
    expect(host.doc()).toBe('')
  })
})
