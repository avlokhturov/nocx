//go:build darwin

package loginshell

import "testing"

// TestParseDSCLUserShell covers the shapes `dscl . -read` actually produces,
// including the folded one: dscl puts a long value on the line after the key,
// indented, and a parser that only ever reads the key's own line answers "" for
// it — which the resolver would read as "this machine has no account record"
// and quietly fall back to a $SHELL a Dock launch does not have.
func TestParseDSCLUserShell(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want string
	}{
		{"the ordinary one-line form", "UserShell: /bin/zsh\n", "/bin/zsh"},
		{"no trailing newline", "UserShell: /bin/bash", "/bin/bash"},
		{"a folded value", "UserShell:\n    /opt/homebrew/bin/zsh\n", "/opt/homebrew/bin/zsh"},
		{"a key we did not ask for is ignored", "RecordName: shady\nUserShell: /bin/zsh\n", "/bin/zsh"},
		{"no such key", "RecordName: shady\n", ""},
		{"an empty answer", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseDSCLUserShell(tt.out); got != tt.want {
				t.Errorf("parseDSCLUserShell(%q) = %q, want %q", tt.out, got, tt.want)
			}
		})
	}
}

// TestReadAccountShell_NamesTheMacDefault is the platform half of the paired
// assertion, stated where it is checkable: macOS has shipped zsh as the default
// login shell since Catalina, and the whole of nocx-wwz0 is that nocx opened
// bash anyway. This does not demand zsh — a developer may legitimately have
// chsh'd — it demands that whatever dscl says is what the resolver reports,
// with the account record as the source and not a $SHELL that agreed by luck.
func TestReadAccountShell_NamesTheMacDefault(t *testing.T) {
	want, err := readAccountShell()
	if err != nil {
		t.Fatalf("readAccountShell: %v", err)
	}
	got := New().Resolve()
	if got.Path != want {
		t.Errorf("Resolve() = %q, want the account record's %q", got.Path, want)
	}
	if got.Source != SourceAccount {
		t.Errorf("source = %q, want %q — on macOS the record is the authority", got.Source, SourceAccount)
	}
}
