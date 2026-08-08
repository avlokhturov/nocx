package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"github.com/shady2k/nocx/internal/export"
	"github.com/shady2k/nocx/internal/settings"
)

// settingsProviderAdapter bridges settings.Registry into
// export.SettingsProvider. It wraps GetSnapshot so secret-class keys
// are excluded by the provider, not by the export package
// (ADR-0011 §3). The export package does not import credential, and
// this adapter preserves that structural invariant.
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
// It is the write-side counterpart of settingsProviderAdapter: whatever
// GetSnapshot exported is what ApplyValues restores, and nothing else
// (ADR-0011 §3). The export package never imports settings, and this
// adapter preserves that structural invariant.
type settingsSinkAdapter struct {
	reg *settings.Registry
}

func (a *settingsSinkAdapter) Apply(values map[string]any) error {
	return a.reg.ApplyValues(values)
}

// --- export.* control-plane handlers ------------------------------------
// handleExportMethod dispatches export.* RPCs.
// All export modes work purely through the profile/group repositories and
// storage paths — the credential.CredentialStore is never consulted, so no
// mode can resolve a secret (ADR-0011 §2, §7).
func (s *WSServer) handleExportMethod(ctx context.Context, wconn Responder, req jsonrpcRequest) {
	if s.profiles == nil || s.groups == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}

	switch req.Method {
	case "export.manifest":
		s.handleExportManifest(wconn, req)
	case "export.configExport":
		s.handleExportConfig(wconn, req)
	case "export.portableEncrypted":
		s.handleExportPortableEncrypted(wconn, req)
	case "export.backup":
		s.handleExportBackup(ctx, wconn, req)
	case "export.import":
		s.handleExportImport(wconn, req)
	case "export.importPortable":
		s.handleExportImportPortable(wconn, req)
	default:
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "Method not found"})
	}
}

// --- export.manifest ---------------------------------------------------

type exportManifestParams struct {
	Mode string `json:"mode"`
}

func (s *WSServer) handleExportManifest(wconn Responder, req jsonrpcRequest) {
	var params exportManifestParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Mode == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: mode required"})
		return
	}
	m := export.ManifestFor(export.Mode(params.Mode))
	_ = wconn.TryResult(req.ID, mustMarshal(m))
}

// --- export.configExport -----------------------------------------------

func (s *WSServer) handleExportConfig(wconn Responder, req jsonrpcRequest) {
	deps := s.buildConfigExportDeps()
	result, err := export.ExportConfiguration(deps)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(result))
}

// --- export.portableEncrypted ------------------------------------------

type exportPortableEncryptedParams struct {
	Passphrase            string `json:"passphrase"`
	IncludePrivateContent bool   `json:"includePrivateContent,omitempty"`
}

func (s *WSServer) handleExportPortableEncrypted(wconn Responder, req jsonrpcRequest) {
	var params exportPortableEncryptedParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Passphrase == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: passphrase required"})
		return
	}

	deps := export.PortableEncryptedDeps{
		ConfigExport: s.buildConfigExportDeps(),
		ContentDB:    s.exportContentDB,
	}

	result, err := export.ExportPortableEncrypted(deps, params.Passphrase, params.IncludePrivateContent)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(result))
}

// --- export.backup -----------------------------------------------------

func (s *WSServer) handleExportBackup(ctx context.Context, wconn Responder, req jsonrpcRequest) {
	if s.exportPaths == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "backup not available (paths not wired)"})
		return
	}
	deps := export.BackupDeps{Paths: s.exportPaths, ContentDB: s.exportContentDB}
	result, err := export.Backup(ctx, deps)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(result))
}

// --- export.import -----------------------------------------------------

type exportImportParams struct {
	Data json.RawMessage `json:"data"`
}

func (s *WSServer) handleExportImport(wconn Responder, req jsonrpcRequest) {
	var params exportImportParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: data required"})
		return
	}

	var data export.ConfigExport
	if err := json.Unmarshal(params.Data, &data); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: data must be a ConfigExport"})
		return
	}

	// Domain restore operation — owner: the restore's own commit interval,
	// not this connection (see internal/export/restore.go, which documents
	// the commit point and its rollback). Profiles, groups and settings
	// commit as one operation; the transport never sequences the stores
	// itself, and never cancels across the boundary. Closing event:
	// RestoreImport returning after commit-or-rollback.
	result, err := export.RestoreImport(context.Background(), s.buildRestoreDeps(), &data, nil)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(result))
}

// exportImportPortableParams is decoded from the export.importPortable RPC payload.
type exportImportPortableParams struct {
	Payload    string `json:"payload"` // base64-encoded encrypted blob
	Passphrase string `json:"passphrase"`
}

func (s *WSServer) handleExportImportPortable(wconn Responder, req jsonrpcRequest) {
	var params exportImportPortableParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Payload == "" || params.Passphrase == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: payload (base64) and passphrase required"})
		return
	}

	payload, err := base64.StdEncoding.DecodeString(params.Payload)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: payload must be base64"})
		return
	}

	enc := &export.PortableEncryptedExport{Payload: payload}
	plain, err := export.DecryptPortableExport(enc, params.Passphrase)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: "Decryption failed: wrong passphrase or corrupted data"})
		return
	}

	// Domain restore operation — owner: the restore's own commit interval
	// (see internal/export/restore.go). Profiles, groups, settings and
	// private content commit as ONE operation with a defined rollback. The
	// transport does not sequence the stores — a failure between two
	// independently sequenced phases would leave them at different
	// generations — and never cancels across the commit point. The
	// closing event is RestoreImport returning after commit-or-rollback.
	result, err := export.RestoreImport(context.Background(), s.buildRestoreDeps(), &plain.Config, plain.Private)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(result))
}

// buildRestoreDeps assembles the restore operation's dependencies: the
// profile service for the atomic configuration write and its rollback, the
// settings provider+sink pair from the same registry, and the content
// database for the private block. The secret store is deliberately absent —
// no import mode may resolve a secret (ADR-0011 §2, §7).
func (s *WSServer) buildRestoreDeps() export.RestoreDeps {
	deps := export.RestoreDeps{
		ProfileSvc: s.profileSvc,
		Content:    s.exportContentDB,
	}
	if s.settings != nil {
		deps.Settings = &settingsProviderAdapter{reg: s.settings}
		deps.Sink = &settingsSinkAdapter{reg: s.settings}
	}
	return deps
}

// buildConfigExportDeps assembles a ConfigExportDeps from the wired
// repositories and settings adapter. The secret store is deliberately
// absent — no export mode may resolve a secret (ADR-0011 §2, §7).
func (s *WSServer) buildConfigExportDeps() export.ConfigExportDeps {
	deps := export.ConfigExportDeps{
		Profiles: s.profiles,
		Groups:   s.groups,
	}
	if s.settings != nil {
		deps.Settings = &settingsProviderAdapter{reg: s.settings}
	}
	return deps
}
