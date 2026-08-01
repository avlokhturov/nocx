package export

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/content"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/nacl/secretbox"
)

// ---------------------------------------------------------------------------
// Portable encrypted export
// ---------------------------------------------------------------------------

// PortableEncryptedExport is a configuration export encrypted under a
// user-supplied passphrase. The payload is NaCl secretbox ciphertext
// wrapping a PortablePayload.
type PortableEncryptedExport struct {
	// Payload is the encrypted PortablePayload.
	Payload []byte `json:"payload"`
	// IncludePrivateContent records whether the user opted in to
	// private content inclusion.
	IncludePrivateContent bool `json:"includePrivateContent,omitempty"`
}

// PortableEncryptedDeps are the dependencies for a portable encrypted
// export.
type PortableEncryptedDeps struct {
	ConfigExport ConfigExportDeps
	// ContentDB provides access to conversations and command history
	// when includePrivateContent is true.
	ContentDB content.ContentDB
}

// PortablePayload is the plaintext structure encrypted inside a
// PortableEncryptedExport.
type PortablePayload struct {
	Config  ConfigExport    `json:"config"`
	Private *PrivateContent `json:"private,omitempty"`
}

// PrivateContent holds conversations and command history for a
// portable export. It is included only when the user explicitly
// opts in (ADR-0011 §7).
type PrivateContent struct {
	Conversations  []content.Conversation  `json:"conversations,omitempty"`
	CommandHistory []content.CommandRecord `json:"commandHistory,omitempty"`
	// Available is false when content.db is a stub (not yet
	// implemented); the slices will be empty in that case.
	Available bool `json:"available"`
}

// ---------------------------------------------------------------------------
// Encryption parameters
// ---------------------------------------------------------------------------

const (
	secretboxKeySize   = 32
	secretboxNonceSize = 24
	saltSize           = 16
	argon2Time         = 3
	argon2Memory       = 64 * 1024 // 64 MiB
	argon2Threads      = 4
)

var errDecryptionFailed = errors.New("decryption failed: wrong passphrase or corrupted data")

// ExportPortableEncrypted produces a passphrase-encrypted PortablePayload.
// includePrivateContent must be explicitly true for conversations and
// command history to be included. The ContentDB is called only when
// includePrivateContent is true; if ContentDB is a stub
// (ErrNotImplemented), the export succeeds with Available=false.
func ExportPortableEncrypted(deps PortableEncryptedDeps, passphrase string, includePrivateContent bool) (*PortableEncryptedExport, error) {
	configExport, err := ExportConfiguration(deps.ConfigExport)
	if err != nil {
		return nil, fmt.Errorf("configuration export: %w", err)
	}

	payload := PortablePayload{
		Config: *configExport,
	}

	if includePrivateContent {
		payload.Private = collectPrivateContent(deps.ContentDB)
	}

	plaintext, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	ciphertext, err := encryptSecretBox(plaintext, passphrase)
	if err != nil {
		return nil, fmt.Errorf("encrypt: %w", err)
	}

	return &PortableEncryptedExport{
		Payload:               ciphertext,
		IncludePrivateContent: includePrivateContent,
	}, nil
}

// DecryptPortableExport decrypts a PortableEncryptedExport back into a
// PortablePayload using the supplied passphrase.
func DecryptPortableExport(enc *PortableEncryptedExport, passphrase string) (*PortablePayload, error) {
	plaintext, err := decryptSecretBox(enc.Payload, passphrase)
	if err != nil {
		return nil, err
	}

	var payload PortablePayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal payload: %w", err)
	}

	return &payload, nil
}

// ---------------------------------------------------------------------------
// NaCl secretbox + Argon2id
// ---------------------------------------------------------------------------

// Wire format: [salt: saltSize][nonce: secretboxNonceSize][ciphertext: ...]

func encryptSecretBox(plaintext []byte, passphrase string) ([]byte, error) {
	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}

	nonce := new([secretboxNonceSize]byte)
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	key := deriveKey(passphrase, salt)

	out := make([]byte, 0, saltSize+secretboxNonceSize+len(plaintext)+secretbox.Overhead)
	out = append(out, salt...)
	out = append(out, nonce[:]...)
	out = secretbox.Seal(out, plaintext, nonce, key)

	return out, nil
}

func decryptSecretBox(ciphertext []byte, passphrase string) ([]byte, error) {
	if len(ciphertext) < saltSize+secretboxNonceSize+secretbox.Overhead {
		return nil, errDecryptionFailed
	}

	salt := ciphertext[:saltSize]
	nonce := new([secretboxNonceSize]byte)
	copy(nonce[:], ciphertext[saltSize:saltSize+secretboxNonceSize])
	box := ciphertext[saltSize+secretboxNonceSize:]

	key := deriveKey(passphrase, salt)

	plaintext, ok := secretbox.Open(nil, box, nonce, key)
	if !ok {
		return nil, errDecryptionFailed
	}

	return plaintext, nil
}

func deriveKey(passphrase string, salt []byte) *[secretboxKeySize]byte {
	raw := argon2.IDKey([]byte(passphrase), salt, argon2Time, argon2Memory, argon2Threads, secretboxKeySize)
	key := new([secretboxKeySize]byte)
	copy(key[:], raw)
	return key
}

// ---------------------------------------------------------------------------
// Private content collection
// ---------------------------------------------------------------------------

// collectPrivateContent attempts to gather conversations and command
// history from ContentDB. If ContentDB is a stub (returns
// content.ErrNotImplemented), it returns a PrivateContent with
// Available=false and empty slices — this is not a failure condition
// (ADR-0011 §5: the SQLite implementation is deferred).
func collectPrivateContent(db content.ContentDB) *PrivateContent {
	pc := &PrivateContent{}

	if db == nil {
		// No ContentDB wired — same outcome as a stub.
		return pc
	}

	convs, err := db.Conversations().List(context.Background(), 0)
	if err != nil {
		// Stub or unavailable — not an error.
		return pc
	}
	pc.Conversations = convs

	history, err := db.CommandHistory().List(context.Background(), 0)
	if err != nil {
		return pc
	}
	pc.CommandHistory = history

	pc.Available = true
	return pc
}

// RestorePrivateContent writes conversations and command history carried by
// a portable export back into the ContentDB. It is a no-op when the payload's
// private block is nil or unavailable — such a payload carries nothing to
// restore. When it does carry content, every item is written and the first
// failure aborts the restore: an import must not report success after
// silently dropping what the archive promised to carry (nocx-ojxa).
//
// Command history rows are restored with their timestamps; row IDs are
// assigned by the receiving store (the record's ID field is informational).
// Conversations keep their IDs, titles and message timelines.
func RestorePrivateContent(db content.ContentDB, pc *PrivateContent) error {
	if pc == nil || !pc.Available {
		// The payload carries nothing to restore.
		return nil
	}
	if db == nil {
		// The archive carries private content and this machine has no store
		// to put it in. Silently dropping it is the defect this fixes.
		return errors.New("restore private content: no content database is available")
	}
	ctx := context.Background()
	for _, conv := range pc.Conversations {
		if err := db.Conversations().Save(ctx, conv); err != nil {
			return fmt.Errorf("restore conversation %s: %w", conv.ID, err)
		}
	}
	for _, rec := range pc.CommandHistory {
		if err := db.CommandHistory().Add(ctx, rec); err != nil {
			return fmt.Errorf("restore command history: %w", err)
		}
	}
	return nil
}
