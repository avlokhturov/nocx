package shellintegration

import (
	"encoding/json"
	"strings"
	"testing"
)

// files and entry are checked accessors: errcheck rejects a bare type
// assertion, and the mutators below need one on every line.
func files(m map[string]any) map[string]any {
	f, _ := m["files"].(map[string]any)
	return f
}

func entry(m map[string]any) map[string]any {
	e, _ := files(m)["nocx.bash"].(map[string]any)
	return e
}

func testBundle(version string) Bundle {
	return Bundle{
		Protocol: ProtocolVersion,
		Version:  version,
		Files: []BundleFile{
			{Name: "nocx.bash", Mode: 0o600, Data: []byte("#!/bin/sh\necho bash\n")},
			{Name: "nocx.zsh", Mode: 0o600, Data: []byte("#!/bin/sh\necho zsh\n")},
			{Name: "nocx.posix", Mode: 0o600, Data: []byte("echo posix\n")},
		},
	}
}

func TestParseManifestRoundTrip(t *testing.T) {
	m := buildManifest(testBundle("10"))
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got, err := parseManifest(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.Protocol != m.Protocol || got.Version != m.Version || got.Generation != m.Generation {
		t.Errorf("round trip mismatch: %+v vs %+v", got, m)
	}
	if len(got.Files) != 3 {
		t.Fatalf("want 3 files, got %d", len(got.Files))
	}
	for name, want := range m.Files {
		if got.Files[name] != want {
			t.Errorf("file %s mismatch: %+v vs %+v", name, got.Files[name], want)
		}
	}
}

// TestParseManifestRejects pins design §4.1: a manifest entry naming an
// absolute path, a ".." segment, an unknown key or a symlink invalidates
// the whole manifest. Symlinks are checked on disk by Verify; every other
// violation here must fail the parse outright.
func TestParseManifestRejects(t *testing.T) {
	valid := func() map[string]any {
		return map[string]any{
			"protocol":   ProtocolVersion,
			"version":    "10",
			"generation": "v10",
			"files": map[string]any{
				"nocx.bash": map[string]any{
					"hash": "sha256:" + strings.Repeat("ab", 32),
					"mode": "0600",
					"size": 3,
				},
			},
		}
	}
	cases := []struct {
		name string
		mut  func(map[string]any)
	}{
		{"not JSON", func(m map[string]any) {}},
		{"unknown top-level key", func(m map[string]any) { m["evil"] = 1 }},
		{"missing protocol", func(m map[string]any) { delete(m, "protocol") }},
		{"zero protocol", func(m map[string]any) { m["protocol"] = 0 }},
		{"missing version", func(m map[string]any) { delete(m, "version") }},
		{"absolute version", func(m map[string]any) { m["version"] = "/etc/passwd" }},
		{"absolute file key", func(m map[string]any) {
			files(m)["/etc/passwd"] = files(m)["nocx.bash"]
		}},
		{"dotdot file key", func(m map[string]any) {
			files(m)["../evil"] = files(m)["nocx.bash"]
		}},
		{"nested file key", func(m map[string]any) {
			files(m)["a/b"] = files(m)["nocx.bash"]
		}},
		{"dot file key", func(m map[string]any) {
			files(m)["."] = files(m)["nocx.bash"]
		}},
		{"unknown file entry key", func(m map[string]any) {
			f := entry(m)
			f["payload"] = "x"
		}},
		{"no files", func(m map[string]any) { delete(m, "files") }},
		{"empty files", func(m map[string]any) { m["files"] = map[string]any{} }},
		{"bad hash algorithm", func(m map[string]any) {
			entry(m)["hash"] = "md5:abc"
		}},
		{"short hash", func(m map[string]any) {
			entry(m)["hash"] = "sha256:abc"
		}},
		{"bad mode digits", func(m map[string]any) {
			entry(m)["mode"] = "0644"
		}},
		{"three-digit mode", func(m map[string]any) {
			entry(m)["mode"] = "644"
		}},
		{"world-writable mode", func(m map[string]any) {
			entry(m)["mode"] = "0666"
		}},
		{"negative size", func(m map[string]any) {
			entry(m)["size"] = -1
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := valid()
			if tc.name != "not JSON" {
				tc.mut(raw)
			}
			var data []byte
			var err error
			if tc.name == "not JSON" {
				data = []byte("{not json")
			} else {
				data, err = json.Marshal(raw)
				if err != nil {
					t.Fatalf("marshal: %v", err)
				}
			}
			if _, err := parseManifest(data); err == nil {
				t.Error("parseManifest accepted an invalid manifest")
			}
		})
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"10", "10", 0},
		{"10", "11", -1},
		{"9", "10", -1},
		{"1.2.3", "1.2.10", -1}, // numeric, not lexical: 10 > 3
		{"1.2.3", "1.2.3", 0},
		{"1.2", "1.2.3", -1}, // shorter sequence is smaller
		{"0.2026.07.15.08.55.stable_01", "0.2026.07.29.09.05.stable_02", -1},
		{"1.0", "1.0.0", -1},
		{"2", "1.9.9", 1},
	}
	for _, tc := range cases {
		if got := compareVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestValidateBundle(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Bundle)
	}{
		{"wrong protocol", func(b *Bundle) { b.Protocol = 99 }},
		{"unsafe version", func(b *Bundle) { b.Version = "../x" }},
		{"no files", func(b *Bundle) { b.Files = nil }},
		{"unsafe file name", func(b *Bundle) { b.Files[0].Name = "a/b" }},
		{"generation file wrong mode", func(b *Bundle) { b.Files[0].Mode = 0o644 }},
		{"duplicate file", func(b *Bundle) { b.Files = append(b.Files, b.Files[0]) }},
		{"launch wrong mode", func(b *Bundle) {
			b.Files = append(b.Files, BundleFile{Name: launchName, Mode: 0o600, Data: []byte("x")})
		}},
		{"launch empty", func(b *Bundle) {
			b.Files = append(b.Files, BundleFile{Name: launchName, Mode: 0o700})
		}},
		{"launch only", func(b *Bundle) { b.Files = []BundleFile{{Name: launchName, Mode: 0o700, Data: []byte("x")}} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := testBundle("10")
			tc.mut(&b)
			if err := validateBundle(b); err == nil {
				t.Error("validateBundle accepted an invalid bundle")
			}
		})
	}

	// A bundle with the launch carrier is valid.
	b := testBundle("10")
	b.Files = append(b.Files, BundleFile{Name: launchName, Mode: 0o700, Data: []byte("#!/bin/sh\nexec /bin/sh\n")})
	if err := validateBundle(b); err != nil {
		t.Errorf("valid bundle with launch rejected: %v", err)
	}
}
