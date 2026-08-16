// The namespace registry — one declaration of who may claim a {{ns:arg}}
// namespace, so a third feature cannot claim one twice.
//
// Deliberately NOT a shared scan. `env` and `ask` spans are resolved before
// the text reaches any destination, so no document secret-reference.ts scans
// ever contains one — a shared parser would buy nothing at runtime while
// placing the vault's resolution path in this feature's change budget. What
// is genuinely one concept is who OWNS a namespace, and that is what lives
// here. Design §7.2.
export const REFERENCE_NAMESPACES = {
  secret: 'vault (secret-reference.ts / vault.resolveLine)',
  env: 'snippets (resolved at fire time)',
  ask: 'snippets (resolved at fire time)',
} as const

export type ReferenceNamespace = keyof typeof REFERENCE_NAMESPACES
