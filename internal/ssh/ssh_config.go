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
