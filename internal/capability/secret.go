package capability

import (
	"context"
	"fmt"
	"regexp"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/transport/control"
	"github.com/shady2k/nocx/internal/vault"
)

// SecretVault is the vault surface the vault-secret domain needs: the
// catalogue-aware secret operations and row resolution. Satisfied by
// *vault.Vault. The lifecycle operations (setup, seal, …) are deliberately
// absent — a SecretOperation cannot seal the vault.
type SecretVault interface {
	BuildInventory(ctx context.Context, inputs []vault.CredentialInventory) ([]vault.InventoryEntry, error)
	CreateNamed(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, error)
	CreateNamedResolved(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, string, error)
	RenameSecret(ctx context.Context, row string, name string, inputs []vault.CredentialInventory) error
	ReplaceSecret(ctx context.Context, row string, value credential.Secret, inputs []vault.CredentialInventory) error
	ResolveRow(row string, inputs []vault.CredentialInventory) (credential.SecretID, bool)
}

// SecretService is the vault-secret domain surface: inventory, create,
// rename, replace, delete, resolve and read. It is what a SecretOperation
// hands its callback.
//
// The renderer addresses secrets by row handle (secrow:...) — never by a
// SecretID (nocx-jb20.1) — so every method that takes a row resolves it
// internally. The inventory-input projection (which profiles reference a
// secret) is computed inside the service from the profile/group stores;
// the handler never sees those stores.
type SecretService interface {
	// Inventory returns the vault inventory — the Secrets page.
	Inventory(ctx context.Context) ([]vault.InventoryEntry, error)
	// CreateSecret stores value with its catalogue metadata (ADR-0016).
	// resolve selects the atomic name-collision resolution (the prompt's
	// ⌘S save); the name ACTUALLY used comes back — the renderer must
	// never predict that a suffixed name is free.
	CreateSecret(ctx context.Context, value credential.Secret, meta vault.SecretMeta, resolve bool) (realName string, err error)
	RenameSecret(ctx context.Context, row, name string) error
	ReplaceSecret(ctx context.Context, row string, value credential.Secret) error
	// DeleteSecret clears every profile reference to the secret — one
	// atomic write — then deletes the stored value (metadata first,
	// ADR-0011 §4).
	DeleteSecret(ctx context.Context, row string) error
	// ResolveRow maps a row handle to the SecretID behind it. False for
	// an unknown row.
	ResolveRow(row string) (credential.SecretID, bool)
	// GetSecret resolves id and reads the secret. The value is only ever
	// used inside Secret.Use; the handler hands the resolved bytes to a
	// PTY write and nowhere else.
	GetSecret(ctx context.Context, id credential.SecretID) (credential.Secret, error)
	// Usage answers the profiles that use the secret behind a row
	// (ADR-0017). An unknown row or an unused secret answers an empty
	// list.
	Usage(ctx context.Context, row string) ([]profile.ProfileRef, error)
	// ResolveLine substitutes every {{secret:NAME}} reference in a line
	// with its resolved value (vault.resolveLine). The value goes to the
	// caller for the PTY write and nowhere else. Refs reports each
	// reference and whether it resolved; an unresolved name is never
	// silently left as literal text. A vault that sealed mid-flight is an
	// error, not an unresolved ref — a retry after unsealing resolves
	// differently, and answering would be a lie.
	ResolveLine(ctx context.Context, line string) (string, []ResolvedLineRef, error)
}

// ResolvedLineRef is one reference in a resolved line (vault.resolveLine).
type ResolvedLineRef struct {
	// Name is the reference as written ({{secret:NAME}}).
	Name string
	// Resolved is false when the vault holds no secret with that name or
	// its store did not answer.
	Resolved bool
}

// SecretOperation is the typed operation for one vault secret. Its gates
// are [config, vault]: the secret operations compute their inventory
// inputs from profile reads and deleteSecret writes profile references.
type SecretOperation interface {
	Run(context.Context, func(context.Context, SecretService) error) error
}

// SecretOperations builds per-secret operations. The KIND of resource is
// compile-time (a SecretOperation can only reach secrets); the id is
// runtime. ForSecret returns an error for an unknown id and never nil — a
// nil handle is not enforcement.
type SecretOperations struct {
	configGate control.Admission
	vaultGate  control.Admission
	profiles   profile.ProfileRepository
	groups     profile.GroupRepository
	vault      SecretVault
	store      credential.SecretStore
	// exists answers whether id names a stored secret. Wired from the
	// vault's own existence check; nil means "no check" (a test seam).
	exists func(context.Context, credential.SecretID) (bool, error)
}

// NewSecretOperations wires the per-secret factory. Each ForSecret call
// returns a fresh operation with its own guarded service.
func NewSecretOperations(
	configGate, vaultGate control.Admission,
	profiles profile.ProfileRepository,
	groups profile.GroupRepository,
	v SecretVault,
	store credential.SecretStore,
	exists func(context.Context, credential.SecretID) (bool, error),
) *SecretOperations {
	return &SecretOperations{
		configGate: configGate,
		vaultGate:  vaultGate,
		profiles:   profiles,
		groups:     groups,
		vault:      v,
		store:      store,
		exists:     exists,
	}
}

// ForSecret returns a SecretOperation scoped to id, or an error when the
// vault holds no secret with that id. Never nil on success.
func (f *SecretOperations) ForSecret(ctx context.Context, id credential.SecretID) (SecretOperation, error) {
	if f.exists != nil {
		ok, err := f.exists(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("capability: check secret %q: %w", id, err)
		}
		if !ok {
			return nil, fmt.Errorf("capability: unknown secret %q", id)
		}
	}
	g := &guard{}
	return newOperation[SecretService](
		control.NewComposite(f.configGate, f.vaultGate),
		g,
		newSecretService(g, f.profiles, f.groups, f.vault, f.store),
	), nil
}

// NewSecretOperation builds a single SecretOperation (the non-dynamically
// keyed form; most handlers use NewSecretOperations + ForSecret). It is
// for handlers whose operation is fixed at construction.
func NewSecretOperation(
	configGate, vaultGate control.Admission,
	profiles profile.ProfileRepository,
	groups profile.GroupRepository,
	v SecretVault,
	store credential.SecretStore,
) SecretOperation {
	g := &guard{}
	return newOperation[SecretService](
		control.NewComposite(configGate, vaultGate),
		g,
		newSecretService(g, profiles, groups, v, store),
	)
}

// newSecretService builds the concrete vault-secret service bound to
// guard g.
func newSecretService(
	g *guard,
	profiles profile.ProfileRepository,
	groups profile.GroupRepository,
	v SecretVault,
	store credential.SecretStore,
) *secretService {
	return &secretService{guard: g, profiles: profiles, groups: groups, vault: v, store: store}
}

type secretService struct {
	guard    *guard
	profiles profile.ProfileRepository
	groups   profile.GroupRepository
	vault    SecretVault
	store    credential.SecretStore
}

func (s *secretService) Inventory(ctx context.Context) ([]vault.InventoryEntry, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	inputs, err := s.inventoryInputs()
	if err != nil {
		return nil, err
	}
	return s.vault.BuildInventory(ctx, inputs)
}

func (s *secretService) CreateSecret(ctx context.Context, value credential.Secret, meta vault.SecretMeta, resolve bool) (string, error) {
	if err := s.guard.check(); err != nil {
		return "", err
	}
	if resolve {
		_, realName, err := s.vault.CreateNamedResolved(ctx, value, meta)
		return realName, err
	}
	_, err := s.vault.CreateNamed(ctx, value, meta)
	return meta.Name, err
}

func (s *secretService) RenameSecret(ctx context.Context, row, name string) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	inputs, err := s.inventoryInputs()
	if err != nil {
		return err
	}
	return s.vault.RenameSecret(ctx, row, name, inputs)
}

func (s *secretService) ReplaceSecret(ctx context.Context, row string, value credential.Secret) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	inputs, err := s.inventoryInputs()
	if err != nil {
		return err
	}
	return s.vault.ReplaceSecret(ctx, row, value, inputs)
}

func (s *secretService) DeleteSecret(ctx context.Context, row string) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	inputs, err := s.inventoryInputs()
	if err != nil {
		return err
	}
	id, ok := s.vault.ResolveRow(row, inputs)
	if !ok {
		return fmt.Errorf("unknown secret row %q", row)
	}
	pc, ok := s.profiles.(interface{ ClearSecretRefs(string) error })
	if !ok {
		return fmt.Errorf("profile store does not support reference clearing")
	}
	if err := pc.ClearSecretRefs(string(id)); err != nil {
		return err
	}
	// Stored secret second, best-effort like every other metadata-first
	// deletion (ADR-0011 §4): the metadata removal stands regardless, and
	// a failed provider delete is a brief unreachable orphan the journal
	// reconciles.
	_ = s.store.Delete(ctx, id)
	return nil
}

func (s *secretService) ResolveRow(row string) (credential.SecretID, bool) {
	if err := s.guard.check(); err != nil {
		return "", false
	}
	inputs, err := s.inventoryInputs()
	if err != nil {
		return "", false
	}
	return s.vault.ResolveRow(row, inputs)
}

func (s *secretService) GetSecret(ctx context.Context, id credential.SecretID) (credential.Secret, error) {
	if err := s.guard.check(); err != nil {
		return credential.Secret{}, err
	}
	return s.store.Get(ctx, id)
}

func (s *secretService) Usage(ctx context.Context, row string) ([]profile.ProfileRef, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	profiles, groups, err := s.loadConfig()
	if err != nil {
		return nil, err
	}
	ref, ok := s.vault.ResolveRow(row, inventoryInputs(profiles, groups))
	if !ok {
		return nil, nil
	}
	for _, u := range profile.ComputeSecretUsage(profiles, groups, profile.SparseSSHOptions{}) {
		if u.SecretID == string(ref) {
			return u.Profiles, nil
		}
	}
	return nil, nil
}

// resolveLineRefRE matches one {{secret:NAME}} reference. NAME is any text
// up to the closing braces — vault inventory names carry spaces, so the
// grammar is deliberately permissive.
var resolveLineRefRE = regexp.MustCompile(`\{\{secret:(.+?)\}\}`)

func (s *secretService) ResolveLine(ctx context.Context, line string) (string, []ResolvedLineRef, error) {
	if err := s.guard.check(); err != nil {
		return "", nil, err
	}
	locs := resolveLineRefRE.FindAllStringSubmatchIndex(line, -1)
	if len(locs) == 0 {
		return line, []ResolvedLineRef{}, nil
	}
	profiles, groups, err := s.loadConfig()
	if err != nil {
		return "", nil, err
	}
	inputs := inventoryInputs(profiles, groups)
	entries, err := s.vault.BuildInventory(ctx, inputs)
	if err != nil {
		return "", nil, err
	}
	nameToRow := make(map[string]string, len(entries))
	for _, e := range entries {
		if _, exists := nameToRow[e.Name]; !exists {
			nameToRow[e.Name] = e.ID
		}
	}

	refs := make([]ResolvedLineRef, 0, len(locs))
	out := make([]byte, 0, len(line))
	out = append(out, line[:locs[0][0]]...)
	for i, loc := range locs {
		name := line[loc[2]:loc[3]]
		value, resolved, sealed := s.resolveVaultSecret(ctx, name, nameToRow, inputs)
		if sealed {
			return "", nil, vault.ErrVaultSealed
		}
		refs = append(refs, ResolvedLineRef{Name: name, Resolved: resolved})
		if resolved {
			out = append(out, value...)
		} else {
			out = append(out, line[loc[0]:loc[1]]...)
		}
		if i+1 < len(locs) {
			out = append(out, line[loc[1]:locs[i+1][0]]...)
		} else {
			out = append(out, line[loc[1]:]...)
		}
	}
	return string(out), refs, nil
}

// resolveVaultSecret maps name → row handle → SecretID → value. sealed is
// true only when the vault sealed mid-flight (an actionable state, distinct
// from "no such secret"); resolved is false for an unknown name or a store
// that did not answer.
func (s *secretService) resolveVaultSecret(ctx context.Context, name string, nameToRow map[string]string, inputs []vault.CredentialInventory) (value string, resolved bool, sealed bool) {
	row, ok := nameToRow[name]
	if !ok {
		return "", false, false
	}
	id, ok := s.vault.ResolveRow(row, inputs)
	if !ok {
		return "", false, false
	}
	secret, err := s.store.Get(ctx, id)
	if err != nil {
		if err == vault.ErrVaultSealed {
			return "", false, true
		}
		return "", false, false
	}
	if secret.IsEmpty() {
		return "", false, false
	}
	var val string
	if err := secret.Use(func(b []byte) error {
		val = string(b)
		return nil
	}); err != nil {
		return "", false, false
	}
	return val, true, false
}

// loadConfig reads the profile/group stores for the inventory projection.
func (s *secretService) loadConfig() ([]profile.SSHProfile, []profile.ProfileGroup, error) {
	profiles, err := s.profiles.LoadProfiles()
	if err != nil {
		return nil, nil, err
	}
	groups, err := s.groups.LoadGroups()
	if err != nil {
		return nil, nil, err
	}
	return profiles, groups, nil
}

// inventoryInputs loads the profile/group stores and projects the secret
// bindings into the vault's inventory input shape.
func (s *secretService) inventoryInputs() ([]vault.CredentialInventory, error) {
	profiles, groups, err := s.loadConfig()
	if err != nil {
		return nil, err
	}
	return inventoryInputs(profiles, groups), nil
}

// inventoryInputs projects profile secret bindings into the vault's
// inventory input shape: one entry per distinct bound secret, with its
// usage count and, for a single-use secret, the effective host and port of
// the sole profile (ADR-0017: a connection references a secret). It is the
// transport's vaultInventoryInputs, owned here so the vault-secret
// operations can compute their inputs without handing the handler the
// profile store.
func inventoryInputs(profiles []profile.SSHProfile, groups []profile.ProfileGroup) []vault.CredentialInventory {
	usage := profile.ComputeSecretUsage(profiles, groups, profile.SparseSSHOptions{})

	profByID := make(map[string]profile.SSHProfile, len(profiles))
	for _, p := range profiles {
		profByID[p.ID] = p
	}

	inputs := make([]vault.CredentialInventory, 0, len(usage))
	for _, u := range usage {
		ci := vault.CredentialInventory{
			SecretID:   u.SecretID,
			UsageCount: len(u.Profiles),
		}
		if len(u.Profiles) > 0 {
			if p, ok := profByID[u.Profiles[0].ProfileID]; ok {
				eff, resolveErr := profile.ResolveEffectiveProfile(p, groups, profile.SparseSSHOptions{})
				if resolveErr == nil {
					ci.Username = eff.ResolvedOptions.User
					ci.AuthMode = string(eff.ResolvedOptions.Auth)
					if len(u.Profiles) == 1 {
						ci.ID = u.Profiles[0].ProfileID
						ci.SingleHost = eff.ResolvedOptions.Host
						ci.SinglePort = eff.ResolvedOptions.Port
					}
				}
			}
		}
		inputs = append(inputs, ci)
	}
	return inputs
}
