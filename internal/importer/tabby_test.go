package importer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/profile"
)

func TestParseTabbyConfig(t *testing.T) {
	data, err := os.ReadFile("testdata/tabby-config.yml")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	cfg, err := ParseTabbyConfig(data)
	if err != nil {
		t.Fatalf("ParseTabbyConfig: %v", err)
	}

	if cfg.Version != 8 {
		t.Errorf("version = %d, want 8", cfg.Version)
	}
	if len(cfg.Profiles) != 3 {
		t.Fatalf("profiles = %d, want 3", len(cfg.Profiles))
	}
	if len(cfg.Groups) != 3 {
		t.Fatalf("groups = %d, want 3", len(cfg.Groups))
	}

	// Spot-check the first profile.
	p := cfg.Profiles[0]
	if p.Type != "ssh" {
		t.Errorf("type = %q, want ssh", p.Type)
	}
	if p.Options.Host != "prod-web1.example.com" {
		t.Errorf("host = %q", p.Options.Host)
	}
	if p.Options.User != "deploy" {
		t.Errorf("user = %q", p.Options.User)
	}
}

func TestImportSSHProfilesOnly(t *testing.T) {
	data, _ := os.ReadFile("testdata/tabby-config.yml")
	cfg, err := ParseTabbyConfig(data)
	if err != nil {
		t.Fatalf("ParseTabbyConfig: %v", err)
	}

	profStore := newMemStore()
	if err := ImportProfiles(cfg, profStore, "ssh"); err != nil {
		t.Fatalf("ImportProfiles: %v", err)
	}

	profs, _ := profStore.LoadProfiles()
	if len(profs) != 3 {
		t.Fatalf("imported %d profiles, want 3 (all are ssh)", len(profs))
	}
	for _, p := range profs {
		if p.Type != "ssh" {
			t.Errorf("non-ssh profile imported: %q", p.Type)
		}
	}
}

func TestImportGroups(t *testing.T) {
	data, _ := os.ReadFile("testdata/tabby-config.yml")
	cfg, _ := ParseTabbyConfig(data)

	profStore := newMemStore()
	if err := ImportGroups(cfg, profStore); err != nil {
		t.Fatalf("ImportGroups: %v", err)
	}

	groups, _ := profStore.LoadGroups()
	if len(groups) != 3 {
		t.Fatalf("imported %d groups, want 3", len(groups))
	}

	var dev *profile.ProfileGroup
	for i, g := range groups {
		if g.ID == "g-dev" {
			dev = &groups[i]
		}
	}
	if dev == nil {
		t.Fatal("g-dev not imported")
	}
	if dev.ParentGroupID != "g-prod" {
		t.Errorf("g-dev parentGroupId = %q, want g-prod", dev.ParentGroupID)
	}
	if dev.Name != "Development" {
		t.Errorf("g-dev name = %q, want Development", dev.Name)
	}
}

func TestImportPreservesNestedGrouping(t *testing.T) {
	data, _ := os.ReadFile("testdata/tabby-config.yml")
	cfg, _ := ParseTabbyConfig(data)

	profStore := newMemStore()
	_ = ImportGroups(cfg, profStore)
	_ = ImportProfiles(cfg, profStore, "ssh")

	profs, _ := profStore.LoadProfiles()
	var devBox *profile.SSHProfile
	for i, p := range profs {
		if p.Name == "dev-box" {
			devBox = &profs[i]
		}
	}
	if devBox == nil {
		t.Fatal("dev-box profile not imported")
	}
	if devBox.Group != "g-dev" {
		t.Errorf("dev-box group = %q, want g-dev", devBox.Group)
	}
}

func TestDedupByHostPortUser(t *testing.T) {
	data, _ := os.ReadFile("testdata/tabby-config.yml")
	cfg, _ := ParseTabbyConfig(data)

	profStore := newMemStore()
	_ = ImportProfiles(cfg, profStore, "ssh")
	// Re-import should not duplicate.
	_ = ImportProfiles(cfg, profStore, "ssh")

	profs, _ := profStore.LoadProfiles()
	if len(profs) != 3 {
		t.Errorf("after re-import, %d profiles (should dedup to 3)", len(profs))
	}
}

func TestImportToJSONStore(t *testing.T) {
	data, _ := os.ReadFile("testdata/tabby-config.yml")
	cfg, _ := ParseTabbyConfig(data)

	dir := t.TempDir()
	store := profile.NewJSONStore(filepath.Join(dir, "imported.json"))

	if err := ImportProfiles(cfg, store, "ssh"); err != nil {
		t.Fatalf("ImportProfiles to JSONStore: %v", err)
	}
	if err := ImportGroups(cfg, store); err != nil {
		t.Fatalf("ImportGroups to JSONStore: %v", err)
	}

	// Reload from disk to verify persistence.
	store2 := profile.NewJSONStore(filepath.Join(dir, "imported.json"))
	profs, _ := store2.LoadProfiles()
	if len(profs) != 3 {
		t.Errorf("reloaded %d profiles, want 3", len(profs))
	}
	groups, _ := store2.LoadGroups()
	if len(groups) != 3 {
		t.Errorf("reloaded %d groups, want 3", len(groups))
	}
}

func TestImportHandlesNonSSHProfiles(t *testing.T) {
	// A config with a mix of ssh and non-ssh profiles should import only ssh.
	yaml := []byte(`
version: 8
profiles:
  - id: "ssh:custom:ssh1:1111"
    type: ssh
    name: ssh1
    options: {host: h1, port: 22, user: u1}
  - id: "local:custom:loc1:2222"
    type: local
    name: loc1
    options: {command: /bin/zsh}
`)
	cfg, err := ParseTabbyConfig(yaml)
	if err != nil {
		t.Fatalf("ParseTabbyConfig: %v", err)
	}

	store := newMemStore()
	if err := ImportProfiles(cfg, store, "ssh"); err != nil {
		t.Fatalf("ImportProfiles: %v", err)
	}
	profs, _ := store.LoadProfiles()
	if len(profs) != 1 {
		t.Fatalf("imported %d profiles, want 1 (ssh only)", len(profs))
	}
	if profs[0].Type != "ssh" {
		t.Errorf("type = %q, want ssh", profs[0].Type)
	}
}
