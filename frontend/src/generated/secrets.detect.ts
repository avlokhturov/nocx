/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/secrets.detect.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the secrets.detect JSON-RPC method — the ONE detector, exposed over the wire. Detection lived twice (internal/secrets and a TS port in the renderer) and the two drifted; the port is deleted and the prompt hint calls here after its 500 ms settle debounce, so detection is one call per pause, never per keystroke. Revision echoes the renderer's document revision so the hint can drop a stale response — it never adjusts an old range onto a newer document.
 */
export interface SecretsDetect {
  /**
   * The document revision this result was computed for, echoed from the request. The renderer drops a response whose revision no longer matches the current document.
   */
  revision: number
  /**
   * Every secret-shaped region of the submitted line, in first-occurrence order. Offsets are UTF-16 code-unit positions into the line — what CodeMirror and JS string slicing use; byte offsets would decorate the wrong text on any line with an emoji, a combining mark or Cyrillic before the credential. The credential's VALUE never crosses: kind and offsets are the fact. Never null: no findings is [].
   */
  findings: {
    /**
     * The closed vocabulary of internal/secrets: openai, github-pat, slack, aws-access-key, gitlab, jwt, private-key, url-userinfo, db-connstring, auth-header, env-assignment, high-entropy. A new kind is a deliberate addition to the vocabulary.
     */
    kind:
      | 'openai'
      | 'github-pat'
      | 'slack'
      | 'aws-access-key'
      | 'gitlab'
      | 'jwt'
      | 'private-key'
      | 'url-userinfo'
      | 'db-connstring'
      | 'auth-header'
      | 'env-assignment'
      | 'high-entropy'
    /**
     * Inclusive UTF-16 code-unit offset into the line.
     */
    start: number
    /**
     * Exclusive UTF-16 code-unit offset into the line.
     */
    end: number
  }[]
}
