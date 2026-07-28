package profile

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// AuthMode controls which auth buckets are tried for an SSH connection.
// AuthAuto (null) means try the full fallback-chain; a specific value
// restricts which buckets are attempted.
type AuthMode string

const (
	AuthAuto                AuthMode = ""
	AuthPassword            AuthMode = "password"
	AuthPublicKey           AuthMode = "publicKey"
	AuthAgent               AuthMode = "agent"
	AuthKeyboardInteractive AuthMode = "keyboardInteractive"
)

// BehaviorOnSessionEnd controls what happens to a tab when its session ends.
type BehaviorOnSessionEnd string

const (
	BehaviorAuto      BehaviorOnSessionEnd = "auto"
	BehaviorKeep      BehaviorOnSessionEnd = "keep"
	BehaviorReconnect BehaviorOnSessionEnd = "reconnect"
	BehaviorClose     BehaviorOnSessionEnd = "close"
)

// Base holds the generic profile fields shared by all profile types
// (SSH now, future types later). Mirrors Tabby's Profile interface.
type Base struct {
	ID                   string               `json:"id"`
	Type                 string               `json:"type"`
	Name                 string               `json:"name"`
	Group                string               `json:"group,omitempty"`
	Icon                 string               `json:"icon,omitempty"`
	Color                string               `json:"color,omitempty"`
	DisableDynamicTitle  bool                 `json:"disableDynamicTitle,omitempty"`
	BehaviorOnSessionEnd BehaviorOnSessionEnd `json:"behaviorOnSessionEnd,omitempty"`
	Weight               int                  `json:"weight,omitempty"`
	IsBuiltin            bool                 `json:"isBuiltin,omitempty"`
	IsTemplate           bool                 `json:"isTemplate,omitempty"`
	// NeedsReview marks a profile that references a credential whose
	// identity was resolved from a local credential during import.
	// Such profiles must be reviewed by a human before they can be
	// resolved for connection. The resolver refuses profiles with this
	// flag set; the UI for clearing it belongs to a later wave.
	NeedsReview bool `json:"needsReview,omitempty"`
}

// SSHProfileOptions is the SSH-specific options block on an SSHProfile.
// CredentialID references a reusable Credential (УЗ) by ID. If set,
// username/auth/keyPath are resolved from the credential at connect time.
// If empty, inline User/Auth/PrivateKeys are used (legacy mode).
type SSHProfileOptions struct {
	Host         string `json:"host"`
	Port         int    `json:"port,omitempty"`
	CredentialID string `json:"credentialId,omitempty"` // Link to Credential.ID
	// Inline fields (used only if CredentialID is empty)
	User              string   `json:"user,omitempty"`
	Auth              AuthMode `json:"auth,omitempty"`
	KeepaliveInterval int      `json:"keepaliveInterval,omitempty"`
	KeepaliveCountMax int      `json:"keepaliveCountMax,omitempty"`
	ReadyTimeout      int      `json:"readyTimeout,omitempty"`
	JumpHost          string   `json:"jumpHost,omitempty"` // Profile name or ID of the jump server
	AgentForward      bool     `json:"agentForward,omitempty"`
	CanBeJumpServer   bool     `json:"canBeJumpServer,omitempty"` // Whether this profile can be used as a jump server
}

// SSHProfile is a connection profile for an SSH host. It holds only
// *identity* (host/port/user) and configuration — never secrets.
// Credentials live in the CredentialStore, addressed by identity.
type SSHProfile struct {
	Base
	Options SSHProfileOptions `json:"options"`
}

// ToPartial returns a sparse representation suitable for persistence:
// only non-zero fields are written. The JSON encoder handles omitempty.
func (p SSHProfile) ToPartial() SSHProfile {
	return p
}

// ProfileGroup is a folder that groups profiles. Groups form a tree via
// ParentGroupID. Defaults carries per-provider defaults inherited by
// profiles in this group.
type ProfileGroup struct {
	ID            string           `json:"id"`
	ParentGroupID string           `json:"parentGroupId,omitempty"`
	Name          string           `json:"name"`
	Icon          string           `json:"icon,omitempty"`
	Color         string           `json:"color,omitempty"`
	Defaults      *ProfileDefaults `json:"defaults,omitempty"`
	Editable      bool             `json:"editable,omitempty"`
}

// ---------------------------------------------------------------------------
// Sparse options — presence-aware typed defaults for groups and globals
// ---------------------------------------------------------------------------

// SparseSSHOptions is a presence-aware counterpart to SSHProfileOptions where
// every inheritable field can be absent (nil pointer = not set, inherit).
// This is what GROUPS and GLOBAL defaults carry, and what the merge accumulates.
// The stored SSHProfile.Options stays non-pointer — only groups/globals use the
// sparse type.
type SparseSSHOptions struct {
	CredentialID         *string               `json:"credentialId,omitempty"`
	Port                 *int                  `json:"port,omitempty"`
	User                 *string               `json:"user,omitempty"`
	KeyPath              *string               `json:"keyPath,omitempty"`
	Auth                 *AuthMode             `json:"auth,omitempty"`
	JumpHost             *string               `json:"jumpHost,omitempty"`
	KeepaliveInterval    *int                  `json:"keepaliveInterval,omitempty"`
	KeepaliveCountMax    *int                  `json:"keepaliveCountMax,omitempty"`
	ReadyTimeout         *int                  `json:"readyTimeout,omitempty"`
	AgentForward         *bool                 `json:"agentForward,omitempty"`
	BehaviorOnSessionEnd *BehaviorOnSessionEnd `json:"behaviorOnSessionEnd,omitempty"`
}

// ProfileDefaults is the typed defaults block on a ProfileGroup (or global
// defaults). It wraps SparseSSHOptions with custom JSON handling that records
// unknown keys instead of rejecting the document. Unknown keys are preserved
// on write so they round-trip without data loss, but they are reported by
// Validate() at write and resolution time.
type ProfileDefaults struct {
	SparseSSHOptions

	unknown map[string]json.RawMessage // unknown keys encountered during unmarshal
}

// allowedDefaultKeys returns the set of JSON field names ProfileDefaults
// accepts. Used in custom unmarshaling and DecodeDefaults.
var allowedFields = map[string]bool{
	"credentialId":         true,
	"port":                 true,
	"user":                 true,
	"keyPath":              true,
	"jumpHost":             true,
	"keepaliveInterval":    true,
	"keepaliveCountMax":    true,
	"readyTimeout":         true,
	"agentForward":         true,
	"behaviorOnSessionEnd": true,
}

// UnmarshalJSON decodes known fields into SparseSSHOptions and records unknown
// keys with their raw values. It never returns an error for syntactically valid
// JSON — unknown keys are preserved for round-trip safety.
func (d *ProfileDefaults) UnmarshalJSON(data []byte) error {
	raw := make(map[string]json.RawMessage)
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if err := json.Unmarshal(data, &d.SparseSSHOptions); err != nil {
		return err
	}
	d.unknown = make(map[string]json.RawMessage, len(raw))
	for key, val := range raw {
		if !allowedFields[key] {
			d.unknown[key] = val
		}
	}
	if len(d.unknown) == 0 {
		d.unknown = nil
	}
	return nil
}

// MarshalJSON serializes known fields and appends any unknown keys that were
// recorded during unmarshal, preserving round-trip fidelity.
func (d ProfileDefaults) MarshalJSON() ([]byte, error) {
	b, err := json.Marshal(d.SparseSSHOptions)
	if err != nil {
		return nil, err
	}
	if len(d.unknown) == 0 {
		return b, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	for k, v := range d.unknown {
		m[k] = v
	}
	return json.Marshal(m)
}

// UnknownKeys returns the list of JSON field names that were present during
// unmarshal but are not in the allowed set. The returned slice is sorted for
// deterministic output.
func (d *ProfileDefaults) UnknownKeys() []string {
	if d == nil || len(d.unknown) == 0 {
		return nil
	}
	keys := make([]string, 0, len(d.unknown))
	for k := range d.unknown {
		keys = append(keys, k)
	}
	return keys
}

// Validate returns an error when unknown keys exist, listing them. It returns
// nil for a nil receiver or clean defaults.
func (d *ProfileDefaults) Validate() error {
	if d == nil {
		return nil
	}
	if keys := d.UnknownKeys(); len(keys) > 0 {
		return fmt.Errorf("unknown keys in defaults: %s", strings.Join(keys, ", "))
	}
	return nil
}

// hardcodedDefaults returns the base-layer defaults that always apply when
// no group, global, or profile overrides them.
func hardcodedDefaults() SparseSSHOptions {
	port := 22
	user := currentUser()
	beh := BehaviorAuto
	return SparseSSHOptions{
		Port:                 &port,
		User:                 &user,
		BehaviorOnSessionEnd: &beh,
	}
}

// ---------------------------------------------------------------------------
// Effective profile — resolved inheritance with provenance
// ---------------------------------------------------------------------------

// FieldSource identifies where an effective field value came from.
type FieldSource string

const (
	FieldSourceProfile FieldSource = "profile" // explicitly set on the stored profile
	FieldSourceGroup   FieldSource = "group:"  // prefix — actual source is "group:<id>"
	FieldSourceGlobal  FieldSource = "global"  // global defaults (Wave 2a: not yet wired to a store)
	FieldSourceDefault FieldSource = "default" // hardcoded application default
)

// EffectiveProfile holds the resolved values for a single profile plus
// per-field provenance. An inherited value is NEVER written back into the
// stored profile — the caller can distinguish "inherited 2222" from
// "overridden here to 2222" forever by comparing Profile against the stored
// version through Source.
type EffectiveProfile struct {
	Profile SSHProfile             // resolved values (merged)
	Source  map[string]FieldSource // field name -> winning provenance
}

// ---------------------------------------------------------------------------
// Group graph validation
// ---------------------------------------------------------------------------

var (
	ErrCycleDetected = errors.New("group cycle detected")
	ErrMissingParent = errors.New("group parent not found")
	ErrDepthExceeded = errors.New("group depth exceeds maximum")
)

const maxGroupDepth = 32

// ValidateGroupTree checks every group for valid parent references, cycles,
// and depth > 32. It returns the first error found, naming the offending
// group ID in the error message.
func ValidateGroupTree(groups []ProfileGroup) error {
	byID := make(map[string]ProfileGroup, len(groups))
	for _, g := range groups {
		byID[g.ID] = g
	}

	for _, g := range groups {
		if err := validateGroup(byID, g.ID); err != nil {
			return fmt.Errorf("group %s: %w", g.ID, err)
		}
	}
	return nil
}

// validateGroup checks a single group's parent chain for existence, cycles,
// and depth.
func validateGroup(byID map[string]ProfileGroup, startID string) error {
	current := startID
	seen := map[string]bool{startID: true}
	for range maxGroupDepth {
		g, ok := byID[current]
		if !ok {
			// root with no parent
			return nil
		}
		if g.ParentGroupID == "" {
			// reached a root — valid
			return nil
		}
		if _, ok := byID[g.ParentGroupID]; !ok {
			return fmt.Errorf("parent %q: %w", g.ParentGroupID, ErrMissingParent)
		}
		if seen[g.ParentGroupID] {
			return fmt.Errorf("parent %q: %w", g.ParentGroupID, ErrCycleDetected)
		}
		seen[g.ParentGroupID] = true
		current = g.ParentGroupID
	}
	return fmt.Errorf("%w (max %d)", ErrDepthExceeded, maxGroupDepth)
}

// ResolveGroupChain walks the parent chain from the given leaf group ID up
// to a root, returning groups ordered from nearest ancestor to root.
// Returns an error if a parent is missing or a cycle is detected.
func ResolveGroupChain(groups []ProfileGroup, leafGroupID string) ([]ProfileGroup, error) {
	byID := make(map[string]ProfileGroup, len(groups))
	for _, g := range groups {
		byID[g.ID] = g
	}

	if err := validateGroup(byID, leafGroupID); err != nil {
		return nil, err
	}

	var chain []ProfileGroup
	current := leafGroupID
	for range maxGroupDepth {
		g, ok := byID[current]
		if !ok || g.ParentGroupID == "" {
			break
		}
		parent, ok := byID[g.ParentGroupID]
		if !ok {
			break
		}
		chain = append(chain, parent)
		current = g.ParentGroupID
	}
	return chain, nil
}

// ---------------------------------------------------------------------------
// Effective profile resolution
// ---------------------------------------------------------------------------

// fieldSourceForGroup builds the provenance string for a group-source field.
func fieldSourceForGroup(id string) FieldSource {
	return FieldSource("group:" + id)
}

// ResolveEffectiveProfile produces the resolved profile with per-field
// provenance. Precedence (highest to lowest):
//
//	profile → nearest ancestor group → … → root group → global → hardcoded default
//
// Host is never inherited and is always required.
func ResolveEffectiveProfile(
	profile SSHProfile,
	groups []ProfileGroup,
	globalDefaults SparseSSHOptions,
) (EffectiveProfile, error) {
	if profile.Options.Host == "" {
		return EffectiveProfile{}, errors.New("profile host is required and cannot be inherited")
	}

	// Build group chain (nearest ancestor first, then parent, up to root).
	groupChain := make([]ProfileGroup, 0)
	if profile.Group != "" {
		var err error
		groupChain, err = ResolveGroupChain(groups, profile.Group)
		if err != nil {
			return EffectiveProfile{}, fmt.Errorf("resolve group chain from %s: %w", profile.Group, err)
		}
	}

	// Convert profile's stored options to sparse — non-zero values become set,
	// zero values become inherit. For bools, only true is treated as "set"
	// (false is indistinguishable from "not set at all" in a JSON-omitempty
	// store, so we treat it as inherited).
	profileSparse := sshOptionsToSparse(profile.Options)

	// Also extract the profile's own BehaviorOnSessionEnd from Base.
	if profile.BehaviorOnSessionEnd != "" {
		beh := profile.BehaviorOnSessionEnd
		profileSparse.BehaviorOnSessionEnd = &beh
	}

	// Start with hardcoded defaults (lowest priority).
	acc := hardcodedDefaults()
	source := map[string]FieldSource{}
	source["port"] = FieldSourceDefault
	source["user"] = FieldSourceDefault
	source["behaviorOnSessionEnd"] = FieldSourceDefault

	// Apply global defaults.
	applySparseLayer(&acc, &source, globalDefaults, FieldSourceGlobal)

	// Apply group defaults: root first, nearest last (so nearest wins).
	for i := len(groupChain) - 1; i >= 0; i-- {
		g := groupChain[i]
		if g.Defaults != nil {
			if err := g.Defaults.Validate(); err != nil {
				return EffectiveProfile{}, fmt.Errorf("group %q defaults: %w", g.ID, err)
			}
			applySparseLayer(&acc, &source, g.Defaults.SparseSSHOptions, fieldSourceForGroup(g.ID))
		}
	}

	// Apply the profile's own group defaults (leaf group), which are not
	// included in the chain returned by ResolveGroupChain.
	if profile.Group != "" {
		for _, g := range groups {
			if g.ID == profile.Group && g.Defaults != nil {
				if err := g.Defaults.Validate(); err != nil {
					return EffectiveProfile{}, fmt.Errorf("group %q defaults: %w", g.ID, err)
				}
				applySparseLayer(&acc, &source, g.Defaults.SparseSSHOptions, fieldSourceForGroup(g.ID))
			}
		}
	}

	// Apply profile's own options (highest priority).
	applySparseLayer(&acc, &source, profileSparse, FieldSourceProfile)

	// Convert accumulator back to SSHProfile.
	result := profile
	result.Options = sparseToOptions(acc)

	// Apply BehaviorOnSessionEnd from accumulator to the result's Base.
	if acc.BehaviorOnSessionEnd != nil {
		result.BehaviorOnSessionEnd = *acc.BehaviorOnSessionEnd
	}

	return EffectiveProfile{Profile: result, Source: source}, nil
}

// applySparseLayer overlays src into acc for non-nil fields, recording
// provenance. acc is updated in place ONLY for fields that are nil in acc
// or that src explicitly sets (including explicit false for bools).
func applySparseLayer(acc *SparseSSHOptions, source *map[string]FieldSource, src SparseSSHOptions, layer FieldSource) {
	if src.CredentialID != nil {
		acc.CredentialID = src.CredentialID
		setSource(source, "credentialId", layer)
	}
	if src.Port != nil {
		acc.Port = src.Port
		setSource(source, "port", layer)
	}
	if src.User != nil {
		acc.User = src.User
		setSource(source, "user", layer)
	}
	if src.Auth != nil {
		acc.Auth = src.Auth
		setSource(source, "auth", layer)
	}
	if src.KeyPath != nil {
		acc.KeyPath = src.KeyPath
		setSource(source, "keyPath", layer)
	}
	if src.JumpHost != nil {
		acc.JumpHost = src.JumpHost
		setSource(source, "jumpHost", layer)
	}
	if src.KeepaliveInterval != nil {
		acc.KeepaliveInterval = src.KeepaliveInterval
		setSource(source, "keepaliveInterval", layer)
	}
	if src.KeepaliveCountMax != nil {
		acc.KeepaliveCountMax = src.KeepaliveCountMax
		setSource(source, "keepaliveCountMax", layer)
	}
	if src.ReadyTimeout != nil {
		acc.ReadyTimeout = src.ReadyTimeout
		setSource(source, "readyTimeout", layer)
	}
	if src.AgentForward != nil {
		acc.AgentForward = src.AgentForward
		setSource(source, "agentForward", layer)
	}
	if src.BehaviorOnSessionEnd != nil {
		acc.BehaviorOnSessionEnd = src.BehaviorOnSessionEnd
		setSource(source, "behaviorOnSessionEnd", layer)
	}
}

// setSource records field <- layer in source, overwriting any previous entry.
func setSource(source *map[string]FieldSource, field string, layer FieldSource) {
	if *source == nil {
		*source = map[string]FieldSource{}
	}
	(*source)[field] = layer
}

// sshOptionsToSparse converts a dense SSHProfileOptions to a sparse
// representation. Zero values become nil (inherit); non-zero values become
// pointer-set. For bools, only true is captured — false is treated as
// "not set" because it cannot be distinguished from an unset field in a
// JSON-omitempty store. (The caller constructs the effective profile and
// the stored profile directly for tests that need explicit false.)
func sshOptionsToSparse(o SSHProfileOptions) SparseSSHOptions {
	s := SparseSSHOptions{}
	if o.CredentialID != "" {
		v := o.CredentialID
		s.CredentialID = &v
	}
	if o.Port != 0 {
		v := o.Port
		s.Port = &v
	}
	if o.User != "" {
		v := o.User
		s.User = &v
	}
	if o.Auth != "" {
		v := o.Auth
		s.Auth = &v
	}
	if o.KeepaliveInterval != 0 {
		v := o.KeepaliveInterval
		s.KeepaliveInterval = &v
	}
	if o.KeepaliveCountMax != 0 {
		v := o.KeepaliveCountMax
		s.KeepaliveCountMax = &v
	}
	if o.ReadyTimeout != 0 {
		v := o.ReadyTimeout
		s.ReadyTimeout = &v
	}
	if o.JumpHost != "" {
		v := o.JumpHost
		s.JumpHost = &v
	}
	if o.AgentForward {
		v := true
		s.AgentForward = &v
	}
	return s
}

// sparseToOptions converts a sparse representation back to dense SSHProfileOptions.
// BehaviorOnSessionEnd is NOT handled here — it lives on Base, not Options.
// The caller applies it to the result's Base separately.
func sparseToOptions(s SparseSSHOptions) SSHProfileOptions {
	o := SSHProfileOptions{}
	if s.CredentialID != nil {
		o.CredentialID = *s.CredentialID
	}
	if s.Port != nil {
		o.Port = *s.Port
	}
	if s.User != nil {
		o.User = *s.User
	}
	if s.Auth != nil {
		o.Auth = *s.Auth
	}
	if s.JumpHost != nil {
		o.JumpHost = *s.JumpHost
	}
	if s.KeepaliveInterval != nil {
		o.KeepaliveInterval = *s.KeepaliveInterval
	}
	if s.KeepaliveCountMax != nil {
		o.KeepaliveCountMax = *s.KeepaliveCountMax
	}
	if s.ReadyTimeout != nil {
		o.ReadyTimeout = *s.ReadyTimeout
	}
	if s.AgentForward != nil {
		o.AgentForward = *s.AgentForward
	}
	return o
}

// ---------------------------------------------------------------------------
// Legacy map decode
// ---------------------------------------------------------------------------

// DecodeDefaults decodes a map[string]any (the old ProfileGroup.Defaults
// format) into a ProfileDefaults. Unknown keys are recorded (not rejected),
// so they round-trip safely and are reported by Validate() at write or
// resolution time.
func DecodeDefaults(m map[string]any) (ProfileDefaults, error) {
	data, err := json.Marshal(m)
	if err != nil {
		return ProfileDefaults{}, fmt.Errorf("re-encode defaults: %w", err)
	}
	var d ProfileDefaults
	if err := d.UnmarshalJSON(data); err != nil {
		return ProfileDefaults{}, err
	}
	return d, nil
}

// ---------------------------------------------------------------------------
// ID generation and parsing
// ---------------------------------------------------------------------------

// namespacedIDParts is the parsed form of a profile id: "type:custom:name:uuid".
type namespacedIDParts struct {
	Type string
	Name string
	UUID string
}

// NewProfileID generates a namespaced profile id: "type:custom:slug:name".
// The name is slugified for filesystem/URL safety.
func NewProfileID(typ, name string) string {
	return typ + ":custom:" + slugify(name) + ":" + newUUID()
}

// isNamespacedID checks whether id has the "type:custom:..." shape.
func isNamespacedID(id string) bool {
	_, ok := parseNamespacedID(id)
	return ok
}

// parseNamespacedID splits "type:custom:name:uuid" into its parts.
func parseNamespacedID(id string) (namespacedIDParts, bool) {
	parts := strings.SplitN(id, ":", 4)
	if len(parts) < 4 || parts[1] != "custom" {
		return namespacedIDParts{}, false
	}
	return namespacedIDParts{Type: parts[0], Name: parts[2], UUID: parts[3]}, true
}

// slugify lowercases and replaces spaces/special chars with hyphens.
func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// Group tree
// ---------------------------------------------------------------------------

// treeNode is a ProfileGroup with its children resolved — the output of
// BuildGroupTree.
type treeNode struct {
	ProfileGroup
	Children []treeNode `json:"children,omitempty"`
}

// BuildGroupTree turns a flat group list into a nested tree via ParentGroupID.
// Orphaned groups (parent not found) become roots. Cycle-safe by construction:
// a group whose parent chain loops will appear at most once because it is only
// attached when its parent is found in the map.
func BuildGroupTree(groups []ProfileGroup) []treeNode {
	m := make(map[string]*treeNode, len(groups))
	for i := range groups {
		m[groups[i].ID] = &treeNode{ProfileGroup: groups[i]}
	}

	var roots []treeNode
	for i := range groups {
		g := &groups[i]
		if g.ParentGroupID == "" {
			roots = append(roots, expandFromMap(m, g.ID))
			continue
		}
		if _, parentExists := m[g.ParentGroupID]; !parentExists {
			roots = append(roots, expandFromMap(m, g.ID))
		}
	}
	return roots
}

// expandFromMap recursively builds a treeNode with children from the map.
func expandFromMap(m map[string]*treeNode, id string) treeNode {
	node := *m[id]
	node.Children = nil
	for _, g := range m {
		if g.ParentGroupID == id {
			node.Children = append(node.Children, expandFromMap(m, g.ID))
		}
	}
	return node
}

// ResolveGroupPath walks the parent chain from the given group id up to a root,
// returning the breadcrumb path of group names (root first, leaf last).
// Cycle-guarded at 32 levels to prevent infinite loops on corrupted data.
func ResolveGroupPath(groups []ProfileGroup, id string) []string {
	m := make(map[string]ProfileGroup, len(groups))
	for _, g := range groups {
		m[g.ID] = g
	}

	var path []string
	current := id
	for depth := 0; current != "" && depth < 32; depth++ {
		g, ok := m[current]
		if !ok {
			path = append([]string{current}, path...)
			break
		}
		if g.Name != "" {
			path = append([]string{g.Name}, path...)
		}
		current = g.ParentGroupID
	}
	return path
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func currentUser() string {
	u := os.Getenv("USER")
	if u == "" {
		u = os.Getenv("LOGNAME")
	}
	if u == "" {
		u = "root"
	}
	return u
}

// newUUID generates a random hex string suitable for profile id suffixes.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Suppress unused import safety — uuid helper.
var _ = hex.EncodeToString
