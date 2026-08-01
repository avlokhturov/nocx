package export

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/shady2k/nocx/internal/content"
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
	// ContentDBSnapshotPath names the consistent, encrypted snapshot that
	// Backup produced for copying. The live store is content.db plus -wal
	// plus -shm while running; the snapshot folds all three into one file
	// via the SQLite online backup API, so the copy step must copy exactly
	// this one file, never the live set.
	ContentDBSnapshotPath string `json:"contentDbSnapshotPath,omitempty"`
	// ContentDBWalPath and ContentDBShmPath name the live WAL state when no
	// snapshot could be produced (stub store): a copy step that ignores the
	// snapshot API at least copies the complete set, not a torn single file.
	ContentDBWalPath string `json:"contentDbWalPath,omitempty"`
	ContentDBShmPath string `json:"contentDbShmPath,omitempty"`
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
	// ContentDB, when wired, is used to produce a consistent encrypted
	// snapshot for the copy step. Absent (or a stub) means only the live
	// file set is reported.
	ContentDB content.ContentDB
}

// Backup returns a manifest describing what to back up. It does not
// perform the file copy — that is a later task's responsibility.
// content.db is probed on disk; if absent (stub mode), ContentDBAbsent
// is true and ContentDBPath is empty (ADR-0011 §5: handle absence
// honestly, do not fail).
//
// When the store is wired, Backup also produces the snapshot the copy step
// must copy: WAL mode means the live store is three files, and copying the
// single content.db while running yields a torn backup (this is data loss,
// not a threat-model issue). The snapshot is created through the store's
// keyed VFS — an encrypted, consistent, single-file image.
func Backup(ctx context.Context, deps BackupDeps) (*BackupManifest, error) {
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

	if absent {
		return bm, nil
	}
	bm.ContentDBPath = dbPath

	if deps.ContentDB != nil {
		snapshot := dbPath + ".snapshot"
		if err := deps.ContentDB.Backup(ctx, snapshot); err == nil {
			bm.ContentDBSnapshotPath = snapshot
			return bm, nil
		} else if !errors.Is(err, content.ErrNotImplemented) {
			return nil, fmt.Errorf("content backup: %w", err)
		}
		// A stub store falls through to reporting the live file set.
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(dbPath + suffix); err == nil {
			if suffix == "-wal" {
				bm.ContentDBWalPath = dbPath + suffix
			} else {
				bm.ContentDBShmPath = dbPath + suffix
			}
		}
	}
	return bm, nil
}
