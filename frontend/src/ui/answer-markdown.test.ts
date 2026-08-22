// @vitest-environment jsdom
//
// AnswerMarkdown (ui/answer-markdown.ts) — the kit contract for ONE line of
// a model's answer, pinned: the structure a model actually emits is painted,
// the model's bytes are DATA and never markup, and a line with no structure
// is left exactly as it was before any of this existed.
import { describe, it, expect } from 'vitest'
import { paintAnswerLine } from './answer-markdown'

function paint(text: string): HTMLElement {
  const row = document.createElement('span')
  row.className = 'term-line'
  paintAnswerLine(row, text)
  return row
}

describe('AnswerMarkdown — structure', () => {
  it('paints a heading as its level, with the marker gone', () => {
    const h1 = paint('# What went wrong')
    expect(h1.dataset.md).toBe('h1')
    expect(h1.textContent).toBe('What went wrong')
    expect(paint('### Three').dataset.md).toBe('h3')
    expect(paint('###### Six').dataset.md).toBe('h6')
    // Seven is not a heading in any markdown, and a hash with no space is a
    // comment or a colour, not a title.
    expect(paint('####### Seven').dataset.md).toBeUndefined()
    expect(paint('#nocx').dataset.md).toBeUndefined()
  })

  it('paints a list item with a bullet and its nesting depth', () => {
    const flat = paint('- first')
    expect(flat.dataset.md).toBe('li')
    expect(flat.dataset.mdDepth).toBe('0')
    expect(flat.querySelector('.ui-md-marker')?.textContent).toBe('•')
    expect(flat.textContent).toContain('first')
    expect(paint('    - nested').dataset.mdDepth).toBe('2')
    // An ordered list keeps the number the model chose — renumbering an
    // answer would be inventing a fact.
    expect(paint('3. third').querySelector('.ui-md-marker')?.textContent).toBe('3.')
  })

  it('paints a quote, and leaves a bare dash alone', () => {
    expect(paint('> so it said').dataset.md).toBe('quote')
    // A dash with no text after it is a rule or a stray, not a list item.
    expect(paint('-').dataset.md).toBeUndefined()
    expect(paint('---').dataset.md).toBeUndefined()
  })

  it('leaves an ordinary line exactly as it was — same text, no markup, no attribute', () => {
    const row = paint('the command exited with 1')
    expect(row.dataset.md).toBeUndefined()
    expect(row.innerHTML).toBe('the command exited with 1')
    expect(row.children.length).toBe(0)
  })
})

describe('AnswerMarkdown — inline', () => {
  it('paints inline code, bold and emphasis with real elements', () => {
    const row = paint('run `ls -la` in **the repo** or *here*')
    expect(row.querySelector('code.ui-md-code')?.textContent).toBe('ls -la')
    expect(row.querySelector('strong.ui-md-strong')?.textContent).toBe('the repo')
    expect(row.querySelector('em.ui-md-em')?.textContent).toBe('here')
    // The markers themselves are gone from the text.
    expect(row.textContent).toBe('run ls -la in the repo or here')
  })

  it('does not emphasise an underscore — a shell is full of them', () => {
    const row = paint('set _MY_VAR_ and read some_file_name')
    expect(row.querySelector('em')).toBeNull()
    expect(row.querySelector('strong')).toBeNull()
    expect(row.textContent).toBe('set _MY_VAR_ and read some_file_name')
  })

  it('does not parse markup inside inline code', () => {
    const row = paint('`**not bold**`')
    expect(row.querySelector('strong')).toBeNull()
    expect(row.querySelector('code.ui-md-code')?.textContent).toBe('**not bold**')
  })
})

describe('AnswerMarkdown — the model’s text is DATA, never markup', () => {
  it('escapes a tag the model wrote instead of building one', () => {
    const row = paint('use <script>alert(1)</script> or <img src=x onerror=y>')
    expect(row.querySelector('script')).toBeNull()
    expect(row.querySelector('img')).toBeNull()
    expect(row.textContent).toBe('use <script>alert(1)</script> or <img src=x onerror=y>')
  })

  it('never builds a link, so a javascript: href stays text', () => {
    const row = paint('read [the docs](javascript:alert(1)) now')
    expect(row.querySelector('a')).toBeNull()
    expect(row.innerHTML).not.toContain('href')
    expect(row.innerHTML).not.toContain('<a')
    // Verbatim: the URL is shown, it is simply not navigable.
    expect(row.textContent).toBe('read [the docs](javascript:alert(1)) now')
  })

  it('escapes inside every painted piece — a heading, a bullet and a code span', () => {
    expect(paint('# <b>hi</b>').textContent).toBe('<b>hi</b>')
    expect(paint('# <b>hi</b>').querySelector('b')).toBeNull()
    const li = paint('- <i>x</i>')
    expect(li.querySelector('i')).toBeNull()
    const code = paint('`<img src=x onerror=alert(1)>`')
    expect(code.querySelector('img')).toBeNull()
    expect(code.querySelector('code')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('escapes an ampersand so it is not read as an entity', () => {
    const row = paint('**a & b**')
    expect(row.textContent).toBe('a & b')
    expect(row.innerHTML).toContain('&amp;')
  })
})
