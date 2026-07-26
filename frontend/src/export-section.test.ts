import { describe, it, expect } from 'vitest'
import { base64ToBytes } from './export-utils'

// Portable encrypted export/import serialization round-trip.
// Verifies the exact serialization the buttons use:
//   Export: atob(payload) → Uint8Array → Blob → download
//   Import: read file → Uint8Array → btoa → send as payload
//
// The invariant is: reading back the Blob written by base64ToBytes
// and base64-encoding it recovers the original base64 string.

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary)
}

describe('portable encrypted serialization round-trip', () => {
  const cases: { label: string; base64: string }[] = [
    { label: 'empty', base64: btoa('') },
    { label: 'single byte', base64: btoa('\xff') },
    { label: 'binary including nulls', base64: btoa('\x00\x01\x80\xff\x00\x7f') },
    { label: 'padded (1 byte → ==)', base64: btoa('\x00') },
    { label: 'padded (2 bytes → =)', base64: btoa('\x00\x00') },
  ]

  for (const tc of cases) {
    it(`round-trips through Blob: ${tc.label}`, async () => {
      // Simulate the export path: base64 → bytes → Blob.
      const bytes = base64ToBytes(tc.base64)

      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
      const buf = await blob.arrayBuffer()
      const reReadBytes = new Uint8Array(buf)
      const reEncoded = uint8ArrayToBase64(reReadBytes)

      expect(reEncoded).toBe(tc.base64)
      expect(reReadBytes).toEqual(bytes)
    })
  }

  it('produces identical bytes as manual atob conversion', () => {
    // Verify base64ToBytes matches the spec: each charCode == byte value.
    const base64 = btoa('\x00\xff\x80\x7f')
    const bytes = base64ToBytes(base64)
    expect(bytes).toEqual(new Uint8Array([0x00, 0xff, 0x80, 0x7f]))
  })
})
