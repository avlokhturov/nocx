// Package connection resolves profile IDs into SSH connect configurations.
// It is the single point where a profile ID becomes a concrete host, user, auth
// method and (through the credential store) a late-bound password.
//
// Nothing in the transport, session or SSH layer carries plaintext after the
// resolver is wired in: passwords stay in the credential store until the SSH
// auth chain pulls them at connect time.
package connection

import (
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/ssh"
)

// Resolver maps profile IDs to ssh.ConnectConfig with credential wiring.
type Resolver struct {
	profiles    profile.ProfileStore
	credentials credential.CredentialStore
}

// NewResolver creates a Resolver backed by the given stores.
func NewResolver(ps profile.ProfileStore, cs credential.CredentialStore) *Resolver {
	return &Resolver{profiles: ps, credentials: cs}
}

// Resolve maps a profile ID to a Resolved ready for SSH connection.
// The returned config has:
//   - Host from the profile (for ~/.ssh/config alias resolution)
//   - User/AuthMode/KeyPath from the credential (if CredentialID is set) or
//     from the profile's inline fields
//   - Credentials + CredIdentity wired for late-bound password resolution
//     (only when a credential is linked)
//   - Jump host fields resolved recursively (with cycle detection)
//
// Passwords are never set as plaintext on the returned config.
func (r *Resolver) Resolve(profileID string) (host string, cfg *ssh.ConnectConfig, err error) {
	prof, err := r.findProfile(profileID)
	if err != nil {
		return "", nil, err
	}

	visited := map[string]bool{profileID: true}
	cfg, err = r.buildConfig(&prof, visited)
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
// resolution and jump host recursion.
func (r *Resolver) buildConfig(prof *profile.SSHProfile, visited map[string]bool) (*ssh.ConnectConfig, error) {
	cfg := &ssh.ConnectConfig{}
	cfg.Port = prof.Options.Port

	if prof.Options.CredentialID != "" {
		// Credential mode: load user/auth/keyPath from the credential.
		cred, err := r.findCredential(prof.Options.CredentialID)
		if err != nil {
			return nil, fmt.Errorf("profile %s: %w", prof.ID, err)
		}
		cfg.User = cred.Username
		cfg.AuthMode = string(cred.Auth)
		cfg.KeyFile = cred.KeyPath

		// Carry the credential's binding down for internal/ssh to enforce
		// after resolveConfig. connection is where the binding is known
		// (from profile.Credential); ssh is where the effective target is
		// known. Neither layer alone has both facts, so the check straddles
		// them (nocx-mon/PR11-T5). An empty BoundHost reaches ssh as empty
		// and is refused there — "any host" is the redirection hole.
		cfg.BoundHost = cred.Host
		cfg.BoundPort = cred.Port

		// Wire credential store for late-bound password resolution.
		// Identity is keyed by credential ID (matching frontend's savePassword path).
		cfg.Credentials = r.credentials
		cfg.CredIdentity = credential.Identity{User: prof.Options.CredentialID}
	} else {
		// Inline mode: use profile's own fields. No stored secret, no
		// binding to enforce — there is nothing for an attacker to redirect.
		cfg.User = prof.Options.User
		cfg.AuthMode = string(prof.Options.Auth)
	}

	// Resolve jump host if set.
	if prof.Options.JumpHost != "" {
		if visited[prof.Options.JumpHost] {
			return nil, fmt.Errorf("cyclic jump host reference: %s -> %s", prof.ID, prof.Options.JumpHost)
		}
		visited[prof.Options.JumpHost] = true

		jumpProf, err := r.findProfile(prof.Options.JumpHost)
		if err != nil {
			return nil, fmt.Errorf("jump host %s: %w", prof.Options.JumpHost, err)
		}

		jumpCfg, err := r.buildConfig(&jumpProf, visited)
		if err != nil {
			return nil, fmt.Errorf("jump host %s: %w", prof.Options.JumpHost, err)
		}

		cfg.JumpHost = jumpProf.Options.Host
		cfg.JumpPort = jumpProf.Options.Port
		cfg.JumpUser = jumpCfg.User
		cfg.JumpKeyFile = jumpCfg.KeyFile
		cfg.JumpAuthMode = jumpCfg.AuthMode

		if jumpCfg.Credentials != nil {
			cfg.JumpCredentials = jumpCfg.Credentials
			cfg.JumpCredIdentity = jumpCfg.CredIdentity
			// Carry the jump credential's binding for ssh to enforce
			// against the jump host's resolved name/port, separately from
			// the target (nocx-mon/PR11-T5).
			cfg.JumpBoundHost = jumpCfg.BoundHost
			cfg.JumpBoundPort = jumpCfg.BoundPort
		}
	}

	return cfg, nil
}

// findCredential loads a credential by ID from the store.
func (r *Resolver) findCredential(id string) (profile.Credential, error) {
	creds, err := r.profiles.LoadCredentials()
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

// ErrProfileNotFound is returned when a profile or credential ID is not found.
var ErrProfileNotFound = errors.New("not found")
