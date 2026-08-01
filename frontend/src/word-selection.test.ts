// @vitest-environment jsdom
// Double-click word selection (nocx-w7h.8): ONE separator policy for both
// surfaces that show command text — the live xterm terminal (its own
// wordSeparator option) and the frozen DOM block (serialized command output,
// where the browser's native word segmentation is what stopped at the `-` and
// `.` in `profile-usage.json`). The policy is xterm's default separator set,
// made explicit and shared: whitespace and the bracket/quote/comma/backtick
// punctuation separate tokens; `-`, `.`, `/`, `:`, `=`, `@` do NOT — a
// filename, a path, a URL, an scp-style `user@host:~/path` and a flag like
// `--no-verify` are one thing to a terminal user.
import { describe, it, expect } from 'vitest'
import {
  WORD_SEPARATORS,
  wordBounds,
  flattenLine,
  charIndexAt,
  wordRangeIn,
} from './word-selection'

describe('word-selection: the shared separator policy', () => {
  it('is exactly the separator set both surfaces use (xterm option + block walk)', () => {
    // Space, parens, brackets, braces, quote, apostrophe, comma, backtick.
    // The hyphen, dot, slash, colon, equals and at-sign are deliberately NOT
    // separators — they live inside filenames, paths, URLs and flags.
    expect(WORD_SEPARATORS).toBe(' ()[]{}\',"`')
  })

  it.each([
    ['profile-usage.json'],
    ['/home/dev/.config/nocx'],
    ['--no-verify'],
    ['user@host:~/path'],
    ['--opt=value'],
    ['host:port'],
  ])('a token like %s is one word from either end', (token) => {
    const mid = Math.floor(token.length / 2)
    const fromMid = wordBounds(token, mid)
    expect(fromMid.start).toBe(0)
    expect(fromMid.end).toBe(token.length)
    // The same bounds from the token's first and last char.
    expect(wordBounds(token, 0)).toEqual({ start: 0, end: token.length })
    expect(wordBounds(token, token.length - 1)).toEqual({ start: 0, end: token.length })
  })

  it('a bare word between spaces is bounded by the spaces', () => {
    expect(wordBounds('run make deploy', 7)).toEqual({ start: 4, end: 8 })
    expect(wordBounds('run make deploy', 4)).toEqual({ start: 4, end: 8 })
  })

  it('a click on a separator selects nothing (start === end)', () => {
    const bounds = wordBounds('a b', 1) // the space
    expect(bounds.start).toBe(bounds.end)
  })

  it('a click at the end of the text clamps to the last word, not an empty range', () => {
    expect(wordBounds('ls -la', 6)).toEqual({ start: 3, end: 6 })
    expect(wordBounds('', 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('word-selection: frozen-block lines whose colouring splits a token across spans', () => {
  function lineWith(html: string): HTMLElement {
    const line = document.createElement('span')
    line.className = 'term-line'
    line.innerHTML = html
    return line
  }

  it('flattens a line of multiple text nodes into one string with a node map', () => {
    const line = lineWith('plain<span style="color:red">red</span>tail')
    const flat = flattenLine(line)
    expect(flat?.text).toBe('plainredtail')
    const span = line.querySelector('span')
    const node = (span?.firstChild as Text | null) ?? null
    expect(flat).not.toBeNull()
    expect(node).not.toBeNull()
    expect(charIndexAt(flat!, node!, 0)).toBe(5) // 'red' starts after 'plain'
  })

  it('selects a token that colour-splitting split across adjacent spans', () => {
    const line = lineWith(
      '<span style="color:blue">profile-</span><span style="color:red">usage.json</span>',
    )
    const second = line.querySelectorAll('span')[1]?.firstChild as Text
    const range = wordRangeIn(line, second, 2) // inside 'usage'
    expect(range?.toString()).toBe('profile-usage.json')
  })

  it('selects a whole uncoloured token from a plain text node', () => {
    const line = lineWith('profile-usage.json')
    const node = line.firstChild as Text
    const range = wordRangeIn(line, node, 8)
    expect(range?.toString()).toBe('profile-usage.json')
  })

  it('a separator click inside a line selects nothing', () => {
    const line = lineWith('one two')
    const node = line.firstChild as Text
    expect(wordRangeIn(line, node, 3)).toBeNull() // the space
  })
})
