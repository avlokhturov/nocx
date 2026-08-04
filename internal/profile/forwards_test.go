package profile

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Stored forwards (spec D5) — the profile carries a list of tunnel
// definitions, topology and policy only. All three directions are first-class
// from day one (spec D4); the list is profile-owned and NOT inheritable —
// merging lists across cascade layers would invent semantics nobody decided.
//
// The stored field is a *[]ForwardSpec: nil means "never configured" and
// &[] means "deliberately none". omitempty drops an empty slice, which would
// collapse the explicit-empty case into the unset case on JSON round trip —
// the pointer keeps them apart (nil omits, &[] marshals as []).
// ---------------------------------------------------------------------------

func TestForwardsJSONRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "profiles.json")
	store := NewJSONStore(path)

	prof := SSHProfile{
		Base: Base{ID: NewProfileID("ssh", "fwd-roundtrip"), Type: "ssh", Name: "fwd-roundtrip"},
		Options: StoredSSHProfileOptions{
			Host: "h",
			Forwards: &[]ForwardSpec{
				{Direction: "local", BindHost: "", BindPort: 8080, Destination: "db.internal:5432"},
				{Direction: "remote", BindHost: "0.0.0.0", BindPort: 9090, Destination: "127.0.0.1:3000"},
				{Direction: "dynamic", BindHost: "127.0.0.1", BindPort: 0},
			},
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
	got := loaded[0].Options.Forwards
	if got == nil {
		t.Fatal("round-tripped forwards = nil, want the stored list")
	}
	if len(*got) != 3 {
		t.Fatalf("round-tripped %d forwards, want 3", len(*got))
	}
	// Every field survives, and an empty bind host stays empty (the tunnel
	// layer defaults it to 127.0.0.1 at New, not the profile).
	if (*got)[0].Direction != "local" || (*got)[0].BindHost != "" || (*got)[0].BindPort != 8080 || (*got)[0].Destination != "db.internal:5432" {
		t.Errorf("forward[0] = %+v, want local row intact", (*got)[0])
	}
	if (*got)[1].Direction != "remote" || (*got)[1].BindHost != "0.0.0.0" || (*got)[1].BindPort != 9090 || (*got)[1].Destination != "127.0.0.1:3000" {
		t.Errorf("forward[1] = %+v, want remote row intact", (*got)[1])
	}
	if (*got)[2].Direction != "dynamic" || (*got)[2].BindPort != 0 {
		t.Errorf("forward[2] = %+v, want dynamic row intact", (*got)[2])
	}
}

func TestForwardsExplicitEmptyIsDistinguishableFromUnset(t *testing.T) {
	// An explicit empty list (the user removed every row) must persist as
	// "forwards": [] — not vanish into the omitted-nil reading, which would
	// lose the difference between "never configured" and "deliberately none".
	dir := t.TempDir()
	path := filepath.Join(dir, "profiles.json")
	store := NewJSONStore(path)

	prof := SSHProfile{
		Base: Base{ID: NewProfileID("ssh", "fwd-empty"), Type: "ssh", Name: "fwd-empty"},
		Options: StoredSSHProfileOptions{
			Host:     "h",
			Forwards: &[]ForwardSpec{},
		},
	}
	if err := store.CreateProfile(prof); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}
	loaded, err := NewJSONStore(path).LoadProfiles()
	if err != nil {
		t.Fatalf("LoadProfiles: %v", err)
	}
	if loaded[0].Options.Forwards == nil {
		t.Fatal("explicit empty forwards round-tripped to nil — [] must survive as []")
	}
	if len(*loaded[0].Options.Forwards) != 0 {
		t.Fatalf("explicit empty forwards = %v, want empty", *loaded[0].Options.Forwards)
	}

	raw, err := json.Marshal(StoredSSHProfileOptions{Host: "h", Forwards: &[]ForwardSpec{}})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"forwards":[]`) {
		t.Errorf("marshalled = %s, want forwards:[] present", raw)
	}

	// And the unset form omits the field entirely.
	rawNil, err := json.Marshal(StoredSSHProfileOptions{Host: "h"})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(rawNil), "forwards") {
		t.Errorf("marshalled = %s, want forwards omitted when nil", rawNil)
	}
}

func TestForwardsDenseConversionPreserves(t *testing.T) {
	// ToDense and StoredOptionsFromDense must carry the list both ways — a
	// conversion that dropped it would look like a working field until a
	// saved forward silently vanished at the next save.
	fwds := []ForwardSpec{{Direction: "local", BindPort: 7000, Destination: "h:1"}}
	stored := StoredSSHProfileOptions{Host: "h", Forwards: &fwds}

	dense := stored.ToDense()
	if len(dense.Forwards) != 1 || dense.Forwards[0].BindPort != 7000 {
		t.Fatalf("ToDense forwards = %+v, want preserved", dense.Forwards)
	}

	back := StoredOptionsFromDense(dense)
	if back.Forwards == nil || len(*back.Forwards) != 1 || (*back.Forwards)[0].BindPort != 7000 {
		t.Fatalf("StoredOptionsFromDense forwards = %+v, want preserved", back.Forwards)
	}
}

// ---------------------------------------------------------------------------
// Patch path — options.forwards is a typed list patch
// ---------------------------------------------------------------------------

func TestApplyPatchForwards(t *testing.T) {
	opts := &StoredSSHProfileOptions{}

	rows := []any{
		map[string]any{"direction": "local", "bindHost": "", "bindPort": float64(8080), "destination": "db:5432"},
		map[string]any{"direction": "remote", "bindHost": "0.0.0.0", "bindPort": float64(9090), "destination": "127.0.0.1:3000"},
		map[string]any{"direction": "dynamic", "bindHost": "127.0.0.1", "bindPort": float64(0)},
	}
	if !ApplyPatchSet(opts, "options.forwards", rows) {
		t.Fatal("ApplyPatchSet(options.forwards) returned false for a valid list")
	}
	if opts.Forwards == nil || len(*opts.Forwards) != 3 {
		t.Fatalf("after set: %v forwards, want 3", opts.Forwards)
	}
	if (*opts.Forwards)[0].Direction != "local" || (*opts.Forwards)[0].BindPort != 8080 || (*opts.Forwards)[0].Destination != "db:5432" {
		t.Errorf("forward[0] = %+v, want decoded local row", (*opts.Forwards)[0])
	}
	if (*opts.Forwards)[2].Direction != "dynamic" {
		t.Errorf("forward[2].direction = %q, want dynamic", (*opts.Forwards)[2].Direction)
	}

	// An explicit empty list is a valid set — it means "no forwards".
	opts2 := &StoredSSHProfileOptions{}
	if !ApplyPatchSet(opts2, "options.forwards", []any{}) {
		t.Fatal("ApplyPatchSet(options.forwards, []) returned false")
	}
	if opts2.Forwards == nil || len(*opts2.Forwards) != 0 {
		t.Fatalf("explicit empty patch = %v, want non-nil empty slice", opts2.Forwards)
	}

	if !ApplyPatchUnset(opts, "options.forwards") {
		t.Fatal("ApplyPatchUnset(options.forwards) returned false for a known path")
	}
	if opts.Forwards != nil {
		t.Fatalf("after unset: forwards = %v, want nil", opts.Forwards)
	}
	if !PatchPathAllowed("options.forwards") {
		t.Fatal("options.forwards must be an allowed patch path")
	}
}

func TestApplyPatchForwardsRejectsMalformed(t *testing.T) {
	opts := &StoredSSHProfileOptions{}

	// Unknown direction must not be stored.
	if ApplyPatchSet(opts, "options.forwards", []any{
		map[string]any{"direction": "banana", "destination": "h:1"},
	}) {
		t.Fatal("ApplyPatchSet accepted an unknown direction")
	}
	if opts.Forwards != nil {
		t.Fatalf("forwards = %+v, want untouched after unknown direction", opts.Forwards)
	}

	// Local/remote without a destination is not a valid forward.
	if ApplyPatchSet(opts, "options.forwards", []any{
		map[string]any{"direction": "local", "bindPort": float64(80)},
	}) {
		t.Fatal("ApplyPatchSet accepted a local forward without a destination")
	}
	if opts.Forwards != nil {
		t.Fatalf("forwards = %+v, want untouched after missing destination", opts.Forwards)
	}

	// A garbage destination must not be stored either.
	if ApplyPatchSet(opts, "options.forwards", []any{
		map[string]any{"direction": "local", "destination": "not-a-host-port"},
	}) {
		t.Fatal("ApplyPatchSet accepted an invalid destination")
	}
	if opts.Forwards != nil {
		t.Fatalf("forwards = %+v, want untouched after invalid destination", opts.Forwards)
	}

	// A non-array value (the value is not a list at all) is rejected.
	if ApplyPatchSet(opts, "options.forwards", "local") {
		t.Fatal("ApplyPatchSet accepted a non-array forwards value")
	}
	if opts.Forwards != nil {
		t.Fatalf("forwards = %+v, want untouched after non-array value", opts.Forwards)
	}
}

func TestValidForwards(t *testing.T) {
	// The single validation authority, exported so the connect-time replay
	// and any later transport-side gate ask the same question.
	valid := []ForwardSpec{
		{Direction: "local", BindHost: "", BindPort: 8080, Destination: "db.internal:5432"},
		{Direction: "remote", BindHost: "0.0.0.0", BindPort: 0, Destination: "127.0.0.1:3000"},
		{Direction: "dynamic", BindHost: "127.0.0.1", BindPort: 1080},
	}
	if err := ValidForwards(valid); err != nil {
		t.Errorf("ValidForwards(%+v) = %v, want nil", valid, err)
	}

	invalid := []struct {
		name string
		rows []ForwardSpec
	}{
		{"unknown direction", []ForwardSpec{{Direction: "tunnel", Destination: "h:1"}}},
		{"local without destination", []ForwardSpec{{Direction: "local"}}},
		{"local with garbage destination", []ForwardSpec{{Direction: "local", Destination: "nope"}}},
		{"negative port", []ForwardSpec{{Direction: "local", BindPort: -1, Destination: "h:1"}}},
		{"port out of range", []ForwardSpec{{Direction: "local", BindPort: 70000, Destination: "h:1"}}},
	}
	for _, tt := range invalid {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidForwards(tt.rows); err == nil {
				t.Errorf("ValidForwards(%+v) = nil, want error", tt.rows)
			}
		})
	}
}
