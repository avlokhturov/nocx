/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/backup.create.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

export interface BackupCreateResult {
  fileName: string
  contents: string
  summary: {
    settings: number
    connections: number
    groups: number
    credentialBindingsRemoved: number
    groupCredentialBindingsRemoved: number
    groupDefaultKeysOmitted: number
  }
}
