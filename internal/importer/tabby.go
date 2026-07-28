package importer

import (
	"errors"
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
// the profile repository. Deduplicates by host+port+user on re-import.
func ImportProfiles(cfg *TabbyConfig, repo profile.ProfileRepository, typeFilter string) error {
	existing, err := repo.LoadProfiles()
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

		// Create, falling back to Update on duplicate — preserving the
		// overwrite-on-reimport behaviour today's SaveProfile provided.
		// Wave 3 routes this through the domain service properly.
		if err := repo.CreateProfile(p); err != nil {
			if errors.Is(err, profile.ErrProfileExists) {
				if upErr := repo.UpdateProfile(p); upErr != nil {
					return fmt.Errorf("update profile %q: %w", p.Name, upErr)
				}
				continue
			}
			return fmt.Errorf("save profile %q: %w", p.Name, err)
		}
	}
	return nil
}

// ImportGroups imports profile groups from a Tabby config into the
// group repository.
func ImportGroups(cfg *TabbyConfig, repo profile.GroupRepository) error {
	for _, tg := range cfg.Groups {
		var defaults *profile.ProfileDefaults
		if tg.Defaults != nil {
			d, err := profile.DecodeDefaults(tg.Defaults)
			if err != nil {
				return fmt.Errorf("import group %q defaults: %w", tg.Name, err)
			}
			defaults = &d
		}
		g := profile.ProfileGroup{
			ID:            tg.ID,
			ParentGroupID: tg.ParentGroupID,
			Name:          tg.Name,
			Icon:          tg.Icon,
			Color:         tg.Color,
			Defaults:      defaults,
			Editable:      true,
		}
		// Create, falling back to Update on duplicate.
		if err := repo.CreateGroup(g); err != nil {
			if errors.Is(err, profile.ErrGroupExists) {
				if upErr := repo.UpdateGroup(g); upErr != nil {
					return fmt.Errorf("update group %q: %w", g.Name, upErr)
				}
				continue
			}
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

// ImportTabbyWithService imports profiles and groups from a Tabby config
// through the domain service, ensuring atomicity. Returns the ImportResult
// from the service call, which includes any import errors.
func ImportTabbyWithService(cfg *TabbyConfig, svc *profile.ProfileService, typeFilter string) *profile.ImportResult {
	// Collect profiles from config.
	var profiles []profile.SSHProfile
	for _, tp := range cfg.Profiles {
		if tp.Type != typeFilter {
			continue
		}
		profiles = append(profiles, convertProfile(tp))
	}

	// Collect groups from config.
	var groups []profile.ProfileGroup
	for _, tg := range cfg.Groups {
		var defaults *profile.ProfileDefaults
		if tg.Defaults != nil {
			d, err := profile.DecodeDefaults(tg.Defaults)
			if err != nil {
				result := &profile.ImportResult{}
				result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("group %q defaults: %v", tg.Name, err))
				return result
			}
			defaults = &d
		}
		groups = append(groups, profile.ProfileGroup{
			ID:            tg.ID,
			ParentGroupID: tg.ParentGroupID,
			Name:          tg.Name,
			Icon:          tg.Icon,
			Color:         tg.Color,
			Defaults:      defaults,
			Editable:      true,
		})
	}

	return svc.AtomicImport(profiles, groups, nil)
}
