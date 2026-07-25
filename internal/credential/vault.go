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
	ivLength        = 16 // 128 bits for AES-CBC
)

// StoredVault is the on-disk encrypted vault: the ciphertext, salt, and IV.
// The passphrase is never stored — it is held in memory only while unlocked.
type StoredVault struct {
	Version  int    `json:"version"`
	Contents string `json:"contents"` // hex-encoded AES-256-CBC ciphertext
	KeySalt  string `json:"keySalt"`  // hex-encoded PBKDF2 salt
	IV       string `json:"iv"`       // hex-encoded AES IV
}

// vaultData is the plaintext JSON inside the vault.
type vaultData struct {
	Secrets []VaultSecret `json:"secrets,omitempty"`
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
func (v *Vault) Marshal() (*StoredVault, error) {
	if v.passphrase == "" {
		return nil, errors.New("vault is locked")
	}

	salt, err := randomBytes(saltLength)
	if err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}
	iv, err := randomBytes(ivLength)
	if err != nil {
		return nil, fmt.Errorf("generate IV: %w", err)
	}

	key := deriveKey(v.passphrase, salt)

	plaintext, err := json.Marshal(v.data)
	if err != nil {
		return nil, fmt.Errorf("marshal vault data: %w", err)
	}

	ciphertext, err := encryptAESCBC(key, iv, plaintext)
	if err != nil {
		return nil, fmt.Errorf("encrypt vault: %w", err)
	}

	return &StoredVault{
		Version:  1,
		Contents: hex.EncodeToString(ciphertext),
		KeySalt:  hex.EncodeToString(salt),
		IV:       hex.EncodeToString(iv),
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

	salt, err := hex.DecodeString(v.store.KeySalt)
	if err != nil {
		return fmt.Errorf("decode salt: %w", err)
	}
	iv, err := hex.DecodeString(v.store.IV)
	if err != nil {
		return fmt.Errorf("decode IV: %w", err)
	}
	ciphertext, err := hex.DecodeString(v.store.Contents)
	if err != nil {
		return fmt.Errorf("decode ciphertext: %w", err)
	}

	key := deriveKey(v.passphrase, salt)

	plaintext, err := decryptAESCBC(key, iv, ciphertext)
	if err != nil {
		return fmt.Errorf("decrypt vault (wrong passphrase?): %w", err)
	}

	if err := json.Unmarshal(plaintext, &v.data); err != nil {
		return fmt.Errorf("parse decrypted vault data: %w", err)
	}
	return nil
}

// GetSecret retrieves a secret by type and key. If no exact match is found
// for a password lookup, it retries with Host="" and Port=0 — the
// "default password shared across servers" fallback (mirrors Tabby).
func (v *Vault) GetSecret(typ SecretType, key VaultKey) (*VaultSecret, error) {
	if !v.IsOpen() {
		return nil, errors.New("vault is locked")
	}
	for i, s := range v.data.Secrets {
		if s.matches(typ, key) {
			return &v.data.Secrets[i], nil
		}
	}
	// host-null fallback for passwords only.
	if typ == SecretTypePassword && (key.Host != "" || key.Port != 0) {
		fallbackKey := VaultKey{User: key.User, Host: "", Port: 0}
		for i, s := range v.data.Secrets {
			if s.matches(typ, fallbackKey) {
				return &v.data.Secrets[i], nil
			}
		}
	}
	return nil, nil
}

// SaveSecret stores or updates a secret. Deduplicates by (type, key) —
// an existing entry with the same key is updated, not duplicated.
func (v *Vault) SaveSecret(secret VaultSecret) error {
	if !v.IsOpen() {
		return errors.New("vault is locked")
	}
	for i, s := range v.data.Secrets {
		if s.Type == secret.Type && keysEqual(s.Key, secret.Key) {
			v.data.Secrets[i] = secret
			return nil
		}
	}
	v.data.Secrets = append(v.data.Secrets, secret)
	return nil
}

// DeleteSecret removes a secret by type and key.
func (v *Vault) DeleteSecret(typ SecretType, key VaultKey) error {
	if !v.IsOpen() {
		return errors.New("vault is locked")
	}
	for i, s := range v.data.Secrets {
		if s.matches(typ, key) {
			v.data.Secrets = append(v.data.Secrets[:i], v.data.Secrets[i+1:]...)
			return nil
		}
	}
	return nil
}

func keysEqual(a, b VaultKey) bool {
	return a.User == b.User && a.Host == b.Host && a.Port == b.Port && a.Hash == b.Hash
}

// ---------------------------------------------------------------------------
// crypto helpers
// ---------------------------------------------------------------------------

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

func encryptAESCBC(key, iv, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	mode := cipher.NewCBCEncrypter(block, iv)

	// PKCS7 padding.
	padLen := aes.BlockSize - len(plaintext)%aes.BlockSize
	padded := make([]byte, len(plaintext)+padLen)
	copy(padded, plaintext)
	for i := len(plaintext); i < len(padded); i++ {
		padded[i] = byte(padLen)
	}

	ciphertext := make([]byte, len(padded))
	mode.CryptBlocks(ciphertext, padded)
	return ciphertext, nil
}

func decryptAESCBC(key, iv, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(ciphertext)%aes.BlockSize != 0 {
		return nil, errors.New("ciphertext is not a multiple of block size")
	}

	mode := cipher.NewCBCDecrypter(block, iv)
	plaintext := make([]byte, len(ciphertext))
	mode.CryptBlocks(plaintext, ciphertext)

	// Remove PKCS7 padding.
	if len(plaintext) == 0 {
		return nil, errors.New("empty plaintext")
	}
	padLen := int(plaintext[len(plaintext)-1])
	if padLen == 0 || padLen > aes.BlockSize || padLen > len(plaintext) {
		return nil, errors.New("invalid padding")
	}
	return plaintext[:len(plaintext)-padLen], nil
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}
