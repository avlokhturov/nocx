/** Convert a base64 string to a Uint8Array. Exported for testing. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Hand a blob to the browser as a download.
 *
 * The anchor is created, clicked and dropped without ever entering the
 * document: this is the browser's download idiom, not UI, which is why it
 * stays imperative in a module the Solid surfaces call.
 */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Download a base64-encoded binary payload as a file. */
export function downloadBinary(filename: string, payload: string): void {
  const bytes = base64ToBytes(payload)
  downloadBlob(filename, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }))
}
