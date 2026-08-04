import { describe, it, expect } from 'vitest'
import { deriveCapability, CAPABILITY_LABELS, type CapabilityFacts } from './capability'

const facts = (over: Partial<CapabilityFacts> = {}): CapabilityFacts => ({
  integrated: false,
  state: 'RAW',
  trusted: false,
  owned: false,
  native: false,
  ...over,
})

describe('deriveCapability', () => {
  it('a plain shell with no markers is native input', () => {
    expect(deriveCapability(facts())).toBe('native-input')
  })

  it('an integrated shell at a trusted owned prompt is command blocks', () => {
    expect(
      deriveCapability(
        facts({ integrated: true, state: 'PROMPT_READY', trusted: true, owned: true }),
      ),
    ).toBe('command-blocks')
  })

  it('an integrated shell nocx does not own right now is enhanced input', () => {
    // Running command: evidence exists (blocks are recorded), input is raw.
    expect(deriveCapability(facts({ integrated: true, state: 'RUNNING_RAW' }))).toBe(
      'enhanced-input',
    )
    // Alt-screen program (a TUI): same statement.
    expect(deriveCapability(facts({ integrated: true, state: 'ALT_SCREEN' }))).toBe(
      'enhanced-input',
    )
    // Prompt not trusted (a nested prompt after a resync).
    expect(
      deriveCapability(
        facts({ integrated: true, state: 'PROMPT_READY', trusted: false, owned: false }),
      ),
    ).toBe('enhanced-input')
  })

  it('the native latch outranks every observation', () => {
    expect(
      deriveCapability(
        facts({
          integrated: true,
          state: 'PROMPT_READY',
          trusted: true,
          owned: true,
          native: true,
        }),
      ),
    ).toBe('native-input')
  })

  it('every capability has a user-facing label', () => {
    for (const c of ['native-input', 'command-blocks', 'enhanced-input'] as const) {
      expect(CAPABILITY_LABELS[c].length).toBeGreaterThan(0)
    }
  })
})
