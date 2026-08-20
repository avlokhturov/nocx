import { describe, it, expect } from 'vitest'
import { applyOutputCap, outputCapBytes, OUTPUT_CAP_DEFAULT_KB, OUTPUT_CAP_KEY } from './output-cap'

describe('the per-command output cap', () => {
  it('starts at the value Go declares', () => {
    expect(outputCapBytes()).toBe(OUTPUT_CAP_DEFAULT_KB * 1024)
    expect(OUTPUT_CAP_KEY).toBe('history.outputCapKB')
  })

  it('adopts the backend value, in bytes', () => {
    applyOutputCap(64)
    expect(outputCapBytes()).toBe(64 * 1024)
  })

  it('keeps what it had when the snapshot does not carry the key', () => {
    applyOutputCap(64)
    applyOutputCap(undefined)
    applyOutputCap('lots')
    expect(outputCapBytes()).toBe(64 * 1024)
  })

  it('refuses a value outside the declared bounds rather than clamping it', () => {
    applyOutputCap(64)
    applyOutputCap(1)
    applyOutputCap(99999)
    // Clamping would silently store something the user did not choose and
    // the settings page does not show; keeping the last valid value is the
    // answer that cannot mislead.
    expect(outputCapBytes()).toBe(64 * 1024)
    applyOutputCap(OUTPUT_CAP_DEFAULT_KB)
  })
})
