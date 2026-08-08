package transport

// vault.resolveLine — the backend half of the reference seam
// ({{secret:NAME}} in a command line). A line may carry references to vault
// secrets BY NAME — the name vault.inventory reports, which is the only
// identifier a person can type; the opaque sec:v1:... reference and the
// secrow:... row handle are both minted ids nobody should ever put in a
// line, and parsing the reference grammar is private to internal/vault
// (.internal/plans/2026-07-30-vault-v1.md).
//
// The result shape is declared once in contracts/vault.resolveLine.schema.json.
//
// The invariant, and the whole point of the method: the resolved value goes
// to the caller for the PTY write and nowhere else. history.record receives
// the line with the REFERENCE intact — a command carrying a reference moves
// to another machine and resolves that machine's secret; a command carrying
// a pasted key is both dead and dangerous. The value is never logged, never
// persisted, never put in a finding or a ref — the refs list carries only
// the name and whether it resolved.

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"

	"github.com/shady2k/nocx/internal/vault"
)

// vaultResolveLineParams is the request: the line to substitute references
// in. There is deliberately no params schema (contracts/README.md): the
// handler is the check.
type vaultResolveLineParams struct {
	Line string `json:"line"`
}

// vaultResolveLineRef is one reference in the line, reported so an
// unresolved name is never silently left as literal text. Name is the
// reference as written ({{secret:NAME}}); Resolved is false when the vault
// holds no secret with that name or its store did not answer — the caller
// must surface that instead of running the literal reference.
type vaultResolveLineRef struct {
	Name     string `json:"name"`
	Resolved bool   `json:"resolved"`
}

// vaultResolveLineResponse is the result of vault.resolveLine. Line is the
// substituted line — it may carry resolved secret values, and the caller
// must not persist it. Refs is never nil: no references is [].
type vaultResolveLineResponse struct {
	Line string                `json:"line"`
	Refs []vaultResolveLineRef `json:"refs"`
}

// resolveLineRefRE matches one {{secret:NAME}} reference. NAME is any text
// up to the closing braces — vault inventory names carry spaces ("SSH
// password for user@host:22"), so the grammar is deliberately permissive.
var resolveLineRefRE = regexp.MustCompile(`\{\{secret:(.+?)\}\}`)

func (s *WSServer) handleVaultResolveLine(ctx context.Context, wconn Responder, req jsonrpcRequest) {
	var p vaultResolveLineParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: params must be an object"})
		return
	}

	if s.profiles == nil || s.groups == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "vault.resolveLine not available"})
		return
	}

	// A line with no references is identity and an empty refs list; the
	// vault is not consulted for it.
	locs := resolveLineRefRE.FindAllStringSubmatchIndex(p.Line, -1)
	if len(locs) == 0 {
		_ = wconn.TryResult(req.ID, mustMarshal(vaultResolveLineResponse{
			Line: p.Line,
			Refs: []vaultResolveLineRef{},
		}))
		return
	}

	profiles, err := s.profiles.LoadProfiles()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	groups, err := s.groups.LoadGroups()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}

	inputs := s.vaultInventoryInputs(profiles, groups)

	// The inventory is the name → row map: NAME is resolved to the row
	// handle the way vault.inventory mints it, then to the SecretID through
	// the vault's own ResolveRow, then to the value through Vault.Get.
	// A sealed vault fails here with the actionable -32001/vault-sealed —
	// the caller has to be able to tell "unseal and retry" from "no such
	// secret", and a generic -32603 would not let it.
	entries, err := s.vaultLifecycle.BuildInventory(ctx, inputs)
	if err != nil {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.resolveLine: ", err))
		return
	}
	nameToRow := make(map[string]string, len(entries))
	for _, e := range entries {
		if _, exists := nameToRow[e.Name]; !exists {
			nameToRow[e.Name] = e.ID
		}
	}

	refs := make([]vaultResolveLineRef, 0, len(locs))
	// Substitute left to right over the original byte offsets: the refs
	// that resolve get their value spliced in, the ones that do not keep
	// their literal text so the caller can see exactly what did not work.
	out := make([]byte, 0, len(p.Line))
	out = append(out, p.Line[:locs[0][0]]...)
	for i, loc := range locs {
		name := p.Line[loc[2]:loc[3]]
		value, resolved, sealed := s.resolveVaultSecret(ctx, name, nameToRow, inputs)
		if sealed {
			// The vault sealed between inventory and read: the response
			// would be a lie, because a retry after unsealing resolves
			// differently. Surface the actionable error instead.
			_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.resolveLine: ", vault.ErrVaultSealed))
			return
		}
		refs = append(refs, vaultResolveLineRef{Name: name, Resolved: resolved})
		if resolved {
			out = append(out, value...)
		} else {
			out = append(out, p.Line[loc[0]:loc[1]]...)
		}
		if i+1 < len(locs) {
			out = append(out, p.Line[loc[1]:locs[i+1][0]]...)
		} else {
			out = append(out, p.Line[loc[1]:]...)
		}
	}

	_ = wconn.TryResult(req.ID, mustMarshal(vaultResolveLineResponse{
		Line: string(out),
		Refs: refs,
	}))
}

// resolveVaultSecret maps name → row handle → SecretID → value. sealed is
// true only when the vault sealed mid-flight (an actionable state, distinct
// from "no such secret"); resolved is false for an unknown name or a store
// that did not answer, and the caller reports that ref as unresolved.
func (s *WSServer) resolveVaultSecret(ctx context.Context, name string, nameToRow map[string]string, inputs []vault.CredentialInventory) (value string, resolved bool, sealed bool) {
	row, ok := nameToRow[name]
	if !ok {
		return "", false, false
	}
	id, ok := s.vaultLifecycle.ResolveRow(row, inputs)
	if !ok {
		return "", false, false
	}
	secret, err := s.vaultLifecycle.Get(ctx, id)
	if err != nil {
		return "", false, errors.Is(err, vault.ErrVaultSealed)
	}
	var valueBuf []byte
	if useErr := secret.Use(func(b []byte) error {
		valueBuf = append([]byte(nil), b...)
		return nil
	}); useErr != nil {
		return "", false, false
	}
	value = string(valueBuf)
	clear(valueBuf)
	return value, true, false
}
