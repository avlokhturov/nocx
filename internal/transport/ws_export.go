package transport

import (
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

// --- export.* control-plane handlers ------------------------------------

// handleExportMethod dispatches export.* RPCs.
// All export modes work purely through the profile/group/credential-metadata
// repositories and storage paths — the credential.CredentialStore is never
// consulted, so no mode can resolve a secret (ADR-0011 §2, §7).
func (s *WSServer) handleExportMethod(wconn *wsConn, req jsonrpcRequest) {
	if s.profiles == nil || s.groups == nil || s.credMeta == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "profiles not available"))
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
		s.handleExportBackup(wconn, req)
	case "export.import":
		s.handleExportImport(wconn, req)
	case "export.importPortable":
		s.handleExportImportPortable(wconn, req)
	default:
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "Method not found"))
	}
}

// --- export.manifest ---------------------------------------------------

type exportManifestParams struct {
	Mode string `json:"mode"`
}

func (s *WSServer) handleExportManifest(wconn *wsConn, req jsonrpcRequest) {
	var params exportManifestParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Mode == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: mode required"))
		return
	}
	m := export.ManifestFor(export.Mode(params.Mode))
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(m)))
}

// --- export.configExport -----------------------------------------------

func (s *WSServer) handleExportConfig(wconn *wsConn, req jsonrpcRequest) {
	deps := s.buildConfigExportDeps()
	result, err := export.ExportConfiguration(deps)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(result)))
}

// --- export.portableEncrypted ------------------------------------------

type exportPortableEncryptedParams struct {
	Passphrase            string `json:"passphrase"`
	IncludePrivateContent bool   `json:"includePrivateContent,omitempty"`
}

func (s *WSServer) handleExportPortableEncrypted(wconn *wsConn, req jsonrpcRequest) {
	var params exportPortableEncryptedParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Passphrase == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: passphrase required"))
		return
	}

	deps := export.PortableEncryptedDeps{
		ConfigExport: s.buildConfigExportDeps(),
		ContentDB:    s.exportContentDB,
	}

	result, err := export.ExportPortableEncrypted(deps, params.Passphrase, params.IncludePrivateContent)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(result)))
}

// --- export.backup -----------------------------------------------------

func (s *WSServer) handleExportBackup(wconn *wsConn, req jsonrpcRequest) {
	if s.exportPaths == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "backup not available (paths not wired)"))
		return
	}
	deps := export.BackupDeps{Paths: s.exportPaths}
	result, err := export.Backup(deps)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(result)))
}

// --- export.import -----------------------------------------------------

type exportImportParams struct {
	Data json.RawMessage `json:"data"`
}

func (s *WSServer) handleExportImport(wconn *wsConn, req jsonrpcRequest) {
	var params exportImportParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: data required"))
		return
	}

	var data export.ConfigExport
	if err := json.Unmarshal(params.Data, &data); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: data must be a ConfigExport"))
		return
	}

	deps := export.ImportDeps{
		Profiles:    s.profiles,
		Groups:      s.groups,
		Credentials: s.credMeta,
	}

	result, err := export.ImportConfiguration(deps, &data)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(result)))
}

// --- export.importPortable ---------------------------------------------

type exportImportPortableParams struct {
	Payload    string `json:"payload"` // base64-encoded encrypted blob
	Passphrase string `json:"passphrase"`
}

func (s *WSServer) handleExportImportPortable(wconn *wsConn, req jsonrpcRequest) {
	var params exportImportPortableParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Payload == "" || params.Passphrase == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: payload (base64) and passphrase required"))
		return
	}

	payload, err := base64.StdEncoding.DecodeString(params.Payload)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: payload must be base64"))
		return
	}

	enc := &export.PortableEncryptedExport{Payload: payload}
	plain, err := export.DecryptPortableExport(enc, params.Passphrase)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "Decryption failed: wrong passphrase or corrupted data"))
		return
	}

	deps := export.ImportDeps{
		Profiles:    s.profiles,
		Groups:      s.groups,
		Credentials: s.credMeta,
	}

	result, err := export.ImportConfiguration(deps, &plain.Config)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(result)))
}

// --- helpers ------------------------------------------------------------

// buildConfigExportDeps assembles a ConfigExportDeps from the wired
// repositories and settings adapter. The credential.CredentialStore is
// deliberately absent — no export mode may resolve a secret
// (ADR-0011 §2, §7).
func (s *WSServer) buildConfigExportDeps() export.ConfigExportDeps {
	deps := export.ConfigExportDeps{
		Profiles:    s.profiles,
		Groups:      s.groups,
		Credentials: s.credMeta,
	}
	if s.settings != nil {
		deps.Settings = &settingsProviderAdapter{reg: s.settings}
	}
	return deps
}
