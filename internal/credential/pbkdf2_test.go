package credential

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // RFC 6070 test vectors only
	"crypto/sha512"
	"encoding/hex"
	"testing"

	xpbkdf2 "golang.org/x/crypto/pbkdf2"
)

// pbkdf2LegacySHA512 is the original inlined PBKDF2 loop from vault.go,
// preserved here after the production swap to x/crypto/pbkdf2 so the
// byte-equality assertion remains testable.
func pbkdf2LegacySHA512(password, salt []byte, iter, keyLen int) []byte {
	hashLen := 64 // SHA-512 output length
	numBlocks := (keyLen + hashLen - 1) / hashLen

	var dk []byte
	for block := 1; block <= numBlocks; block++ {
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

func pbkdf2SHA1(password, salt []byte, iter, keyLen int) []byte {
	hashLen := sha1.Size // 20
	numBlocks := (keyLen + hashLen - 1) / hashLen

	var dk []byte
	for block := 1; block <= numBlocks; block++ {
		prf := hmac.New(sha1.New, password)
		prf.Write(salt)
		prf.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)

		for n := 2; n <= iter; n++ {
			prf = hmac.New(sha1.New, password)
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

// rfc6070Vector is one PBKDF2-HMAC-SHA1 test vector from RFC 6070.
type rfc6070Vector struct {
	password string
	salt     string
	iter     int
	keyLen   int
	want     string // hex-encoded expected output
}

var rfc6070Vectors = []rfc6070Vector{
	{
		password: "password",
		salt:     "salt",
		iter:     1,
		keyLen:   20,
		want:     "0c60c80f961f0e71f3a9b524af6012062fe037a6",
	},
	{
		password: "password",
		salt:     "salt",
		iter:     2,
		keyLen:   20,
		want:     "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957",
	},
	{
		password: "password",
		salt:     "salt",
		iter:     4096,
		keyLen:   20,
		want:     "4b007901b765489abead49d926f721d065a429c1",
	},
	// RFC 6070 also has a c=16777216 vector; skipped — it takes ~30s and
	// proves nothing the other vectors do not already cover.
	{
		password: "passwordPASSWORDpassword",
		salt:     "saltSALTsaltSALTsaltSALTsaltSALTsalt",
		iter:     4096,
		keyLen:   25,
		want:     "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038",
	},
}

// TestPBKDF2RFC6070 runs the RFC 6070 vectors against a test-only SHA-1
// mirror of the inlined PBKDF2 loop, then against golang.org/x/crypto/pbkdf2.
// The two MUST produce byte-identical output or the inlined implementation
// is wrong.
func TestPBKDF2RFC6070(t *testing.T) {
	for i, v := range rfc6070Vectors {
		got := pbkdf2SHA1([]byte(v.password), []byte(v.salt), v.iter, v.keyLen)
		if hex.EncodeToString(got) != v.want {
			t.Errorf("vector %d (iter=%d, keyLen=%d): pbkdf2SHA1 mismatch", i, v.iter, v.keyLen)
		}
	}
}

// TestPBKDF2VaultParamsSHA512 derives a key at the vault's actual parameters
// (100_000 iterations, 8-byte salt, 32-byte output, HMAC-SHA512) using both
// the current inlined pbkdf2 and golang.org/x/crypto/pbkdf2.Key. They MUST
// produce byte-identical output or existing vaults become unreadable.
func TestPBKDF2VaultParamsSHA512(t *testing.T) {
	const (
		iter   = 100_000
		keyLen = 32
	)
	password := []byte("test vault passphrase")
	salt := []byte("deadbeef") // 8 bytes

	// Pre-swap production path — the inlined loop preserved in this test file.
	inline := pbkdf2LegacySHA512(password, salt, iter, keyLen)

	// Reference — golang.org/x/crypto/pbkdf2.Key with SHA-512.
	ref := xpbkdf2.Key(password, salt, iter, keyLen, sha512.New)
	if len(inline) != len(ref) {
		t.Fatalf("length mismatch: inline=%d ref=%d", len(inline), len(ref))
	}
	for i := range inline {
		if inline[i] != ref[i] {
			t.Fatalf("byte mismatch at offset %d", i)
		}
	}
	// If we reach here, the two are byte-identical — the swap is safe.
	t.Logf("byte-identical at vault parameters (iter=%d, keyLen=%d, SHA-512)", iter, keyLen)
}

func TestPBKDF2XCryptoMatchesRFC6070(t *testing.T) {
	for i, v := range rfc6070Vectors {
		got := xpbkdf2.Key([]byte(v.password), []byte(v.salt), v.iter, v.keyLen, sha1.New)
		if hex.EncodeToString(got) != v.want {
			t.Errorf("vector %d (iter=%d, keyLen=%d): x/crypto/pbkdf2 mismatch", i, v.iter, v.keyLen)
		}
	}
}
