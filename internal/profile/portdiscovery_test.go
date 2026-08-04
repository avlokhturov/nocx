package profile

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// portDiscovery cascade — red acceptance tests (nocx-wzc4.3, spec D3)
// ---------------------------------------------------------------------------

func TestResolveEffectiveProfile_PortDiscoveryPrecedence(t *testing.T) {
	// One row per cascade layer: the field set ONLY at that layer resolves
	// to it, and a lower layer setting it too must not win. The final row is
	// the case a user actually relies on: explicit off at the profile over
	// auto at the group — the one a partial implementation gets wrong.
	tests := []struct {
		name       string
		profile    SSHProfile
		groups     []ProfileGroup
		global     SparseSSHOptions
		want       PortDiscoveryMode
		wantSource FieldSource
	}{
		{
			name: "hardcoded default is auto",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web"},
				Options: StoredSSHProfileOptions{Host: "h"},
			},
			want:       PortDiscoveryAuto,
			wantSource: FieldSourceDefault,
		},
		{
			name: "global layer",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web"},
				Options: StoredSSHProfileOptions{Host: "h"},
			},
			global:     SparseSSHOptions{PortDiscovery: new(PortDiscoveryAsk)},
			want:       PortDiscoveryAsk,
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
					SparseSSHOptions: SparseSSHOptions{PortDiscovery: new(PortDiscoveryAsk)},
				}},
				{ID: "g2", Name: "Leaf", ParentGroupID: "g1"},
			},
			want:       PortDiscoveryAsk,
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
					SparseSSHOptions: SparseSSHOptions{PortDiscovery: new(PortDiscoveryAuto)},
				}},
				{ID: "g2", Name: "Leaf", ParentGroupID: "g1", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{PortDiscovery: new(PortDiscoveryAsk)},
				}},
			},
			want:       PortDiscoveryAsk,
			wantSource: fieldSourceForGroup("g2"),
		},
		{
			name: "profile wins over group",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web", Group: "g1"},
				Options: StoredSSHProfileOptions{Host: "h", PortDiscovery: new(PortDiscoveryAsk)},
			},
			groups: []ProfileGroup{
				{ID: "g1", Name: "Prod", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{PortDiscovery: new(PortDiscoveryAuto)},
				}},
			},
			want:       PortDiscoveryAsk,
			wantSource: FieldSourceProfile,
		},
		{
			name: "explicit off at profile over auto at group",
			profile: SSHProfile{
				Base:    Base{ID: "p1", Type: "ssh", Name: "web", Group: "g1"},
				Options: StoredSSHProfileOptions{Host: "h", PortDiscovery: new(PortDiscoveryOff)},
			},
			groups: []ProfileGroup{
				{ID: "g1", Name: "Prod", Defaults: &ProfileDefaults{
					SparseSSHOptions: SparseSSHOptions{PortDiscovery: new(PortDiscoveryAuto)},
				}},
			},
			want:       PortDiscoveryOff,
			wantSource: FieldSourceProfile,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			eff, err := ResolveEffectiveProfile(tt.profile, tt.groups, tt.global)
			if err != nil {
				t.Fatalf("ResolveEffectiveProfile: %v", err)
			}
			if got := eff.ResolvedOptions.PortDiscovery; got != tt.want {
				t.Errorf("portDiscovery = %q, want %q", got, tt.want)
			}
			if got := eff.Source["portDiscovery"]; got != tt.wantSource {
				t.Errorf("provenance for portDiscovery = %q, want %q", got, tt.wantSource)
			}
		})
	}
}

func TestResolveEffectiveProfile_PortDiscoveryInvalidStoredFallsBackToDefault(t *testing.T) {
	// A stored value this build does not recognise falls back to the default
	// (auto) rather than being treated as a silent no-op: auto is the safe
	// behaviour for an unrecognised choice, and the provenance says "default"
	// so the effective view shows the fallback instead of a value that never
	// takes effect. Exactly the shellIntegration rule (nocx-p0ug).
	profile := SSHProfile{
		Base: Base{ID: "p1", Type: "ssh", Name: "web", Group: "g1"},
		Options: StoredSSHProfileOptions{
			Host:          "h",
			PortDiscovery: new(PortDiscoveryMode("sometimes")),
		},
	}
	groups := []ProfileGroup{
		{ID: "g1", Name: "Prod", Defaults: &ProfileDefaults{
			SparseSSHOptions: SparseSSHOptions{PortDiscovery: new(PortDiscoveryAsk)},
		}},
	}
	eff, err := ResolveEffectiveProfile(profile, groups, SparseSSHOptions{})
	if err != nil {
		t.Fatalf("ResolveEffectiveProfile: %v", err)
	}
	if got := eff.ResolvedOptions.PortDiscovery; got != PortDiscoveryAuto {
		t.Errorf("portDiscovery = %q, want %q (fallback)", got, PortDiscoveryAuto)
	}
	if got := eff.Source["portDiscovery"]; got != FieldSourceDefault {
		t.Errorf("provenance for portDiscovery = %q, want %q", got, FieldSourceDefault)
	}
}

// ---------------------------------------------------------------------------
// Patch path
// ---------------------------------------------------------------------------

func TestApplyPatchPortDiscovery(t *testing.T) {
	opts := &StoredSSHProfileOptions{}

	if !ApplyPatchSet(opts, "options.portDiscovery", "ask") {
		t.Fatal("ApplyPatchSet(options.portDiscovery) returned false for a known path")
	}
	if opts.PortDiscovery == nil || *opts.PortDiscovery != PortDiscoveryAsk {
		t.Fatalf("after set: PortDiscovery = %v, want ask", opts.PortDiscovery)
	}

	if !ApplyPatchSet(opts, "options.portDiscovery", "off") {
		t.Fatal("ApplyPatchSet(options.portDiscovery) returned false for a known path")
	}
	if opts.PortDiscovery == nil || *opts.PortDiscovery != PortDiscoveryOff {
		t.Fatalf("after re-set: PortDiscovery = %v, want off", opts.PortDiscovery)
	}

	if !ApplyPatchUnset(opts, "options.portDiscovery") {
		t.Fatal("ApplyPatchUnset(options.portDiscovery) returned false for a known path")
	}
	if opts.PortDiscovery != nil {
		t.Fatalf("after unset: PortDiscovery = %v, want nil (inherit)", opts.PortDiscovery)
	}

	if ApplyPatchSet(opts, "options.notARealPath", "ask") {
		t.Fatal("ApplyPatchSet accepted an unknown path")
	}
	if !PatchPathAllowed("options.portDiscovery") {
		t.Fatal("options.portDiscovery must be an allowed patch path")
	}
}

// ---------------------------------------------------------------------------
// Store round trip — the field must survive JSON persistence
// ---------------------------------------------------------------------------

func TestPortDiscoveryJSONRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "profiles.json")
	store := NewJSONStore(path)

	prof := SSHProfile{
		Base: Base{ID: NewProfileID("ssh", "pd-roundtrip"), Type: "ssh", Name: "pd-roundtrip"},
		Options: StoredSSHProfileOptions{
			Host:          "h",
			PortDiscovery: new(PortDiscoveryOff),
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
	if loaded[0].Options.PortDiscovery == nil || *loaded[0].Options.PortDiscovery != PortDiscoveryOff {
		t.Errorf("round-tripped portDiscovery = %v, want off", loaded[0].Options.PortDiscovery)
	}
}

func TestPortDiscoveryStoredOptionsMarshal(t *testing.T) {
	// The stored JSON must carry the field with the exact enum spelling
	// (host is always present — it has no omitempty).
	raw, err := json.Marshal(StoredSSHProfileOptions{PortDiscovery: new(PortDiscoveryAsk)})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if got := string(raw); got != `{"host":"","portDiscovery":"ask"}` {
		t.Errorf("marshalled = %s, want {\"host\":\"\",\"portDiscovery\":\"ask\"}", got)
	}
}

// ---------------------------------------------------------------------------
// Group defaults allowlist — the field must be known, not an unknown key
// ---------------------------------------------------------------------------

func TestPortDiscoveryIsAnAllowedDefaultKey(t *testing.T) {
	var d ProfileDefaults
	if err := d.UnmarshalJSON([]byte(`{"portDiscovery":"ask"}`)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	if keys := d.UnknownKeys(); len(keys) != 0 {
		t.Errorf("UnknownKeys = %v, want none — portDiscovery must be a known default key", keys)
	}
	if d.PortDiscovery == nil || *d.PortDiscovery != PortDiscoveryAsk {
		t.Errorf("decoded portDiscovery = %v, want ask", d.PortDiscovery)
	}
	if err := d.Validate(); err != nil {
		t.Errorf("Validate = %v, want nil", err)
	}
}

// ---------------------------------------------------------------------------
// Effective DTO — the field rides the wire with its provenance
// ---------------------------------------------------------------------------

func TestToEffectiveDTOIncludesPortDiscovery(t *testing.T) {
	profile := SSHProfile{
		Base:    Base{ID: "p1", Type: "ssh", Name: "web"},
		Options: StoredSSHProfileOptions{Host: "h", PortDiscovery: new(PortDiscoveryOff)},
	}
	eff, err := ResolveEffectiveProfile(profile, nil, SparseSSHOptions{})
	if err != nil {
		t.Fatalf("ResolveEffectiveProfile: %v", err)
	}
	dto := ToEffectiveDTO(eff, nil)
	f, ok := dto.Fields["portDiscovery"]
	if !ok {
		t.Fatal("effective fields missing portDiscovery")
	}
	if got := f.Value; got != "off" {
		t.Errorf("effective portDiscovery value = %v, want off", got)
	}
	if f.Source.Kind != EffectiveSourceProfile {
		t.Errorf("effective portDiscovery source = %s, want profile", f.Source.Kind)
	}
}
