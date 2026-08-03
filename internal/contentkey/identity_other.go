//go:build !linux && !darwin && !windows

package contentkey

import "errors"

// readMachineID and readUserID are unimplemented on platforms nocx does not
// ship for: a host that cannot name itself cannot derive a key, and history
// stays unavailable (the caller's no-history fallback) rather than minting a
// key that would rotate on the first restart.
func readMachineID() (string, error) {
	return "", errors.New("machine identity is not implemented on this platform")
}

func readUserID() (string, error) {
	return "", errors.New("user identity is not implemented on this platform")
}
