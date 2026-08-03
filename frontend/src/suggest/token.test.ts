// @vitest-environment node
// Token extraction and position classification — the rules that decide which
// providers are consulted for the word at the caret (design §8.5: a provider
// declares where it applies and is not consulted outside it).
import { describe, it, expect } from 'vitest'
import { tokenAt, positionOf, looksLikePath } from './token'

describe('tokenAt', () => {
  it('extracts the word under the caret', () => {
    expect(tokenAt('git sta', 7)).toEqual({ text: 'sta', from: 4, to: 7 })
  })

  it('extracts the word at the caret mid-word', () => {
    expect(tokenAt('git stashing', 6)).toEqual({ text: 'stashing', from: 4, to: 12 })
  })

  it('is empty at the end of a trailing space', () => {
    expect(tokenAt('git ', 4)).toEqual({ text: '', from: 4, to: 4 })
  })

  it('is empty on an empty doc', () => {
    expect(tokenAt('', 0)).toEqual({ text: '', from: 0, to: 0 })
  })

  it('splits on shell control characters, not just whitespace', () => {
    // `ls | gr` — the caret token after the pipeline is `gr`, not `ls|gr`.
    expect(tokenAt('ls | gr', 7)).toEqual({ text: 'gr', from: 5, to: 7 })
    expect(tokenAt('a;b', 3)).toEqual({ text: 'b', from: 2, to: 3 })
    expect(tokenAt('a&&b', 4)).toEqual({ text: 'b', from: 3, to: 4 })
    expect(tokenAt('a(b', 3)).toEqual({ text: 'b', from: 2, to: 3 })
  })

  it('keeps a quoted fragment as one token', () => {
    // `echo "fo` — the quote is a boundary; the token is what is being typed.
    expect(tokenAt('echo "fo', 8)).toEqual({ text: 'fo', from: 6, to: 8 })
  })

  it('keeps slashes and dots inside the token', () => {
    expect(tokenAt('cd ./src/fo', 11)).toEqual({ text: './src/fo', from: 3, to: 11 })
  })
})

describe('positionOf', () => {
  it('the first word of the line is command position', () => {
    expect(positionOf('git sta', 3)).toBe('command')
  })

  it('a word after a pipeline is command position', () => {
    expect(positionOf('git status | head', 17)).toBe('command')
  })

  it('a word after ; && || ( is command position', () => {
    expect(positionOf('make; tes', 9)).toBe('command')
    expect(positionOf('make && cle', 11)).toBe('command')
    expect(positionOf('x || y', 6)).toBe('command')
    expect(positionOf('$(git', 5)).toBe('command')
  })

  it('a later word of a command segment is argument position', () => {
    expect(positionOf('git sta', 7)).toBe('argument')
    expect(positionOf('cd sr', 5)).toBe('argument')
    expect(positionOf('ls -l fo', 8)).toBe('argument')
    expect(positionOf('$(git che', 9)).toBe('argument')
    expect(positionOf('git status | head -', 19)).toBe('argument')
  })
})

describe('looksLikePath', () => {
  it('true for slash, leading dot and tilde forms', () => {
    expect(looksLikePath('src/')).toBe(true)
    expect(looksLikePath('./sr')).toBe(true)
    expect(looksLikePath('../s')).toBe(true)
    expect(looksLikePath('~/Doc')).toBe(true)
    expect(looksLikePath('/usr/lo')).toBe(true)
    expect(looksLikePath('.gitignore')).toBe(true)
  })

  it('false for bare words', () => {
    expect(looksLikePath('git')).toBe(false)
    expect(looksLikePath('src')).toBe(false)
    expect(looksLikePath('')).toBe(false)
  })
})
