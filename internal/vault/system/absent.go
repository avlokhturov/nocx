package system

// A machine with no usable OS keystore, stated once and portably.
//
// The e2e suite has cases that are ABOUT the passphrase path — vault setup with
// nothing to fall back on — and they need the backend to have no system store.
// Until now the only way to arrange that was DBUS_SESSION_BUS_ADDRESS pointed at
// a nonexistent socket, which is a Linux mechanism: on macOS go-keyring talks to
// the Security framework and the variable means nothing, so those cases were not
// expressing their condition there at all.
//
// Worse than not expressing it: a backend given a disposable $HOME on macOS
// looks for the login keychain under that home, does not find one, and macOS
// puts a "Keychain not found" dialog in front of whoever is running the suite —
// on their own machine, once per backend start (nocx-o4hg).
//
// AbsentKeyring is the honest way to say it: every operation fails with a reason
// naming the condition, on every platform, and the provider's Probe then reports
// unavailable exactly as it does on a machine that genuinely has no keystore.
import "errors"

// ErrNoKeystore is what an AbsentKeyring returns. It is a plain error rather
// than one of the keyring package's sentinels because it is not a keyring
// failure — it is the absence of a keyring.
var ErrNoKeystore = errors.New("system: this host has no OS keystore")

// AbsentKeyring is a Keyring for a host with no usable OS secret store. Pass it
// to WithKeyring to build a provider that is unavailable by construction:
//
//	system.New(system.WithKeyring(system.AbsentKeyring{}))
//
// Dev and test only — it is wired from cmd/devharness behind an environment
// variable, never from the shipped composition root.
type AbsentKeyring struct{}

func (AbsentKeyring) Set(_, _, _ string) error        { return ErrNoKeystore }
func (AbsentKeyring) Get(_, _ string) (string, error) { return "", ErrNoKeystore }
func (AbsentKeyring) Delete(_, _ string) error        { return ErrNoKeystore }
func (AbsentKeyring) DeleteAll(_ string) error        { return ErrNoKeystore }
