// settings-model — re‑exports from settings-domain, so this confirms the
// re‑export layer is intact.  The full transition tests are in
// settings-domain.test.ts.
import { describe, it, expect } from 'vitest'
import {
  createMirror,
  applyAcceptedSnapshot,
  canResetSetting,
  recordSaveOutcome,
  monotonicRevisionPolicy,
  reconnectRevisionPolicy,
} from './settings-model'
import type { SettingsSnapshot } from './settings-model'

describe('settings-model re-exports', () => {
  it('createMirror produces an empty mirror', () => {
    const m = createMirror()
    expect(m.values).toEqual({})
    expect(m.draftValues).toEqual({})
    expect(m.overridden).toBeInstanceOf(Set)
    expect(m.overridden.size).toBe(0)
    expect(m.errors).toEqual({})
    expect(m.revision).toBe(0)
  })

  it('AcceptedSnapshot rejects stale revisions', () => {
    const snap: SettingsSnapshot = {
      values: { theme: 'dark' },
      overridden: ['theme'],
      revision: 1,
    }
    const accepted = monotonicRevisionPolicy(2, snap)
    expect(accepted).toBeNull()
  })

  it('AcceptedSnapshot accepts matching revisions', () => {
    const snap: SettingsSnapshot = {
      values: { theme: 'dark' },
      overridden: ['theme'],
      revision: 2,
    }
    const accepted = monotonicRevisionPolicy(1, snap)
    expect(accepted).not.toBeNull()
    expect(accepted!.values.theme).toBe('dark')
  })

  it('reconnectRevisionPolicy ignores revision check', () => {
    const snap: SettingsSnapshot = {
      values: { theme: 'dark' },
      overridden: ['theme'],
      revision: 0,
    }
    const accepted = reconnectRevisionPolicy(5, snap)
    expect(accepted).not.toBeNull()
    expect(accepted!.values.theme).toBe('dark')
  })

  it('applyAcceptedSnapshot produces a clean mirror', () => {
    const snap = monotonicRevisionPolicy(0, {
      values: { theme: 'dark', fontSize: 12 },
      overridden: ['theme'],
      revision: 1,
    })!
    const m = applyAcceptedSnapshot(snap)
    expect(m.values.theme).toBe('dark')
    expect(m.draftValues).toEqual({})
    expect(m.overridden.has('theme')).toBe(true)
    expect(m.errors).toEqual({})
    expect(m.revision).toBe(1)
  })

  it('recordSaveOutcome preserves drafts on reject', () => {
    const m = recordSaveOutcome(createMirror(), 'theme', {
      kind: 'rejected',
      error: 'readonly',
      attemptedValue: 'dark',
    })
    expect(m.draftValues.theme).toBe('dark')
    expect(m.errors.theme).toBe('readonly')
    expect(m.overridden.has('theme')).toBe(false)
  })

  it('recordSaveOutcome writes on accept', () => {
    const m = recordSaveOutcome(createMirror(), 'theme', {
      kind: 'accepted',
      value: 'dark',
    })
    expect(m.values.theme).toBe('dark')
    expect(m.overridden.has('theme')).toBe(true)
    expect(m.errors.theme).toBeUndefined()
  })

  it('canResetSetting returns denied for non-overridden keys', () => {
    const r = canResetSetting(new Set(), 'theme')
    expect(r.canReset).toBe(false)
  })

  it('canResetSetting returns allowed for overridden keys', () => {
    const r = canResetSetting(new Set(['theme']), 'theme')
    expect(r.canReset).toBe(true)
  })
})
