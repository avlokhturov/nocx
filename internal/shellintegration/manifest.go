package shellintegration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Manifest is the activation pointer: the only committed document that
// names a generation (design §4). A generation is active if and only if the
// manifest names it; the launch carrier reads only this file.
type Manifest struct {
	Protocol   int                     `json:"protocol"`
	Version    string                  `json:"version"`
	Generation string                  `json:"generation"`
	Files      map[string]ManifestFile `json:"files"`
}

// ManifestFile is one generation file's recorded identity: content hash,
// mode and size, everything the activation proof needs (design §7: an
// active manifest implies every file it names exists with the recorded hash
// and mode).
type ManifestFile struct {
	Hash string `json:"hash"` // "sha256:<64 hex>"
	Mode string `json:"mode"` // 4-digit octal, e.g. "0600"
	Size int64  `json:"size"`
}

var safeNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// isSafeName reports whether s is a fixed, portable name: a single path
// component, no leading dot, no path separators, no "..", bounded length.
// It is the gate for versions, generation names and manifest keys — anything
// that becomes part of a path or of the wire protocol's generation field
// (design §5.2 restricts those fields to [A-Za-z0-9._-]{1,64}).
func isSafeName(s string) bool { return safeNameRe.MatchString(s) }

const hashPrefix = "sha256:"

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hashPrefix + hex.EncodeToString(sum[:])
}

func validHash(h string) bool {
	if !strings.HasPrefix(h, hashPrefix) {
		return false
	}
	digest := h[len(hashPrefix):]
	if len(digest) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}

// parseModeStr parses a 4-digit octal mode string such as "0600".
func parseModeStr(s string) (os.FileMode, error) {
	if len(s) != 4 {
		return 0, fmt.Errorf("not a 4-digit octal string")
	}
	n, err := strconv.ParseUint(s, 8, 32)
	if err != nil {
		return 0, fmt.Errorf("not octal")
	}
	return os.FileMode(n), nil
}

// parseManifest decodes and validates a manifest. Any violation — a missing
// or unknown field, an absolute or ".." file key, an unsupported mode, a
// malformed hash — invalidates the whole manifest (design §4.1): nothing is
// active and no entry may be acted on. Unknown keys are rejected explicitly
// because encoding/json would otherwise drop them silently.
func parseManifest(data []byte) (*Manifest, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return nil, fmt.Errorf("not valid JSON: %w", err)
	}
	for key := range top {
		switch key {
		case "protocol", "version", "generation", "files":
		default:
			return nil, fmt.Errorf("unknown key %q", key)
		}
	}
	var files map[string]map[string]json.RawMessage
	if raw, ok := top["files"]; ok {
		if err := json.Unmarshal(raw, &files); err != nil {
			return nil, fmt.Errorf("files: %w", err)
		}
		for name, entry := range files {
			for key := range entry {
				switch key {
				case "hash", "mode", "size":
				default:
					return nil, fmt.Errorf("file %s: unknown key %q", name, key)
				}
			}
		}
	}

	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if m.Protocol <= 0 {
		return nil, fmt.Errorf("protocol must be a positive integer")
	}
	if !isSafeName(m.Version) {
		return nil, fmt.Errorf("version %q is not a safe name", m.Version)
	}
	if !isSafeName(m.Generation) {
		return nil, fmt.Errorf("generation %q is not a safe name", m.Generation)
	}
	if len(m.Files) == 0 {
		return nil, fmt.Errorf("manifest names no files")
	}
	for name, mf := range m.Files {
		if !isSafeName(name) {
			return nil, fmt.Errorf("file key %q is not a fixed base name", name)
		}
		if !validHash(mf.Hash) {
			return nil, fmt.Errorf("file %s: hash %q is not %s<hex>", name, mf.Hash, hashPrefix)
		}
		mode, err := parseModeStr(mf.Mode)
		if err != nil {
			return nil, fmt.Errorf("file %s: mode %q: %w", name, mf.Mode, err)
		}
		if mode != 0o600 && mode != 0o700 {
			return nil, fmt.Errorf("file %s: mode %q is not a supported fixed mode", name, mf.Mode)
		}
		if mf.Size < 0 {
			return nil, fmt.Errorf("file %s: negative size", name)
		}
	}
	return &m, nil
}

var tokenRe = regexp.MustCompile(`\d+|[A-Za-z]+`)

// compareVersions orders two version strings: -1/0/+1 for a < b / equal /
// a > b. Versions are split into numeric and alphabetic tokens ("10",
// "1.2.3", "0.2026.07.15.08.55.stable_01") and compared token-wise, numbers
// numerically and letters lexically; a shorter token sequence is smaller.
// Deliberately tolerant: P2 owns the version strings and they are not
// promised to be semver. The downgrade rule (an installed newer compatible
// generation is never downgraded; equality is not the comparison) is a
// >= comparison over this ordering.
func compareVersions(a, b string) int {
	ta, tb := versionTokens(a), versionTokens(b)
	for i := 0; i < len(ta) && i < len(tb); i++ {
		if c := compareToken(ta[i], tb[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(ta) < len(tb):
		return -1
	case len(ta) > len(tb):
		return 1
	}
	return 0
}

func versionTokens(s string) []string { return tokenRe.FindAllString(s, -1) }

func compareToken(a, b string) int {
	an, aerr := strconv.ParseInt(a, 10, 64)
	bn, berr := strconv.ParseInt(b, 10, 64)
	if aerr == nil && berr == nil {
		switch {
		case an < bn:
			return -1
		case an > bn:
			return 1
		}
		return 0
	}
	return strings.Compare(a, b)
}
