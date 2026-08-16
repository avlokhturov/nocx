// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isNoteChord, NOTE_CHORD_LABEL } from './chord'

const key = (init: KeyboardEventInit & { code?: string }) =>
  new KeyboardEvent('keydown', { code: 'KeyN', ...init })

describe('isNoteChord (⌥⌘N, design §6.3)', () => {
  it('matches the plain chord: Alt+Meta+N, nothing else', () => {
    expect(isNoteChord(key({ altKey: true, metaKey: true }))).toBe(true)
  })

  it('rejects every neighbouring chord', () => {
    expect(isNoteChord(key({ metaKey: true }))).toBe(false)
    expect(isNoteChord(key({ altKey: true }))).toBe(false)
    expect(isNoteChord(key({ altKey: true, metaKey: true, shiftKey: true }))).toBe(false)
    expect(isNoteChord(key({ altKey: true, metaKey: true, ctrlKey: true }))).toBe(false)
    expect(isNoteChord(key({ altKey: true, metaKey: true, code: 'KeyP' }))).toBe(false)
  })

  it('matches by physical key, so Option+N on a layout with a dead key still fires', () => {
    const composed = new KeyboardEvent('keydown', {
      code: 'KeyN',
      key: '˜',
      altKey: true,
      metaKey: true,
    })
    expect(isNoteChord(composed)).toBe(true)
  })

  it('the label names the chord the UI prints', () => {
    expect(NOTE_CHORD_LABEL).toBe('⌥⌘N')
  })
})
