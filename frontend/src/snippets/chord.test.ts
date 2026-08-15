// @vitest-environment jsdom
// The snippet palette chord (design §10.1): one predicate, owned here, read
// by both keyboard boundaries (the xterm custom key handler and the
// editor's arbiter chain), which delegate to the SAME opener (AD-8). The
// match is on `code`, not `key`: with Option held, macOS reports the
// composed character (Option+P = 'π' on the US layout).
import { describe, it, expect } from 'vitest'
import { isSnippetChord, SNIPPET_CHORD_LABEL } from './chord'

const chord = (init: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { code: 'KeyP', ...init })

describe('isSnippetChord (⌥⌘P, design §10.1)', () => {
  it('matches the plain chord: Alt+Meta+P, nothing else', () => {
    expect(isSnippetChord(chord({ altKey: true, metaKey: true }))).toBe(true)
  })

  it('rejects every neighbouring chord', () => {
    expect(isSnippetChord(chord())).toBe(false)
    expect(isSnippetChord(chord({ altKey: true }))).toBe(false)
    expect(isSnippetChord(chord({ metaKey: true }))).toBe(false)
    expect(isSnippetChord(chord({ altKey: true, metaKey: true, shiftKey: true }))).toBe(false)
    expect(isSnippetChord(chord({ altKey: true, metaKey: true, ctrlKey: true }))).toBe(false)
    // A different physical key with the same modifiers is not the chord.
    expect(isSnippetChord(chord({ altKey: true, metaKey: true, code: 'KeyO' }))).toBe(false)
    // Keyup is not a chord press.
    expect(
      isSnippetChord(new KeyboardEvent('keyup', { code: 'KeyP', altKey: true, metaKey: true })),
    ).toBe(false)
  })

  it('matches by physical key, so Option+P on a non-US layout still fires (key would be π)', () => {
    expect(isSnippetChord(chord({ altKey: true, metaKey: true, key: 'π' }))).toBe(true)
  })

  it('the label names the chord the UI prints', () => {
    expect(SNIPPET_CHORD_LABEL).toBe('⌥⌘P')
  })
})
