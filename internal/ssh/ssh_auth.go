package ssh

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/shady2k/nocx/internal/credential"
	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// ---------------------------------------------------------------------------
// Auth fallback chain (Tabby-parity)
// ---------------------------------------------------------------------------

// authMethodKind labels a bucket in the fallback chain.
type authMethodKind int

const (
	kindNone authMethodKind = iota
	kindPublicKey
	kindAgent
	kindSavedPassword
	kindKeyboardInteractive
	kindPromptPassword
	kindHostbased
)

// authChainEntry is one bucket in the ordered fallback chain.
type authChainEntry struct {
	kind     authMethodKind
	method   gossh.AuthMethod
	password string
}

// buildAuthChain builds the ordered auth fallback chain, porting Tabby's
// SSHSession.init(). Order: none → publicKey(s) → agent → savedPassword →
// keyboard-interactive → promptPassword → hostbased.
func (rc *RealClient) buildAuthChain(resolved *resolvedConfig, cfg *ConnectConfig) ([]authChainEntry, error) {
	if len(cfg.AuthMethods) > 0 {
		chain := make([]authChainEntry, 0, len(cfg.AuthMethods))
		for _, m := range cfg.AuthMethods {
			chain = append(chain, authChainEntry{kind: kindPublicKey, method: m})
		}
		return chain, nil
	}

	mode := cfg.AuthMode
	var chain []authChainEntry

	chain = append(chain, authChainEntry{kind: kindNone})

	if mode == "" || mode == "publicKey" {
		rc.addPublicKeyMethods(&chain, resolved)
	}

	if (mode == "" || mode == "agent") && rc.agentAvailable() {
		rc.addAgentMethods(&chain)
	}

	if mode == "" || mode == "password" {
		rc.addPasswordMethods(&chain, cfg)
	}

	if mode == "" || mode == "keyboardInteractive" {
		rc.addKeyboardInteractiveMethods(&chain, cfg)
	}

	if mode == "" || mode == "password" {
		chain = append(chain, authChainEntry{kind: kindPromptPassword})
	}

	chain = append(chain, authChainEntry{kind: kindHostbased})

	return chain, nil
}

func (rc *RealClient) addPublicKeyMethods(chain *[]authChainEntry, resolved *resolvedConfig) {
	if resolved.identityFile != "" {
		if signer, err := rc.loadKey(resolved.identityFile); err == nil {
			*chain = append(*chain, authChainEntry{kind: kindPublicKey, method: gossh.PublicKeys(signer)})
		}
	}

	for _, path := range defaultKeyPaths() {
		signer, err := rc.loadKey(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			var encKeyErr *ErrEncryptedKey
			if errors.As(err, &encKeyErr) {
				rc.log.Debug("skipping encrypted key in chain", "path", path)
			}
			continue
		}
		*chain = append(*chain, authChainEntry{kind: kindPublicKey, method: gossh.PublicKeys(signer)})
	}
}

func (rc *RealClient) addAgentMethods(chain *[]authChainEntry) {
	if am := rc.agentMethods(); len(am) > 0 {
		for _, m := range am {
			*chain = append(*chain, authChainEntry{kind: kindAgent, method: m})
		}
	}
}

func (rc *RealClient) addPasswordMethods(chain *[]authChainEntry, cfg *ConnectConfig) {
	if cfg.Credentials != nil {
		if stored, err := cfg.Credentials.LookupPassword(cfg.CredIdentity); err == nil && stored != "" {
			*chain = append(*chain, authChainEntry{kind: kindSavedPassword, method: gossh.Password(stored), password: stored})
		} else if err != nil {
			rc.log.Debug("credential lookup failed", "error", err)
		}
	}
}

func (rc *RealClient) addKeyboardInteractiveMethods(chain *[]authChainEntry, cfg *ConnectConfig) {
	if cfg.Credentials != nil {
		if stored, err := cfg.Credentials.LookupPassword(cfg.CredIdentity); err == nil && stored != "" {
			*chain = append(*chain, authChainEntry{kind: kindKeyboardInteractive, password: stored})
		}
	}
	*chain = append(*chain, authChainEntry{kind: kindKeyboardInteractive})
}

// authMethodsFromChain extracts the concrete gossh.AuthMethod values from the chain.
func authMethodsFromChain(chain []authChainEntry) []gossh.AuthMethod {
	var methods []gossh.AuthMethod
	for _, entry := range chain {
		if entry.method != nil {
			methods = append(methods, entry.method)
		}
	}
	return methods
}

// lookupKeyPassphrase resolves a private-key passphrase by hash from the credential store.
func (rc *RealClient) lookupKeyPassphrase(store credential.CredentialStore, hash credential.KeyHash) (string, error) {
	if store == nil {
		return "", nil
	}
	return store.LookupKeyPassphrase(hash)
}

// agentAvailable checks whether SSH_AUTH_SOCK is set.
func (rc *RealClient) agentAvailable() bool {
	return os.Getenv("SSH_AUTH_SOCK") != ""
}

// defaultKeyPaths returns the conventional default private key paths.
func defaultKeyPaths() []string {
	home := os.Getenv("HOME")
	if home == "" {
		return nil
	}
	return []string{
		filepath.Join(home, ".ssh", "id_ed25519"),
		filepath.Join(home, ".ssh", "id_rsa"),
		filepath.Join(home, ".ssh", "id_ecdsa"),
	}
}

func (rc *RealClient) loadKey(path string) (gossh.Signer, error) {
	data, err := os.ReadFile(path) //nolint:gosec
	if err != nil {
		return nil, err
	}

	signer, err := gossh.ParsePrivateKey(data)
	if err != nil {
		var passErr *gossh.PassphraseMissingError
		if errors.As(err, &passErr) {
			return nil, &ErrEncryptedKey{Path: path}
		}
		return nil, fmt.Errorf("parse key %s: %w", path, err)
	}
	return signer, nil
}

func (rc *RealClient) agentMethods() []gossh.AuthMethod {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil
	}

	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil
	}
	_ = conn.Close()

	return []gossh.AuthMethod{
		gossh.PublicKeysCallback(func() ([]gossh.Signer, error) {
			conn, err := net.Dial("unix", sock)
			if err != nil {
				return nil, err
			}
			defer func() { _ = conn.Close() }()
			return agent.NewClient(conn).Signers()
		}),
	}
}
