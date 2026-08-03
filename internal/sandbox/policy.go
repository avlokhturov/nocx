package sandbox

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Policy is the validated, canonical-path document both backends enforce.
// It is JSON-serializable for the Linux helper FD handshake. Every path is
// absolute and symlink-resolved; the backend never re-resolves anything.
type Policy struct {
	Workspace     string   `json:"workspace"`
	WritableRoots []string `json:"writableRoots"`
	ReadOnlyRoots []string `json:"readOnlyRoots"`
	Shell         string   `json:"shell"`
	Home          string   `json:"home"`
	Tmp           string   `json:"tmp"`
}

// Policy document bounds (design spec §5.6): reject policy above a fixed
// root count or serialized size.
const (
	maxRoots       = 256
	maxPolicyBytes = 64 * 1024
)

// BuildPolicy constructs the common filesystem policy for a canonical
// workspace. env supplies the inherited PATH; shellPath is the resolved
// shell executable; runtimeRoot is the per-session mode-0700 tree containing
// home/ and tmp/ (NewRuntimeRoot).
//
// Errors wrapping ErrInvalidWorkspace mean the workspace is unusable
// (-32602). Any other error is a setup failure (-32012).
func BuildPolicy(workspace, shellPath, runtimeRoot string, env []string) (*Policy, error) {
	canon, err := canonicalizeWorkspace(workspace)
	if err != nil {
		return nil, err
	}

	home := filepath.Join(runtimeRoot, "home")
	tmp := filepath.Join(runtimeRoot, "tmp")
	for _, d := range []string{home, tmp} {
		fi, e := os.Stat(d)
		if e != nil {
			return nil, NewSetupErrorf("runtime root %q: %v", d, e)
		}
		if !fi.IsDir() {
			return nil, NewSetupErrorf("runtime root %q is not a directory", d)
		}
	}

	// Writable roots, in the tooltip order the spec fixes (design spec §3.3):
	// workspace, optional Git common dir, ephemeral home/tmp.
	writable := []string{canon}
	if git, ok := gitCommonDir(canon); ok {
		writable = append(writable, git)
	}
	writable = append(writable, home, tmp)

	// Read-only roots: documented system set, canonical shell, absolute
	// directories from inherited PATH. Missing optional roots are skipped;
	// permission and canonicalization errors are fatal.
	readonly := make([]string, 0, len(systemReadOnlyRoots())+16)
	for _, root := range systemReadOnlyRoots() {
		c, ok, e := canonicalOptionalDir(root)
		if e != nil {
			return nil, NewSetupErrorf("system root %q: %v", root, e)
		}
		if ok {
			readonly = append(readonly, c)
		}
	}

	shellCanon, err := filepath.EvalSymlinks(shellPath)
	if err != nil {
		return nil, NewSetupErrorf("shell %q: %v", shellPath, err)
	}
	if fi, err := os.Stat(shellCanon); err != nil || fi.IsDir() {
		return nil, NewSetupErrorf("shell %q is not a regular file", shellCanon)
	}
	readonly = append(readonly, shellCanon)

	for _, dir := range pathEntries(env) {
		if dir == "" || !filepath.IsAbs(dir) {
			continue // relative PATH entries resolve against the child's cwd — skip
		}
		c, ok, e := canonicalOptionalDir(dir)
		if e != nil {
			return nil, NewSetupErrorf("PATH dir %q: %v", dir, e)
		}
		if ok {
			readonly = append(readonly, c)
		}
	}

	p := &Policy{
		Workspace:     canon,
		WritableRoots: writable,
		ReadOnlyRoots: readonly,
		Shell:         shellCanon,
		Home:          home,
		Tmp:           tmp,
	}
	if err := p.normalize(); err != nil {
		return nil, err
	}
	return p, nil
}

// ValidatePolicy rejects policy documents that cannot be enforced: NUL or
// empty paths, relative or non-absolute paths, the same canonical path
// declared with conflicting permissions, and documents above the size or
// root-count bounds. It is the first check the Linux helper applies to the
// decoded FD payload.
func ValidatePolicy(p *Policy) error {
	seenRW := make(map[string]bool, len(p.WritableRoots))
	for _, r := range p.WritableRoots {
		if err := validatePolicyPath(r); err != nil {
			return err
		}
		seenRW[r] = true
	}
	for _, r := range p.ReadOnlyRoots {
		if err := validatePolicyPath(r); err != nil {
			return err
		}
		if seenRW[r] {
			return fmt.Errorf("sandbox: conflicting permissions for %q: read-write and read-only", r)
		}
	}
	for _, field := range []string{p.Workspace, p.Shell, p.Home, p.Tmp} {
		if err := validatePolicyPath(field); err != nil {
			return err
		}
	}
	if len(p.WritableRoots)+len(p.ReadOnlyRoots) > maxRoots {
		return fmt.Errorf("sandbox: policy exceeds %d roots", maxRoots)
	}
	if _, err := p.Bytes(); err != nil {
		return err
	}
	return nil
}

// Bytes serializes the policy for the helper FD handshake, enforcing the
// serialized-size bound.
func (p *Policy) Bytes() ([]byte, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("sandbox: serialize policy: %w", err)
	}
	if len(b) > maxPolicyBytes {
		return nil, fmt.Errorf("sandbox: policy exceeds %d bytes", maxPolicyBytes)
	}
	return b, nil
}

// normalize deduplicates roots, lets a read-write rule subsume a read-only
// duplicate, and drops read-only roots that are already writable.
func (p *Policy) normalize() error {
	p.WritableRoots = dedupeKeepOrder(p.WritableRoots)
	writable := make(map[string]bool, len(p.WritableRoots))
	for _, r := range p.WritableRoots {
		writable[r] = true
	}
	ro := make([]string, 0, len(p.ReadOnlyRoots))
	for _, r := range p.ReadOnlyRoots {
		if writable[r] {
			continue
		}
		ro = append(ro, r)
	}
	p.ReadOnlyRoots = dedupeKeepOrder(ro)
	return ValidatePolicy(p)
}

func dedupeKeepOrder(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func validatePolicyPath(p string) error {
	if p == "" {
		return errors.New("sandbox: empty path in policy")
	}
	if strings.ContainsRune(p, 0) {
		return errors.New("sandbox: NUL byte in policy path")
	}
	if !filepath.IsAbs(p) {
		return errors.New("sandbox: non-absolute path in policy: " + p)
	}
	return nil
}

// canonicalizeWorkspace applies Abs → EvalSymlinks → Stat and requires an
// existing absolute directory. Any failure is a workspace validation error
// (-32602), never a setup failure.
func canonicalizeWorkspace(workspace string) (string, error) {
	if workspace == "" {
		return "", NewValidationErrorf("workspace is empty")
	}
	if strings.ContainsRune(workspace, 0) {
		return "", NewValidationErrorf("workspace contains a NUL byte")
	}
	abs, err := filepath.Abs(workspace)
	if err != nil {
		return "", NewValidationErrorf("resolve workspace: %v", err)
	}
	canon, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", NewValidationErrorf("resolve symlinks: %v", err)
	}
	fi, err := os.Stat(canon)
	if err != nil {
		return "", NewValidationErrorf("stat: %v", err)
	}
	if !fi.IsDir() {
		return "", NewValidationErrorf("not a directory: %v", canon)
	}
	return canon, nil
}

// canonicalOptionalDir resolves an optional root. Missing roots (ENOENT /
// ENOTDIR) are skipped with ok=false; permission and other errors are fatal.
func canonicalOptionalDir(p string) (string, bool, error) {
	if p == "" || strings.ContainsRune(p, 0) {
		return "", false, nil
	}
	canon, err := filepath.EvalSymlinks(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	fi, err := os.Stat(canon)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	if !fi.IsDir() {
		return "", false, nil
	}
	return canon, true, nil
}

// gitCommonDir parses only the selected root's .git file (a worktree
// pointer: "gitdir: <path>"), resolves and canonicalizes the target, and
// reports it as an additional writable root. Malformed or missing input
// yields no extra root and no error; parents are never searched and Git is
// never invoked (design spec §5.4).
func gitCommonDir(workspace string) (string, bool) {
	gitFile := filepath.Join(workspace, ".git")
	fi, err := os.Stat(gitFile)
	if err != nil || fi.IsDir() {
		return "", false
	}
	data, err := os.ReadFile(gitFile) //nolint:gosec // fixed basename inside a validated workspace; only a gitdir: line is consumed
	if err != nil {
		return "", false
	}
	firstLine := strings.TrimSpace(strings.SplitN(string(data), "\n", 2)[0])
	rest, ok := strings.CutPrefix(firstLine, "gitdir:")
	if !ok {
		return "", false
	}
	target := strings.TrimSpace(rest)
	if target == "" || strings.ContainsRune(target, 0) {
		return "", false
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(workspace, target)
	}
	canon, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", false
	}
	fi2, err := os.Stat(canon)
	if err != nil || !fi2.IsDir() {
		return "", false
	}
	return canon, true
}

// pathEntries returns the absolute entries of the last PATH in env.
func pathEntries(env []string) []string {
	path := ""
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = v
		}
	}
	if path == "" {
		return nil
	}
	return strings.Split(path, string(os.PathListSeparator))
}

// NewRuntimeRoot creates a fresh mode-0700 per-session runtime tree under
// cacheDir/sandbox-sessions/<random>/ containing home/ and tmp/ (design
// spec §5.2).
func NewRuntimeRoot(cacheDir string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("sandbox: runtime root entropy: %w", err)
	}
	root := filepath.Join(cacheDir, "sandbox-sessions", hex.EncodeToString(b[:]))
	for _, d := range []string{root, filepath.Join(root, "home"), filepath.Join(root, "tmp")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return "", fmt.Errorf("sandbox: runtime root %q: %w", d, err)
		}
	}
	return root, nil
}

// RemoveRuntimeRoot best-effort deletes a per-session runtime tree. Deletion
// is not secure erase (design spec §5.3).
func RemoveRuntimeRoot(root string) {
	if root == "" {
		return
	}
	_ = os.RemoveAll(root)
}
