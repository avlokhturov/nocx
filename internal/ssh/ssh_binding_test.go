package ssh

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
)

// credStub is a minimal CredentialStore for binding tests: it reports a
// stored password so Credentials != nil (the gate for the binding check)
// without depending on the keyring.
type credStub struct{ pw string }

func (s *credStub) LookupPassword(_ credential.Identity) (credential.Secret, error) {
	return credential.NewSecret(s.pw), nil
}
func (s *credStub) SavePassword(_ credential.Identity, _ string) error { return nil }
func (s *credStub) DeletePassword(_ credential.Identity) error         { return nil }
func (s *credStub) HasPassword(_ credential.Identity) (bool, error)    { return true, nil }
func (s *credStub) LookupKeyPassphrase(_ credential.KeyHash) (credential.Secret, error) {
	return credential.Secret{}, nil
}
func (s *credStub) SaveKeyPassphrase(_ credential.KeyHash, _ string) error { return nil }
func (s *credStub) DeleteKeyPassphrase(_ credential.KeyHash) error         { return nil }

// newBindingClient builds a RealClient pointed at an empty ssh_config so
// resolution is deterministic (alias lookups come only from the config we
// write per test, if any).
func newBindingClient(t *testing.T) *RealClient {
	t.Helper()
	c, err := NewReal(
		log.NewSlogAdapter(nil),
		WithSSHConfigPath(writeSSHConfig(t, "")),
		WithKnownHostsFile(writeSSHConfig(t, "")),
	)
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// unreachableHost is a host:port that refuses connections quickly, used to
// prove the binding check fires BEFORE any dial: a mismatched binding against
// this host returns a binding error, not a connection error.
const unreachableHost = "127.0.0.1:1"

// TestBinding_RefusesMismatchedHost proves the attack is stopped: a
// credential bound to host A, aimed at host B, is refused. The target here
// is unreachable, so the only way to get a binding error instead of a dial
// error is that the check runs before the dial.
func TestBinding_RefusesMismatchedHost(t *testing.T) {
	c := newBindingClient(t)
	store := &credStub{pw: "victim-secret"}

	_, err := c.Connect(
		context.Background(), unreachableHost,
		WithUser("victim"),
		WithCredentials(store, credential.Identity{User: "cred:victim:1"}),
		// Credential is bound to a different host than the one we dial.
		withBinding("good.example.com", 0),
	)

	var mismatch *ErrCredentialBindingMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("want ErrCredentialBindingMismatch, got %T: %v", err, err)
	}
	if mismatch.ResolvedHost != "127.0.0.1" {
		t.Errorf("ResolvedHost = %q, want 127.0.0.1 (the dialed host, not the alias)", mismatch.ResolvedHost)
	}
	if mismatch.BoundHost != "good.example.com" {
		t.Errorf("BoundHost = %q, want good.example.com", mismatch.BoundHost)
	}
	if mismatch.Jump {
		t.Error("Jump flag should be false for the target binding")
	}
}

// TestBinding_AliasResolutionNotAlias pins the load-bearing criterion from
// the bead: matching uses the RESOLVED hostname, never the alias. An alias
// "victim" whose HostName is evil.example.com must be refused for a
// credential bound to "victim" (the alias) AND for one bound to the real
// target's peer — only a credential bound to the resolved HostName passes.
func TestBinding_AliasResolutionNotAlias(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()
	_, portStr, _ := net.SplitHostPort(srv.addr)

	// Alias "victim" -> HostName 127.0.0.1 (the test server), Port = srv port.
	configContent := fmt.Sprintf(`Host victim
    HostName %s
    Port %s
`, hostPortOnly(srv.addr), portStr)
	configPath := writeSSHConfig(t, configContent)
	khPath := writeKnownHosts(t, srv, srv.addr)

	client, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(configPath), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	defer func() { _ = client.Close() }()

	store := &credStub{pw: "x"}

	// Bound to the ALIAS "victim" — must be REFUSED. The alias is a name the
	// renderer/attacker chooses; binding on it is unsound because HostName
	// can be remapped. The resolved host is 127.0.0.1, so "victim" != 127.0.0.1.
	_, err = client.Connect(
		context.Background(), "victim",
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.Identity{User: "cred:victim:1"}),
		withBinding("victim", 0),
	)
	var mismatch *ErrCredentialBindingMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("bound-to-alias: want ErrCredentialBindingMismatch, got %T: %v", err, err)
	}
	if mismatch.ResolvedHost != hostPortOnly(srv.addr) {
		t.Errorf("ResolvedHost = %q, want %s (resolved, not the alias)", mismatch.ResolvedHost, hostPortOnly(srv.addr))
	}

	// Bound to the RESOLVED host — must CONNECT. This proves the check is
	// "match the resolved value", not "deny everything".
	ch, err := client.Connect(
		context.Background(), "victim",
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.Identity{User: "cred:victim:1"}),
		withBinding(hostPortOnly(srv.addr), 0),
	)
	if err != nil {
		t.Fatalf("bound-to-resolved: Connect: %v", err)
	}
	defer func() { _ = ch.Close() }()
}

// TestBinding_JumpHostRefused pins the easier-to-miss path: JumpCredentials
// resolves separately and is enforced against the jump host's resolved name,
// independently of the target. A jump credential bound to host A must be
// refused when the jump host resolves to host B.
func TestBinding_JumpHostRefused(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()
	_, portStr, _ := net.SplitHostPort(srv.addr)

	// Jump alias "jumphost" -> HostName 127.0.0.1 (the test server). The
	// target is the same server reached directly. The jump credential is
	// bound to "other-bastion.example.com", so the jump binding must refuse.
	configContent := fmt.Sprintf(`Host jumphost
    HostName %s
    Port %s
`, hostPortOnly(srv.addr), portStr)
	configPath := writeSSHConfig(t, configContent)
	khPath := writeKnownHosts(t, srv, srv.addr)

	client, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(configPath), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	defer func() { _ = client.Close() }()

	store := &credStub{pw: "x"}

	// Target binding matches the resolved target; only the jump binding is
	// wrong. This isolates the jump-host enforcement from the target's.
	_, err = client.Connect(
		context.Background(), srv.addr,
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.Identity{User: "cred:target:1"}),
		withBinding(hostPortOnly(srv.addr), 0),
		WithJumpHost("jumphost", 0, "test", "publicKey"),
		WithJumpCredentials(store, credential.Identity{User: "cred:jump:1"}),
		// Jump credential bound to a host the jump alias does NOT resolve to.
		func(c *ConnectConfig) {
			c.JumpBoundHost = "other-bastion.example.com"
			c.JumpBoundPort = 0
		},
	)
	var mismatch *ErrCredentialBindingMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("want ErrCredentialBindingMismatch for jump, got %T: %v", err, err)
	}
	if !mismatch.Jump {
		t.Error("Jump flag should be true for a jump-credential binding failure")
	}
	if mismatch.ResolvedHost != hostPortOnly(srv.addr) {
		t.Errorf("ResolvedHost = %q, want %s (the jump alias's resolved HostName)", mismatch.ResolvedHost, hostPortOnly(srv.addr))
	}
	if mismatch.BoundHost != "other-bastion.example.com" {
		t.Errorf("BoundHost = %q, want other-bastion.example.com", mismatch.BoundHost)
	}
}

// TestBinding_PortFromAlias pins the second bead criterion: matching uses
// the EFFECTIVE port after resolution, not the profile's. An alias whose
// Port overrides the default means the effective port is the alias's port;
// a credential bound to port 22 must be refused when the alias resolves to
// the test server's port.
func TestBinding_PortFromAlias(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()
	_, portStr, _ := net.SplitHostPort(srv.addr)

	configContent := fmt.Sprintf(`Host portalias
    HostName %s
    Port %s
`, hostPortOnly(srv.addr), portStr)
	configPath := writeSSHConfig(t, configContent)
	khPath := writeKnownHosts(t, srv, srv.addr)

	client, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(configPath), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	defer func() { _ = client.Close() }()

	store := &credStub{pw: "x"}

	// Bound to the right host but port 22 — the alias resolves to srv port,
	// which is not 22 (it's an ephemeral port). Must be refused.
	_, err = client.Connect(
		context.Background(), "portalias",
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.Identity{User: "cred:victim:1"}),
		withBinding(hostPortOnly(srv.addr), 22),
	)
	var mismatch *ErrCredentialBindingMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("port mismatch: want ErrCredentialBindingMismatch, got %T: %v", err, err)
	}
	if mismatch.BoundPort != 22 {
		t.Errorf("BoundPort = %d, want 22", mismatch.BoundPort)
	}
	if mismatch.ResolvedPort == 22 {
		t.Error("ResolvedPort = 22, but the alias overrides Port to the test server's ephemeral port")
	}
}

// TestBinding_UnboundRefused pins the decision about empty Host: an unbound
// credential (BoundHost == "") is refused at connect time. "Any host" is the
// redirection hole; it does not become legal because the check is new.
func TestBinding_UnboundRefused(t *testing.T) {
	c := newBindingClient(t)
	store := &credStub{pw: "x"}

	_, err := c.Connect(
		context.Background(), unreachableHost,
		WithUser("victim"),
		WithCredentials(store, credential.Identity{User: "cred:unbound:1"}),
		// No binding set — BoundHost stays "".
	)
	var unbound *ErrCredentialNotBound
	if !errors.As(err, &unbound) {
		t.Fatalf("want ErrCredentialNotBound, got %T: %v", err, err)
	}
	if unbound.CredentialID != "cred:unbound:1" {
		t.Errorf("CredentialID = %q, want cred:unbound:1", unbound.CredentialID)
	}
}

// TestBinding_HostAnyPortWhenPortUnset pins the stated exception: a
// credential bound to a host with no port (BoundPort == 0) is accepted for
// that host on ANY port. Host is the load-bearing identity; making port
// mandatory would break every existing host-only credential harder than the
// hole it would close.
func TestBinding_HostAnyPortWhenPortUnset(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()
	khPath := writeKnownHosts(t, srv, srv.addr)

	client, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(writeSSHConfig(t, "")), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	defer func() { _ = client.Close() }()

	store := &credStub{pw: "x"}
	_, srvPort, _ := net.SplitHostPort(srv.addr)

	// Bound to the host with port 0 -> accepted on the server's ephemeral port.
	ch, err := client.Connect(
		context.Background(), srv.addr,
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.Identity{User: "cred:hostonly:1"}),
		withBinding(hostPortOnly(srv.addr), 0),
	)
	if err != nil {
		t.Fatalf("host-only binding on port %s: Connect: %v", srvPort, err)
	}
	defer func() { _ = ch.Close() }()
}

// TestBinding_InlineAuthNotChecked pins the negative space: inline (no
// credential) auth has no stored secret to redirect, so there is no binding
// to enforce and Connect proceeds normally. This guards against an
// over-broad check that would break every inline profile.
func TestBinding_InlineAuthNotChecked(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()
	khPath := writeKnownHosts(t, srv, srv.addr)

	client, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(writeSSHConfig(t, "")), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	defer func() { _ = client.Close() }()

	// No WithCredentials -> Credentials nil -> check skipped. BoundHost left
	// empty would otherwise trip ErrCredentialNotBound; that it does not is
	// exactly the point.
	ch, err := client.Connect(
		context.Background(), srv.addr,
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
	)
	if err != nil {
		t.Fatalf("inline Connect: %v", err)
	}
	defer func() { _ = ch.Close() }()
}

// withBinding sets the credential binding on a ConnectConfig. It is a test
// helper rather than a public With option because binding is resolver-owned
// data, not something callers set directly in production.
func withBinding(host string, port int) ConnectOption {
	return func(c *ConnectConfig) {
		c.BoundHost = host
		c.BoundPort = port
	}
}
