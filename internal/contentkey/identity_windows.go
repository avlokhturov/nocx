//go:build windows

package contentkey

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// readMachineID returns the stable per-machine identifier: the MachineGuid
// registry value (HKLM\SOFTWARE\Microsoft\Cryptography). It is not a
// secret — the salt is the secret ingredient of the derivation.
func readMachineID() (string, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE)
	if err != nil {
		return "", fmt.Errorf("open MachineGuid key: %w", err)
	}
	defer k.Close()
	guid, _, err := k.GetStringValue("MachineGuid")
	if err != nil {
		return "", fmt.Errorf("read MachineGuid: %w", err)
	}
	if guid == "" {
		return "", errors.New("MachineGuid is empty")
	}
	return guid, nil
}

// readUserID returns the stable per-user identifier: the user SID. Windows
// has no numeric uid; the SID is the closest stable per-user identity.
func readUserID() (string, error) {
	t, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", fmt.Errorf("open process token: %w", err)
	}
	defer t.Close()
	u, err := t.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("token user: %w", err)
	}
	return u.User.Sid.String(), nil
}
