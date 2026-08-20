import { describe, it, expect } from 'vitest'
import {
  applyRestoreOnStartup,
  restoreOnStartup,
  RESTORE_ON_STARTUP_DEFAULT,
  RESTORE_ON_STARTUP_KEY,
} from './restore-setting'

describe('restore.onStartup', () => {
  it('starts at the value Go declares', () => {
    expect(restoreOnStartup()).toBe(RESTORE_ON_STARTUP_DEFAULT)
    expect(RESTORE_ON_STARTUP_KEY).toBe('restore.onStartup')
  })

  it('adopts the backend value', () => {
    applyRestoreOnStartup(false)
    expect(restoreOnStartup()).toBe(false)
    applyRestoreOnStartup(true)
    expect(restoreOnStartup()).toBe(true)
  })

  it('keeps what it had when the snapshot does not carry a boolean', () => {
    // A failed settings read must not silently give somebody a clean start:
    // the tabs they had are the expensive half of being wrong here.
    applyRestoreOnStartup(false)
    applyRestoreOnStartup(undefined)
    applyRestoreOnStartup('yes')
    expect(restoreOnStartup()).toBe(false)
    applyRestoreOnStartup(RESTORE_ON_STARTUP_DEFAULT)
  })
})
