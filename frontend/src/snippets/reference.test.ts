import { describe, expect, it } from 'vitest'
import { REFERENCE_NAMESPACES, type ReferenceNamespace } from './reference-namespaces'
import { SNIPPET_REFERENCE_RE, findSnippetSpans } from './reference'
import { findReferences } from '../secret-reference'

describe('snippet reference scan', () => {
  it('finds env and ask spans in first-occurrence order', () => {
    const spans = findSnippetSpans('cd {{env:cwd}} && run -p {{ask:port=8080}}')
    expect(spans.map((s) => `${s.ns}:${s.arg}`)).toEqual(['env:cwd', 'ask:port=8080'])
    expect(spans[0].from).toBe(3)
    expect(spans[0].to).toBe(14)
  })

  // The scan must never claim the vault's namespace. If it did, two owners
  // would derive "is this a secret reference" and would disagree exactly once.
  it('never claims a secret span', () => {
    expect(findSnippetSpans('echo {{secret:prod-db}}')).toEqual([])
  })

  it('ignores a malformed span', () => {
    expect(findSnippetSpans('{{ask:port}')).toEqual([])
    expect(findSnippetSpans('{{env:cw}d}}')).toEqual([])
  })

  it('ignores an unknown namespace', () => {
    expect(findSnippetSpans('{{cwd}}')).toEqual([])
    expect(findSnippetSpans('{{evn:cwd}}')).toEqual([])
    // The closed alternation is the contract, not the scan: an unknown
    // namespace must match nothing at the regex seam either (spec §7.2).
    expect([...'{{cwd}} {{evn:cwd}}'.matchAll(SNIPPET_REFERENCE_RE)]).toEqual([])
  })

  // The property that makes two scans safe. A fourth namespace added to one
  // and forgotten in the other fails HERE rather than colliding at runtime.
  it('the two scans are disjoint and together cover the registry', () => {
    const line = 'a {{secret:s}} b {{env:cwd}} c {{ask:p}}'
    const secretNames: ReferenceNamespace[] = findReferences(line).map(() => 'secret')
    const snippetNames: ReferenceNamespace[] = findSnippetSpans(line).map((s) => s.ns)
    expect(secretNames.filter((n) => snippetNames.includes(n))).toEqual([])
    expect(new Set([...secretNames, ...snippetNames])).toEqual(
      new Set(Object.keys(REFERENCE_NAMESPACES)),
    )
  })
})
