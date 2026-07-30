//go:build linux

// Package system provides the OS keychain provider backed by the
// freedesktop.org Secret Service (org.freedesktop.secrets) over D-Bus.
//
// Linux build only: the package is gated by a build constraint because
// go-keyring's backend is platform-specific and the D-Bus probe below
// is meaningless on macOS/Windows.
package system

import (
	dbus "github.com/godbus/dbus/v5"
)

// SecretServiceAvailable reports whether a running Secret Service
// (org.freedesktop.secrets) is reachable on the session bus.
//
// A test that exercises the OS keychain should call this at the top
// and t.Skipf with a descriptive message when it returns false:
//
//	if !system.SecretServiceAvailable() {
//	    t.Skipf("skipping: no Secret Service on the session bus")
//	}
func SecretServiceAvailable() bool {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return false
	}
	defer func() { _ = conn.Close() }()

	var hasOwner bool
	if err := conn.BusObject().Call(
		"org.freedesktop.DBus.NameHasOwner", 0,
		"org.freedesktop.secrets",
	).Store(&hasOwner); err != nil {
		return false
	}
	return hasOwner
}
