// The closed kind vocabulary plus the two display facts that follow from a
// kind — its human word and how loud it may be while the user is still
// composing. Shared by every surface that renders a finding or a redaction
// (the prompt's composition-time decoration, the frozen block's chips, the
// after-submit receipt): one table, one copy, never per-surface constants.
//
// The type follows the wire's generated union, never a hand-rolled list —
// a new kind is a deliberate addition to internal/secrets, and the schema
// is what spells it.
import type { SecretsDetect } from './vault-client'

/** The closed kind vocabulary, as the wire's generated union spells it. */
export type SecretKind = SecretsDetect['findings'][number]['kind']

/** The human word for a detected kind — the badge on a receipt row and the
 *  chip label on a block. */
export const KIND_LABELS: Record<SecretKind, string> = {
  openai: 'OpenAI key',
  'github-pat': 'GitHub token',
  slack: 'Slack token',
  'aws-access-key': 'AWS access key',
  gitlab: 'GitLab token',
  jwt: 'JWT',
  'private-key': 'Private key',
  'url-userinfo': 'URL password',
  'db-connstring': 'Database password',
  'auth-header': 'API key',
  'env-assignment': 'Environment secret',
  'high-entropy': 'API key',
}

/**
 * How loud a finding may be while the user is still typing. A vendor prefix
 * (openai, github-pat, …) is close to proof and earns the quiet in-line
 * decoration; a shape-based guess (jwt, auth-header, db-connstring,
 * url-userinfo, env-assignment, high-entropy) is worth exactly nothing at
 * composition time — a wrong guess interrupting someone mid-flow is the
 * failure mode this epic names. The shape-based kinds still appear in the
 * after-submit receipt, where a wrong guess costs a glance instead of an
 * interruption.
 *
 * If the tier ever needs to be more than a function of kind — a per-line
 * confidence, a policy — it belongs in the wire schema, not in this table.
 */
export const KIND_LOUDNESS: Record<SecretKind, 'quiet' | 'silent'> = {
  openai: 'quiet',
  'github-pat': 'quiet',
  slack: 'quiet',
  'aws-access-key': 'quiet',
  gitlab: 'quiet',
  'private-key': 'quiet',
  jwt: 'silent',
  'auth-header': 'silent',
  'db-connstring': 'silent',
  'url-userinfo': 'silent',
  'env-assignment': 'silent',
  'high-entropy': 'silent',
}

/** Whether a finding of this kind gets the composition-time decoration. */
export function kindIsQuiet(kind: SecretKind): boolean {
  return KIND_LOUDNESS[kind] === 'quiet'
}
