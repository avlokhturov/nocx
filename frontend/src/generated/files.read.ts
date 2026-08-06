/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/files.read.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the files.read JSON-RPC method: bounded, streamed content of one file. The provider reads at most the effective limit plus one byte and never the whole file, so the memory guard holds for a 40 GB file; maxBytes <= 0 means the server default and the parameter can only lower the 2 MiB ceiling. Canonical is the identity the viewer tab's singletonKey is built from — without it, two symlinks to one file would open two tabs claiming to be different files, which is D12 failing in exactly the case it exists for.
 */
export interface FilesReadResult {
  /**
   * The lexical path the caller asked for — what the tab label shows, not necessarily what was read. Canonical is what was actually read.
   */
  path: string
  /**
   * The provider-canonical identity of the object actually read — what singletonKey ('endpointId ?? local' + ':' + canonical) deduplicates viewer tabs on. A symlink and its target share a canonical.
   */
  canonical: string
  /**
   * The content, always valid UTF-8. Empty when binary — the viewer says 'binary file, N bytes', never base64. When lossy, invalid sequences have been replaced.
   */
  text: string
  /**
   * The size sampled at read start. The viewer renders this, and the read-end sample is what corroborates changed.
   */
  size: number
  /**
   * The modification time sampled at read start, ISO-8601 UTC. Sampled again at read end; a difference is part of what sets changed.
   */
  modTime: string
  /**
   * True iff the effective limit (min(requested, 2 MiB)) was reached and the extra byte was readable — the result is a prefix, not the whole file.
   */
  truncated: boolean
  /**
   * A NUL byte among the bytes actually read. A heuristic and labelled as one: a binary whose first bytes are NUL-free reads as text, accepted.
   */
  binary: boolean
  /**
   * True when the bytes actually read were not valid UTF-8, so text is a lossy conversion with invalid sequences replaced. Distinct from binary: a NUL-free latin-1 file reads as lossy text, not as binary.
   */
  lossy: boolean
  /**
   * True when size or mtime differed between the before- and after-samples — the file changed while it was being read, and the viewer says 'this changed while I was reading it' instead of presenting an unknowable mixture.
   */
  changed: boolean
}
