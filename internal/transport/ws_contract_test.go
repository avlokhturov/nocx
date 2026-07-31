package transport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/shady2k/nocx/internal/vault"
)

// contractDir holds the wire schemas. Deliberately not under internal/: the
// renderer generates its types from these files, and a contract only binds if
// it belongs to neither party.
const contractDir = "../../contracts"

func loadSchema(t *testing.T, name string) *jsonschema.Schema {
	t.Helper()
	path := filepath.Join(contractDir, filepath.Base(name))
	f, openErr := os.Open(path) //nolint:gosec // a test-only path under contracts/
	if openErr != nil {
		t.Fatalf("open %s: %v", path, openErr)
	}
	defer func() { _ = f.Close() }()

	doc, parseErr := jsonschema.UnmarshalJSON(f)
	if parseErr != nil {
		t.Fatalf("parse %s: %v", path, parseErr)
	}
	c := jsonschema.NewCompiler()
	if addErr := c.AddResource(name, doc); addErr != nil {
		t.Fatalf("add %s: %v", name, addErr)
	}
	s, err := c.Compile(name)
	if err != nil {
		t.Fatalf("compile %s: %v", name, err)
	}
	return s
}

// validateJSON checks raw against the schema. Takes bytes rather than a Go
// value so it can be handed a real JSON-RPC `result` straight off the socket.
func validateJSON(t *testing.T, s *jsonschema.Schema, raw []byte, what string) {
	t.Helper()
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("%s: unmarshal: %v", what, err)
	}
	if err := s.Validate(doc); err != nil {
		t.Errorf("%s does not satisfy its contract:\n%v\n\npayload was:\n%s", what, err, raw)
	}
}

// ── vault.status ───────────────────────────────────────────────────────

// The DTO's own conformance: field tags, omitempty behaviour, how a pointer
// renders, whether an enum value spells what the schema says. Cheap, fast, and
// it is NOT the test that catches a missing field — see the WebSocket test
// below for that, and the comment there for why.
func TestVaultStatus_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "vault.status.schema.json")

	cases := map[string]vault.Snapshot{
		// Everything populated, including the fields with omitempty — those are
		// exactly the ones a sparse payload hides.
		"populated": {
			State:           vault.StateUnsealed,
			HasOSKey:        true,
			OSKeyCapable:    true,
			HasPassphrase:   true,
			AutoSealMinutes: 15,
			DefaultProvider: "file",
			Providers: []vault.ProviderSnapshot{
				{ID: "system", Writable: true, Ready: false, Reason: vault.ReasonNoService},
				{ID: "file", Writable: true, Ready: true},
			},
		},
		// The state a fresh install is actually in. `defaultProvider` must be
		// null here and `providers` must be [] rather than null — an empty
		// inventory arriving as null was already a shipped defect once
		// (nocx-25k9.14), and the schema is where that stops being possible.
		"uninitialized": {
			State:           vault.StateUninitialized,
			DefaultProvider: "",
			Providers:       nil,
		},
	}

	for name, snap := range cases {
		t.Run(name, func(t *testing.T) {
			raw, err := json.Marshal(vaultSnapToStatus(snap))
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			validateJSON(t, schema, raw, "vault.status DTO")
		})
	}
}

// The test that would have caught it.
//
// `vault.status` shipped without `defaultProvider` while the renderer read that
// field on every render, so the Vault page could not mark which store new
// secrets go to. Both suites were green: the Go tests decoded the result into
// anonymous structs naming only the fields under test — and a field nobody
// names is a field whose absence nobody notices — while the renderer's tests
// mocked the client with fixtures written FROM the interface, so they contained
// the field because the renderer wanted it, not because anything sent it.
//
// This drives the real handler through the real socket and validates the actual
// `result` bytes. Nothing here names a field, so nothing here can omit one:
// `additionalProperties: false` plus `required` in the schema is what makes the
// key set exact in both directions (nocx-nfld.5).
func TestVaultStatus_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "vault.status.schema.json")

	fake := newFakeVaultLifecycle()
	fake.snap.DefaultProvider = "file"
	ws, stop := newVaultWSServer(t, fake)
	defer stop()

	conn := connectWS(t, ws)
	resp := vaultCall(t, conn, "vault.status", map[string]any{}, 1)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	if resp.Result == nil {
		t.Fatal("expected a result")
	}

	validateJSON(t, schema, resp.Result, "vault.status result")
}
