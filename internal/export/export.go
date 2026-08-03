// Package export implements four distinct export/backup/import modes
// as required by ADR-0011 §7:
//
//  1. Configuration export — profiles, groups, settings. Secret references
//     are machine-local bindings and are stripped: the export carries
//     neither material nor the backend-owned references to it.
//  2. Portable encrypted export — configuration encrypted under a new
//     user-supplied passphrase. Private content (conversations, command
//     history) is never silently included; it requires an explicit opt-in.
//  3. Same-machine backup — configuration documents and content.db locations,
//     with a plain statement that secrets stay in the OS keychain.
//  4. Import — metadata first; the user binds their own secrets afterwards.
//     Import never resolves or invents a secret.
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
	// ModeConfigExport exports profiles, groups, and settings. Secret
	// references are machine-local and are stripped; no secret material is
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
				"Settings and preferences",
			},
			Omits: []string{
				"Secret material (passwords, key passphrases) — never exported",
				"Secret references — machine-local bindings, not exported",
				"Private content (AI conversations, command history)",
			},
			Notes: []string{
				"Imported connections have no saved passwords until secrets are bound on the receiving machine",
			},
		}
	case ModePortableEncrypted:
		return Manifest{
			Mode: mode,
			Carries: []string{
				"SSH connection profiles",
				"Profile groups and folder structure",
				"Settings and preferences",
				"Private content (conversations, command history) — when you tick the box",
			},
			Omits: []string{
				"Secret material (passwords, key passphrases) — never exported",
				"Secret references — machine-local bindings, not exported",
			},
			Notes: []string{
				"Encryption: NaCl secretbox (XSalsa20-Poly1305) with Argon2id key derivation",
				"Lose the passphrase and the backup is unrecoverable",
				"Private content is frequently more sensitive than host metadata; it is excluded by default",
			},
		}
	case ModeSameMachineBackup:
		return Manifest{
			Mode: mode,
			Carries: []string{
				"Configuration documents (profiles, groups, settings)",
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
				"Settings and preferences",
			},
			Omits: []string{
				"Secret resolution — import never invents or resolves secrets",
				"Secret references — machine-local bindings never travel",
			},
			Notes: []string{
				"After import, bind the machine's own secrets to the connections that need them",
				"Existing profiles, groups and settings with the same identifiers are replaced",
			},
		}
	default:
		return Manifest{
			Mode:  mode,
			Notes: []string{"Unknown mode"},
		}
	}
}
