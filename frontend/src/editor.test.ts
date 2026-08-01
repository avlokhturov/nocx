// @vitest-environment jsdom
//
// CommandEditor tests, rewritten for the CodeMirror 6 engine (ADR-0010, W1).
// No querySelector('textarea'), no .value/.rows/.selectionStart pokes: the
// suite asserts through the public API and observable behaviour.
//
// Honesty about the one seam: jsdom performs no layout and no native
// contenteditable editing, so a real keystroke/selection gesture is
// impossible here. Tests therefore seed selections through the CM6 view
// (`viewOf` — the same transaction a mouse drag produces) and dispatch
// keydown/mouseup on the view's contentDOM (where real events land). Almost
// every outcome is then observed through the public callbacks — submit,
// cancel, onInputChange, onSelectionEnd, resized, onAcceptHint, focus,
// visibility. The document is read back directly in exactly three places
// where no public channel exists and the assertion is state integrity
// (cleared after a throwing submit; untouched by a no-op Ctrl-C).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { CommandEditor, EditorActions } from './editor'
import { shellExtensions, highlightShellText, shellHighlightReady } from './shell-highlight'
import { CommandSnapshotStore } from './command-snapshot'

/**
 * The editor's internal CM6 view. CommandEditor keeps it private; tests
 * reach it only to seed selections and to read the document where no public
 * channel exists (see file header).
 */
const viewOf = (ed: CommandEditor): EditorView => {
  const withView = ed as unknown as { view: EditorView }
  return withView.view
}

const setup = (actions: Partial<EditorActions> = {}, extensions: Extension[] = []) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const order: string[] = []
  const submit = vi.fn((doc: string) => order.push(`submit:${doc}`))
  const cancel = vi.fn(() => order.push('cancel'))
  const ed = new CommandEditor({ submit, cancel, ...actions }, extensions)
  ed.mount(container)
  const view = viewOf(ed)
  return { ed, view, submit, cancel, order, container }
}

/** Dispatch a keydown exactly where a user's keystroke lands. */
const key = (view: EditorView, init: KeyboardEventInit) =>
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  )

const enter = (view: EditorView, shift = false) => key(view, { key: 'Enter', shiftKey: shift })

const ctrlC = (view: EditorView) => key(view, { key: 'c', ctrlKey: true })

const escape = (view: EditorView) => key(view, { key: 'Escape' })

/** Seed a selection the way a mouse drag would (gesture stand-in). */
const select = (view: EditorView, anchor: number, head: number) =>
  view.dispatch({ selection: { anchor, head } })

describe('CommandEditor', () => {
  it('starts hidden; show/hide toggle isVisible', () => {
    const { ed } = setup()
    expect(ed.isVisible).toBe(false)
    ed.show()
    expect(ed.isVisible).toBe(true)
    ed.hide()
    expect(ed.isVisible).toBe(false)
  })

  it('Enter hides+clears before submit (atomic handoff)', () => {
    const { ed, view, submit, order } = setup()
    ed.show()
    ed.insertText('echo hi')
    submit.mockImplementation((d: string) => order.push(`visible@submit:${ed.isVisible}|${d}`))
    enter(view)
    expect(submit).toHaveBeenCalledWith('echo hi')
    expect(order[0]).toBe('visible@submit:false|echo hi') // hidden BEFORE submit

    // The clear half of the handoff, observed publicly: the next prompt shows
    // an empty editor — had 'echo hi' survived, this submit would carry it.
    ed.show()
    ed.insertText('fresh')
    enter(view)
    expect(submit).toHaveBeenLastCalledWith('fresh')
  })

  it('submit receives the composed document byte-identical', () => {
    const { ed, view, submit } = setup()
    ed.show()
    ed.insertText('echo "a\tb"  &&\nprintf ok')
    enter(view)
    expect(submit).toHaveBeenCalledWith('echo "a\tb"  &&\nprintf ok')
  })

  // Tab is completion's key, and completion is not built yet. What it must
  // NOT be meanwhile is the browser's focus-move: measured in a real browser
  // on 2026-08-02, pressing Tab at the prompt took document.activeElement
  // from .cm-content to nothing, so the next keystroke went nowhere. The
  // keydown is cancelled and the document is untouched — pressing Tab does
  // nothing, visibly, instead of doing something invisible and wrong.
  it('Tab is swallowed at the prompt rather than moving the focus away', () => {
    const { ed, view } = setup()
    ed.show()
    ed.insertText('ec')
    const delivered = key(view, { key: 'Tab' })
    expect(delivered).toBe(false) // preventDefault: no browser focus move
    expect(view.state.doc.toString()).toBe('ec')
  })

  it('Ctrl/Cmd+Tab is left alone — it belongs to the window, not the prompt', () => {
    const { ed, view } = setup()
    ed.show()
    expect(key(view, { key: 'Tab', ctrlKey: true })).toBe(true)
    expect(key(view, { key: 'Tab', metaKey: true })).toBe(true)
  })

  it('Shift+Enter does not submit', () => {
    const { ed, view, submit } = setup()
    ed.show()
    ed.insertText('x')
    enter(view, true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('Ctrl-C with no selection clears and cancels (interrupt)', () => {
    const { ed, view, cancel, submit } = setup()
    ed.show()
    ed.insertText('echo partial')
    ctrlC(view)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()

    // Cleared, observed publicly: what the next prompt shows is only 'fresh'.
    ed.insertText('fresh')
    enter(view)
    expect(submit).toHaveBeenLastCalledWith('fresh')
  })

  it('Ctrl-C with a selection is left alone so copy still works', () => {
    const { ed, view, cancel } = setup()
    ed.show()
    ed.insertText('echo hi')
    select(view, 0, 7) // "echo hi" fully selected
    ctrlC(view)
    expect(cancel).not.toHaveBeenCalled()
    expect(viewOf(ed).state.doc.toString()).toBe('echo hi') // draft untouched
  })

  it('Escape clears the draft, does not cancel (no shell interrupt)', () => {
    const { ed, view, cancel, submit } = setup()
    ed.show()
    ed.insertText('some draft')
    escape(view)
    expect(cancel).not.toHaveBeenCalled()

    // Cleared, observed publicly: the next submit carries only what was typed
    // after the escape.
    ed.insertText('fresh')
    enter(view)
    expect(submit).toHaveBeenLastCalledWith('fresh')
  })

  it('IME composition keys are never interpreted as editor commands', () => {
    const { ed, view, cancel, submit } = setup()
    ed.show()
    ed.insertText('ni')
    // A composition-in-progress Enter (accepting a candidate) must not submit.
    key(view, { key: 'Enter', isComposing: true })
    expect(submit).not.toHaveBeenCalled()
    // ... nor a composing Ctrl-C or Escape.
    key(view, { key: 'c', ctrlKey: true, isComposing: true })
    key(view, { key: 'Escape', isComposing: true })
    expect(cancel).not.toHaveBeenCalled()

    // Draft intact, observed publicly: 'ni' still leads the next submit.
    ed.insertText('!')
    enter(view)
    expect(submit).toHaveBeenLastCalledWith('ni!')
  })

  it('insertText inserts at the caret, replacing any selection', () => {
    const { ed, view, submit } = setup()
    ed.show()
    ed.insertText('echo XX')
    select(view, 5, 7) // select "XX"
    ed.insertText('hi')
    // Replaced, not appended: the next insertion lands after 'hi' and the
    // submitted document is exactly 'echo hi!'.
    ed.insertText('!')
    enter(view)
    expect(submit).toHaveBeenCalledWith('echo hi!')
  })

  it('insertText focuses the editor when visible', () => {
    const { ed, view } = setup()
    ed.show()
    ed.insertText('a')
    expect(document.activeElement).toBe(view.contentDOM)
  })

  it('applies the nocx-editor-input class to the input surface', () => {
    const { view } = setup()
    expect(view.contentDOM.classList.contains('nocx-editor-input')).toBe(true)
  })

  it('multiline: the host is told when the capped row count changes', () => {
    const resized = vi.fn()
    const { ed } = setup({ resized })
    ed.show()
    expect(resized).not.toHaveBeenCalled() // 1 line = no growth

    ed.insertText('line1\nline2\nline3')
    expect(resized).toHaveBeenCalledTimes(1) // 3 lines

    ed.insertText('\nline4')
    expect(resized).toHaveBeenCalledTimes(2) // 4 lines
  })

  it('multiline: growth reports stop at the ten-line cap', () => {
    const resized = vi.fn()
    const { ed } = setup({ resized })
    ed.show()
    ed.insertText(Array(15).fill('line').join('\n'))
    expect(resized).toHaveBeenCalledTimes(1) // capped at 10, fired once

    ed.insertText('\nline16')
    expect(resized).toHaveBeenCalledTimes(1) // still 10 rows — no further report
  })

  it('setCwd updates the cwd chip text', () => {
    const { ed, container } = setup()
    ed.show()
    expect(container.querySelector('.nocx-editor-cwd')!.textContent).toContain('~')
    ed.setCwd('/home/dev/projects')
    expect(container.querySelector('.nocx-editor-cwd')!.textContent).toContain('dev/projects')
  })

  it('setTime updates the time chip', () => {
    const { ed, container } = setup()
    ed.setTime(new Date('2026-08-01T12:34:56'))
    expect(container.querySelector('.nocx-editor-time')!.textContent).toContain('12:34:56')
  })

  it('rootContains returns true for the input surface and chrome (focus-bounce)', () => {
    const { ed, view, container } = setup()
    ed.show()
    // The focus-bounce tests `rootContains(activeElement)`; with CM6 the active
    // element is the contentDOM, so this is the contract that must hold.
    expect(ed.rootContains(view.contentDOM)).toBe(true)
    expect(ed.rootContains(container.querySelector('.nocx-editor-cwd'))).toBe(true)
  })

  it('rootContains returns false for elements outside the editor root', () => {
    const { ed, container } = setup()
    ed.show()
    expect(ed.rootContains(document.body)).toBe(false)
    expect(ed.rootContains(container)).toBe(false) // mount parent, not inside root
    expect(ed.rootContains(null)).toBe(false)
  })

  it('after hide()/show() the editor is focusable, re-measured, and functional', () => {
    const { ed, view, submit } = setup()
    const requestMeasure = vi.spyOn(view, 'requestMeasure')
    ed.show()
    ed.insertText('first')
    ed.hide()
    expect(ed.isVisible).toBe(false)
    ed.show()
    // A hidden CM6 view can cache wrong geometry; show() must re-measure.
    expect(requestMeasure).toHaveBeenCalled()
    expect(ed.isVisible).toBe(true)
    expect(document.activeElement).toBe(view.contentDOM) // focus lands
    ed.insertText(' + second')
    enter(view)
    expect(submit).toHaveBeenCalledWith('first + second') // editing still works
    requestMeasure.mockRestore()
  })

  it('onSelectionEnd fires with the selected text when a selection gesture completes', () => {
    const onSelectionEnd = vi.fn()
    const { ed, view } = setup()
    ed.onSelectionEnd(onSelectionEnd) // a method, not a constructor action
    ed.show()
    ed.insertText('echo hello world')
    select(view, 5, 10) // "hello"
    view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(onSelectionEnd).toHaveBeenCalledWith('hello')
    expect(onSelectionEnd).toHaveBeenCalledTimes(1)
  })

  it('onSelectionEnd does not fire for a collapsed selection', () => {
    const onSelectionEnd = vi.fn()
    const { ed, view } = setup()
    ed.onSelectionEnd(onSelectionEnd)
    ed.show()
    ed.insertText('echo hi')
    view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(onSelectionEnd).not.toHaveBeenCalled()
  })

  it('onInputChange fires on a user-driven document change with the text', () => {
    const onInputChange = vi.fn()
    const { ed, view } = setup({ onInputChange })
    ed.show()
    // The transaction a keystroke produces: a plain dispatch, not the public API.
    view.dispatch({ changes: { from: 0, insert: 'hello' } })
    expect(onInputChange).toHaveBeenCalledWith('hello')
    view.dispatch({ changes: { from: 0, to: 5, insert: 'ssh prod' } })
    expect(onInputChange).toHaveBeenCalledWith('ssh prod')
    expect(onInputChange).toHaveBeenCalledTimes(2)
  })

  it('onInputChange does not fire for programmatic edits (paste/accept parity)', () => {
    const onInputChange = vi.fn()
    const { ed } = setup({ onInputChange })
    ed.show()
    ed.insertText('ssh prod')
    expect(onInputChange).not.toHaveBeenCalled()
  })

  it('constructor extensions reach the CM6 view', () => {
    const ran: string[] = []
    const ext = keymap.of([{ key: 'F8', run: () => (ran.push('F8'), true) }])
    const { ed, view } = setup({}, [ext])
    ed.show()
    key(view, { key: 'F8' })
    expect(ran).toEqual(['F8'])
  })

  it('Enter still submits even when a default-precedence keymap binds it (keymap precedence)', () => {
    // The scenario ADR-0010 §4 warns about: CM6's defaultKeymap binds Enter to
    // insertNewline. Without Prec.highest that binding would insert a newline —
    // W1's interception must win so the submit contract survives.
    const { ed, view, submit } = setup({}, [keymap.of(defaultKeymap)])
    ed.show()
    ed.insertText('abc')
    enter(view)
    expect(submit).toHaveBeenCalledWith('abc')
  })

  it('a throwing onInputChange cannot corrupt the editor (fail-open)', () => {
    const { ed, view, submit } = setup({
      onInputChange: () => {
        throw new Error('consumer bug')
      },
    })
    ed.show()
    ed.insertText('still works')
    enter(view)
    expect(submit).toHaveBeenCalledWith('still works')
  })

  it('a throwing resized cannot corrupt the editor (fail-open)', () => {
    const { ed, view, submit } = setup({
      resized: () => {
        throw new Error('consumer bug')
      },
    })
    ed.show()
    ed.insertText('a\nb')
    enter(view)
    expect(submit).toHaveBeenCalledWith('a\nb')
  })

  it('a throwing submit leaves the editor hidden and cleared (state consistent)', () => {
    const { ed, view } = setup({
      submit: (d: string) => {
        throw new Error(`submit exploded on ${d}`)
      },
    })
    ed.show()
    ed.insertText('boom')
    // jsdom swallows listener exceptions and reports them as a window 'error'
    // event, which vitest's jsdom environment forwards to
    // process 'uncaughtException' (failing the run) unless a user error
    // listener exists. So the throw cannot be observed with toThrow here; in a
    // real browser it surfaces as an uncaught error AFTER the handoff. What
    // matters is the editor's state: the handoff (clear + hide) already
    // completed before the throw.
    const swallowWindowError = () => {}
    window.addEventListener('error', swallowWindowError)
    try {
      enter(view)
    } finally {
      window.removeEventListener('error', swallowWindowError)
    }
    expect(ed.isVisible).toBe(false)
    expect(viewOf(ed).state.doc.toString()).toBe('')
  })

  it('dispose removes the root and leaves the editor inert, not broken', () => {
    const { ed, container } = setup()
    ed.show()
    ed.dispose()
    expect(container.querySelector('.nocx-editor')).toBeNull()
    expect(() => ed.hide()).not.toThrow()
    expect(ed.isVisible).toBe(false)
    expect(() => ed.insertText('x')).not.toThrow()
  })
})

describe('alias hints', () => {
  const HINT_ITEMS = [
    { alias: 'prod-db', hostName: '10.0.0.1', user: 'deploy' },
    { alias: 'prod-web', hostName: 'web.example.com', port: 2222 },
    { alias: 'staging-db', hostName: 'staging.example.com' },
  ]

  const hintEl = (container: HTMLElement) =>
    container.querySelector('.nocx-editor-hint') as HTMLElement

  it('showAliasHints renders items; hideAliasHints clears them', () => {
    const { ed, container } = setup()
    expect(hintEl(container).style.display).toBe('none')

    ed.showAliasHints(HINT_ITEMS)
    expect(hintEl(container).style.display).not.toBe('none')
    expect(container.querySelectorAll('.nocx-editor-hint__item').length).toBe(3)

    ed.hideAliasHints()
    expect(hintEl(container).style.display).toBe('none')
    expect(container.querySelectorAll('.nocx-editor-hint__item').length).toBe(0)
  })

  it('showAliasHints with an empty list hides the dropdown', () => {
    const { ed, container } = setup()
    ed.show()
    ed.showAliasHints([])
    expect(hintEl(container).style.display).toBe('none')
  })

  it('showAliasHints highlights the first item by default', () => {
    const { ed, container } = setup()
    ed.show()
    ed.showAliasHints(HINT_ITEMS)
    const items = container.querySelectorAll('.nocx-editor-hint__item')
    expect(items[0].classList.contains('nocx-editor-hint__item--selected')).toBe(true)
    expect(items[1].classList.contains('nocx-editor-hint__item--selected')).toBe(false)
  })

  it('ArrowDown/ArrowUp navigates the hint list and wraps', () => {
    const { ed, view, container } = setup()
    ed.show()
    ed.showAliasHints(HINT_ITEMS)
    const items = () => container.querySelectorAll('.nocx-editor-hint__item')

    expect(items()[0].classList.contains('nocx-editor-hint__item--selected')).toBe(true)

    key(view, { key: 'ArrowDown' })
    expect(items()[1].classList.contains('nocx-editor-hint__item--selected')).toBe(true)

    key(view, { key: 'ArrowDown' })
    expect(items()[2].classList.contains('nocx-editor-hint__item--selected')).toBe(true)

    key(view, { key: 'ArrowDown' }) // wrap around
    expect(items()[0].classList.contains('nocx-editor-hint__item--selected')).toBe(true)

    key(view, { key: 'ArrowUp' }) // back up
    expect(items()[2].classList.contains('nocx-editor-hint__item--selected')).toBe(true)
  })

  it('Enter on a hint accepts the alias and does NOT submit', () => {
    const onAcceptHint = vi.fn()
    const { ed, view, submit } = setup({ onAcceptHint })
    ed.show()
    ed.insertText('ssh prod')
    ed.showAliasHints(HINT_ITEMS)
    enter(view)
    expect(submit).not.toHaveBeenCalled()
    expect(onAcceptHint).toHaveBeenCalledWith('prod-db')

    // The line was rewritten to the alias, observed publicly: the next Enter
    // submits the alias, not the partial.
    enter(view)
    expect(submit).toHaveBeenLastCalledWith('ssh prod-db')
  })

  it('clicking a hint item accepts the alias', () => {
    const onAcceptHint = vi.fn()
    const { ed, view, container, submit } = setup({ onAcceptHint })
    ed.show()
    ed.insertText('ssh prod')
    ed.showAliasHints(HINT_ITEMS)
    const item = container.querySelectorAll('.nocx-editor-hint__item')[1]
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(onAcceptHint).toHaveBeenCalledWith('prod-web')

    enter(view)
    expect(submit).toHaveBeenLastCalledWith('ssh prod-web')
  })

  it('Escape dismisses hints without clearing the document', () => {
    const { ed, view, container, submit } = setup()
    ed.show()
    ed.insertText('ssh prod')
    ed.showAliasHints(HINT_ITEMS)
    expect(hintEl(container).style.display).not.toBe('none')

    escape(view)
    expect(hintEl(container).style.display).toBe('none')

    // Draft untouched, observed publicly: the next submit still starts with it.
    ed.insertText('!')
    enter(view)
    expect(submit).toHaveBeenLastCalledWith('ssh prod!')
  })

  it('hints are hidden after hide() is called', () => {
    const { ed, container } = setup()
    ed.show()
    ed.showAliasHints(HINT_ITEMS)
    expect(hintEl(container).style.display).not.toBe('none')
    ed.hide()
    expect(hintEl(container).style.display).toBe('none')
  })

  it('a dismissed hint set is forgotten on the next show()', () => {
    const { ed, view, container } = setup()
    ed.show()
    ed.insertText('ssh prod')
    ed.showAliasHints(HINT_ITEMS)
    escape(view) // dismiss
    expect(hintEl(container).style.display).toBe('none')

    ed.hide()
    ed.show()
    ed.showAliasHints(HINT_ITEMS) // must render again — dismissal was per-session
    expect(hintEl(container).style.display).not.toBe('none')
    expect(container.querySelectorAll('.nocx-editor-hint__item').length).toBe(3)
  })
})

// ── Shell syntax highlighting (shell-highlight.ts) ─────────────────────

/** Read the live line's token spans as [class, text] pairs, in DOM order. */
function liveTokens(doc: string, store?: CommandSnapshotStore): Array<[string, string]> {
  const { ed, view } = setup({}, shellExtensions(store ?? new CommandSnapshotStore()))
  ed.show()
  ed.insertText(doc)
  return [...view.contentDOM.querySelectorAll<HTMLElement>('[class^="tok-"]')].map((span) => [
    span.className,
    span.textContent ?? '',
  ])
}

/** A fresh, empty store — "no snapshot" verdicts for the pure-syntax tests. */
const freshStore = (): CommandSnapshotStore => new CommandSnapshotStore()

/** Read the static pass's token spans the same way, from a template element. */
function staticTokens(html: string): Array<[string, string]> {
  const root = document.createElement('div')
  root.innerHTML = html
  return [...root.querySelectorAll<HTMLElement>('[class^="tok-"]')].map((span) => [
    span.className,
    span.textContent ?? '',
  ])
}

describe('shell syntax highlighting', () => {
  // The grammar loads asynchronously at module init; every test below needs
  // the tokenizer ready so live and frozen classes are deterministic.
  beforeAll(async () => {
    await shellHighlightReady
  })

  it('command name, flag, pipe and redirect target are distinguishable token classes', () => {
    const byClass = new Map<string, string[]>()
    for (const [cls, text] of liveTokens('ls -la | grep foo > out.txt')) {
      byClass.set(cls, [...(byClass.get(cls) ?? []), text])
    }
    expect(byClass.get('tok-command')).toEqual(['ls', 'grep'])
    expect(byClass.get('tok-flag')).toEqual(['-la'])
    expect(byClass.get('tok-operator')).toEqual(['|', '>'])
    // The VS Code grammar styles every bare word after the command as an
    // unquoted argument, so the redirect target and the plain argument `foo`
    // share the path role.
    expect(byClass.get('tok-path')).toEqual(['foo', 'out.txt'])
  })

  it('a quoted string containing a pipe is one string token', () => {
    const tokens = liveTokens('echo "a|b"')
    expect(tokens.filter(([cls]) => cls === 'tok-string')).toEqual([['tok-string', '"a|b"']])
    expect(tokens.some(([cls, text]) => cls === 'tok-operator' && text === '|')).toBe(false)
  })

  it('a pipe inside a comment is not an operator', () => {
    const tokens = liveTokens('# ls | grep foo')
    expect(tokens).toContainEqual(['tok-comment', '# ls | grep foo'])
    expect(tokens.some(([cls, text]) => cls === 'tok-operator' && text === '|')).toBe(false)
  })

  it('highlighting is off when no shell language is installed (non-shell target)', () => {
    const { ed, view } = setup() // extensions default to []
    ed.show()
    ed.insertText('ls -la | grep foo > out.txt')
    expect(view.contentDOM.querySelectorAll('[class^="tok-"]').length).toBe(0)
  })

  it('the frozen-header pass emits the same classes as the live line for the same text', () => {
    const doc = 'ls -la | grep foo > out.txt'
    expect(staticTokens(highlightShellText(doc, freshStore()))).toEqual(liveTokens(doc))
  })

  it('the static pass escapes the command text (no markup injection)', () => {
    const html = highlightShellText('echo "<script>alert(1)</script>"', freshStore())
    expect(html).not.toContain('<script>')
    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.textContent).toBe('echo "<script>alert(1)</script>"')
  })

  it('the corpus: every command word, real or invented, lands in the same class', () => {
    const cases: Array<[string, string]> = [
      ['ls -la', 'ls'],
      ['pwd', 'pwd'],
      ['cargo test', 'cargo'],
      ['kubectl get pods', 'kubectl'],
      ['docker compose up', 'docker'],
      ['./scripts/release', './scripts/release'],
      ['sdf dffd', 'sdf'],
    ]
    for (const [line, word] of cases) {
      const classes = liveTokens(line)
        .filter(([, text]) => text === word)
        .map(([cls]) => cls)
      // Exactly the command class and nothing else — `sdf` is styled like any
      // other command word and gets no diagnostic (no existence claim).
      expect(classes).toEqual(['tok-command'])
    }
  })

  it('the corpus: live and frozen produce identical classes for identical text', () => {
    const corpus = [
      'ls -la',
      'pwd',
      'cargo test',
      'kubectl get pods',
      'docker compose up',
      './scripts/release',
      'FOO=bar make build',
      'sudo -u deploy make release',
      'echo "a|b"',
      '# ls | grep foo',
      'sdf dffd',
    ]
    for (const line of corpus) {
      expect(staticTokens(highlightShellText(line, freshStore()))).toEqual(liveTokens(line))
    }
  })

  it('an assignment keeps its variable and operator roles distinct from the command', () => {
    const tokens = liveTokens('FOO=bar make build')
    expect(tokens).toContainEqual(['tok-variable', 'FOO'])
    expect(tokens).toContainEqual(['tok-operator', '='])
    expect(tokens).toContainEqual(['tok-command', 'make'])
    // `build` is make's argument, so the grammar styles it as an unquoted
    // argument, not a command — only the command-position word is special.
    expect(tokens).toContainEqual(['tok-path', 'build'])
  })

  it('a multiline document colours every line (document-wide token offsets)', () => {
    const tokens = liveTokens('kubectl get pods\nls -la')
    expect(tokens).toContainEqual(['tok-command', 'kubectl'])
    expect(tokens).toContainEqual(['tok-command', 'ls'])
    expect(tokens).toContainEqual(['tok-flag', '-la'])
  })

  it('a heredoc body across lines keeps the heredoc role', () => {
    const tokens = staticTokens(highlightShellText('cat <<EOF\nhello world\nEOF', freshStore()))
    expect(tokens).toContainEqual(['tok-heredoc', 'hello world'])
    expect(tokens).toContainEqual(['tok-heredoc', 'EOF'])
  })
})

// ── Command-existence verdicts (OSC 636 snapshot) ──────────────────────────

describe('command existence verdicts', () => {
  // The tokenizer must be ready so the verdict classes are deterministic.
  beforeAll(async () => {
    await shellHighlightReady
  })

  const SEED_NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const snap = (names: string[]) => `S;${SEED_NONCE};${names.join(';')}`
  /** A fresh tab store, seeded with the given names (or left empty). */
  const makeStore = (names?: string[]): CommandSnapshotStore => {
    const store = freshStore()
    if (names) {
      store.ingest(`H;${SEED_NONCE}`)
      store.ingest(snap(names))
    }
    return store
  }

  it('pwd — a builtin, not a file — renders resolved with no underline', () => {
    expect(liveTokens('pwd', makeStore(['pwd', 'ls']))).toEqual([['tok-command', 'pwd']])
  })

  it('sdfsdf renders unresolved: the command class plus the underline class, not a red foreground', () => {
    expect(liveTokens('sdfsdf', makeStore(['pwd', 'ls']))).toEqual([
      ['tok-command tok-unresolved', 'sdfsdf'],
    ])
  })

  it('$TOOL build renders indeterminate — nothing is underlined', () => {
    expect(
      liveTokens('$TOOL build', makeStore(['pwd', 'ls'])).some(([cls]) =>
        cls.includes('tok-unresolved'),
      ),
    ).toBe(false)
  })

  it('"$(pick)" arg renders indeterminate — the name inside a substitution is not checked', () => {
    expect(
      liveTokens('"$(pick)" arg', makeStore(['pwd', 'ls'])).some(([cls]) =>
        cls.includes('tok-unresolved'),
      ),
    ).toBe(false)
  })

  it('a command inside $( ) renders indeterminate even when it exists', () => {
    expect(
      liveTokens('x=$(ls)', makeStore(['pwd', 'ls'])).some(([cls]) =>
        cls.includes('tok-unresolved'),
      ),
    ).toBe(false)
  })

  it('with no snapshot everything is unavailable and nothing is underlined', () => {
    const tokens = liveTokens('sdfsdf && pwd', makeStore())
    expect(tokens.some(([cls]) => cls.includes('tok-unresolved'))).toBe(false)
    expect(tokens.filter(([cls]) => cls === 'tok-command')).toEqual([
      ['tok-command', 'sdfsdf'],
      ['tok-command', 'pwd'],
    ])
  })

  it('the live line re-decorates when the snapshot arrives mid-typing', () => {
    const store = freshStore()
    const { ed, view } = setup({}, shellExtensions(store))
    ed.show()
    ed.insertText('sdfsdf')
    expect(view.contentDOM.querySelectorAll('.tok-unresolved').length).toBe(0)
    store.ingest(`H;${SEED_NONCE}`)
    store.ingest(snap(['pwd']))
    expect(view.contentDOM.querySelectorAll('.tok-unresolved').length).toBe(1)
  })

  it('the frozen-header pass carries the same verdict classes', () => {
    const store = makeStore(['pwd'])
    expect(staticTokens(highlightShellText('pwd', store))).toEqual([['tok-command', 'pwd']])
    expect(staticTokens(highlightShellText('sdfsdf', store))).toEqual([
      ['tok-command tok-unresolved', 'sdfsdf'],
    ])
  })

  it('a tab whose session never sent a snapshot reports unavailable even when another tab has one', () => {
    const other = makeStore(['pwd']) // this tab is ready…
    const mine = makeStore() // …this tab never received a snapshot
    expect(other.status).toBe('ready')
    expect(mine.status).toBe('unavailable')
    // No underline in the snapshot-less tab — unavailable never collapses
    // into unresolved, even while a sibling tab is fully seeded.
    expect(liveTokens('sdfsdf', mine)).toEqual([['tok-command', 'sdfsdf']])
    expect(liveTokens('sdfsdf', other)).toEqual([['tok-command tok-unresolved', 'sdfsdf']])
  })
})
