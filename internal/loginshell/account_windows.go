//go:build windows

package loginshell

// readAccountShell has nothing to read: Windows accounts carry no login-shell
// field, so the resolver falls through to $SHELL and then to its candidates.
// Present so the package builds everywhere the rest of the backend does, the
// same shape internal/contentkey uses for a platform without the identity it
// wants.
func readAccountShell() (string, error) {
	return "", errNoAccountShell
}
