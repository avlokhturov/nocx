// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { MAX_BACKUP_BYTES, readBackupText, downloadText } from './backup-file'

describe('backup file limits', () => {
  it('uses the 8 MiB boundary', () => {
    expect(MAX_BACKUP_BYTES).toBe(8 * 1024 * 1024)
  })

  it('reads valid backup text and accepts the exact boundary', async () => {
    const content = '{"format":"nocx-backup","version":1}'
    await expect(readBackupText(new File([content], 'backup.json'))).resolves.toBe(content)
    const exact = 'x'.repeat(MAX_BACKUP_BYTES)
    await expect(readBackupText(new File([exact], 'exact.json'))).resolves.toBe(exact)
  })

  it('rejects oversized files before reading them', async () => {
    await expect(
      readBackupText(new File(['x'.repeat(MAX_BACKUP_BYTES + 1)], 'large.json')),
    ).rejects.toThrow('exceeds')
  })
})

describe('downloadText', () => {
  it('downloads using the supplied filename', () => {
    const createObjectURL = vi.fn(() => 'blob:test')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    const original = document.createElement.bind(document)
    let captured = ''
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = original(tag)
      if (tag === 'a') {
        Object.defineProperty(element, 'download', {
          get: () => captured,
          set: (value: string) => {
            captured = value
          },
        })
        vi.spyOn(element, 'click').mockImplementation(() => {})
      }
      return element
    })

    downloadText('my-backup.json', '{}')

    expect(captured).toBe('my-backup.json')
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test')
    vi.restoreAllMocks()
  })
})
