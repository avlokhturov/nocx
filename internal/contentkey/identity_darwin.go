//go:build darwin

package contentkey

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
)

// ioPlatformUUIDRe matches the IOPlatformUUID line of
// `ioreg -rd1 -c IOPlatformExpertDevice` — the hardware UUID macOS exposes,
// stable across reboots and reinstalls.
var ioPlatformUUIDRe = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([^"]+)"`)

// readMachineID returns the stable per-machine identifier: IOPlatformUUID.
// It is not a secret — the salt is the secret ingredient of the derivation.
func readMachineID() (string, error) {
	out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return "", fmt.Errorf("ioreg: %w", err)
	}
	m := ioPlatformUUIDRe.FindSubmatch(out)
	if len(m) < 2 {
		return "", errors.New("IOPlatformUUID not found in ioreg output")
	}
	return string(m[1]), nil
}

// readUserID returns the stable per-user identifier: the numeric uid.
func readUserID() (string, error) {
	return strconv.Itoa(os.Getuid()), nil
}
