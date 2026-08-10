package transport

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/shellintegration"
)

// capStubBootstrapper returns a plan that carries a per-epoch capability —
// the state the composition root's wiring will produce once it mints the
// domain and passes the channel config. The real handler must not route it
// into the result.
type capStubBootstrapper struct{}

func (capStubBootstrapper) InBandBootstrap(sessionID string, ch *shellintegration.ChannelConfig) (shellintegration.InBandPlan, error) {
	_ = ch
	return shellintegration.InBandPlan{
		Wrapper:    "saved=$(stty -g); printf wrapper",
		Payload:    "# nocx in-band integration — dispatcher (POSIX sh).\n# nocx-ib-complete\n",
		Terminator: "NOCX_IB_EOF",
		Capability: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}, nil
}

// TestShellIntegrate_ResultNeverCarriesTheCapability proves ADR-0024
// decision 7's renderer boundary over the REAL socket: the real
// shell.integrate handler serves a plan whose Capability field is set (the
// backend-only delivery value), and the JSON-RPC result that crosses the
// WebSocket contains no trace of it — not as a field, not as a value in
// wrapper/payload/terminator.
func TestShellIntegrate_ResultNeverCarriesTheCapability(t *testing.T) {
	ctx := context.Background()
	ws := NewWSServer(
		log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithInBandBootstrapper(capStubBootstrapper{}),
	)
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Open a local session so shell.integrate's server-authoritative id
	// check passes (AD-7).
	openResp := vaultCall(t, conn, "open", map[string]any{
		"cols": 80, "rows": 24, "xpixel": 0, "ypixel": 0,
	}, 1)
	openResult := openResp.Result
	if openResult == nil {
		t.Fatalf("open failed: %+v", openResp)
	}
	var open struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(openResult, &open); err != nil || open.SessionID == "" {
		t.Fatalf("open did not return a session id: %s", openResult)
	}

	resp := vaultCall(t, conn, "shell.integrate", map[string]any{
		"sessionId": open.SessionID,
	}, 2)
	if resp.Error != nil {
		t.Fatalf("shell.integrate failed: %+v", resp.Error)
	}
	var out map[string]any
	if err := json.Unmarshal(resp.Result, &out); err != nil {
		t.Fatalf("shell.integrate result unparseable: %s", resp.Result)
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	// The capability must not appear anywhere in the result: not as a key,
	// not as a value, not inside wrapper/payload/terminator text.
	if strings.Contains(string(raw), "capability") {
		t.Errorf("result carries a capability key: %s", raw)
	}
	if strings.Contains(string(raw), "0123456789abcdef") {
		t.Errorf("the per-epoch capability crossed the WebSocket in the result: %s", raw)
	}
	// The result is exactly the three renderer-visible fields (the schema's
	// additionalProperties:false would reject anything else, but the value
	// check above is the one that proves non-leakage).
	for _, want := range []string{"wrapper", "payload", "terminator"} {
		if _, ok := out[want]; !ok {
			t.Errorf("result missing %q: %s", want, raw)
		}
	}
}

// TestShellIntegrateResultFromPlan_DropsCapability is the unit-level half:
// the field-by-field copy that builds the renderer-visible result omits
// InBandPlan.Capability even when it is set.
func TestShellIntegrateResultFromPlan_DropsCapability(t *testing.T) {
	plan := shellintegration.InBandPlan{
		Wrapper:    "w",
		Payload:    "p",
		Terminator: "t",
		Capability: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	raw, err := json.Marshal(shellIntegrateResultFromPlan(plan))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "0123456789abcdef") {
		t.Errorf("the field-by-field copy leaked the capability: %s", raw)
	}
}
