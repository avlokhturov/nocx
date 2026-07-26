package export

import (
	"os"
	"path/filepath"

	"github.com/shady2k/nocx/internal/storage"
)

// ---------------------------------------------------------------------------
// Same-machine backup
// ---------------------------------------------------------------------------

// BackupManifest describes a same-machine backup: what files to copy
// and what is deliberately absent. The manifest is returned for the
// UI to display; the actual file copy is performed by a later task.
type BackupManifest struct {
	Mode          Mode   `json:"mode"`
	ConfigDir     string `json:"configDir"`
	ContentDBPath string `json:"contentDbPath,omitempty"`
	// ContentDBAbsent is true when content.db does not exist (stub mode).
	ContentDBAbsent bool `json:"contentDbAbsent"`
	// SecretsStatement is the plain statement shown to the user.
	SecretsStatement string `json:"secretsStatement"`
	// Carries and Omits match ManifestFor(ModeSameMachineBackup).
	Carries []string `json:"carries"`
	Omits   []string `json:"omits"`
}

// BackupDeps are the dependencies for a same-machine backup.
type BackupDeps struct {
	Paths storage.Paths
}

// Backup returns a manifest describing what to back up. It does not
// perform the file copy — that is a later task's responsibility.
// content.db is probed on disk; if absent (stub mode), ContentDBAbsent
// is true and ContentDBPath is empty (ADR-0011 §5: handle absence
// honestly, do not fail).
func Backup(deps BackupDeps) (*BackupManifest, error) {
	manifest := ManifestFor(ModeSameMachineBackup)

	dbPath := filepath.Join(deps.Paths.DataDir(), "content.db")
	_, err := os.Stat(dbPath)
	absent := os.IsNotExist(err)

	bm := &BackupManifest{
		Mode:             ModeSameMachineBackup,
		ConfigDir:        deps.Paths.ConfigDir(),
		ContentDBAbsent:  absent,
		SecretsStatement: "Secrets (passwords, key passphrases) are held in the OS keychain and are not included in this backup. They cannot be backed up to a file.",
		Carries:          manifest.Carries,
		Omits:            manifest.Omits,
	}

	if !absent {
		bm.ContentDBPath = dbPath
	}

	return bm, nil
}
