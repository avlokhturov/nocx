package transport

// The delivery planner's behaviour (nocx-mlm7 P7): fresh environment id per
// attempt, the oracle seeing the typed argv, a failed oracle refusing the
// rewrite (nocx-qwhp), the installed fact choosing the compact line, and the
// observation RPC writing and invalidating that fact. The resolver stub here
// records the exact argv so "the typed line reached the oracle" is asserted,
// not assumed.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/shellintegration"
	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/storage"
)

// launcherTestResolver is a stub ssh.ConfigResolver for the planner tests:
// it records the oracle argv verbatim, resolves the destination positional
// against a static map, and can be told to fail (a failed or unavailable
// oracle) or to answer with a RemoteCommand.
type launcherTestResolver struct {
	entries  map[string]ssh.HostConfig
	lastArgv []string
	fail     bool
}

func newLauncherTestResolver() *launcherTestResolver {
	return &launcherTestResolver{entries: make(map[string]ssh.HostConfig)}
}

func (r *launcherTestResolver) add(host string, cfg ssh.HostConfig) { r.entries[host] = cfg }

func (r *launcherTestResolver) ResolveHost(_ context.Context, host string) (string, error) {
	if e, ok := r.entries[host]; ok && e.HostName != "" {
		return e.HostName, nil
	}
	return host, nil
}

func (r *launcherTestResolver) ResolveConfig(_ context.Context, host string) (*ssh.HostConfig, error) {
	if r.fail {
		return nil, ssh.ErrSSHConfigFailed
	}
	if e, ok := r.entries[host]; ok {
		cfg := e
		return &cfg, nil
	}
	return &ssh.HostConfig{HostName: host, User: "testuser", Port: 22}, nil
}

// ResolveArgv records the exact argv and resolves the destination positional.
// The typed options themselves are ignored for the answer — the stub has no
// getopt semantics — which is exactly why the argv is recorded: tests assert
// the typed line reached the oracle, and seed the answer for the destination.
func (r *launcherTestResolver) ResolveArgv(_ context.Context, argv []string) (*ssh.HostConfig, error) {
	r.lastArgv = append([]string(nil), argv...)
	if r.fail {
		return nil, ssh.ErrSSHConfigFailed
	}
	if len(argv) == 0 {
		return nil, ssh.ErrSSHConfigFailed
	}
	return r.ResolveConfig(context.Background(), argv[len(argv)-1])
}

// plannerHarness builds a WSServer with the planner's seams: the real
// launcher and stager, the stub resolver, and a real fact store over a
// disposable document store.
func plannerHarness(t *testing.T) (*WSServer, *launcherTestResolver, *ssh.InstalledFactStore) {
	t.Helper()
	ctx := context.Background()
	resolver := newLauncherTestResolver()
	facts := ssh.NewInstalledFactStore(
		log.NewSlogAdapter(nil), storage.NewDocumentStore(t.TempDir()), "installed-facts.json")
	ws := NewWSServer(
		log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithRemoteLauncher(&realRemoteLauncher{}),
		WithLauncherStager(shellintegration.NewLauncherStager(log.NewSlogAdapter(nil), t.TempDir())),
		WithSSHConfigResolver(resolver, "/nonexistent/config"),
		WithInstalledFactStore(facts),
	)
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	return ws, resolver, facts
}

// plannerTestIdentity is the identity the stub's default answer resolves to
// for a destination named "testhost".
const plannerTestIdentity = "testuser@testhost:22"

func observe(t *testing.T, conn *websocket.Conn, id int, envID string, passport *observedPassport) environmentObservedResult {
	t.Helper()
	resp := vaultCall(t, conn, "shell.environmentObserved", map[string]any{
		"environmentId": envID,
		"passport":      passport,
	}, id)
	if resp.Error != nil {
		t.Fatalf("shell.environmentObserved: %+v", resp.Error)
	}
	var got environmentObservedResult
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got
}

func acceptedPassport(envID string) *observedPassport {
	return &observedPassport{
		ProtocolVersion:     "1",
		EnvironmentID:       envID,
		ParentEnvironmentID: "-",
		ScriptVersion:       "0.6.0",
		Tier:                "enhanced",
		Generation:          "v10",
	}
}

// TestShellLauncherCommand_FailedOracleRefuses (nocx-qwhp): a failed oracle
// must refuse the rewrite — the typed bytes go to the pty, never a rewrite
// built on a guess.
func TestShellLauncherCommand_FailedOracleRefuses(t *testing.T) {
	ws, resolver, _ := plannerHarness(t)
	resolver.fail = true
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	got := launcherCommandCall(t, conn, sid, 2)
	if got.Mode != launcherModeRaw {
		t.Errorf("mode = %q, want raw — a failed oracle must refuse the rewrite", got.Mode)
	}
	if got.LauncherPath != nil {
		t.Errorf("launcherPath = %q, want nil", *got.LauncherPath)
	}
	if got.Reason == nil || *got.Reason != "oracle-failed" {
		t.Errorf("reason = %v, want oracle-failed", got.Reason)
	}
	if got.EnvironmentID == "" {
		t.Error("a refusal still carries a per-attempt environmentId")
	}
}

// TestShellLauncherCommand_RemoteCommandRefuses: the resolved config sets
// RemoteCommand, so no rewrite (ADR-0015).
func TestShellLauncherCommand_RemoteCommandRefuses(t *testing.T) {
	ws, resolver, _ := plannerHarness(t)
	resolver.add("testhost", ssh.HostConfig{HostName: "testhost", User: "testuser", Port: 22, RemoteCommand: "top -d 1"})
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	got := launcherCommandCall(t, conn, sid, 2)
	if got.Mode != launcherModeRaw || got.Reason == nil || *got.Reason != "remote-command" {
		t.Errorf("got mode=%q reason=%v, want raw/remote-command", got.Mode, got.Reason)
	}
}

// TestShellLauncherCommand_OracleSeesTypedArgv: the -p/-F/-o/-l/-J typed on
// the line reach the ssh -G oracle verbatim (nocx-c5az).
func TestShellLauncherCommand_OracleSeesTypedArgv(t *testing.T) {
	ws, resolver, _ := plannerHarness(t)
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	argv := []string{"ssh", "-G", "-o", "ServerAliveInterval=5", "-p", "2222", "pi@testhost"}
	resp := vaultCall(t, conn, "shell.launcherCommand", map[string]any{
		"sessionId":  sid,
		"oracleArgv": argv,
	}, 2)
	if resp.Error != nil {
		t.Fatalf("shell.launcherCommand: %+v", resp.Error)
	}
	if len(resolver.lastArgv) != len(argv) {
		t.Fatalf("oracle argv = %v, want the typed argv verbatim", resolver.lastArgv)
	}
	for i := range argv {
		if resolver.lastArgv[i] != argv[i] {
			t.Errorf("oracle argv[%d] = %q, want %q — the typed options must reach ssh -G", i, resolver.lastArgv[i], argv[i])
		}
	}
}

// TestShellLauncherCommand_InstalledMode: a fact that says installed and
// protocol-compatible chooses the compact line — no staging, no launcher.
func TestShellLauncherCommand_InstalledMode(t *testing.T) {
	ws, _, facts := plannerHarness(t)
	if err := facts.Record(ssh.InstalledFact{
		Identity: plannerTestIdentity, Protocol: expectedInstalledProtocol,
		ScriptVersion: "0.6.0", Generation: "v10",
	}); err != nil {
		t.Fatalf("seed fact: %v", err)
	}
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	got := launcherCommandCall(t, conn, sid, 2)
	if got.Mode != launcherModeInstalled {
		t.Errorf("mode = %q, want installed when the fact is present and compatible", got.Mode)
	}
	if got.LauncherPath != nil {
		t.Errorf("launcherPath = %q, want nil for the compact line", *got.LauncherPath)
	}
	if got.Reason != nil {
		t.Errorf("reason = %v, want nil", *got.Reason)
	}
	if got.EnvironmentID == "" {
		t.Error("installed mode still mints a per-attempt environmentId")
	}
}

// TestShellLauncherCommand_ProtocolMismatchBootstraps: a fact whose protocol
// is not the one this product speaks must not choose the compact line —
// anything else bootstraps.
func TestShellLauncherCommand_ProtocolMismatchBootstraps(t *testing.T) {
	ws, _, facts := plannerHarness(t)
	if err := facts.Record(ssh.InstalledFact{
		Identity: plannerTestIdentity, Protocol: "2",
		ScriptVersion: "0.9.0", Generation: "v99",
	}); err != nil {
		t.Fatalf("seed fact: %v", err)
	}
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	got := launcherCommandCall(t, conn, sid, 2)
	if got.Mode != launcherModeBootstrap {
		t.Errorf("mode = %q, want bootstrap for a protocol-incompatible fact", got.Mode)
	}
}

// TestShellLauncherCommand_FactKeyedByResolvedIdentity: two typed lines that
// resolve to the same destination share one installed fact (ADR-0015
// narrowing) — the fact is keyed by the ssh -G answer, not the hostname.
func TestShellLauncherCommand_FactKeyedByResolvedIdentity(t *testing.T) {
	ws, resolver, facts := plannerHarness(t)
	// Two aliases that both resolve to 10.0.0.1: one identity.
	resolver.add("hostA", ssh.HostConfig{HostName: "10.0.0.1", User: "testuser", Port: 22})
	resolver.add("hostB", ssh.HostConfig{HostName: "10.0.0.1", User: "testuser", Port: 22})
	if err := facts.Record(ssh.InstalledFact{
		Identity: "testuser@10.0.0.1:22", Protocol: expectedInstalledProtocol,
		ScriptVersion: "0.6.0", Generation: "v10",
	}); err != nil {
		t.Fatalf("seed fact: %v", err)
	}
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	for _, host := range []string{"hostA", "hostB"} {
		resp := vaultCall(t, conn, "shell.launcherCommand", map[string]any{
			"sessionId":  sid,
			"oracleArgv": []string{"ssh", "-G", host},
		}, 2)
		if resp.Error != nil {
			t.Fatalf("shell.launcherCommand %s: %+v", host, resp.Error)
		}
		var got shellLauncherCommandResult
		if err := json.Unmarshal(resp.Result, &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.Mode != launcherModeInstalled {
			t.Errorf("%s: mode = %q, want installed — the fact must be keyed by the resolved identity, not the typed host", host, got.Mode)
		}
	}
}

// TestShellEnvironmentObserved_PassportWritesFact: an accepted passport for
// a bootstrap attempt durably records the fact, and the NEXT connection
// takes the compact line.
func TestShellEnvironmentObserved_PassportWritesFact(t *testing.T) {
	ws, _, facts := plannerHarness(t)
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	first := launcherCommandCall(t, conn, sid, 2)
	if first.Mode != launcherModeBootstrap {
		t.Fatalf("first attempt mode = %q, want bootstrap", first.Mode)
	}

	got := observe(t, conn, 3, first.EnvironmentID, acceptedPassport(first.EnvironmentID))
	if !got.Processed || !got.FactUpdated {
		t.Errorf("observation = %+v, want processed+factUpdated", got)
	}
	if f, ok := facts.Get(plannerTestIdentity); !ok {
		t.Error("the accepted passport did not record the installed fact")
	} else if f.Generation != "v10" || f.Protocol != "1" {
		t.Errorf("fact = %+v, want the passport's values preserved", f)
	}

	second := launcherCommandCall(t, conn, sid, 4)
	if second.Mode != launcherModeInstalled {
		t.Errorf("second attempt mode = %q, want installed after the fact was recorded", second.Mode)
	}
}

// TestShellEnvironmentObserved_NoPassportInvalidates: a connection that
// expected installed-script and produced no passport invalidates the fact —
// the host whose bundle rotted bootstraps again.
func TestShellEnvironmentObserved_NoPassportInvalidates(t *testing.T) {
	ws, _, facts := plannerHarness(t)
	if err := facts.Record(ssh.InstalledFact{
		Identity: plannerTestIdentity, Protocol: expectedInstalledProtocol,
		ScriptVersion: "0.6.0", Generation: "v10",
	}); err != nil {
		t.Fatalf("seed fact: %v", err)
	}
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	first := launcherCommandCall(t, conn, sid, 2)
	if first.Mode != launcherModeInstalled {
		t.Fatalf("first attempt mode = %q, want installed", first.Mode)
	}

	got := observe(t, conn, 3, first.EnvironmentID, nil)
	if !got.Processed || !got.FactUpdated {
		t.Errorf("no-passport observation = %+v, want processed+factUpdated", got)
	}
	if _, ok := facts.Get(plannerTestIdentity); ok {
		t.Error("the installed fact survived a no-passport observation")
	}

	second := launcherCommandCall(t, conn, sid, 4)
	if second.Mode != launcherModeBootstrap {
		t.Errorf("second attempt mode = %q, want bootstrap after invalidation", second.Mode)
	}
}

// TestShellEnvironmentObserved_UnknownID: a report for an id the backend
// never minted is processed=false and writes nothing.
func TestShellEnvironmentObserved_UnknownID(t *testing.T) {
	ws, _, facts := plannerHarness(t)
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	openSessionForLauncher(t, conn)

	got := observe(t, conn, 2, "00000000000000000000000000000000", acceptedPassport("00000000000000000000000000000000"))
	if got.Processed {
		t.Errorf("unknown environmentId reported processed=true; want false")
	}
	if got.FactUpdated {
		t.Errorf("unknown environmentId reported factUpdated=true; want false")
	}
	if _, ok := facts.Get(plannerTestIdentity); ok {
		t.Error("a foreign observation wrote a fact")
	}
}

// TestShellEnvironmentObserved_RawAttemptNeverWritesFact: a refusal (raw)
// cannot record a fact — a passport observed in a raw session changes nothing.
func TestShellEnvironmentObserved_RawAttemptNeverWritesFact(t *testing.T) {
	ws, resolver, facts := plannerHarness(t)
	resolver.add("testhost", ssh.HostConfig{HostName: "testhost", User: "testuser", Port: 22, RemoteCommand: "top"})
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	refused := launcherCommandCall(t, conn, sid, 2)
	if refused.Mode != launcherModeRaw {
		t.Fatalf("mode = %q, want raw", refused.Mode)
	}
	got := observe(t, conn, 3, refused.EnvironmentID, acceptedPassport(refused.EnvironmentID))
	if !got.Processed {
		t.Errorf("processed = false for a live raw attempt; want true (the report matched, the fact must stay untouched)")
	}
	if got.FactUpdated {
		t.Errorf("factUpdated = true for a raw attempt; a raw session must never write a fact")
	}
	if _, ok := facts.Get(plannerTestIdentity); ok {
		t.Error("a raw attempt recorded an installed fact")
	}
}

// TestShellEnvironmentObserved_DuplicateIsIdempotent: the first observation
// decides an attempt; a duplicate cannot regress the written fact.
func TestShellEnvironmentObserved_DuplicateIsIdempotent(t *testing.T) {
	ws, _, facts := plannerHarness(t)
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	first := launcherCommandCall(t, conn, sid, 2)
	got := observe(t, conn, 3, first.EnvironmentID, acceptedPassport(first.EnvironmentID))
	if !got.Processed || !got.FactUpdated {
		t.Fatalf("first observation = %+v, want processed+factUpdated", got)
	}
	dup := observe(t, conn, 4, first.EnvironmentID, acceptedPassport(first.EnvironmentID))
	if !dup.Processed || dup.FactUpdated {
		t.Errorf("duplicate observation = %+v, want processed but no fact update", dup)
	}
	if f, ok := facts.Get(plannerTestIdentity); !ok || f.Generation != "v10" {
		t.Errorf("fact = %+v (ok=%v), want the first observation's values intact", f, ok)
	}
}

// TestShellEnvironmentObserved_MalformedPassport: the observation RPC is the
// write boundary of the fact store and rejects a partial or hostile passport.
func TestShellEnvironmentObserved_MalformedPassport(t *testing.T) {
	ws, _, _ := plannerHarness(t)
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()
	sid := openSessionForLauncher(t, conn)

	first := launcherCommandCall(t, conn, sid, 2)
	bad := acceptedPassport(first.EnvironmentID)
	bad.Tier = "turbo"
	resp := vaultCall(t, conn, "shell.environmentObserved", map[string]any{
		"environmentId": first.EnvironmentID,
		"passport":      bad,
	}, 3)
	if resp.Error == nil || resp.Error.Code != -32602 {
		t.Fatalf("unknown tier: got %+v, want -32602", resp.Error)
	}

	mismatch := acceptedPassport(first.EnvironmentID)
	mismatch.EnvironmentID = "another-id"
	resp = vaultCall(t, conn, "shell.environmentObserved", map[string]any{
		"environmentId": first.EnvironmentID,
		"passport":      mismatch,
	}, 4)
	if resp.Error == nil || resp.Error.Code != -32602 {
		t.Fatalf("mismatched passport id: got %+v, want -32602", resp.Error)
	}

	resp = vaultCall(t, conn, "shell.environmentObserved", map[string]any{}, 5)
	if resp.Error == nil || resp.Error.Code != -32602 {
		t.Fatalf("missing params: got %+v, want -32602", resp.Error)
	}
}
