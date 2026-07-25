package importer

import (
	"fmt"

	"github.com/shady2k/nocx/internal/profile"
	"gopkg.in/yaml.v3"
)

// TabbyConfig is a subset of the Tabby config schema relevant to import.
// Only fields we actually read are modeled; the rest is ignored on decode.
type TabbyConfig struct {
	Version         int            `yaml:"version"`
	Profiles        []TabbyProfile `yaml:"profiles"`
	Groups          []TabbyGroup   `yaml:"groups"`
	ProfileDefaults map[string]any `yaml:"profileDefaults"`
	Vault           *TabbyVault    `yaml:"vault"`
}

// TabbyProfile is a single profile in the Tabby config (the PartialProfile form).
type TabbyProfile struct {
	ID      string          `yaml:"id"`
	Type    string          `yaml:"type"`
	Name    string          `yaml:"name"`
	Group   string          `yaml:"group"`
	Icon    string          `yaml:"icon"`
	Color   string          `yaml:"color"`
	Options TabbySSHOptions `yaml:"options"`
}

// TabbySSHOptions mirrors the SSHProfileOptions from tabby-ssh (the fields we map).
type TabbySSHOptions struct {
	Host              string   `yaml:"host"`
	Port              int      `yaml:"port"`
	User              string   `yaml:"user"`
	Auth              string   `yaml:"auth"`
	Password          string   `yaml:"password"`
	PrivateKeys       []string `yaml:"privateKeys"`
	KeepaliveInterval int      `yaml:"keepaliveInterval"`
	KeepaliveCountMax int      `yaml:"keepaliveCountMax"`
	ReadyTimeout      int      `yaml:"readyTimeout"`
	JumpHost          string   `yaml:"jumpHost"`
	AgentForward      bool     `yaml:"agentForward"`
}

// TabbyGroup is a profile group in the Tabby config.
type TabbyGroup struct {
	ID            string         `yaml:"id"`
	ParentGroupID string         `yaml:"parentGroupId"`
	Name          string         `yaml:"name"`
	Icon          string         `yaml:"icon"`
	Color         string         `yaml:"color"`
	Defaults      map[string]any `yaml:"defaults"`
}

// TabbyVault is the (possibly encrypted) vault section. For import we only
// need it if encrypted=true (then the caller decrypts first and passes the
// decrypted secrets separately).
type TabbyVault struct {
	Version   int    `yaml:"version"`
	Encrypted bool   `yaml:"encrypted"`
	Contents  string `yaml:"contents"`
	KeySalt   string `yaml:"keySalt"`
	IV        string `yaml:"iv"`
}

// ParseTabbyConfig parses a Tabby config YAML byte slice.
func ParseTabbyConfig(data []byte) (*TabbyConfig, error) {
	var cfg TabbyConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse tabby config: %w", err)
	}
	return &cfg, nil
}

// ImportProfiles imports profiles of the given type from a Tabby config into
// the profile store. Deduplicates by host+port+user on re-import.
func ImportProfiles(cfg *TabbyConfig, store profile.ProfileStore, typeFilter string) error {
	existing, err := store.LoadProfiles()
	if err != nil {
		return fmt.Errorf("load existing profiles: %w", err)
	}
	seen := dedupKeySet(existing)

	for _, tp := range cfg.Profiles {
		if tp.Type != typeFilter {
			continue
		}

		p := convertProfile(tp)
		key := dedupKey(p)
		if seen[key] {
			continue
		}
		seen[key] = true

		if err := store.SaveProfile(p); err != nil {
			return fmt.Errorf("save profile %q: %w", p.Name, err)
		}
	}
	return nil
}

// ImportGroups imports profile groups from a Tabby config into the store.
func ImportGroups(cfg *TabbyConfig, store profile.ProfileStore) error {
	for _, tg := range cfg.Groups {
		g := profile.ProfileGroup{
			ID:            tg.ID,
			ParentGroupID: tg.ParentGroupID,
			Name:          tg.Name,
			Icon:          tg.Icon,
			Color:         tg.Color,
			Defaults:      tg.Defaults,
			Editable:      true,
		}
		if err := store.SaveGroup(g); err != nil {
			return fmt.Errorf("save group %q: %w", g.Name, err)
		}
	}
	return nil
}

// convertProfile maps a TabbyProfile to a nocx SSHProfile.
func convertProfile(tp TabbyProfile) profile.SSHProfile {
	return profile.SSHProfile{
		Base: profile.Base{
			ID:    tp.ID,
			Type:  tp.Type,
			Name:  tp.Name,
			Group: tp.Group,
			Icon:  tp.Icon,
			Color: tp.Color,
		},
		Options: profile.SSHProfileOptions{
			Host:              tp.Options.Host,
			Port:              tp.Options.Port,
			User:              tp.Options.User,
			Auth:              profile.AuthMode(tp.Options.Auth),
			KeepaliveInterval: tp.Options.KeepaliveInterval,
			KeepaliveCountMax: tp.Options.KeepaliveCountMax,
			ReadyTimeout:      tp.Options.ReadyTimeout,
			JumpHost:          tp.Options.JumpHost,
			AgentForward:      tp.Options.AgentForward,
		},
	}
}

// dedupKey builds a dedup key from host+port+user.
func dedupKey(p profile.SSHProfile) string {
	return fmt.Sprintf("%s|%d|%s", p.Options.Host, p.Options.Port, p.Options.User)
}

// dedupKeySet builds a set of existing dedup keys.
func dedupKeySet(profs []profile.SSHProfile) map[string]bool {
	m := make(map[string]bool, len(profs))
	for _, p := range profs {
		m[dedupKey(p)] = true
	}
	return m
}
