package ssh

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/kevinburke/ssh_config"
)

// resolvedConfig holds the merged configuration from ~/.ssh/config and explicit options.
type resolvedConfig struct {
	hostName     string
	user         string
	port         int
	identityFile string
	keyAlgos     []string
	cols         uint16
	rows         uint16
	xpixel       uint16
	ypixel       uint16
}

// resolveConfig merges ~/.ssh/config values with explicit ConnectOptions.
// Precedence: explicit option > config file > default.
func (rc *RealClient) resolveConfig(host string, cfg *ConnectConfig) (*resolvedConfig, error) {
	resolvedHost, resolvedPort := host, 22
	if h, p, err := net.SplitHostPort(host); err == nil {
		resolvedHost = h
		if port, err := strconv.Atoi(p); err == nil {
			resolvedPort = port
		}
	}

	resolved := &resolvedConfig{
		hostName: resolvedHost,
		user:     currentUser(),
		port:     resolvedPort,
		cols:     80,
		rows:     24,
	}

	sshCfg, err := rc.openSSHConfig()
	if err == nil && sshCfg != nil {
		if hn, _ := sshCfg.Get(host, "HostName"); hn != "" {
			resolved.hostName = hn
		}
		if u, _ := sshCfg.Get(host, "User"); u != "" {
			resolved.user = u
		}
		if p, _ := sshCfg.Get(host, "Port"); p != "" {
			if port, err := strconv.Atoi(p); err == nil {
				resolved.port = port
			}
		}
		if idf, _ := sshCfg.Get(host, "IdentityFile"); idf != "" {
			resolved.identityFile = expandPath(idf)
		}
	}

	if cfg.User != "" {
		resolved.user = cfg.User
	}
	if cfg.Port > 0 {
		resolved.port = cfg.Port
	}
	if cfg.KeyFile != "" {
		resolved.identityFile = cfg.KeyFile
	}
	if cfg.Cols > 0 {
		resolved.cols = cfg.Cols
	}
	if cfg.Rows > 0 {
		resolved.rows = cfg.Rows
	}
	if cfg.XPixel > 0 {
		resolved.xpixel = cfg.XPixel
	}
	if cfg.YPixel > 0 {
		resolved.ypixel = cfg.YPixel
	}
	if len(cfg.KeyExchanges) > 0 {
		resolved.keyAlgos = cfg.KeyExchanges
	}

	return resolved, nil
}

func (rc *RealClient) openSSHConfig() (*ssh_config.Config, error) {
	f, err := os.Open(rc.sshConfigPath)
	if err != nil {
		return nil, nil
	}
	defer func() { _ = f.Close() }()
	return ssh_config.Decode(f)
}

func currentUser() string {
	u := os.Getenv("USER")
	if u == "" {
		u = os.Getenv("LOGNAME")
	}
	if u == "" {
		u = "root"
	}
	return u
}

func expandPath(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

// ResolveHostName applies ~/.ssh/config to resolve a host alias to its
// HostName directive value. Returns the original host if the config file
// cannot be read or has no matching HostName directive.
// This is a package-level function so the resolver (internal/connection)
// can call it without importing the ssh_config package directly.
func ResolveHostName(configPath, host string) string {
	// #nosec G304 -- configPath is the app-owned ~/.ssh/config location, not
	// renderer input; the renderer never names a file here.
	f, err := os.Open(configPath)
	if err != nil {
		return host
	}
	defer func() { _ = f.Close() }()

	sshCfg, err := ssh_config.Decode(f)
	if err != nil {
		return host
	}

	if hn, _ := sshCfg.Get(host, "HostName"); hn != "" {
		return hn
	}
	return host
}

// resolveAuthzEndpoint applies ~/.ssh/config HostName resolution to the host
// portion of an endpoint string. If the endpoint is already a resolved value
// (an IP address or real hostname, not an alias), this is a no-op. For an
// alias, it resolves through the same SSH config that resolveConfig uses for
// the dial target, so both sides of the authorization comparison go through
// the same resolution.
//
// An empty endpoint returns empty — inline auth has no authorization check.
func (rc *RealClient) resolveAuthzEndpoint(endpoint string) string {
	if endpoint == "" {
		return ""
	}
	authHost, authPortStr, err := net.SplitHostPort(endpoint)
	if err != nil {
		authHost = endpoint
		authPortStr = ""
	}

	sshCfg, err := rc.openSSHConfig()
	if err == nil && sshCfg != nil {
		if hn, _ := sshCfg.Get(authHost, "HostName"); hn != "" {
			authHost = hn
		}
	}

	if authPortStr != "" {
		return net.JoinHostPort(authHost, authPortStr)
	}
	return authHost
}

// checkAuthorization enforces that a linked credential is only submitted to
// the endpoint its profile authorizes. The authorized endpoint comes from the
// resolver's effective profile resolution, resolved through ~/.ssh/config
// to the canonical hostname. The check runs AFTER resolveConfig on the dial
// target, comparing the resolved authorized identity against the freshly-
// resolved dial target.
//
// authorizedEndpoint empty => the credential is unlinked (inline auth) —
// the caller must not call this function when Secrets is nil.
// Port is included when the effective profile specifies one, so the port
// check only runs when the format is "host:port".
//
// credID is carried only for the error message; authorization is decided by
// the endpoint the resolver computed from the effective profile.
func checkAuthorization(authorizedEndpoint string, resolved *resolvedConfig, credID string, jump bool) error {
	if authorizedEndpoint == "" {
		return &ErrCredentialAuthorizationFailed{
			CredentialID: credID,
			Expected:     "<none>",
			ResolvedHost: resolved.hostName,
			ResolvedPort: resolved.port,
			Jump:         jump,
		}
	}

	authHost, authPortStr, err := net.SplitHostPort(authorizedEndpoint)
	if err != nil {
		// No port in the endpoint — host-only authorization.
		authHost = authorizedEndpoint
		authPortStr = ""
	}

	// Host comparison: case-insensitive DNS name comparison (crude but correct
	// for ASCII DNS names and IP literals). IP literals are stored canonically
	// by the resolver (via net.JoinHostPort).
	if !strings.EqualFold(authHost, resolved.hostName) {
		return &ErrCredentialAuthorizationFailed{
			CredentialID: credID,
			Expected:     authorizedEndpoint,
			ResolvedHost: resolved.hostName,
			ResolvedPort: resolved.port,
			Jump:         jump,
		}
	}

	// Port comparison when the authorized endpoint includes one.
	if authPortStr != "" {
		authPort, err := strconv.Atoi(authPortStr)
		if err == nil && authPort != resolved.port {
			return &ErrCredentialAuthorizationFailed{
				CredentialID: credID,
				Expected:     authorizedEndpoint,
				ResolvedHost: resolved.hostName,
				ResolvedPort: resolved.port,
				Jump:         jump,
			}
		}
	}

	return nil
}
