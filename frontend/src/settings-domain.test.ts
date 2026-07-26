// settings-domain — pure functions only, no jsdom, no DOM, no markup.
import { describe, it, expect } from 'vitest'
import {
  createMirror,
  recordSaveOutcome,
  canResetSetting,
  applyAcceptedSnapshot,
  AcceptedSnapshot,
  type SettingsMirror,
  type SettingsSnapshot,
} from './settings-domain'

// ── helpers ────────────────────────────────────────────────────────────────

/** A specific-membership matcher that checks `.has()` on a Set. */
function hasKeys(s: ReadonlySet<string>, ...keys: string[]): boolean {
  return keys.every((k) => s.has(k))
}

// ── createMirror ───────────────────────────────────────────────────────────

describe('createMirror', () => {
  it('returns empty, zero-revision state', () => {
    const m = createMirror()
    expect(m.values).toEqual({})
    expect(m.draftValues).toEqual({})
    expect(m.overridden.size).toBe(0)
    expect(m.errors).toEqual({})
    expect(m.revision).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  1. Draft preservation on rejected save
// ═══════════════════════════════════════════════════════════════════════════

describe('recordSaveOutcome', () => {
  // ── accepted ──────────────────────────────────────────────────────────

  it('writes value into values and marks overridden on accepted save', () => {
    const m = createMirror()
    const next = recordSaveOutcome(m, 'terminal.fontSize', {
      kind: 'accepted',
      value: 16,
    })
    expect(next.values['terminal.fontSize']).toBe(16)
    expect(hasKeys(next.overridden, 'terminal.fontSize')).toBe(true)
    // Original was not mutated.
    expect('terminal.fontSize' in m.values).toBe(false)
    expect(m.overridden.size).toBe(0)
  })

  it('clears existing draft for the key on accepted save', () => {
    const m: SettingsMirror = {
      values: { 'terminal.fontSize': 12 },
      draftValues: { 'terminal.fontSize': 20 },
      overridden: new Set(['terminal.fontSize']),
      errors: {},
      revision: 1,
    }
    const next = recordSaveOutcome(m, 'terminal.fontSize', {
      kind: 'accepted',
      value: 16,
    })
    expect(next.values['terminal.fontSize']).toBe(16)
    expect('terminal.fontSize' in next.draftValues).toBe(false)
  })

  it('clears existing error for the key on accepted save', () => {
    const m: SettingsMirror = {
      values: { key1: 'old' },
      draftValues: {},
      overridden: new Set(),
      errors: { key1: 'previous error' },
      revision: 1,
    }
    const next = recordSaveOutcome(m, 'key1', { kind: 'accepted', value: 'new' })
    expect('key1' in next.errors).toBe(false)
  })

  // ── rejected ──────────────────────────────────────────────────────────

  it('preserves attempted value in draftValues on rejected save', () => {
    const m = createMirror()
    const next = recordSaveOutcome(m, 'terminal.fontFamily', {
      kind: 'rejected',
      error: 'validation error',
      attemptedValue: 'Bad Font',
    })
    expect(next.draftValues['terminal.fontFamily']).toBe('Bad Font')
    expect(next.errors['terminal.fontFamily']).toBe('validation error')
    // Original values are NOT polluted by the attempted value.
    expect('terminal.fontFamily' in m.values).toBe(false)
    // Draft is only in the new state.
    expect('terminal.fontFamily' in m.draftValues).toBe(false)
  })

  it('clears existing draft for the key before recording a new rejection', () => {
    const m: SettingsMirror = {
      values: { k: 'original' },
      draftValues: { k: 'old-draft' },
      overridden: new Set(),
      errors: {},
      revision: 0,
    }
    const next = recordSaveOutcome(m, 'k', {
      kind: 'rejected',
      error: 'new error',
      attemptedValue: 'new-draft',
    })
    expect(next.draftValues['k']).toBe('new-draft')
    expect(next.errors['k']).toBe('new error')
  })

  it('does not mark key as overridden on rejected save', () => {
    const m = createMirror()
    const next = recordSaveOutcome(m, 'key', {
      kind: 'rejected',
      error: 'nope',
      attemptedValue: 'x',
    })
    expect(hasKeys(next.overridden, 'key')).toBe(false)
  })

  // ── preserves unrelated state ─────────────────────────────────────────

  it('preserves unrelated values and overridden state across a save', () => {
    const m: SettingsMirror = {
      values: { existing: 'val' },
      draftValues: {},
      overridden: new Set(['existing']),
      errors: {},
      revision: 5,
    }
    const next = recordSaveOutcome(m, 'newkey', { kind: 'accepted', value: 'newval' })
    expect(next.values['existing']).toBe('val')
    expect(hasKeys(next.overridden, 'existing', 'newkey')).toBe(true)
    expect(next.revision).toBe(5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  2. Provenance-based reset
// ═══════════════════════════════════════════════════════════════════════════

describe('canResetSetting', () => {
  it('allows reset when key is overridden and has a default', () => {
    const overridden: ReadonlySet<string> = new Set(['terminal.fontSize'])
    const r = canResetSetting(overridden, 'terminal.fontSize', true)
    expect(r.canReset).toBe(true)
  })

  it('denies reset when key is not overridden', () => {
    const r = canResetSetting(new Set(), 'terminal.fontSize', true)
    expect(r.canReset).toBe(false)
    if (!r.canReset) {
      expect(r.reason).toBe('notOverridden')
    }
  })

  it('denies reset when key has no default (e.g. secret)', () => {
    const overridden: ReadonlySet<string> = new Set(['ai.apiKey'])
    const r = canResetSetting(overridden, 'ai.apiKey', false)
    expect(r.canReset).toBe(false)
    if (!r.canReset) {
      expect(r.reason).toBe('noDefault')
    }
  })

  it('denies reset when both not overridden and no default', () => {
    const r = canResetSetting(new Set(), 'noDefaultKey', false)
    expect(r.canReset).toBe(false)
    if (!r.canReset) {
      expect(r.reason).toBe('noDefault')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  3. Snapshot revision policy (AD-7 authority-in-the-type)
// ═══════════════════════════════════════════════════════════════════════════

describe('AcceptedSnapshot', () => {
  // ── accept ────────────────────────────────────────────────────────────

  it('accepts snapshot with revision >= current', () => {
    const snap: SettingsSnapshot = {
      values: { 'terminal.fontSize': 16 },
      overridden: ['terminal.fontSize'],
      revision: 2,
    }
    const accepted = AcceptedSnapshot.accept(1, snap)
    expect(accepted).not.toBeNull()
    if (accepted) {
      expect(accepted.values['terminal.fontSize']).toBe(16)
      expect(accepted.overridden.has('terminal.fontSize')).toBe(true)
      expect(accepted.revision).toBe(2)
    }
  })

  it('accepts snapshot with equal revision (common refresh)', () => {
    const snap: SettingsSnapshot = {
      values: {},
      overridden: [],
      revision: 3,
    }
    const accepted = AcceptedSnapshot.accept(3, snap)
    expect(accepted).not.toBeNull()
  })

  it('rejects stale snapshot (revision < current)', () => {
    const snap: SettingsSnapshot = {
      values: {},
      overridden: [],
      revision: 1,
    }
    const accepted = AcceptedSnapshot.accept(5, snap)
    expect(accepted).toBeNull()
  })

  it('accepts snapshot with revision 0 when current is 0 (initial load)', () => {
    const snap: SettingsSnapshot = {
      values: { k: 'v' },
      overridden: ['k'],
      revision: 0,
    }
    const accepted = AcceptedSnapshot.accept(0, snap)
    expect(accepted).not.toBeNull()
  })

  it('accepts higher revision when current is default 0', () => {
    const snap: SettingsSnapshot = {
      values: { k: 'v' },
      overridden: ['k'],
      revision: 5,
    }
    const accepted = AcceptedSnapshot.accept(0, snap)
    expect(accepted).not.toBeNull()
  })

  // ── AD-7: authority enforcement ───────────────────────────────────────

  it('values are frozen against mutation through the accepted snapshot', () => {
    const snap: SettingsSnapshot = {
      values: { k: 'v' },
      overridden: ['k'],
      revision: 1,
    }
    const accepted = AcceptedSnapshot.accept(0, snap)!
    // Mutating the original input does not affect the accepted copy.
    snap.values['k'] = 'mutated'
    expect(accepted.values['k']).toBe('v')
  })

  // ── reset (reconnect path) ───────────────────────────────────────────

  it('reset accepts snapshot unconditionally regardless of revision', () => {
    const snap: SettingsSnapshot = {
      values: { k: 'v' },
      overridden: ['k'],
      revision: 0,
    }
    // After reconnect: this.revision = 5, incoming revision = 0
    const accepted = AcceptedSnapshot.reset(snap)
    expect(accepted).toBeInstanceOf(AcceptedSnapshot)
    expect(accepted.values['k']).toBe('v')
    expect(accepted.overridden.has('k')).toBe(true)
    expect(accepted.revision).toBe(0)
  })

  it('values are isolated from mutation after reset', () => {
    const snap: SettingsSnapshot = {
      values: { k: 'v' },
      overridden: [],
      revision: 0,
    }
    const accepted = AcceptedSnapshot.reset(snap)
    snap.values['k'] = 'mutated'
    expect(accepted.values['k']).toBe('v')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  applyAcceptedSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe('applyAcceptedSnapshot', () => {
  it('replaces values and overridden from the accepted snapshot', () => {
    const m = createMirror()
    const snap = AcceptedSnapshot.accept(0, {
      values: { k: 'v' },
      overridden: ['k'],
      revision: 2,
    })!
    const next = applyAcceptedSnapshot(m, snap)
    expect(next.values).toEqual({ k: 'v' })
    expect(hasKeys(next.overridden, 'k')).toBe(true)
    expect(next.revision).toBe(2)
  })

  it('clears draftValues and errors on receiving a fresh snapshot', () => {
    const m: SettingsMirror = {
      values: { k: 'old' },
      draftValues: { k: 'draft' },
      overridden: new Set(['k']),
      errors: { k: 'old error' },
      revision: 1,
    }
    const snap = AcceptedSnapshot.accept(1, {
      values: { k: 'new' },
      overridden: [],
      revision: 2,
    })!
    const next = applyAcceptedSnapshot(m, snap)
    expect(next.draftValues).toEqual({})
    expect(next.errors).toEqual({})
    expect(next.values['k']).toBe('new')
    expect(next.overridden.size).toBe(0)
  })

  it('does not mutate the input mirror', () => {
    const m: SettingsMirror = {
      values: { k: 'old' },
      draftValues: {},
      overridden: new Set(['k']),
      errors: {},
      revision: 1,
    }
    const snap = AcceptedSnapshot.accept(1, {
      values: { k: 'new' },
      overridden: [],
      revision: 2,
    })!
    void applyAcceptedSnapshot(m, snap)
    expect(m.values['k']).toBe('old')
    expect(hasKeys(m.overridden, 'k')).toBe(true)
  })
})
