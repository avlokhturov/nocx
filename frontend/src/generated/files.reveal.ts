/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/files.reveal.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the files.reveal JSON-RPC method: the path was revealed in the platform's file manager (Finder/Explorer). Local bindings only — the backend refuses a remote binding rather than silently doing nothing, because a UI-only guard is one bug away from being no guard (§5.2). An empty result is still a contract: additionalProperties: false on an empty shape is what makes 'returns nothing' enforceable.
 */
export interface FilesRevealResult {}
