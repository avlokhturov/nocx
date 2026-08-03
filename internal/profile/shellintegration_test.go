package profile

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// shellIntegration cascade — red acceptance tests (nocx-p0ug)
// ---------------------------------------------------------------------------

func TestResolveEffectiveProfile_ShellIntegrationPrecedence(t *testing.T) {
	// One row per cascade layer: the field set ONLY at that layer resolves
	// to it, and a lower layer setting it too must not win. The final row is
	// the case a user actually relies on: explicit off at the profile over
	// auto at the group — the one a partial implementation gets wrong.
	tests := []struct {
		name       string
		profile    SSHProfile
		groups     []ProfileGroup
		global     SparseSSHOptions
		want       ShellIntegrationMode
		wantSource FieldSource
	}{
		{
			name: "hardcoded default is auto",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web"},
				Options: StoredSSHProfileOptions{Host: "h"},
			},
			want:       ShellIntegrationAuto,
			wantSource: FieldSourceDefault,
		},
		{
			name: "global layer",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web"},
				Options: StoredSSHProfileOptions{Host: "h"},
			},
			global:     SparseSSHOptions{ShellIntegration: new(ShellIntegrationAsk)},
			want:       ShellIntegrationAsk,
			wantSource: FieldSourceGlobal,
		},
		{
			name: "ancestor group layer, no nearer layer",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web", Group: "g2"},
				Options: StoredSSHProfileOptions{Host: "h"},
			},
			groups: []ProfileGroup{
				{ID: "g1", Name: "Root", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{ShellIntegration: new(ShellIntegrationAsk)},
				}},
				{ID: "g2", Name: "Leaf", ParentGroupID: "g1"},
			},
			want:       ShellIntegrationAsk,
			wantSource: fieldSourceForGroup("g1"),
		},
		{
			name: "nearest group wins over ancestor",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web", Group: "g2"},
				Options: StoredSSHProfileOptions{Host: "h"},
			},
			groups: []ProfileGroup{
				{ID: "g1", Name: "Root", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{ShellIntegration: new(ShellIntegrationAuto)},
				}},
				{ID: "g2", Name: "Leaf", ParentGroupID: "g1", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{ShellIntegration: new(ShellIntegrationAsk)},
				}},
			},
			want:       ShellIntegrationAsk,
			wantSource: fieldSourceForGroup("g2"),
		},
		{
			name: "profile wins over group",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web", Group: "g1"},
				Options: StoredSSHProfileOptions{Host: "h", ShellIntegration: new(ShellIntegrationAsk)},
			},
			groups: []ProfileGroup{
				{ID: "g1", Name: "Prod", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{ShellIntegration: new(ShellIntegrationAuto)},
				}},
			},
			want:       ShellIntegrationAsk,
			wantSource: FieldSourceProfile,
		},
		{
			name: "explicit off at profile over auto at group",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web", Group: "g1"},
				Options: StoredSSHProfileOptions{Host: "h", ShellIntegration: new(ShellIntegrationOff)},
			},
			groups: []ProfileGroup{
				{ID: "g1", Name: "Prod", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{ShellIntegration: new(ShellIntegrationAuto)},
				}},
			},
			want:       ShellIntegrationOff,
			wantSource: FieldSourceProfile,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			eff, err := ResolveEffectiveProfile(tt.profile, tt.groups, tt.global)
			if err != nil {
				t.Fatalf("ResolveEffectiveProfile: %v", err)
			}
			if got := eff.ResolvedOptions.ShellIntegration; got != tt.want {
				t.Errorf("shellIntegration = %q, want %q", got, tt.want)
			}
			if got := eff.Source["shellIntegration"]; got != tt.wantSource {
				t.Errorf("provenance for shellIntegration = %q, want %q", got, tt.wantSource)
			}
		})
	}
}

func TestResolveEffectiveProfile_ShellIntegrationInvalidStoredFallsBackToDefault(t *testing.T) {
	// A stored value this build does not recognise falls back to the default
	// (auto) rather than being treated as a silent no-op: auto is the safe
	// behaviour for an unrecognised choice, and the provenance says "default"
	// so the effective view shows the fallback instead of a value that never
	// takes effect.
	profile := SSHProfile{
		Base: Base{ID: "p1", Type: "ssh", Name: "web", Group: "g1"},
		Options: StoredSSHProfileOptions{
			Host:             "h",
			ShellIntegration: new(ShellIntegrationMode("sometimes")),
		},
	}
	groups := []ProfileGroup{
		{ID: "g1", Name: "Prod", Defaults: &ProfileDefaults{
			SparseSSHOptions: SparseSSHOptions{ShellIntegration: new(ShellIntegrationAsk)},
		}},
	}
	eff, err := ResolveEffectiveProfile(profile, groups, SparseSSHOptions{})
	if err != nil {
		t.Fatalf("ResolveEffectiveProfile: %v", err)
	}
	if got := eff.ResolvedOptions.ShellIntegration; got != ShellIntegrationAuto {
		t.Errorf("shellIntegration = %q, want %q (fallback)", got, ShellIntegrationAuto)
	}
	if got := eff.Source["shellIntegration"]; got != FieldSourceDefault {
		t.Errorf("provenance for shellIntegration = %q, want %q", got, FieldSourceDefault)
	}
}

// ---------------------------------------------------------------------------
// Patch path
// ---------------------------------------------------------------------------

func TestApplyPatchShellIntegration(t *testing.T) {
	opts := &StoredSSHProfileOptions{}

	if !ApplyPatchSet(opts, "options.shellIntegration", "ask") {
		t.Fatal("ApplyPatchSet(options.shellIntegration) returned false for a known path")
	}
	if opts.ShellIntegration == nil || *opts.ShellIntegration != ShellIntegrationAsk {
		t.Fatalf("after set: ShellIntegration = %v, want ask", opts.ShellIntegration)
	}

	if !ApplyPatchSet(opts, "options.shellIntegration", "off") {
		t.Fatal("ApplyPatchSet(options.shellIntegration) returned false for a known path")
	}
	if opts.ShellIntegration == nil || *opts.ShellIntegration != ShellIntegrationOff {
		t.Fatalf("after re-set: ShellIntegration = %v, want off", opts.ShellIntegration)
	}

	if !ApplyPatchUnset(opts, "options.shellIntegration") {
		t.Fatal("ApplyPatchUnset(options.shellIntegration) returned false for a known path")
	}
	if opts.ShellIntegration != nil {
		t.Fatalf("after unset: ShellIntegration = %v, want nil (inherit)", opts.ShellIntegration)
	}

	if ApplyPatchSet(opts, "options.notARealPath", "ask") {
		t.Fatal("ApplyPatchSet accepted an unknown path")
	}
	if !PatchPathAllowed("options.shellIntegration") {
		t.Fatal("options.shellIntegration must be an allowed patch path")
	}
}

// ---------------------------------------------------------------------------
// Store round trip — the field must survive JSON persistence
// ---------------------------------------------------------------------------

func TestShellIntegrationJSONRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "profiles.json")
	store := NewJSONStore(path)

	prof := SSHProfile{
		Base: Base{ID: NewProfileID("ssh", "si-roundtrip"), Type: "ssh", Name: "si-roundtrip"},
		Options: StoredSSHProfileOptions{
			Host:             "h",
			ShellIntegration: new(ShellIntegrationOff),
		},
	}
	if err := store.CreateProfile(prof); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}
	loaded, err := NewJSONStore(path).LoadProfiles()
	if err != nil {
		t.Fatalf("LoadProfiles: %v", err)
	}
	if len(loaded) != 1 {
		t.Fatalf("loaded %d profiles, want 1", len(loaded))
	}
	if loaded[0].Options.ShellIntegration == nil || *loaded[0].Options.ShellIntegration != ShellIntegrationOff {
		t.Errorf("round-tripped shellIntegration = %v, want off", loaded[0].Options.ShellIntegration)
	}
}

func TestShellIntegrationStoredOptionsMarshal(t *testing.T) {
	// The stored JSON must carry the field with the exact enum spelling
	// (host is always present — it has no omitempty).
	raw, err := json.Marshal(StoredSSHProfileOptions{ShellIntegration: new(ShellIntegrationAsk)})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if got := string(raw); got != `{"host":"","shellIntegration":"ask"}` {
		t.Errorf("marshalled = %s, want {\"host\":\"\",\"shellIntegration\":\"ask\"}", got)
	}
}

// ---------------------------------------------------------------------------
// Group defaults allowlist — the field must be known, not an unknown key
// ---------------------------------------------------------------------------

func TestShellIntegrationIsAnAllowedDefaultKey(t *testing.T) {
	var d ProfileDefaults
	if err := d.UnmarshalJSON([]byte(`{"shellIntegration":"ask"}`)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	if keys := d.UnknownKeys(); len(keys) != 0 {
		t.Errorf("UnknownKeys = %v, want none — shellIntegration must be a known default key", keys)
	}
	if d.ShellIntegration == nil || *d.ShellIntegration != ShellIntegrationAsk {
		t.Errorf("decoded shellIntegration = %v, want ask", d.ShellIntegration)
	}
	if err := d.Validate(); err != nil {
		t.Errorf("Validate = %v, want nil", err)
	}
}
