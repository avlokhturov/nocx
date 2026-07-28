// @vitest-environment node
// css-tree is loaded via createRequire and has no type declarations;
// every call to it touches a value typed `any`, so no-unsafe-* must
// be disabled at the file level for this test.
/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                      @typescript-eslint/no-unsafe-call,
                      @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect } from 'vitest'
import { FONT_SIZE } from './renderers/font'
// @ts-expect-error — @types/node not installed; vitest resolves at runtime
import { createRequire } from 'node:module'
// @ts-expect-error — @types/node not installed; vitest resolves at runtime
import { readFileSync } from 'node:fs'
// @ts-expect-error — @types/node not installed; vitest resolves at runtime
import { resolve } from 'node:path'

const css = createRequire(import.meta.url)('css-tree')

function isDeclarationNode(node: unknown, property: string): node is { value: unknown } {
  if (!node || typeof node !== 'object') return false
  if (!('type' in node) || !('property' in node) || !('value' in node)) return false
  return (
    (node as { type: unknown }).type === 'Declaration' &&
    (node as { property: unknown }).property === property
  )
}

describe('font-size scale', () => {
  it('--font-size-terminal equals renderers/font.ts::FONT_SIZE', () => {
    const dirname =
      (import.meta as { dirname?: string }).dirname ??
      resolve(new URL('.', import.meta.url).pathname)
    const tokensPath = resolve(dirname, 'styles/tokens.css')
    const source = readFileSync(tokensPath, 'utf8')
    const ast = css.parse(source, { positions: true })

    let terminalValue: string | null = null
    css.walk(ast, (node: unknown) => {
      if (!isDeclarationNode(node, '--font-size-terminal')) return
      terminalValue = css.generate(node.value).trim()
    })

    expect(terminalValue).not.toBeNull()
    expect(terminalValue).toMatch(/^\d+px$/)
    const parsed = parseInt(terminalValue!, 10)
    expect(parsed).toBe(FONT_SIZE)
  })
})
