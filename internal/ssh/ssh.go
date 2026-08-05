package ssh

import (
	"context"
	"io"
	"time"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
)

type Channel interface {
	io.ReadWriteCloser
	Resize(ctx context.Context, cols, rows, xpixel, ypixel uint16) error
	// Done returns a channel closed when the remote shell exits or the
	// underlying connection is lost — the Disconnected signal from AD-7.
	Done() <-chan struct{}
	// ShellIntegrationReason reports why shell integration did not happen
	// for this channel (nocx-r52q). ReasonNone means integration succeeded
	// or was never attempted — a plain shell is the default. The transport
	// carries this value to the UI; it must never be log-only.
	ShellIntegrationReason() RefusalReason
}

// RemoteInstaller installs shell integration scripts on a remote host via
// SSH/SFTP and returns the start command for the shell. Defined here (not
// in shellintegration) to avoid a cyclic import.
type RemoteInstaller interface {
	EnsureInstalledRemote(ctx context.Context, sshClient *gossh.Client, remoteHome string) error
	GetRemoteHome(sshClient *gossh.Client) (string, error)
	RemoteStartCommand() string
}

// LaunchPolicy controls whether the wired RemoteLauncher may build an
// integrated start command when the session opens (nocx-4t37.2). The
// profile cascade decides the policy (auto|ask|off, nocx-p0ug): Auto
// integrates at startup, silently, in the interval nocx owns; Ask and Off
// open a plain shell and leave the explicit-request path to the renderer's
// capability control (shell.integrate, gated on the trusted prompt).
// internal/ssh declares its own enum because it must not depend on
// internal/profile — the same boundary that already duplicates ShellKind,
// LaunchOptions and RefusalReason between the two packages.
type LaunchPolicy string

const (
	LaunchPolicyAuto LaunchPolicy = "auto"
	LaunchPolicyAsk  LaunchPolicy = "ask"
	LaunchPolicyOff  LaunchPolicy = "off"
)

// launchAllowed reports whether the launcher (or the legacy installer) may
// run at open. Empty means Auto: every caller that predates the field keeps
// integrating at startup.
func launchAllowed(p LaunchPolicy) bool {
	return p == "" || p == LaunchPolicyAuto
}

// ---------------------------------------------------------------------------
// Remote shell launcher — the pinned nocx-xs1d contract for bringing up an
// integrated interactive shell on the far host.
//
// The canonical declarations land in internal/shellintegration (a parallel
// worktree); they are mirrored here because internal/ssh must not depend on
// that package, and Go interface satisfaction requires identical named types.
// The composition root adapts the two declarations at wiring time.
// ---------------------------------------------------------------------------

// ShellKind names the far shell a launcher builds a start command for.
type ShellKind string

const (
	ShellBash    ShellKind = "bash"
	ShellZsh     ShellKind = "zsh"
	ShellUnknown ShellKind = "unknown"
	// ShellAuto means "the far host decides": the launcher emits a single
	// strictly-POSIX dispatcher that detects the login shell at runtime and
	// execs the matching tier (nocx-6rj0). The default when a profile pins
	// no shell.
	ShellAuto ShellKind = "auto"
)

// RefusalReason is why integration did not happen, in a form the product
// renders. The empty string means "no refusal".
type RefusalReason string

const (
	ReasonNone             RefusalReason = ""
	ReasonUnsupportedShell RefusalReason = "unsupported-shell"
	ReasonNoSecureTemp     RefusalReason = "no-secure-temp"
	ReasonRemoteCommand    RefusalReason = "remote-command"
	// ReasonUnknown means integration did not happen and the backend cannot
	// say why — the remoteLauncherAdapter's fail-open for a refusal reason
	// the ssh vocabulary does not yet know (nocx-axpz). It is a distinct
	// visible failure, never a synonym for ReasonNone: the product renders
	// "no refusal" as "integration succeeded", which would be a lie.
	ReasonUnknown RefusalReason = "unknown"
)

// LaunchOptions carries what the start command must embed.
type LaunchOptions struct {
	SessionID string // NOCX_SESSION_ID for this session; never empty when Enhanced
	Enhanced  bool   // request marker-only prompt mode (ADR-0006)
}

// RemoteLauncher builds the command string passed to an SSH session's Start()
// to bring up an integrated interactive shell on the far host.
type RemoteLauncher interface {
	// StartCommand returns the remote command for the given far shell.
	// ok is false when this shell cannot be integrated; reason then says
	// why, and the caller falls back to a plain shell.
	StartCommand(shell ShellKind, opts LaunchOptions) (cmd string, reason RefusalReason, ok bool)
}

type SSH interface {
	Connect(ctx context.Context, host string, opts ...ConnectOption) (Channel, error)
	Close() error
}

type ConnectOption func(*ConnectConfig)

type ConnectConfig struct {
	User            string
	Port            int
	KeyFile         string
	UseAgent        bool
	Cols            uint16
	Rows            uint16
	XPixel          uint16
	YPixel          uint16
	AuthMethods     []gossh.AuthMethod
	KeyExchanges    []string
	RemoteInstaller RemoteInstaller

	// RemoteLauncher builds the start command for an integrated remote shell
	// (nocx-xs1d). openShell consults it unless the destination configures a
	// RemoteCommand (which refuses a command-line remote command); when it
	// declines, openShell starts a plain shell and surfaces the reason on the
	// channel. The legacy RemoteInstaller is consulted only when no launcher
	// is wired.
	RemoteLauncher RemoteLauncher

	// LaunchPolicy gates the launcher (and the legacy installer) at open
	// (nocx-4t37.2). Auto (or empty — the pre-policy default) integrates at
	// startup; Ask and Off open a plain shell, with the renderer's
	// capability control as the explicit-request path. Set by the profile
	// resolver from the effective shellIntegration field.
	LaunchPolicy LaunchPolicy

	// DesiredMode is the resolved destination mode (raw|script|relay,
	// nocx-mlm7) stamped by the profile resolver and carried verbatim to
	// the open ack. The ssh layer does not consume it yet — the launch
	// policy above is the open-time translation of it — but the renderer
	// needs the AXIS value (not the translated policy) to show consent
	// state for relay and to gate submit-time rewrites, and translating it
	// back from LaunchPolicy would collapse raw and relay into one value.
	// Empty means unset (direct-host/local opens): the ack defaults it to
	// script. P6/P7 rework this seam when the relay gates land.
	DesiredMode string

	// SessionID is the backend-assigned session ID (AD-7) for the session
	// this connection serves. The launcher embeds it as NOCX_SESSION_ID;
	// never empty when Enhanced is set.
	SessionID string

	// Enhanced requests the marker-only prompt mode (ADR-0006) for the
	// remote shell; forwarded to the launcher in LaunchOptions.
	Enhanced bool

	// Shell pins the far shell the launcher must target. Empty means
	// "detect it" — the launcher receives ShellAuto and decides on the far
	// host, where the login shell can say what it is (nocx-6rj0). A pin
	// (from the user's profile) wins over detection: a user who says "this
	// host runs zsh" knows something the detector cannot.
	Shell ShellKind

	// AuthMode controls which auth buckets are tried (null=Auto with full
	// fallback-chain; a specific value restricts which buckets are attempted).
	// Mirrors Tabby's profile.options.auth enum.
	AuthMode string

	// JumpHost is the first hop's hostname or IP. When JumpConfig is also set
	// (set by the resolver for multi-hop), JumpConfig carries the full
	// recursive hop configuration and this flat field is the first hop's host.
	// For backward compatibility, both fields are populated: acquireJumpHost
	// prefers JumpConfig when non-nil.
	JumpHost string
	// JumpPort is the port of the first jump server (0 means use default 22).
	JumpPort int
	// Jump host credentials — loaded from jump server's profile.
	JumpUser     string
	JumpKeyFile  string
	JumpAuthMode string

	// JumpConfig carries the full recursive jump host configuration for
	// multi-hop routes. When the resolver builds the config for a target
	// accessed through a chain of bastions, JumpConfig is the recursive
	// ConnectConfig of the first hop, which itself may have JumpConfig set
	// for the next hop, and so on. This is nil for direct connections.
	// acquireJumpHost reads this field preferentially; the flat Jump* fields
	// are populated as well for backward compatibility.
	JumpConfig *ConnectConfig

	// AuthorizedEndpoint carries the endpoint identity that a linked credential
	// is authorized for, set by the resolver. The value is the profile's Host
	// resolved through ~/.ssh/config to the canonical hostname (not the alias).
	// At connect time, after resolveConfig applies ~/.ssh/config to the dial
	// target, this value is compared against the resolved endpoint: the
	// credential may only be spent on the endpoint its profile identifies.
	// An empty AuthorizedEndpoint means no credential is linked (inline auth)
	// and no check is performed.
	// Port is included when the effective profile specifies one.
	AuthorizedEndpoint string

	// JumpAuthorizedEndpoint is the jump credential's authorized endpoint,
	// resolved through ~/.ssh/config independently of the target.
	JumpAuthorizedEndpoint string

	// Secrets, when set, enables late-bind of stored passwords from the
	// SecretStore by SecretID. The store is the seam between the profile
	// manager (clear data) and the secret store — never call it directly
	// from frontend code.
	Secrets  credential.SecretStore
	SecretID credential.SecretID
	// UnlockRequester is called by auth callbacks when Secrets.Get returns
	// ErrVaultSealed. It should show the unlock prompt and return nil on
	// success, or an error if the unlock was refused / not possible.
	// When nil, a sealed vault is reported as an auth failure (the
	// existing dispatcher.onVaultSealed path catches it for foreground
	// RPCs; this field covers background goroutines like forward replay).
	UnlockRequester func(ctx context.Context, reason string) error

	// PassphraseSecretID is the opaque reference to the stored key
	// passphrase in the SecretStore.
	PassphraseSecretID credential.SecretID
	// KeySecretID is the opaque reference to the stored private key
	// material in the SecretStore, resolved from the credential version's
	// KeyMaterialSecretID. Mutually exclusive with KeyFile: when set, the
	// auth chain loads key bytes from the SecretStore instead of reading
	// a file. The bytes never touch disk.
	KeySecretID credential.SecretID

	// JumpSecrets, when set, enables late-bind of the jump host's
	// password from the SecretStore. Separate from the target's Secrets
	// so each hop resolves independently.
	JumpSecrets  credential.SecretStore
	JumpSecretID credential.SecretID
	// JumpPassphraseSecretID is the opaque reference to the jump host's key
	// passphrase in the SecretStore.
	JumpPassphraseSecretID credential.SecretID

	// KeepaliveInterval controls how often the SSH keepalive probe
	// ("keepalive@openssh.com") is sent on the connection. Zero disables
	// keepalive. The profile stores this value in milliseconds; callers
	// convert to a time.Duration before setting this field.
	KeepaliveInterval time.Duration

	// KeepaliveCountMax is the number of consecutive keepalive failures
	// before the connection is considered dead and closed. Only meaningful
	// when KeepaliveInterval > 0. Zero or negative means a single failure
	// closes the connection.
	KeepaliveCountMax int

	// ReadyTimeout is the maximum time to wait for the SSH TCP dial and
	// handshake to complete. Zero means use the default of 30 seconds.
	ReadyTimeout time.Duration

	// AgentForward enables SSH agent forwarding (auth-agent-req@openssh.com)
	// on the session. The request is sent only when agent auth is actually
	// in play (SSH_AUTH_SOCK is reachable); if set but no agent is available,
	// the connect fails with an error.
	AgentForward bool

	// CredentialID identifies which credential this config was resolved from.
	// Used by revocation to scope session matching by credential.
	CredentialID string
}

func WithUser(user string) ConnectOption {
	return func(c *ConnectConfig) { c.User = user }
}

func WithPort(port int) ConnectOption {
	return func(c *ConnectConfig) { c.Port = port }
}

// WithKeyFile sets an explicit private key path for authentication.
func WithKeyFile(path string) ConnectOption {
	return func(c *ConnectConfig) { c.KeyFile = path }
}

// WithAgent enables ssh-agent authentication (default when no key or password
// is specified).
func WithAgent() ConnectOption {
	return func(c *ConnectConfig) { c.UseAgent = true }
}

// WithPTYSize sets the initial PTY dimensions for the shell channel.
// Per AD-1/AD-7 the channel is created at this size, never spawned-then-resized.
func WithPTYSize(cols, rows, xpixel, ypixel uint16) ConnectOption {
	return func(c *ConnectConfig) {
		c.Cols = cols
		c.Rows = rows
		c.XPixel = xpixel
		c.YPixel = ypixel
	}
}

// WithKeepalive sets the keepalive interval and consecutive-failure limit.
// A zero interval disables keepalive. Negative countMax means a single
// failure closes the connection.
func WithKeepalive(interval time.Duration, countMax int) ConnectOption {
	return func(c *ConnectConfig) {
		c.KeepaliveInterval = interval
		c.KeepaliveCountMax = countMax
	}
}

// WithTimeout sets the connect timeout for the TCP dial and SSH handshake.
// Zero means the default of 30 seconds.
func WithTimeout(timeout time.Duration) ConnectOption {
	return func(c *ConnectConfig) { c.ReadyTimeout = timeout }
}

// WithAgentForward enables SSH agent forwarding on the session. It is only
// honoured when the SSH agent is actually available (SSH_AUTH_SOCK set).
func WithAgentForward() ConnectOption {
	return func(c *ConnectConfig) { c.AgentForward = true }
}

// WithAuthMethods injects explicit ssh.AuthMethod values, bypassing the
// default key-discovery logic. Used primarily in tests.
func WithAuthMethods(auths []gossh.AuthMethod) ConnectOption {
	return func(c *ConnectConfig) { c.AuthMethods = auths }
}

// WithRemoteLauncher injects the launcher that builds the start command for
// an integrated remote shell (nocx-xs1d). When it declines, openShell falls
// back to a plain shell and the refusal reason is surfaced on the channel.
func WithRemoteLauncher(l RemoteLauncher) ConnectOption {
	return func(c *ConnectConfig) { c.RemoteLauncher = l }
}

// WithSessionID binds the backend-assigned session ID (AD-7) to the
// connection; the launcher embeds it as NOCX_SESSION_ID.
func WithSessionID(id string) ConnectOption {
	return func(c *ConnectConfig) { c.SessionID = id }
}

// WithLaunchPolicy sets the open-time launch policy (nocx-4t37.2). Ask and
// Off open a plain shell and leave the explicit-request path to the
// renderer's capability control; empty/Auto integrate at startup whenever a
// launcher is wired.
func WithLaunchPolicy(p LaunchPolicy) ConnectOption {
	return func(c *ConnectConfig) { c.LaunchPolicy = p }
}

// WithEnhanced requests the marker-only prompt mode (ADR-0006) for the
// remote shell.
func WithEnhanced() ConnectOption {
	return func(c *ConnectConfig) { c.Enhanced = true }
}

// WithShell pins the far shell the launcher must target, winning over the
// auto-detecting dispatcher. This is where a profile field that says "this
// host runs zsh" lands (nocx-6rj0); the empty default means detect.
func WithShell(shell ShellKind) ConnectOption {
	return func(c *ConnectConfig) { c.Shell = shell }
}

// WithRemoteInstaller injects a shell integration installer for the remote
// session. It remains as an EXPLICIT opt-in for the later persistent-install
// flow: openShell consults it only when no RemoteLauncher is wired, so the
// default path never SFTP-mutates a remote home (nocx-r52q).
func WithRemoteInstaller(ri RemoteInstaller) ConnectOption {
	return func(c *ConnectConfig) { c.RemoteInstaller = ri }
}

// WithAuthMode sets the auth-method filter for the connection (null=Auto).
// A specific value ("password"/"publicKey"/"agent"/"keyboardInteractive")
// restricts which auth buckets are attempted in the fallback chain.
func WithAuthMode(mode string) ConnectOption {
	return func(c *ConnectConfig) { c.AuthMode = mode }
}

// WithJumpHost sets the jump host configuration for SSH connection.
// Password authentication for the jump host comes from JumpCredentials
// (late-bound via the credential store), never as plaintext.
func WithJumpHost(host string, port int, user, authMode string) ConnectOption {
	return func(c *ConnectConfig) {
		c.JumpHost = host
		c.JumpPort = port
		c.JumpUser = user
		c.JumpAuthMode = authMode
	}
}

// WithJumpCredentials injects a SecretStore for late-bind of the jump
// host's password by SecretID. Mirrors WithCredentials but for the jump hop.
func WithJumpCredentials(store credential.SecretStore, id credential.SecretID) ConnectOption {
	return func(c *ConnectConfig) {
		c.JumpSecrets = store
		c.JumpSecretID = id
	}
}

// WithKeySecretID wires the vault-stored private key for the connection:
// the auth chain loads key bytes from the SecretStore by KeySecretID instead
// of reading a file. WithPassphraseSecretID pairs the key's stored
// passphrase with it; both are set by the resolver from the profile's secret
// bindings (ADR-0017), and the session layer must carry them verbatim.
func WithKeySecretID(id credential.SecretID) ConnectOption {
	return func(c *ConnectConfig) { c.KeySecretID = id }
}

// WithPassphraseSecretID wires the vault-stored passphrase for the
// connection's private key. Only meaningful alongside WithKeySecretID.
func WithPassphraseSecretID(id credential.SecretID) ConnectOption {
	return func(c *ConnectConfig) { c.PassphraseSecretID = id }
}

// WithJumpPassphraseSecretID wires the vault-stored passphrase for the JUMP
// host's key. Mirrors WithPassphraseSecretID but for the jump hop.
func WithJumpPassphraseSecretID(id credential.SecretID) ConnectOption {
	return func(c *ConnectConfig) { c.JumpPassphraseSecretID = id }
}

// WithCredentials injects a SecretStore for late-bind of stored
// passwords by SecretID. The store is the seam between the profile manager
// and the secret store.
func WithCredentials(store credential.SecretStore, id credential.SecretID) ConnectOption {
	return func(c *ConnectConfig) {
		c.Secrets = store
		c.SecretID = id
	}
}

// WithAuthorizedEndpoint sets the endpoint identity a linked credential is
// authorized for, set by the resolver. The value is the profile's Host,
// resolved through ~/.ssh/config to the canonical hostname. At connect time,
// this is compared against the resolved dial target.
func WithAuthorizedEndpoint(endpoint string) ConnectOption {
	return func(c *ConnectConfig) { c.AuthorizedEndpoint = endpoint }
}

// WithJumpAuthorizedEndpoint sets the jump credential's authorized endpoint,
// matching WithAuthorizedEndpoint but for the jump host.
func WithJumpAuthorizedEndpoint(endpoint string) ConnectOption {
	return func(c *ConnectConfig) { c.JumpAuthorizedEndpoint = endpoint }
}

type Stub struct {
	log log.Logger
}

func NewStub(logger log.Logger) *Stub {
	return &Stub{log: logger}
}

func (s *Stub) Connect(ctx context.Context, host string, opts ...ConnectOption) (Channel, error) {
	s.log.Info("ssh stub: Connect called (not implemented)", "host", host)
	return NewStubChannel(s.log), nil
}

func (s *Stub) Close() error {
	s.log.Debug("ssh stub: Close called")
	return nil
}

type StubChannel struct {
	log  log.Logger
	done chan struct{}
}

func NewStubChannel(logger log.Logger) *StubChannel {
	return &StubChannel{log: logger, done: make(chan struct{})}
}

func (c *StubChannel) Read(p []byte) (int, error) {
	return 0, io.EOF
}

func (c *StubChannel) Write(p []byte) (int, error) {
	return len(p), nil
}

func (c *StubChannel) Close() error {
	c.onceClose()
	return nil
}

func (c *StubChannel) onceClose() {
	select {
	case <-c.done:
	default:
		close(c.done)
	}
}

func (c *StubChannel) Done() <-chan struct{} {
	return c.done
}

func (c *StubChannel) Resize(_ context.Context, cols, rows, xpixel, ypixel uint16) error {
	return nil
}

func (c *StubChannel) ShellIntegrationReason() RefusalReason {
	return ReasonNone
}
