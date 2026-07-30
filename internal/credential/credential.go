// Package credential provides the Secret type and the SecretStore capability.
//
// It deliberately no longer contains a store implementation. Secrets are held
// by providers under internal/vault, and the Vault is what the composition
// root wires — see ADR-0011 as amended by the vault design.
package credential

// CredentialStore is a type alias for SecretStore, still referenced by the
// composition root (internal/app/app.go).
//
// It is scheduled for deletion together with the move to the ctx-bearing
// Create/Get/Delete/Exists contract, at which point app.go references
// SecretStore directly. It survives here only because removing it and rewiring
// app.go are the same edit, and that edit is a task of its own.
type CredentialStore = SecretStore
