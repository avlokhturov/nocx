package ssh

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
)

// recordingInstaller is the smallest ssh.RemoteInstaller double that records
// what the capability hands it: the live *gossh.Client and the remote home.
// The SFTP behaviour itself is shellintegration's fixture; here the contract
// under test is that the capability OWNS the dial-and-call — the client
// never leaves internal/ssh.
type recordingInstaller struct {
	mu            sync.Mutex
	homes         []string
	clientSeen    *gossh.Client
	uninstallHome string
	removed       []string
	conflicts     []string
}

func (r *recordingInstaller) EnsureInstalledRemote(context.Context, *gossh.Client, string) error {
	return nil
}

func (r *recordingInstaller) RemoteStartCommand() string { return "" }

func (r *recordingInstaller) GetRemoteHome(c *gossh.Client) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clientSeen = c
	r.homes = append(r.homes, "remote-home")
	return "remote-home", nil
}

func (r *recordingInstaller) UninstallRemote(_ context.Context, c *gossh.Client, home string) ([]string, []string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.uninstallHome = home
	return r.removed, r.conflicts, nil
}

// uninstallConnectOpts is the dial plumbing every UninstallIntegration test
// needs: the same authorization a Connect uses.
func uninstallConnectOpts(t *testing.T, srv *testSSHServer) []ConnectOption {
	t.Helper()
	t.Cleanup(srv.close)
	return []ConnectOption{
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
	}
}

// newUninstallClient builds a RealClient that trusts the test server's host
// key and answers config resolution with the stub.
func newUninstallClient(t *testing.T, srv *testSSHServer) *RealClient {
	t.Helper()
	khPath := writeKnownHosts(t, srv, srv.addr)
	rc, err := NewReal(log.NewSlogAdapter(nil),
		WithConfigResolver(NewStubConfigResolver()), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	return rc
}

// TestUninstallIntegration_OwnsTheDialAndCall: the capability acquires a
// pooled connection the way Connect does, asks the carrier for the remote
// home, delegates UninstallRemote to it, and returns the two lists — the
// recording double proves the carrier saw a live connection and the home.
func TestUninstallIntegration_OwnsTheDialAndCall(t *testing.T) {
	srv := startTestSSHServer(t)
	rc := newUninstallClient(t, srv)

	rec := &recordingInstaller{removed: []string{"manifest.json"}, conflicts: []string{"integration/v10/nocx.bash"}}
	opts := append(uninstallConnectOpts(t, srv), WithRemoteInstaller(rec))

	removed, conflicts, err := rc.UninstallIntegration(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("UninstallIntegration: %v", err)
	}
	if len(removed) != 1 || removed[0] != "manifest.json" {
		t.Errorf("removed = %v, want [manifest.json]", removed)
	}
	if len(conflicts) != 1 || conflicts[0] != "integration/v10/nocx.bash" {
		t.Errorf("conflicts = %v, want [integration/v10/nocx.bash]", conflicts)
	}
	rec.mu.Lock()
	live := len(rec.homes) == 1 && rec.clientSeen != nil && rec.uninstallHome == "remote-home"
	rec.mu.Unlock()
	if !live {
		t.Errorf("carrier did not receive one live client + the remote home (homes=%d clientSeen=%v uninstallHome=%q)",
			len(rec.homes), rec.clientSeen != nil, rec.uninstallHome)
	}
}

// TestUninstallIntegration_NoInstallerRefuses: without a carrier in the
// ConnectConfig nothing can be removed, and the refusal is an error — never
// an empty success.
func TestUninstallIntegration_NoInstallerRefuses(t *testing.T) {
	srv := startTestSSHServer(t)
	rc := newUninstallClient(t, srv)

	_, _, err := rc.UninstallIntegration(context.Background(), srv.addr, uninstallConnectOpts(t, srv)...)
	if err == nil {
		t.Fatal("UninstallIntegration without a RemoteInstaller succeeded")
	}
}

// TestUninstallIntegration_HomeFailureStopsBeforeUninstall: a carrier that
// cannot determine the remote home means nothing is removed — UninstallRemote
// must not be reached with a guess.
func TestUninstallIntegration_HomeFailureStopsBeforeUninstall(t *testing.T) {
	srv := startTestSSHServer(t)
	rc := newUninstallClient(t, srv)

	rec := &recordingInstaller{}
	failing := &failingHomeInstaller{rec: rec}

	_, _, err := rc.UninstallIntegration(context.Background(), srv.addr, append(uninstallConnectOpts(t, srv), WithRemoteInstaller(failing))...)
	if err == nil {
		t.Fatal("UninstallIntegration with an unreachable home succeeded")
	}
	rec.mu.Lock()
	called := rec.uninstallHome != ""
	rec.mu.Unlock()
	if called {
		t.Error("UninstallRemote was called although GetRemoteHome failed")
	}
}

// failingHomeInstaller fails GetRemoteHome and delegates everything else.
type failingHomeInstaller struct {
	rec *recordingInstaller
}

func (f *failingHomeInstaller) EnsureInstalledRemote(context.Context, *gossh.Client, string) error {
	return nil
}

func (f *failingHomeInstaller) RemoteStartCommand() string { return "" }

func (f *failingHomeInstaller) GetRemoteHome(*gossh.Client) (string, error) {
	return "", errors.New("no home")
}

func (f *failingHomeInstaller) UninstallRemote(ctx context.Context, c *gossh.Client, home string) ([]string, []string, error) {
	return f.rec.UninstallRemote(ctx, c, home)
}
