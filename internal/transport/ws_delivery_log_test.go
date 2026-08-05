package transport

// The delivery-path log contract (P0 observability): every decision the
// backend makes on the delivery path is one findable INFO line with its
// fields — the launcherCommand request, the ssh -G verdict (a refusal
// naming its REASON as a value, never prose), the chosen mode and why, the
// observation status (accepted/unexpected/ignored/none), and the
// installed-fact write or invalidation. These tests capture the real
// WSServer's log through a JSON handler and assert, per scenario, that
// each decision emitted its line with its fields.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/shellintegration"
	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/storage"
)

// capturePlannerHarness builds the planner's WSServer with a JSON log
// capture, so a test can assert what the delivery path logged, field by
// field.
func capturePlannerHarness(t *testing.T) (*WSServer, *launcherTestResolver, *ssh.InstalledFactStore, *bytes.Buffer) {
	t.Helper()
	ctx := context.Background()
	resolver := newLauncherTestResolver()
	facts := ssh.NewInstalledFactStore(
		log.NewSlogAdapter(nil), storage.NewDocumentStore(t.TempDir()), "installed-facts.json")
	var buf bytes.Buffer
	ws := NewWSServer(
		log.NewSlogAdapter(slog.New(slog.NewJSONHandler(&buf, nil))), newRegWithStub(log.NewSlogAdapter(nil)),
		WithRemoteLauncher(&realRemoteLauncher{}),
		WithLauncherStager(shellintegration.NewLauncherStager(log.NewSlogAdapter(nil), t.TempDir())),
		WithSSHConfigResolver(resolver, "/nonexistent/config"),
		WithInstalledFactStore(facts),
	)
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	return ws, resolver, facts, &buf
}

// logRecord is one decoded JSON log line: the message plus its fields.
type logRecord struct {
	msg    string
	fields map[string]any
}

func captureRecords(t *testing.T, buf *bytes.Buffer) []logRecord {
	t.Helper()
	var out []logRecord
	for _, line := range strings.Split(buf.String(), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("captured log line is not JSON: %q", line)
		}
		msg, _ := m["msg"].(string)
		delete(m, "time")
		delete(m, "level")
		delete(m, "msg")
		out = append(out, logRecord{msg: msg, fields: m})
	}
	return out
}

// wantLine asserts one decision line: the message appears and carries the
// named fields with the given values; present names fields that must exist
// with any value (the minted environment id, which is per-attempt random).
type wantLine struct {
	msg     string
	fields  map[string]any
	present []string
}

func assertLogLines(t *testing.T, records []logRecord, want []wantLine) {
	t.Helper()
	for _, w := range want {
		found := false
		for _, r := range records {
			if r.msg != w.msg {
				continue
			}
			matches := true
			for k, v := range w.fields {
				got, ok := r.fields[k]
				if !ok || got != v {
					matches = false
					break
				}
			}
			for _, k := range w.present {
				if _, ok := r.fields[k]; !ok {
					matches = false
					break
				}
			}
			if matches {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no log line %q with fields %v (present %v); captured:\n%s",
				w.msg, w.fields, w.present, formatRecords(records))
		}
	}
}

func formatRecords(records []logRecord) string {
	var b strings.Builder
	for _, r := range records {
		fields, _ := json.Marshal(r.fields)
		b.WriteString("  " + r.msg + " " + string(fields) + "\n")
	}
	return b.String()
}

func TestDeliveryPathLogsEveryDecision(t *testing.T) {
	rows := []struct {
		name string
		// seed prepares the resolver and fact store for the scenario.
		seed func(resolver *launcherTestResolver, facts *ssh.InstalledFactStore) error
		// act performs the RPC calls that produce the decisions; it may
		// return the minted environmentId the scenario observed.
		act  func(t *testing.T, conn *websocket.Conn, sid string) string
		want []wantLine
	}{
		{
			name: "installed mode chosen from the fact",
			seed: func(_ *launcherTestResolver, facts *ssh.InstalledFactStore) error {
				return facts.Record(ssh.InstalledFact{
					Identity: plannerTestIdentity, Protocol: expectedInstalledProtocol,
					ScriptVersion: "0.6.0", Generation: "v10",
				})
			},
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				launcherCommandCall(t, conn, sid, 2)
				return ""
			},
			want: []wantLine{
				{
					msg:     "shell.launcherCommand called",
					fields:  map[string]any{"destination": "testhost"},
					present: []string{"environmentId"},
				},
				{
					msg:    "shell.launcherCommand oracle verdict",
					fields: map[string]any{"ok": true, "identity": plannerTestIdentity, "remoteCommand": false},
				},
				{
					msg:    "shell.launcherCommand mode decided",
					fields: map[string]any{"mode": "installed", "reason": "installed-fact", "identity": plannerTestIdentity},
				},
			},
		},
		{
			name: "bootstrap mode when no fact",
			seed: func(_ *launcherTestResolver, _ *ssh.InstalledFactStore) error { return nil },
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				launcherCommandCall(t, conn, sid, 2)
				return ""
			},
			want: []wantLine{
				{
					msg:     "shell.launcherCommand called",
					fields:  map[string]any{"destination": "testhost"},
					present: []string{"environmentId"},
				},
				{
					msg:    "shell.launcherCommand oracle verdict",
					fields: map[string]any{"ok": true, "identity": plannerTestIdentity},
				},
				{
					msg:    "shell.launcherCommand mode decided",
					fields: map[string]any{"mode": "bootstrap", "reason": "no-installed-fact", "identity": plannerTestIdentity},
				},
			},
		},
		{
			name: "failed oracle refuses and names its reason",
			seed: func(resolver *launcherTestResolver, _ *ssh.InstalledFactStore) error {
				resolver.fail = true
				return nil
			},
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				launcherCommandCall(t, conn, sid, 2)
				return ""
			},
			want: []wantLine{
				{
					msg:    "shell.launcherCommand oracle verdict",
					fields: map[string]any{"destination": "testhost", "ok": false, "reason": "oracle-failed"},
				},
				{
					msg:    "shell.launcherCommand mode decided",
					fields: map[string]any{"mode": "raw", "reason": "oracle-failed"},
				},
			},
		},
		{
			name: "remote command refuses and names its reason",
			seed: func(resolver *launcherTestResolver, _ *ssh.InstalledFactStore) error {
				resolver.add("testhost", ssh.HostConfig{HostName: "testhost", User: "testuser", Port: 22, RemoteCommand: "top"})
				return nil
			},
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				launcherCommandCall(t, conn, sid, 2)
				return ""
			},
			want: []wantLine{
				{
					msg:    "shell.launcherCommand oracle verdict",
					fields: map[string]any{"ok": true, "identity": plannerTestIdentity, "remoteCommand": true},
				},
				{
					msg:    "shell.launcherCommand mode decided",
					fields: map[string]any{"mode": "raw", "reason": "remote-command", "identity": plannerTestIdentity},
				},
			},
		},
		{
			name: "accepted passport records the installed fact",
			seed: func(_ *launcherTestResolver, _ *ssh.InstalledFactStore) error { return nil },
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				got := launcherCommandCall(t, conn, sid, 2)
				observe(t, conn, 3, got.EnvironmentID, acceptedPassport(got.EnvironmentID))
				return got.EnvironmentID
			},
			want: []wantLine{
				{
					msg:    "shell.environmentObserved",
					fields: map[string]any{"status": "accepted", "identity": plannerTestIdentity},
				},
				{
					msg:    "installed fact recorded",
					fields: map[string]any{"identity": plannerTestIdentity, "protocol": "1", "generation": "v10"},
				},
			},
		},
		{
			name: "missing passport invalidates the installed fact",
			seed: func(_ *launcherTestResolver, facts *ssh.InstalledFactStore) error {
				return facts.Record(ssh.InstalledFact{
					Identity: plannerTestIdentity, Protocol: expectedInstalledProtocol,
					ScriptVersion: "0.6.0", Generation: "v10",
				})
			},
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				got := launcherCommandCall(t, conn, sid, 2)
				observe(t, conn, 3, got.EnvironmentID, nil)
				return got.EnvironmentID
			},
			want: []wantLine{
				{
					msg:    "shell.environmentObserved",
					fields: map[string]any{"status": "none", "identity": plannerTestIdentity},
				},
				{
					msg:    "installed fact invalidated",
					fields: map[string]any{"identity": plannerTestIdentity},
				},
			},
		},
		{
			name: "unknown environment id is unexpected",
			seed: func(_ *launcherTestResolver, _ *ssh.InstalledFactStore) error { return nil },
			act: func(t *testing.T, conn *websocket.Conn, _ string) string {
				observe(t, conn, 3, "deadbeef00000000", acceptedPassport("deadbeef00000000"))
				return ""
			},
			want: []wantLine{
				{
					msg:    "shell.environmentObserved",
					fields: map[string]any{"status": "unexpected", "environmentId": "deadbeef00000000"},
				},
			},
		},
		{
			name: "duplicate observation is ignored",
			seed: func(_ *launcherTestResolver, _ *ssh.InstalledFactStore) error { return nil },
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				got := launcherCommandCall(t, conn, sid, 2)
				observe(t, conn, 3, got.EnvironmentID, acceptedPassport(got.EnvironmentID))
				observe(t, conn, 4, got.EnvironmentID, acceptedPassport(got.EnvironmentID))
				return got.EnvironmentID
			},
			want: []wantLine{
				{
					msg:    "shell.environmentObserved",
					fields: map[string]any{"status": "accepted", "identity": plannerTestIdentity},
				},
				{
					msg:    "shell.environmentObserved",
					fields: map[string]any{"status": "ignored"},
				},
			},
		},
		{
			name: "raw attempt observation is ignored",
			seed: func(resolver *launcherTestResolver, _ *ssh.InstalledFactStore) error {
				resolver.fail = true
				return nil
			},
			act: func(t *testing.T, conn *websocket.Conn, sid string) string {
				got := launcherCommandCall(t, conn, sid, 2)
				observe(t, conn, 3, got.EnvironmentID, acceptedPassport(got.EnvironmentID))
				return got.EnvironmentID
			},
			want: []wantLine{
				{
					msg:    "shell.environmentObserved",
					fields: map[string]any{"status": "ignored"},
				},
			},
		},
	}

	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			ws, resolver, facts, buf := capturePlannerHarness(t)
			if err := row.seed(resolver, facts); err != nil {
				t.Fatalf("seed: %v", err)
			}
			conn := connectWS(t, ws)
			defer func() { _ = conn.Close() }()
			sid := openSessionForLauncher(t, conn)
			row.act(t, conn, sid)
			assertLogLines(t, captureRecords(t, buf), row.want)
		})
	}
}
