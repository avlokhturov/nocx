package capability

import (
	"context"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/export"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/settings"
	"github.com/shady2k/nocx/internal/storage"
	"github.com/shady2k/nocx/internal/transport/control"
	"github.com/shady2k/nocx/internal/vault"
)

// ---------------------------------------------------------------------------
// Export — the read half of the configuration family
// ---------------------------------------------------------------------------

// ExportService is the export surface: manifest, configuration export,
// portable encrypted export and same-machine backup. It is what an
// ExportOperation hands its callback. The secret store is deliberately
// absent — no export mode may resolve a secret (ADR-0011 §2, §7).
type ExportService interface {
	Manifest(mode export.Mode) export.Manifest
	ConfigExport() (*export.ConfigExport, error)
	PortableEncrypted(ctx context.Context, passphrase string, includePrivateContent bool) (*export.PortableEncryptedExport, error)
	Backup(ctx context.Context) (*export.BackupManifest, error)
}

// ExportOperation is the typed operation for the export reads. Its gates
// are [config, content]: the configuration export reads profiles, groups
// and settings, and the portable/backup modes additionally read the
// content database.
type ExportOperation interface {
	Run(context.Context, func(context.Context, ExportService) error) error
}

// NewExportOperation builds an ExportOperation that acquires configGate
// before contentGate (the canonical order), then the execution lane.
func NewExportOperation(
	configGate, contentGate, lane control.Admission,
	profiles profile.ProfileRepository,
	groups profile.GroupRepository,
	reg *settings.Registry,
	paths storage.Paths,
	contentDB content.ContentDB,
) ExportOperation {
	g := &guard{}
	return newOperation[ExportService](
		control.NewComposite(configGate, contentGate, lane),
		g,
		newExportService(g, profiles, groups, reg, paths, contentDB),
	)
}

// newExportService builds the concrete export service bound to guard g.
func newExportService(
	g *guard,
	profiles profile.ProfileRepository,
	groups profile.GroupRepository,
	reg *settings.Registry,
	paths storage.Paths,
	contentDB content.ContentDB,
) *exportService {
	var provider export.SettingsProvider
	if reg != nil {
		provider = &settingsProviderAdapter{reg: reg}
	}
	return &exportService{guard: g, profiles: profiles, groups: groups, settings: provider, paths: paths, contentDB: contentDB}
}

type exportService struct {
	guard     *guard
	profiles  profile.ProfileRepository
	groups    profile.GroupRepository
	settings  export.SettingsProvider
	paths     storage.Paths
	contentDB content.ContentDB
}

func (s *exportService) Manifest(mode export.Mode) export.Manifest {
	return export.ManifestFor(mode)
}

func (s *exportService) ConfigExport() (*export.ConfigExport, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return export.ExportConfiguration(export.ConfigExportDeps{
		Profiles: s.profiles,
		Groups:   s.groups,
		Settings: s.settings,
	})
}

func (s *exportService) PortableEncrypted(ctx context.Context, passphrase string, includePrivateContent bool) (*export.PortableEncryptedExport, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return export.ExportPortableEncrypted(export.PortableEncryptedDeps{
		ConfigExport: export.ConfigExportDeps{Profiles: s.profiles, Groups: s.groups, Settings: s.settings},
		ContentDB:    s.contentDB,
	}, passphrase, includePrivateContent)
}

func (s *exportService) Backup(ctx context.Context) (*export.BackupManifest, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return export.Backup(ctx, export.BackupDeps{Paths: s.paths, ContentDB: s.contentDB})
}

// ---------------------------------------------------------------------------
// Restore — the whole profiles + groups + settings + content transaction
// ---------------------------------------------------------------------------

// RestoreService is the restore surface: it wraps export.RestoreImport,
// which already owns the sequencing and the rollback of the
// profiles+groups+settings+content transaction with a documented commit
// point. The service builds the operation's dependencies internally; the
// handler never sequences the stores itself. The secret store is
// deliberately absent — no import mode may resolve a secret (ADR-0011
// §2, §7).
type RestoreService interface {
	Import(ctx context.Context, cfg *export.ConfigExport, priv *export.PrivateContent) (*export.ImportResult, error)
}

// RestoreOperation is the typed operation for export.import and
// export.importPortable. Its gates are [config, content].
type RestoreOperation interface {
	Run(context.Context, func(context.Context, RestoreService) error) error
}

// NewRestoreOperation builds a RestoreOperation that acquires configGate
// before contentGate (the canonical order), then the execution lane.
func NewRestoreOperation(
	configGate, contentGate, lane control.Admission,
	profileSvc *profile.ProfileService,
	reg *settings.Registry,
	contentDB content.ContentDB,
) RestoreOperation {
	g := &guard{}
	return newOperation[RestoreService](
		control.NewComposite(configGate, contentGate, lane),
		g,
		newRestoreService(g, profileSvc, reg, contentDB),
	)
}

// newRestoreService builds the concrete restore service bound to guard g.
func newRestoreService(g *guard, profileSvc *profile.ProfileService, reg *settings.Registry, contentDB content.ContentDB) *restoreService {
	var provider export.SettingsProvider
	var sink export.SettingsSink
	if reg != nil {
		provider = &settingsProviderAdapter{reg: reg}
		sink = &settingsSinkAdapter{reg: reg}
	}
	return &restoreService{guard: g, deps: export.RestoreDeps{
		ProfileSvc: profileSvc,
		Settings:   provider,
		Sink:       sink,
		Content:    contentDB,
	}}
}

type restoreService struct {
	guard *guard
	deps  export.RestoreDeps
}

func (s *restoreService) Import(ctx context.Context, cfg *export.ConfigExport, priv *export.PrivateContent) (*export.ImportResult, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return export.RestoreImport(ctx, s.deps, cfg, priv)
}

// settingsProviderAdapter bridges settings.Registry into
// export.SettingsProvider. It wraps GetSnapshot so secret-class keys are
// excluded by the provider, not by the export package (ADR-0011 §3). The
// export package does not import credential, and this adapter preserves
// that structural invariant. It is the transport's adapter of the same
// name, owned here so the restore/export operations can build their deps
// without the handler seeing the registry.
type settingsProviderAdapter struct {
	reg *settings.Registry
}

func (a *settingsProviderAdapter) All() (map[string]any, error) {
	snap, err := a.reg.GetSnapshot()
	if err != nil {
		return nil, err
	}
	return snap.Values, nil
}

// settingsSinkAdapter bridges settings.Registry into export.SettingsSink.
type settingsSinkAdapter struct {
	reg *settings.Registry
}

func (a *settingsSinkAdapter) Apply(values map[string]any) error {
	return a.reg.ApplyValues(values)
}

// ---------------------------------------------------------------------------
// Capture save — the vault + content settlement of a pending capture
// ---------------------------------------------------------------------------

// CaptureSaveService is the domain half of secrets.captureSave: create the
// vault secret (atomically name-collision-resolved), then rewrite every
// linked history row's redaction segment to the reference. The handler
// keeps the capture registry (connection-scoped in-memory state); this
// service owns the two stores the settlement writes. Never the other order
// — rewriting first can leave a reference to a secret that does not exist.
type CaptureSaveService interface {
	// CreateSecret stores the capture's value with its catalogue metadata
	// and atomic name-collision resolution; the name ACTUALLY used comes
	// back (the renderer must never predict that a suffixed name is free).
	CreateSecret(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, string, error)
	// RewriteRedaction replaces one history row's redaction segment with a
	// vault reference. A row the retention sweep removed is ErrNotFound.
	RewriteRedaction(ctx context.Context, id int64, span content.Redaction, reference string) error
}

// CaptureSaveOperation is the typed operation for secrets.captureSave. Its
// gates are [vault, content].
type CaptureSaveOperation interface {
	Run(context.Context, func(context.Context, CaptureSaveService) error) error
}

// NewCaptureSaveOperation builds a CaptureSaveOperation that acquires
// vaultGate before contentGate (the canonical order), then the execution
// lane.
func NewCaptureSaveOperation(
	vaultGate, contentGate, lane control.Admission,
	vaultLifecycle SecretVault,
	contentDB content.ContentDB,
) CaptureSaveOperation {
	g := &guard{}
	return newOperation[CaptureSaveService](
		control.NewComposite(vaultGate, contentGate, lane),
		g,
		newCaptureSaveService(g, vaultLifecycle, contentDB),
	)
}

// newCaptureSaveService builds the concrete capture-save service bound to
// guard g.
func newCaptureSaveService(g *guard, vaultLifecycle SecretVault, contentDB content.ContentDB) *captureSaveService {
	return &captureSaveService{guard: g, vault: vaultLifecycle, contentDB: contentDB}
}

type captureSaveService struct {
	guard     *guard
	vault     SecretVault
	contentDB content.ContentDB
}

func (s *captureSaveService) CreateSecret(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, string, error) {
	if err := s.guard.check(); err != nil {
		return "", "", err
	}
	return s.vault.CreateNamedResolved(ctx, value, meta)
}

func (s *captureSaveService) RewriteRedaction(ctx context.Context, id int64, span content.Redaction, reference string) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	return s.contentDB.CommandHistory().RewriteRedaction(ctx, id, span, reference)
}

// ---------------------------------------------------------------------------
// Tabby import — the config + vault write of profiles.tabby*
// ---------------------------------------------------------------------------

// TabbyImportService is the domain surface of the Tabby import flow: the
// config reads the planner needs, the vault write the executor needs, and
// the atomic config write. The plan/parse logic stays with the handler
// (it owns the Tabby YAML grammar); this service is the only store access.
type TabbyImportService interface {
	ListProfiles() ([]profile.SSHProfile, error)
	ListGroups() ([]profile.ProfileGroup, error)
	// CreateSecret stores value with its catalogue metadata (ADR-0016);
	// when no vault is wired, the plain store records it namelessly.
	CreateSecret(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, error)
	AtomicImport(profiles []profile.SSHProfile, groups []profile.ProfileGroup) *profile.ImportResult
}

// TabbyImportOperation is the typed operation for profiles.importTabby,
// profiles.tabbyPreview and profiles.tabbyExecute. Its gates are
// [config, vault].
type TabbyImportOperation interface {
	Run(context.Context, func(context.Context, TabbyImportService) error) error
}

// NewTabbyImportOperation builds a TabbyImportOperation that acquires
// configGate before vaultGate (the canonical order), then the execution
// lane.
func NewTabbyImportOperation(
	configGate, vaultGate, lane control.Admission,
	profiles profile.ProfileRepository,
	groups profile.GroupRepository,
	svc *profile.ProfileService,
	vaultLifecycle SecretVault,
	store credential.SecretStore,
) TabbyImportOperation {
	g := &guard{}
	return newOperation[TabbyImportService](
		control.NewComposite(configGate, vaultGate, lane),
		g,
		newTabbyImportService(g, profiles, groups, svc, vaultLifecycle, store),
	)
}

// newTabbyImportService builds the concrete tabby-import service bound to
// guard g.
func newTabbyImportService(
	g *guard,
	profiles profile.ProfileRepository,
	groups profile.GroupRepository,
	svc *profile.ProfileService,
	vaultLifecycle SecretVault,
	store credential.SecretStore,
) *tabbyImportService {
	return &tabbyImportService{guard: g, profiles: profiles, groups: groups, svc: svc, vault: vaultLifecycle, store: store}
}

type tabbyImportService struct {
	guard    *guard
	profiles profile.ProfileRepository
	groups   profile.GroupRepository
	svc      *profile.ProfileService
	vault    SecretVault
	store    credential.SecretStore
}

func (s *tabbyImportService) ListProfiles() ([]profile.SSHProfile, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return s.profiles.LoadProfiles()
}

func (s *tabbyImportService) ListGroups() ([]profile.ProfileGroup, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return s.groups.LoadGroups()
}

func (s *tabbyImportService) CreateSecret(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, error) {
	if err := s.guard.check(); err != nil {
		return "", err
	}
	if s.vault == nil {
		return s.store.Create(ctx, value)
	}
	return s.vault.CreateNamed(ctx, value, meta)
}

func (s *tabbyImportService) AtomicImport(profiles []profile.SSHProfile, groups []profile.ProfileGroup) *profile.ImportResult {
	return s.svc.AtomicImport(profiles, groups)
}
