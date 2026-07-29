// Package connection resolves profile IDs into SSH connect configurations.
// It is the single point where a profile ID becomes a concrete host, user, auth
// method and (through the credential store) a late-bound password.
//
// Nothing in the transport, session or SSH layer carries plaintext after the
// resolver is wired in: passwords stay in the credential store until the SSH
// auth chain pulls them at connect time.
package connection

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/ssh"
)

// Resolver maps profile IDs to ssh.ConnectConfig with credential wiring.
type Resolver struct {
	profiles profile.ProfileRepository
	groups   profile.GroupRepository
	credMeta profile.CredentialMetadataRepository
	secrets  credential.SecretStore
	// configResolver resolves ~/.ssh/config directives using ssh -G.
	// Injected at the composition root, shared with the RealClient so both
	// sides of the authorization comparison go through the same resolution.
	// When nil, host resolution is a no-op (original host returned as-is).
	configResolver ssh.ConfigResolver
}

// ResolverOption configures the Resolver.
type ResolverOption func(*Resolver)

func WithConfigResolver(resolver ssh.ConfigResolver) ResolverOption {
	return func(r *Resolver) { r.configResolver = resolver }
}

// NewResolver creates a Resolver backed by the given stores.
func NewResolver(pr profile.ProfileRepository, gr profile.GroupRepository, cmr profile.CredentialMetadataRepository, ss credential.SecretStore, opts ...ResolverOption) *Resolver {
	r := &Resolver{profiles: pr, groups: gr, credMeta: cmr, secrets: ss}
	for _, o := range opts {
		o(r)
	}
	return r
}

// Resolve maps a profile ID to a Resolved ready for SSH connection.
// The returned config has:
//   - Host from the profile (for ~/.ssh/config alias resolution)
//   - User/AuthMode/KeyPath from the credential (if CredentialID is set) or
//     from the profile's inline fields
//   - SecretStore + SecretID wired for late-bound password resolution
//     (only when a credential is linked)
//   - Jump host fields resolved recursively (with cycle detection)
//   - KeepaliveInterval/KeepaliveCountMax/ReadyTimeout/AgentForward from the
//     effective profile (profile + group inheritance + global defaults)
//   - AuthorizedEndpoint from the profile's Host, resolved through
//     ~/.ssh/config to the canonical hostname (not the alias). The credential
//     is authorized for this resolved endpoint, verified at connect time
//     against the freshly-resolved dial target.
//
// Passwords are never set as plaintext on the returned config.
func (r *Resolver) Resolve(profileID string) (host string, cfg *ssh.ConnectConfig, err error) {
	prof, err := r.findProfile(profileID)
	if err != nil {
		return "", nil, err
	}
	visited := map[string]bool{profileID: true}
	cfg, err = r.buildConfig(&prof, visited, nil)
	if err != nil {
		return "", nil, err
	}

	return prof.Options.Host, cfg, nil
}

// versionOverride names one credential version to resolve instead of the
// credential's current one. It carries the credential ID as well as the version
// so the resolver can refuse a profile that turns out to use a different
// credential, rather than silently applying the override to whatever it finds.
type versionOverride struct {
	credentialID string
	versionID    string
}

// ResolveWithVersion is Resolve pinned to one explicit credential version. It
// exists for the rollout probe, which must authenticate with a staged candidate
// rather than with the version ordinary connections use.
//
// The contract that matters is what it does NOT do. If versionID does not exist
// on the credential, this returns ErrVersionNotFound — it never falls back to
// the current version. A fallback here would mean a candidate rejection
// followed by an invisible retry with the working password, which is
// indistinguishable from password spraying to the host being probed and burns
// a MaxAuthTries slot the operator did not ask to spend. Callers get an error
// and decide; the resolver never decides for them.
//
// The override applies to the target profile only. A jump host resolves with
// its own credential's current version: rotating a credential must not change
// how the bastion in front of it is authenticated.
func (r *Resolver) ResolveWithVersion(profileID, credentialID, versionID string) (host string, cfg *ssh.ConnectConfig, err error) {
	if credentialID == "" || versionID == "" {
		return "", nil, fmt.Errorf("resolve %s: credential id and version id are required", profileID)
	}
	prof, err := r.findProfile(profileID)
	if err != nil {
		return "", nil, err
	}
	visited := map[string]bool{profileID: true}
	cfg, err = r.buildConfig(&prof, visited, &versionOverride{credentialID: credentialID, versionID: versionID})
	if err != nil {
		return "", nil, err
	}

	return prof.Options.Host, cfg, nil
}

// findProfile loads the profile by ID from the store.
func (r *Resolver) findProfile(id string) (profile.SSHProfile, error) {
	profs, err := r.profiles.LoadProfiles()
	if err != nil {
		return profile.SSHProfile{}, fmt.Errorf("load profiles: %w", err)
	}
	for _, p := range profs {
		if p.ID == id {
			return p, nil
		}
	}
	return profile.SSHProfile{}, fmt.Errorf("profile %s: %w", id, ErrProfileNotFound)
}

// buildConfig constructs a ConnectConfig from a profile, handling credential
// resolution, effective profile inheritance, and jump host recursion.
// override, when non-nil, names one credential version to use instead of the
// credential's current one; it is never passed down to a jump host.
func (r *Resolver) buildConfig(prof *profile.SSHProfile, visited map[string]bool, override *versionOverride) (*ssh.ConnectConfig, error) {
	cfg := &ssh.ConnectConfig{}

	// Resolve effective profile (profile + group inheritance + defaults).
	groups, err := r.groups.LoadGroups()
	if err != nil {
		return nil, fmt.Errorf("load groups: %w", err)
	}
	// No global defaults store yet — pass empty.
	eff, err := profile.ResolveEffectiveProfile(*prof, groups, profile.SparseSSHOptions{})
	if err != nil {
		return nil, fmt.Errorf("resolve effective profile for %s: %w", prof.ID, err)
	}

	// Use the effective profile's port (profile > group chain > global > 22).
	// ~/.ssh/config Port is applied at connect time by resolveConfig, which
	// is outranked by the explicit cfg.Port set here.
	cfg.Port = eff.ResolvedOptions.Port

	// Copy keepalive/timeout/agentforward from effective profile.
	// The profile stores MILLISECONDS; ConnectConfig fields are time.Duration.
	if eff.ResolvedOptions.KeepaliveInterval > 0 {
		cfg.KeepaliveInterval = time.Duration(eff.ResolvedOptions.KeepaliveInterval) * time.Millisecond
	}
	if eff.ResolvedOptions.KeepaliveCountMax > 0 {
		cfg.KeepaliveCountMax = eff.ResolvedOptions.KeepaliveCountMax
	} else {
		cfg.KeepaliveCountMax = -1 // default: single failure closes
	}
	if eff.ResolvedOptions.ReadyTimeout > 0 {
		cfg.ReadyTimeout = time.Duration(eff.ResolvedOptions.ReadyTimeout) * time.Millisecond
	}
	cfg.AgentForward = eff.ResolvedOptions.AgentForward

	credID := eff.ResolvedOptions.CredentialID
	if credID != "" {
		cred, err := r.findCredential(credID)
		if err != nil {
			return nil, fmt.Errorf("profile %s: %w", prof.ID, err)
		}
		cfg.User = cred.Username
		cfg.AuthMode = string(cred.Auth)
		cfg.KeyFile = cred.KeyPath
		// Authorized endpoint: the profile's Host is resolved through
		// ~/.ssh/config to get the canonical hostname (not the alias), then
		// stored as the authorization identity. At connect time, the same
		// resolution is applied to the dial target, so an alias connects and
		// a HostName change (drift) is detected as a mismatch.
		authHost := r.resolveProfileHost(prof.Options.Host)
		cfg.AuthorizedEndpoint = authHost
		if cfg.Port > 0 {
			cfg.AuthorizedEndpoint = net.JoinHostPort(authHost, strconv.Itoa(cfg.Port))
		}
		// Wire SecretStore for late-bound password/passphrase resolution
		// via opaque SecretID references (ADR-0011 §2).
		cfg.Secrets = r.secrets

		// The SELECTED version's references, not the record's. poolKeyFor
		// (ssh_dial.go:38) keys on cfg.SecretID, so this is also what makes
		// a promotion produce a new pool entry without any change in
		// internal/ssh.
		v, ok := cred.Current()
		if override != nil {
			if credID != override.credentialID {
				return nil, fmt.Errorf("profile %s uses credential %s, not %s: %w", prof.ID, credID, override.credentialID, ErrCredentialMismatch)
			}
			// Deliberately overwrites ok as well: a missing version must not
			// leave the current version's references on the config.
			v, ok = cred.Version(override.versionID)
			if !ok {
				return nil, fmt.Errorf("credential %s version %s: %w", credID, override.versionID, ErrVersionNotFound)
			}
		}
		if ok {
			if v.PasswordSecretID != "" {
				cfg.SecretID = credential.SecretID(v.PasswordSecretID)
			}
			if v.PassphraseSecretID != "" {
				cfg.PassphraseSecretID = credential.SecretID(v.PassphraseSecretID)
			}
			cfg.CredentialVersionID = v.ID
		}
	} else {
		if override != nil {
			return nil, fmt.Errorf("profile %s uses no credential, cannot resolve version %s: %w", prof.ID, override.versionID, ErrCredentialMismatch)
		}
		cfg.User = eff.ResolvedOptions.User
		cfg.AuthMode = string(eff.ResolvedOptions.Auth)
	}

	// Resolve jump host if set (from effective profile, which may inherit it).
	jumpHostID := eff.ResolvedOptions.JumpHost
	if jumpHostID != "" {
		if visited[jumpHostID] {
			return nil, fmt.Errorf("cyclic jump host reference: %s -> %s", prof.ID, jumpHostID)
		}
		visited[jumpHostID] = true

		jumpProf, err := r.findProfile(jumpHostID)
		if err != nil {
			return nil, fmt.Errorf("jump host %s: %w", jumpHostID, err)
		}

		// nil, not override: the bastion keeps its own current version.
		jumpCfg, err := r.buildConfig(&jumpProf, visited, nil)
		if err != nil {
			return nil, fmt.Errorf("jump host %s: %w", jumpHostID, err)
		}

		// Populate flat fields for backward compatibility and JumpConfig
		// for multi-hop support. JumpConfig carries the full recursive
		// config so acquireJumpHost can follow the chain.
		cfg.JumpHost = jumpProf.Options.Host
		cfg.JumpPort = jumpCfg.Port
		cfg.JumpUser = jumpCfg.User
		cfg.JumpKeyFile = jumpCfg.KeyFile
		cfg.JumpAuthMode = jumpCfg.AuthMode
		cfg.JumpConfig = jumpCfg

		if jumpCfg.Secrets != nil {
			cfg.JumpSecrets = jumpCfg.Secrets
			cfg.JumpSecretID = jumpCfg.SecretID
			cfg.JumpPassphraseSecretID = jumpCfg.PassphraseSecretID
			// Authorized endpoint for the jump credential: resolved through
			// ~/.ssh/config, same as the target credential.
			jumpAuthHost := r.resolveProfileHost(jumpProf.Options.Host)
			cfg.JumpAuthorizedEndpoint = jumpAuthHost
			if jumpCfg.Port > 0 {
				cfg.JumpAuthorizedEndpoint = net.JoinHostPort(jumpAuthHost, strconv.Itoa(jumpCfg.Port))
			}
		}
	}

	return cfg, nil
}

// findCredential loads a credential by ID from the credential metadata store.
func (r *Resolver) findCredential(id string) (profile.Credential, error) {
	creds, err := r.credMeta.LoadCredentials()
	if err != nil {
		return profile.Credential{}, fmt.Errorf("load credentials: %w", err)
	}
	for _, c := range creds {
		if c.ID == id {
			return c, nil
		}
	}
	return profile.Credential{}, fmt.Errorf("credential %s: %w", id, ErrProfileNotFound)
}

// resolveProfileHost applies the ConfigResolver's HostName resolution to a
// profile's host, returning the canonical hostname. When no resolver is
// configured, the original host is returned unchanged (no resolution).
// Uses context.Background() since profile resolution runs during
// configuration, not on the connect path; the resolver's own 10s internal
// timeout still bounds the subprocess.
func (r *Resolver) resolveProfileHost(host string) string {
	if r.configResolver == nil {
		return host
	}
	resolved, err := r.configResolver.ResolveHost(context.Background(), host)
	if err != nil || resolved == "" {
		return host
	}
	return resolved
}

// ErrProfileNotFound is returned when a profile or credential ID is not found.
var ErrProfileNotFound = errors.New("not found")

// ErrVersionNotFound is returned by ResolveWithVersion when the named
// credential version does not exist. It is deliberately an error rather than a
// fallback: see the contract on ResolveWithVersion.
var ErrVersionNotFound = errors.New("credential version not found")

// ErrCredentialMismatch is returned by ResolveWithVersion when the profile does
// not in fact use the credential the caller named. A rollout that has selected
// the wrong target must stop rather than probe with somebody else's secret.
var ErrCredentialMismatch = errors.New("profile does not use the named credential")
