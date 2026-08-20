// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isOverviewChord, OVERVIEW_CHORD_LABEL } from './chord'
import { isNoteChord } from '../notes/chord'
import { isSnippetChord } from '../snippets/chord'

/** The chords already spoken for, as a person types them. Each is asserted to
 *  NOT open the overview — a collision found by eye is a collision found once,
 *  and this is the same list `notes/chord.ts` checked itself against. */
function key(init: Partial<KeyboardEventInit> & { code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  })
}

describe('the overview chord', () => {
  it('is ⌥⌘O and says so', () => {
    expect(OVERVIEW_CHORD_LABEL).toBe('⌥⌘O')
    expect(isOverviewChord(key({ code: 'KeyO', altKey: true, metaKey: true }))).toBe(true)
  })

  it('is matched on the physical key, not the composed character', () => {
    // Option+O composes ø on the US layout, so a `key`-based match would fail
    // on exactly the layouts the chord is typed on.
    const composed = new KeyboardEvent('keydown', {
      key: 'ø',
      code: 'KeyO',
      altKey: true,
      metaKey: true,
    })
    expect(isOverviewChord(composed)).toBe(true)
  })

  it('is not any chord the application already owns', () => {
    const taken: KeyboardEvent[] = [
      key({ code: 'KeyT', metaKey: true }), // ⌘T new pane
      key({ code: 'KeyW', metaKey: true }), // ⌘W close pane
      key({ code: 'Digit1', metaKey: true }), // ⌘1..9 activate by index
      key({ code: 'Comma', metaKey: true }), // ⌘, settings
      key({ code: 'KeyB', metaKey: true }), // ⌘B sidebar
      key({ code: 'KeyP', metaKey: true, shiftKey: true }), // ⌘⇧P palette
      key({ code: 'KeyO', metaKey: true, shiftKey: true }), // ⌘⇧O ports
      key({ code: 'KeyP', metaKey: true, altKey: true }), // ⌥⌘P snippets
      key({ code: 'KeyN', metaKey: true, altKey: true }), // ⌥⌘N notes
    ]
    for (const e of taken) expect(isOverviewChord(e)).toBe(false)
  })

  it('does not fire the notes or snippets chord, and they do not fire it', () => {
    const ours = key({ code: 'KeyO', altKey: true, metaKey: true })
    expect(isNoteChord(ours)).toBe(false)
    expect(isSnippetChord(ours)).toBe(false)
  })

  it('ignores keyup — a chord is a press', () => {
    const up = new KeyboardEvent('keyup', { code: 'KeyO', altKey: true, metaKey: true })
    expect(isOverviewChord(up)).toBe(false)
  })
})
