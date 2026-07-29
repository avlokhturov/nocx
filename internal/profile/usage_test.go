package profile

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestComputeCredentialUsage_EmptyStore(t *testing.T) {
	usage := ComputeCredentialUsage(nil, nil, nil, SparseSSHOptions{})
	if len(usage) != 0 {
		t.Errorf("expected empty result, got %d items", len(usage))
	}
}

func TestComputeCredentialUsage_ProfileNamesDirectly(t *testing.T) {
	c1 := Credential{ID: "cred:prod:1", Name: "Prod", Username: "deploy"}
	p1 := SSHProfile{
		Base: Base{ID: "ssh:p1:1", Type: "ssh", Name: "web"},
		Options: SSHProfileOptions{
			Host:         "web.example.com",
			CredentialID: "cred:prod:1",
		},
	}

	usage := ComputeCredentialUsage([]Credential{c1}, []SSHProfile{p1}, nil, SparseSSHOptions{})

	if len(usage) != 1 {
		t.Fatalf("expected 1 credential usage, got %d", len(usage))
	}
	if usage[0].CredentialID != "cred:prod:1" {
		t.Errorf("credentialId = %q, want cred:prod:1", usage[0].CredentialID)
	}
	if len(usage[0].Profiles) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(usage[0].Profiles))
	}
	ref := usage[0].Profiles[0]
	if ref.ProfileID != "ssh:p1:1" {
		t.Errorf("profileId = %q", ref.ProfileID)
	}
	if ref.Source != "profile" {
		t.Errorf("source = %q, want profile", ref.Source)
	}
	if ref.GroupID != "" || ref.GroupName != "" {
		t.Errorf("unexpected group fields for profile-source ref: groupId=%q groupName=%q", ref.GroupID, ref.GroupName)
	}
}

func TestComputeCredentialUsage_ProfileInheritsFromGroup(t *testing.T) {
	c1 := Credential{ID: "cred:prod:1", Name: "Prod", Username: "deploy"}
	p1 := SSHProfile{
		Base: Base{ID: "ssh:p1:1", Type: "ssh", Name: "web", Group: "g1"},
		Options: SSHProfileOptions{
			Host: "web.example.com",
			// No CredentialID — inherits from group
		},
	}
	groups := []ProfileGroup{
		{ID: "g1", Name: "Prod Group", Defaults: &ProfileDefaults{
			SparseSSHOptions: SparseSSHOptions{
				CredentialID: credPtr("cred:prod:1"),
			},
		}},
	}

	usage := ComputeCredentialUsage([]Credential{c1}, []SSHProfile{p1}, groups, SparseSSHOptions{})

	if len(usage) != 1 {
		t.Fatalf("expected 1 credential usage, got %d", len(usage))
	}
	if len(usage[0].Profiles) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(usage[0].Profiles))
	}
	ref := usage[0].Profiles[0]
	if ref.Source != "group" {
		t.Errorf("source = %q, want group", ref.Source)
	}
	if ref.GroupID != "g1" {
		t.Errorf("groupId = %q, want g1", ref.GroupID)
	}
	if ref.GroupName != "Prod Group" {
		t.Errorf("groupName = %q, want Prod Group", ref.GroupName)
	}
}

func TestComputeCredentialUsage_ProfileOverridesGroupCredential(t *testing.T) {
	c1 := Credential{ID: "cred:direct:1", Name: "Direct", Username: "alice"}
	c2 := Credential{ID: "cred:group:1", Name: "GroupDefault", Username: "bob"}

	p1 := SSHProfile{
		Base: Base{ID: "ssh:p1:1", Type: "ssh", Name: "web", Group: "g1"},
		Options: SSHProfileOptions{
			Host:         "web.example.com",
			CredentialID: "cred:direct:1", // profile names its own credential
		},
	}
	groups := []ProfileGroup{
		{ID: "g1", Name: "Prod", Defaults: &ProfileDefaults{
			SparseSSHOptions: SparseSSHOptions{
				CredentialID: credPtr("cred:group:1"),
			},
		}},
	}

	usage := ComputeCredentialUsage([]Credential{c1, c2}, []SSHProfile{p1}, groups, SparseSSHOptions{})

	// Find entries for both credentials.
	usageByID := make(map[string]CredentialUsage)
	for _, u := range usage {
		usageByID[u.CredentialID] = u
	}

	// c1 (direct) should have the profile.
	direct, ok := usageByID["cred:direct:1"]
	if !ok {
		t.Fatal("expected entry for cred:direct:1 (profile's own credential)")
	}
	if len(direct.Profiles) != 1 {
		t.Fatalf("cred:direct:1: expected 1 profile, got %d", len(direct.Profiles))
	}
	if direct.Profiles[0].ProfileID != "ssh:p1:1" {
		t.Errorf("cred:direct:1: profileId = %q", direct.Profiles[0].ProfileID)
	}

	// c2 (group default) should have zero profiles — profile overrides it.
	groupDefault, ok := usageByID["cred:group:1"]
	if !ok {
		t.Fatal("expected entry for cred:group:1 (group default, unused)")
	}
	if len(groupDefault.Profiles) != 0 {
		t.Errorf("cred:group:1: expected 0 profiles (overridden), got %d", len(groupDefault.Profiles))
	}
}

func TestComputeCredentialUsage_CredentialUnused(t *testing.T) {
	c1 := Credential{ID: "cred:orphan:1", Name: "Orphan", Username: "ghost"}
	c2 := Credential{ID: "cred:used:1", Name: "Used", Username: "real"}
	p1 := SSHProfile{
		Base: Base{ID: "ssh:p1:1", Type: "ssh", Name: "web"},
		Options: SSHProfileOptions{
			Host:         "web.example.com",
			CredentialID: "cred:used:1",
		},
	}

	usage := ComputeCredentialUsage([]Credential{c1, c2}, []SSHProfile{p1}, nil, SparseSSHOptions{})

	usageByID := make(map[string]CredentialUsage)
	for _, u := range usage {
		usageByID[u.CredentialID] = u
	}

	// Orphan credential: must be present with empty profiles.
	orphan, ok := usageByID["cred:orphan:1"]
	if !ok {
		t.Fatal("expected entry for cred:orphan:1 (unused credential must appear)")
	}
	if len(orphan.Profiles) != 0 {
		t.Errorf("orphan credential: expected empty profiles, got %d", len(orphan.Profiles))
	}

	// Used credential: must have 1 profile.
	used, ok := usageByID["cred:used:1"]
	if !ok {
		t.Fatal("expected entry for cred:used:1")
	}
	if len(used.Profiles) != 1 {
		t.Errorf("used credential: expected 1 profile, got %d", len(used.Profiles))
	}
}

func TestComputeCredentialUsage_GroupNestedChain(t *testing.T) {
	c1 := Credential{ID: "cred:parent:1", Name: "ParentCred", Username: "root"}
	c2 := Credential{ID: "cred:child:1", Name: "ChildCred", Username: "dev"}

	// Groups: grandparent -> parent -> child (g3 is leaf group).
	groups := []ProfileGroup{
		{ID: "g1", Name: "Grandparent", Defaults: &ProfileDefaults{
			SparseSSHOptions: SparseSSHOptions{
				CredentialID: credPtr("cred:parent:1"),
			},
		}},
		{ID: "g2", Name: "Parent", ParentGroupID: "g1", Defaults: &ProfileDefaults{
			SparseSSHOptions: SparseSSHOptions{
				CredentialID: credPtr("cred:child:1"),
			},
		}},
		{ID: "g3", Name: "Child", ParentGroupID: "g2"}, // no credentialId — inherits from parent
	}

	// Profile p1 is in g3 (child) — inherits from g2 which is nearest ancestor
	// with a credentialId.
	p1 := SSHProfile{
		Base: Base{ID: "ssh:p1:1", Type: "ssh", Name: "leaf", Group: "g3"},
		Options: SSHProfileOptions{
			Host: "leaf.example.com",
			// No credentialId — inherits from g2 via g3
		},
	}

	// Profile p2 is in g2 (parent) — directly inherits g2's credential.
	p2 := SSHProfile{
		Base: Base{ID: "ssh:p2:1", Type: "ssh", Name: "mid", Group: "g2"},
		Options: SSHProfileOptions{
			Host: "mid.example.com",
			// No credentialId — inherits from g2 directly
		},
	}

	// Profile p3 is in g1 (grandparent) — inherits g1's credential.
	p3 := SSHProfile{
		Base: Base{ID: "ssh:p3:1", Type: "ssh", Name: "root", Group: "g1"},
		Options: SSHProfileOptions{
			Host: "root.example.com",
			// No credentialId — inherits from g1
		},
	}

	usage := ComputeCredentialUsage(
		[]Credential{c1, c2},
		[]SSHProfile{p1, p2, p3},
		groups,
		SparseSSHOptions{},
	)

	usageByID := make(map[string]CredentialUsage)
	for _, u := range usage {
		usageByID[u.CredentialID] = u
	}

	// c1 (cred:parent:1) should have p3 (root group inheritor).
	parentCred, ok := usageByID["cred:parent:1"]
	if !ok {
		t.Fatal("expected entry for cred:parent:1")
	}
	var p3Found bool
	for _, ref := range parentCred.Profiles {
		if ref.ProfileID == "ssh:p3:1" {
			p3Found = true
			if ref.Source != "group" || ref.GroupID != "g1" {
				t.Errorf("p3: expected source=group g1, got source=%q groupId=%q", ref.Source, ref.GroupID)
			}
		}
	}
	if !p3Found {
		t.Error("cred:parent:1: p3 not found in profiles")
	}

	// c2 (cred:child:1) should have p1 and p2.
	childCred, ok := usageByID["cred:child:1"]
	if !ok {
		t.Fatal("expected entry for cred:child:1")
	}
	var p1Found, p2Found bool
	for _, ref := range childCred.Profiles {
		switch ref.ProfileID {
		case "ssh:p1:1":
			p1Found = true
			// p1 is in g3 which inherits from g2. The source chain resolves to g2
			// (nearest ancestor with credentialId). Verify group membership.
			if ref.Source != "group" {
				t.Errorf("p1: expected source=group, got %q", ref.Source)
			}
		case "ssh:p2:1":
			p2Found = true
			if ref.Source != "group" || ref.GroupID != "g2" {
				t.Errorf("p2: expected source=group g2, got source=%q groupId=%q", ref.Source, ref.GroupID)
			}
		}
	}
	if !p1Found {
		t.Error("cred:child:1: p1 not found")
	}
	if !p2Found {
		t.Error("cred:child:1: p2 not found")
	}
}

func TestComputeCredentialUsage_GlobalDefaultsInherited(t *testing.T) {
	c1 := Credential{ID: "cred:global:1", Name: "Global", Username: "root"}
	p1 := SSHProfile{
		Base: Base{ID: "ssh:p1:1", Type: "ssh", Name: "web"},
		Options: SSHProfileOptions{
			Host: "web.example.com",
			// No credentialId — inherits from global defaults
		},
	}
	global := SparseSSHOptions{
		CredentialID: credPtr("cred:global:1"),
	}

	usage := ComputeCredentialUsage([]Credential{c1}, []SSHProfile{p1}, nil, global)

	if len(usage) != 1 {
		t.Fatalf("expected 1 credential usage, got %d", len(usage))
	}
	if len(usage[0].Profiles) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(usage[0].Profiles))
	}
	ref := usage[0].Profiles[0]
	if ref.Source != "global" {
		t.Errorf("source = %q, want global", ref.Source)
	}
	if ref.GroupID != "" {
		t.Errorf("unexpected groupId for global source: %q", ref.GroupID)
	}
}

func TestComputeCredentialUsage_MultipleProfilesPerCredential(t *testing.T) {
	c1 := Credential{ID: "cred:fleet:1", Name: "Fleet", Username: "ops"}
	profiles := []SSHProfile{
		{
			Base: Base{ID: "ssh:p1:1", Type: "ssh", Name: "web1"},
			Options: SSHProfileOptions{
				Host:         "web1.example.com",
				CredentialID: "cred:fleet:1",
			},
		},
		{
			Base: Base{ID: "ssh:p2:1", Type: "ssh", Name: "web2"},
			Options: SSHProfileOptions{
				Host:         "web2.example.com",
				CredentialID: "cred:fleet:1",
			},
		},
		{
			Base: Base{ID: "ssh:p3:1", Type: "ssh", Name: "web3"},
			Options: SSHProfileOptions{
				Host:         "web3.example.com",
				CredentialID: "cred:fleet:1",
			},
		},
	}

	usage := ComputeCredentialUsage([]Credential{c1}, profiles, nil, SparseSSHOptions{})

	if len(usage) != 1 {
		t.Fatalf("expected 1 credential usage, got %d", len(usage))
	}
	if len(usage[0].Profiles) != 3 {
		t.Errorf("expected 3 profiles, got %d", len(usage[0].Profiles))
	}
}

// credPtr returns a pointer to the given string, for use in SparseSSHOptions.
func credPtr(s string) *string {
	return &s
}

// TestComputeCredentialUsage_UnusedMarshalsAsArray asserts the WIRE format, not
// the Go value. A nil slice and an empty slice are indistinguishable to len(),
// so a test written against len() passes while the JSON says
// "profiles": null — and the renderer's field is typed as an array. This is the
// only test that fails when that regresses.
func TestComputeCredentialUsage_UnusedMarshalsAsArray(t *testing.T) {
	c := Credential{ID: "cred:orphan:1", Name: "Orphan", Username: "nobody"}

	usage := ComputeCredentialUsage([]Credential{c}, nil, nil, SparseSSHOptions{})

	b, err := json.Marshal(usage)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := string(b); !strings.Contains(got, `"profiles":[]`) {
		t.Errorf("unused credential must marshal profiles as [], got %s", got)
	}
}
