// Package export implements four distinct export/backup/import modes
// as required by ADR-0011 §7:
//
//  1. Configuration export — profiles, groups, credential metadata, settings.
//     Secret references (SecretID) are present but unresolved.
//  2. Portable encrypted export — configuration encrypted under a new
//     user-supplied passphrase. Private content (conversations, command
//     history) is never silently included; it requires an explicit opt-in.
//  3. Same-machine backup — configuration documents and content.db locations,
//     with a plain statement that secrets stay in the OS keychain.
//  4. Import — metadata first; the user maps existing credentials or supplies
//     missing secrets. Import never resolves or invents a secret.
//
// Hard constraints (ADR-0011 §2, §7):
//   - No mode resolves a secret. No code path in this package calls
//     credential.SecretStore.Get or any equivalent that returns plaintext.
//   - Private content is never silently included in a portable export.
//   - Every mode states what it carries and what it omits, as data the
//     UI can display (see ManifestFor).
package export

// Mode identifies which export/backup/import operation to perform.
type Mode string

const (
	// ModeConfigExport exports profiles, groups, credential metadata, and
	// settings. SecretID references travel as-is; no secret material is
	// ever resolved or included.
	ModeConfigExport Mode = "config-export"

	// ModePortableEncrypted exports configuration encrypted under a new
	// user-supplied passphrase using NaCl secretbox + Argon2id key
	// derivation. Private content is excluded unless explicitly requested.
	ModePortableEncrypted Mode = "portable-encrypted"

	// ModeSameMachineBackup reports what files to copy for a same-machine
	// backup. Secrets remain in the OS keychain and are not in the backup.
	ModeSameMachineBackup Mode = "same-machine-backup"

	// ModeImport imports a configuration export into the local stores.
	// Metadata lands first; secrets are never resolved or invented.
	ModeImport Mode = "import"
)

// Manifest describes what a mode carries and what it omits.
// This is data the UI can display — not a comment in source (ADR-0011 §7).
type Manifest struct {
	Mode    Mode     `json:"mode"`
	Carries []string `json:"carries"`
	Omits   []string `json:"omits"`
	Notes   []string `json:"notes,omitempty"`
}

// ManifestFor returns the manifest for the given mode, before any
// operation is performed. This lets the UI show what will happen
// before the user commits.
func ManifestFor(mode Mode) Manifest {
	switch mode {
	case ModeConfigExport:
		return Manifest{
			Mode: mode,
			Carries: []string{
				"SSH connection profiles",
				"Profile groups and folder structure",
				"Credential metadata (username, key path, auth method)",
				"Settings and preferences",
			},
			Omits: []string{
				"Secret material (passwords, key passphrases) — only SecretID references travel",
				"Private content (AI conversations, command history)",
			},
			Notes: []string{
				"SecretID values are opaque references; the receiving machine must have its own secrets",
			},
		}
	case ModePortableEncrypted:
		return Manifest{
			Mode: mode,
			Carries: []string{
				"Everything in a configuration export, encrypted under your passphrase",
			},
			Omits: []string{
				"Secret material — never resolved, never encrypted",
				"Private content (AI conversations, command history) — unless you explicitly opt in",
			},
			Notes: []string{
				"Encryption: NaCl secretbox (XSalsa20-Poly1305) with Argon2id key derivation",
				"Lose the passphrase and the export is unrecoverable",
				"Private content is frequently more sensitive than host metadata; it is excluded by default",
			},
		}
	case ModeSameMachineBackup:
		return Manifest{
			Mode: mode,
			Carries: []string{
				"Configuration documents (profiles, groups, credentials, settings)",
				"Content database (content.db), if it exists",
			},
			Omits: []string{
				"Secrets — they stay in the OS keychain and cannot be backed up this way",
			},
			Notes: []string{
				"Same-machine only — secrets are tied to the OS keychain on this machine",
				"content.db is reported as absent if it does not yet exist (stub mode)",
			},
		}
	case ModeImport:
		return Manifest{
			Mode: mode,
			Carries: []string{
				"SSH connection profiles",
				"Profile groups and folder structure",
				"Credential metadata (with SecretID references intact)",
			},
			Omits: []string{
				"Secret resolution — import never invents or resolves secrets",
			},
			Notes: []string{
				"After import, map existing credentials or supply missing secrets",
				"Unresolved credentials are reported so the UI can prompt the user",
			},
		}
	default:
		return Manifest{
			Mode:  mode,
			Notes: []string{"Unknown mode"},
		}
	}
}
