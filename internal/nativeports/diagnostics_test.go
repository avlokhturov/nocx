package nativeports

import "runtime"

// lsofPathForDiagnostics names the external tool the current platform's
// provider depends on, for a failure message that has to be read from a CI log
// by someone who cannot reproduce it (nocx-ou3e). It is test-only: nothing in
// the provider should branch on the platform outside its build-tagged file.
func lsofPathForDiagnostics() string {
	if runtime.GOOS == "darwin" {
		return "/usr/sbin/lsof"
	}
	return "the platform's listener source"
}
