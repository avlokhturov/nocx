package ssh

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
)

// credStub is a minimal SecretStore for binding tests: it reports a
// stored password so Secrets != nil (the gate for the binding check)
// without depending on the keyring.
type credStub struct{ pw string }

func (s *credStub) Get(_ credential.SecretID) (credential.Secret, error) {
	return credential.NewSecret(s.pw), nil
}
func (s *credStub) Set(_ credential.SecretID, _ credential.Secret) error { return nil }
func (s *credStub) Delete(_ credential.SecretID) error                   { return nil }
func (s *credStub) Exists(_ credential.SecretID) (bool, error)           { return true, nil }

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
		WithCredentials(store, credential.NewSecretID()),
		// Credential is bound to a different host than the one we dial.
		withBinding("good.example.com", 0),
	)

	var authErr *ErrCredentialAuthorizationFailed
	if !errors.As(err, &authErr) {
		t.Fatalf("want ErrCredentialAuthorizationFailed, got %T: %v", err, err)
	}
	if authErr.ResolvedHost != "127.0.0.1" {
		t.Errorf("ResolvedHost = %q, want 127.0.0.1 (the dialed host, not the alias)", authErr.ResolvedHost)
	}
	if authErr.Expected != "good.example.com" {
		t.Errorf("Expected = %q, want good.example.com", authErr.Expected)
	}
	if authErr.Jump {
		t.Error("Jump flag should be false for the target binding")
	}
}

// TestBinding_AliasConnects proves that a credential bound to an SSH alias
// CONNECTS when the alias resolves through ~/.ssh/config to the same target
// as the dial endpoint. Under the computed-authorization redesign the identity
// is the profile's Host, which is an alias the user chose — the credential
// is authorized for the canonical hostname, so an alias resolves correctly.
func TestBinding_AliasConnects(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()
	_, portStr, _ := net.SplitHostPort(srv.addr)
	srvHost := hostPortOnly(srv.addr)

	configContent := fmt.Sprintf(`Host victim
    HostName %s
    Port %s
`, srvHost, portStr)
	configPath := writeSSHConfig(t, configContent)
	khPath := writeKnownHosts(t, srv, srv.addr)

	client, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(configPath), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	defer func() { _ = client.Close() }()

	store := &credStub{pw: "x"}

	// Bound to the ALIAS — must CONNECT. resolveAuthzEndpoint("victim")
	// resolves through ~/.ssh/config to srvHost, and resolveConfig("victim")
	// also resolves to srvHost. Both sides match.
	ch, err := client.Connect(
		context.Background(), "victim",
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.NewSecretID()),
		withBinding("victim", 0),
	)
	if err != nil {
		t.Fatalf("alias-bound: Connect: %v", err)
	}
	_ = ch.Close()
}

// TestBinding_AliasDriftRefused proves that when ~/.ssh/config changes the
// HostName of an alias after the authorized endpoint was resolved, the
// connection is refused (drift detection). The authorized endpoint is the
// canonical hostname from the OLD resolution; the dial target resolves
// through the NEW config, which yields a different host — the mismatch is
// detected and the credential is not submitted.
func TestBinding_AliasDriftRefused(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()
	_, portStr, _ := net.SplitHostPort(srv.addr)
	srvHost := hostPortOnly(srv.addr)

	// Old config: alias "victim" → HostName 127.0.0.1 (the test server).
	oldConfig := fmt.Sprintf(`Host victim
    HostName %s
    Port %s
`, srvHost, portStr)
	configPath := writeSSHConfig(t, oldConfig)
	khPath := writeKnownHosts(t, srv, srv.addr)

	store := &credStub{pw: "x"}

	// Connect with AuthorizedEndpoint set to the OLD resolved value (srvHost).
	// At connect time, resolveAuthzEndpoint("127.0.0.1") is a no-op (IP, not an
	// alias), so the authorized identity stays "127.0.0.1".
	// resolveConfig("victim") → hostName = "127.0.0.1" (from old config).
	// Match → connect.
	client, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(configPath), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	defer func() { _ = client.Close() }()

	_, err = client.Connect(
		context.Background(), "victim",
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.NewSecretID()),
		func(c *ConnectConfig) { c.AuthorizedEndpoint = srvHost },
	)
	if err != nil {
		t.Fatalf("connect with old resolved endpoint: %v", err)
	}

	// Now the config changes: alias "victim" → HostName "evil.example.com".
	driftConfig := fmt.Sprintf(`Host victim
    HostName evil.example.com
    Port %s
`, portStr)
	configPath2 := writeSSHConfig(t, driftConfig)

	client2, err := NewReal(log.NewSlogAdapter(nil), WithSSHConfigPath(configPath2), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal 2: %v", err)
	}
	defer func() { _ = client2.Close() }()

	// The authorized endpoint is still "127.0.0.1" (the old resolved value).
	// resolveAuthzEndpoint("127.0.0.1") → "127.0.0.1" (no-op).
	// resolveConfig("victim").hostName → "evil.example.com" (from new config).
	// "127.0.0.1" != "evil.example.com" → drifts → REFUSED.
	_, err = client2.Connect(
		context.Background(), "victim",
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithCredentials(store, credential.NewSecretID()),
		func(c *ConnectConfig) { c.AuthorizedEndpoint = srvHost },
	)
	var authErr *ErrCredentialAuthorizationFailed
	if !errors.As(err, &authErr) {
		t.Fatalf("drift: want ErrCredentialAuthorizationFailed, got %T: %v", err, err)
	}
	if authErr.Expected != srvHost {
		t.Errorf("Expected = %q, want %q (the old resolved endpoint)", authErr.Expected, srvHost)
	}
	if authErr.ResolvedHost != "evil.example.com" {
		t.Errorf("ResolvedHost = %q, want evil.example.com (the new HostName after drift)", authErr.ResolvedHost)
	}
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
		WithCredentials(store, credential.NewSecretID()),
		withBinding(hostPortOnly(srv.addr), 0),
		WithJumpHost("jumphost", 0, "test", "publicKey"),
		WithJumpCredentials(store, credential.NewSecretID()),
		// Jump credential bound to a host the jump alias does NOT resolve to.
		func(c *ConnectConfig) {
			c.JumpAuthorizedEndpoint = "other-bastion.example.com"
		},
	)
	var authErr *ErrCredentialAuthorizationFailed
	if !errors.As(err, &authErr) {
		t.Fatalf("want ErrCredentialAuthorizationFailed for jump, got %T: %v", err, err)
	}
	if !authErr.Jump {
		t.Error("Jump flag should be true for a jump-credential binding failure")
	}
	if authErr.ResolvedHost != hostPortOnly(srv.addr) {
		t.Errorf("ResolvedHost = %q, want %s (the jump alias's resolved HostName)", authErr.ResolvedHost, hostPortOnly(srv.addr))
	}
	if authErr.Expected != "other-bastion.example.com" {
		t.Errorf("Expected = %q, want other-bastion.example.com", authErr.Expected)
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
		WithCredentials(store, credential.NewSecretID()),
		withBinding(hostPortOnly(srv.addr), 22),
	)
	var authErr *ErrCredentialAuthorizationFailed
	if !errors.As(err, &authErr) {
		t.Fatalf("port mismatch: want ErrCredentialAuthorizationFailed, got %T: %v", err, err)
	}
	if authErr.Expected != "127.0.0.1:22" {
		t.Errorf("Expected = %q, want 127.0.0.1:22", authErr.Expected)
	}
	if authErr.ResolvedPort == 22 {
		t.Error("ResolvedPort = 22, but the alias overrides Port to the test server's ephemeral port")
	}
}

// TestBinding_UnboundRefused pins the decision about empty Host: an unbound
// credential (BoundHost == "") is refused at connect time. "Any host" is the
// redirection hole; it does not become legal because the check is new.
func TestBinding_UnboundRefused(t *testing.T) {
	c := newBindingClient(t)
	store := &credStub{pw: "x"}
	secretID := credential.NewSecretID()

	_, err := c.Connect(
		context.Background(), unreachableHost,
		WithUser("victim"),
		WithCredentials(store, secretID),
		// No binding set — BoundHost stays "".
	)
	var authErr *ErrCredentialAuthorizationFailed
	if !errors.As(err, &authErr) {
		t.Fatalf("want ErrCredentialAuthorizationFailed, got %T: %v", err, err)
	}
	if authErr.Expected != "<none>" {
		t.Errorf("Expected = %q, want \"<none>\" for unbound credential", authErr.Expected)
	}
	if authErr.ResolvedHost != "127.0.0.1" {
		t.Errorf("ResolvedHost = %q, want 127.0.0.1", authErr.ResolvedHost)
	}
	if authErr.CredentialID != string(secretID) {
		t.Errorf("CredentialID = %q, want %q", authErr.CredentialID, secretID)
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
		WithCredentials(store, credential.NewSecretID()),
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

	// No WithCredentials -> Secrets nil -> check skipped. BoundHost left
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
		if port == 0 {
			c.AuthorizedEndpoint = host
		} else {
			c.AuthorizedEndpoint = net.JoinHostPort(host, strconv.Itoa(port))
		}
	}
}
