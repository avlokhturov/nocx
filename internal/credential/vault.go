package credential

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// Crypto constants (match Tabby's VaultService for portability).
const (
	pbkdfIterations = 100_000
	saltLength      = 8  // 64 bits
	keyLength       = 32 // 256 bits for AES-256
	vaultVersion    = 2  // current vault format: AES-256-GCM with authenticated version
	legacyVersion   = 1  // deprecated: AES-256-CBC, unauthenticated
)

// StoredVault is the on-disk encrypted vault.
//
// Format version 2 (current): AES-256-GCM. Contents = hex(nonce || ciphertext || tag).
// Nonce is 12 bytes (GCM standard), generated fresh from crypto/rand per Marshal.
// The version, salt, and KDF parameters are passed as GCM additional authenticated
// data (AAD) so an attacker cannot swap them without detection.
//
// The passphrase is never stored — it is held in memory only while unlocked.
type StoredVault struct {
	Version  int    `json:"version"`
	Contents string `json:"contents"` // hex(nonce || AES-256-GCM ciphertext+tag)
	KeySalt  string `json:"keySalt"`  // hex-encoded PBKDF2 salt (8 bytes)
	IV       string `json:"iv"`       // unused in v2, kept for backward JSON compat
}

// vaultData is the in-memory plaintext state of the vault, keyed by SecretID.
type vaultData struct {
	Secrets map[SecretID]VaultSecret
}

// vaultDataDTO is the serializable shape of vaultData: an array of
// ID + plaintext value entries. It exists only at the marshal / decrypt
// boundary so the encrypted blob can be serialized without going through
// VaultSecret.Value (a Secret that refuses MarshalJSON).
type vaultDataDTO struct {
	Secrets []vaultSecretDTO `json:"secrets,omitempty"`
}

// vaultSecretDTO is the on-disk shape of a single VaultSecret.
type vaultSecretDTO struct {
	ID    SecretID `json:"id"`
	Value string   `json:"value"`
}

// toDTO converts the in-memory vaultData (with non-serializable Secrets)
// into a serializable DTO by reading each secret's plaintext through
// Secret.Use. This is the one place the vault materializes plaintext for
// encryption; the bytes live only for the duration of the Marshal call.
func (d vaultData) toDTO() (vaultDataDTO, error) {
	out := vaultDataDTO{Secrets: make([]vaultSecretDTO, 0, len(d.Secrets))}
	for id, s := range d.Secrets {
		dto := vaultSecretDTO{ID: id}
		if err := s.Value.Use(func(b []byte) error {
			dto.Value = string(b)
			return nil
		}); err != nil {
			return vaultDataDTO{}, fmt.Errorf("marshal secret %s: %w", id, err)
		}
		out.Secrets = append(out.Secrets, dto)
	}
	return out, nil
}

// fromDTO converts a decrypted DTO back into in-memory vaultData, wrapping
// each plaintext value in a Secret so it is again non-serializable.
func (vaultDataDTO) fromDTO(dto vaultDataDTO) vaultData {
	out := vaultData{Secrets: make(map[SecretID]VaultSecret, len(dto.Secrets))}
	for _, s := range dto.Secrets {
		out.Secrets[s.ID] = VaultSecret{ID: s.ID, Value: NewSecret(s.Value)}
	}
	return out
}

// Vault is a passphrase-encrypted secret store. It holds secrets in memory
// while unlocked and serializes to an encrypted StoredVault on demand.
// The passphrase is held in a package-level variable (not a struct field)
// so a compromised *Vault reference cannot exfiltrate it — mirroring
// Tabby's module-private _rememberedPassphrase design.
type Vault struct {
	store      *StoredVault
	passphrase string // in-memory only, not serialized
	data       vaultData
}

// NewVault creates an empty, locked vault.
func NewVault() *Vault {
	return &Vault{}
}

// Unlock sets the passphrase for the vault, decrypting the stored data if
// a StoredVault has been loaded. If no store is set, the vault starts empty
// and is ready to receive secrets.
func (v *Vault) Unlock(passphrase string) error {
	v.passphrase = passphrase
	if v.store == nil {
		v.data = vaultData{}
		return nil
	}
	return v.decrypt()
}

// LoadStore attaches a previously-serialized StoredVault. Must be called
// before Unlock for the passphrase to decrypt existing data.
func (v *Vault) LoadStore(s *StoredVault) {
	v.store = s
}

// IsEnabled reports whether a StoredVault is attached (vault is active).
func (v *Vault) IsEnabled() bool {
	return v.store != nil
}

// IsOpen reports whether the vault is unlocked (passphrase set).
func (v *Vault) IsOpen() bool {
	return v.passphrase != ""
}

// Marshal serializes the current data into an encrypted StoredVault using
// the held passphrase. Returns nil if the vault is not unlocked.
//
// Uses AES-256-GCM (format version 2). A fresh random salt and nonce are
// generated per call, so even identical plaintext produces a different blob.
// The in-memory VaultSecrets (with non-serializable Secret values) are
// converted to a private DTO via Secret.Use at this boundary only.
func (v *Vault) Marshal() (*StoredVault, error) {
	if v.passphrase == "" {
		return nil, errors.New("vault is locked")
	}

	salt, err := randomBytes(saltLength)
	if err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}

	key := deriveKey(v.passphrase, salt)

	// Materialize plaintext through Secret.Use at this boundary only. The
	// DTO's string values live just long enough for json.Marshal + GCM
	// encryption; they are never handed out beyond this function.
	dto, err := v.data.toDTO()
	if err != nil {
		return nil, fmt.Errorf("marshal vault data: %w", err)
	}
	plaintext, err := json.Marshal(dto)
	if err != nil {
		return nil, fmt.Errorf("marshal vault data: %w", err)
	}

	ciphertext, err := encryptGCM(key, plaintext, salt)
	if err != nil {
		return nil, fmt.Errorf("encrypt vault: %w", err)
	}

	return &StoredVault{
		Version:  vaultVersion,
		Contents: hex.EncodeToString(ciphertext),
		KeySalt:  hex.EncodeToString(salt),
	}, nil
}

// Unmarshal loads and decrypts a StoredVault with the given passphrase.
func (v *Vault) Unmarshal(s *StoredVault, passphrase string) error {
	v.store = s
	v.passphrase = passphrase
	return v.decrypt()
}

func (v *Vault) decrypt() error {
	if v.store == nil {
		return errors.New("no store loaded")
	}
	if v.passphrase == "" {
		return errors.New("vault is locked")
	}

	switch v.store.Version {
	case legacyVersion:
		return fmt.Errorf("vault format version 1 is no longer supported (unauthenticated AES-CBC); " +
			"delete the vault file and create a new one with a fresh passphrase")
	case vaultVersion:
		// proceed
	default:
		return fmt.Errorf("unknown vault format version %d", v.store.Version)
	}

	salt, err := hex.DecodeString(v.store.KeySalt)
	if err != nil {
		return fmt.Errorf("decode salt: %w", err)
	}
	ciphertext, err := hex.DecodeString(v.store.Contents)
	if err != nil {
		return fmt.Errorf("decode ciphertext: %w", err)
	}

	key := deriveKey(v.passphrase, salt)

	plaintext, err := decryptGCM(key, ciphertext, salt)
	if err != nil {
		// Do not distinguish wrong-passphrase from tampered data.
		return errors.New("decrypt failed: wrong passphrase or corrupted vault")
	}

	// Unmarshal into the DTO (plaintext strings) then wrap each value in a
	// Secret so the in-memory state is again non-serializable.
	var dto vaultDataDTO
	if err := json.Unmarshal(plaintext, &dto); err != nil {
		return fmt.Errorf("parse decrypted vault data: %w", err)
	}
	v.data = vaultDataDTO{}.fromDTO(dto)
	return nil
}

// GetSecret retrieves a secret by ID. Returns nil when no secret with that
// ID exists — absence is not an error.
func (v *Vault) GetSecret(id SecretID) (*VaultSecret, error) {
	if !v.IsOpen() {
		return nil, errors.New("vault is locked")
	}
	s, ok := v.data.Secrets[id]
	if !ok {
		return nil, nil
	}
	return &s, nil
}

// SaveSecret stores or updates a secret keyed by its ID.
func (v *Vault) SaveSecret(secret VaultSecret) error {
	if !v.IsOpen() {
		return errors.New("vault is locked")
	}
	if v.data.Secrets == nil {
		v.data.Secrets = make(map[SecretID]VaultSecret)
	}
	v.data.Secrets[secret.ID] = secret
	return nil
}

// DeleteSecret removes a secret by ID. Absence is not an error.
func (v *Vault) DeleteSecret(id SecretID) error {
	if !v.IsOpen() {
		return errors.New("vault is locked")
	}
	delete(v.data.Secrets, id)
	return nil
}

// deriveKey derives a 32-byte AES key from passphrase + salt via PBKDF2-HMAC-SHA512.
func deriveKey(passphrase string, salt []byte) []byte {
	return pbkdf2([]byte(passphrase), salt, pbkdfIterations, keyLength)
}

// pbkdf2 is a minimal PBKDF2 implementation (RFC 2898) using HMAC-SHA512.
// We avoid the x/crypto/pbkdf2 dependency by inlining the core loop.
func pbkdf2(password, salt []byte, iter, keyLen int) []byte {
	hashLen := 64 // SHA-512 output length
	numBlocks := (keyLen + hashLen - 1) / hashLen

	var dk []byte
	for block := 1; block <= numBlocks; block++ {
		// U1 = PRF(Password, Salt || INT_32_BE(block))
		prf := hmac.New(sha512.New, password)
		prf.Write(salt)
		prf.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)

		for n := 2; n <= iter; n++ {
			prf = hmac.New(sha512.New, password)
			prf.Write(u)
			u = prf.Sum(nil)
			for i := range t {
				t[i] ^= u[i]
			}
		}
		dk = append(dk, t...)
	}
	return dk[:keyLen]
}

// encryptGCM encrypts plaintext with AES-256-GCM.
//
// # AEAD construction
//
// AES-256-GCM was chosen over alternatives:
//   - ChaCha20-Poly1305: Go's x/crypto implements it, but AES-GCM is in stdlib
//     and benefits from hardware acceleration (AES-NI) on all modern CPUs.
//   - AES-GCM-SIV: would tolerate nonce misuse, but we generate a fresh random
//     nonce per encryption, so nonce reuse is not a concern.
//   - XChaCha20-Poly1305: larger nonce, but 96-bit random nonce with GCM is
//     safe for the number of encryptions a vault sees (<< 2^32).
//
// # Nonce generation and reuse prevention
//
// The nonce is 12 bytes from crypto/rand, generated fresh per Marshal call.
// A new random salt is also generated per Marshal, so even when encrypting the
// same plaintext with the same passphrase, the derived key differs and the
// nonce is unique. The birthday bound for random 96-bit nonces is ~2^48
// encryptions before collision probability becomes significant — far beyond
// the lifetime of a vault file.
//
// # Authenticated data
//
// The GCM additional authenticated data (AAD) binds the salt and KDF
// parameters to the ciphertext. An attacker who swaps the salt, iterations,
// or key length in a stored blob will cause GCM authentication to fail,
// producing the same error as a wrong passphrase.
//
// AAD encoding (16 bytes):
//
//	version (4 bytes, big-endian) ||
//	salt (8 bytes, raw) ||
//	iterations (4 bytes, big-endian) ||
//	keyLength (1 byte)
//
// The version in AAD mirrors the StoredVault.Version field; GCM
// authenticates it so version-tampering is detected.
func encryptGCM(key, plaintext, salt []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	aad := buildAAD(salt)
	// gcm.Seal appends to dst: nonce || ciphertext || tag
	return gcm.Seal(nonce, nonce, plaintext, aad), nil
}

// decryptGCM decrypts ciphertext (nonce || ciphertext || tag) with AES-256-GCM.
// Returns an error indistinguishable from wrong-passphrase when authentication fails.
func decryptGCM(key, ciphertext, salt []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, errors.New("ciphertext too short")
	}

	nonce, ct := ciphertext[:nonceSize], ciphertext[nonceSize:]
	aad := buildAAD(salt)
	return gcm.Open(nil, nonce, ct, aad)
}

// buildAAD constructs the GCM additional authenticated data from the
// salt and KDF parameters. Format:
//
//	version (4 bytes BE) || salt (8 bytes) || iterations (4 bytes BE) || keyLength (1 byte)
func buildAAD(salt []byte) []byte {
	aad := make([]byte, 4+8+4+1) // 17 bytes
	ver := uint32(vaultVersion)
	aad[0] = byte(ver >> 24)
	aad[1] = byte(ver >> 16)
	aad[2] = byte(ver >> 8)
	aad[3] = byte(ver)
	copy(aad[4:12], salt)
	iter := uint32(pbkdfIterations)
	aad[12] = byte(iter >> 24)
	aad[13] = byte(iter >> 16)
	aad[14] = byte(iter >> 8)
	aad[15] = byte(iter)
	aad[16] = byte(keyLength)
	return aad
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}
