// @vitest-environment node
// The quick-connect host assembly (bead nocx-n9i6) — the shared derivation
// of "which hosts do I know" that quick-connect.tsx renders and
// suggest/host-provider.ts routes. Its behaviour is specified by those two
// suites; this file pins the one thing the old shape could not express: the
// degraded-resolver condition travels as typed data, not as a label that has
// to be parsed back out.
import { describe, expect, it } from 'vitest'
import { aliasRows } from './quick-connect-assembly'

describe('quick-connect host assembly', () => {
  it('the degraded condition is typed data, not a parsed label', () => {
    // The old shape carried the reason only inside the row's human-facing
    // label (`SSH config: ${reason}`) and host-provider recovered it with a
    // string-prefix slice. The assembly answers with the condition itself —
    // no human-facing string is involved anywhere on the path.
    const { degraded } = aliasRows({
      profiles: [],
      aliases: [],
      unavailable: { reason: 'no-ssh-binary', detail: 'ssh not found' },
    })
    expect(degraded).toEqual({ reason: 'no-ssh-binary', detail: 'ssh not found' })
  })
})
