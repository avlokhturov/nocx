package secrets

import (
	"reflect"
	"strings"
	"testing"
)

// Golden cases both ways: real keys of every kind masked, plus the shapes
// that must be left alone — commit SHAs, UUIDs, base64 contents, long paths
// and --output-style long args are not secrets and masking one of them would
// corrupt a command the user will re-run and cannot explain.
func TestMaskGoldenCases(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		kind Kind
	}{
		{"openai", "sk-proj-abcdef1234567890", "sk-p...7890", KindOpenAI},
		{"github classic pat", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_...6789", KindGitHubPAT},
		{"slack token", "xoxp-abcdefghijklmnopqrstuvwxyz1234567890", "xoxp...7890", KindSlack},
		{"aws access key", "AKIAIOSFODNN7EXAMPLE", "AKIA...MPLE", KindAWSAccessKey},
		{"gitlab pat", "glpat-abcdefghijklmnopqrstuvwxyz123456", "glpa...3456", KindGitLab},
		{"jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "eyJh...sw5c", KindJWT},
		{"private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7dGJ\n-----END RSA PRIVATE KEY-----", "[REDACTED PRIVATE KEY]", KindPrivateKey},
		{"url userinfo", "https://user:sup3rs3cret@api.example.com/v1", "https://user:***@api.example.com/v1", KindURLUserinfo},
		{"github pat inside url userinfo", "https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/org/repo.git", "https://ghp_...6789@github.com/org/repo.git", KindGitHubPAT},
		{"db connstring", "postgres://dbuser:dbpass123@db.internal:5432/main", "postgres://dbuser:***@db.internal:5432/main", KindDBConnstring},
		{"dollar-prefixed literal is not a reference", `deploy --password='$2a$10$abcdefghijklmnopqrstuvwxyz123456'`, `deploy --password='$2a$...3456'`, KindHighEntropy},
		{"secret header", `curl -H "x-api-key: abcdefghijklmnopqrstuvwxyz123456" https://api`, `curl -H "x-api-key: abcd...3456" https://api`, KindAuthHeader},
		{"env assignment long value", "export OPENAI_TOKEN=abcdefghijklmnopqrstuvwxyz ./run.sh", "export OPENAI_TOKEN=abcd...wxyz ./run.sh", KindEnvAssignment},
		{"env assignment short value", "TOKEN=short", "TOKEN=***", KindEnvAssignment},
		{"env assignment quoted", `TOKEN="abcdefghijklmnopqrstuvwxyz"`, `TOKEN="abcd...wxyz"`, KindEnvAssignment},
		{"high-entropy after flag", "deploy --token abcdefghijklmnopqrstuvwxyz123456", "deploy --token abcd...3456", KindHighEntropy},
		{"high-entropy flag equals", "deploy --password=abcdefghijklmnopqrstuvwxyz123456", "deploy --password=abcd...3456", KindHighEntropy},
		{"high-entropy quoted value", "deploy --token='abcdefghijklmnopqrstuvwxyz123456'", "deploy --token='abcd...3456'", KindHighEntropy},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, findings := Mask(tc.in)
			if got != tc.want {
				t.Errorf("Mask(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if len(findings) != 1 {
				t.Fatalf("Mask(%q) findings = %+v, want exactly one", tc.in, findings)
			}
			if findings[0].Kind != tc.kind {
				t.Errorf("kind = %q, want %q", findings[0].Kind, tc.kind)
			}
			if !strings.Contains(tc.in, tc.in[findings[0].Start:findings[0].End]) {
				t.Fatalf("finding span [%d:%d] does not slice the input", findings[0].Start, findings[0].End)
			}
		})
	}
}

// The shapes that are NOT secrets and must pass through byte-for-byte: long
// bare words, paths, git SHAs, UUIDs, base64 file contents, --output-style
// long arguments, web-URL query strings, and prose that merely contains a
// secret keyword.
func TestMaskNegativeCases(t *testing.T) {
	cases := []string{
		"git checkout 9f8e7d6c5b4a3928172635445362718291048576",
		"cat /tmp/550e8400-e29b-41d4-a716-446655440000.log",
		`echo "aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyBmb3IgdGVzdGluZw=="`,
		"/home/user/very/long/path/to/some/deeply/nested/directory/file.txt",
		"prog --output /tmp/some/long/output/file/name/that/goes/on/and/on/forever.txt",
		"prog --output=/tmp/some/long/output/file/name/that/goes/on/and/on/forever.txt",
		"https://example.com/cb?code=ABC123&state=xyz",
		"ssh user@10.0.0.1 -p 2222",
		"author=Smith",
		"keyboard=abc",
		"ls -la /var/log/something/very/long/that/is/just/a/path/with/no/equals/or/flags",
		"echo 550e8400e29b41d4a716446655440000",
		// A bare token in URL userinfo is a username, not a credential — no
		// floor separates the two, and the prefix families already cover
		// real tokens in URLs.
		"ssh://developer@example.com",
		"git clone ssh://myusername@github.com/o/r.git",
		"https://sup3rt0kenvalue12345@github.com/org/repo.git",
		// Values that NAME a secret are not secrets: shell expansions,
		// command substitutions, programmatic env lookups and vault
		// references. Masking one loses information and gains nothing.
		`curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api`,
		`curl -H "Authorization: Bearer ${OPENAI_API_KEY}" https://api`,
		`curl -H "Authorization: Bearer $(pass show gh/token)" https://api`,
		`curl -H "Authorization: Bearer {{secret:OPENAI}}" https://api`,
		"curl -H \"Authorization: Bearer `pass show gh/token`\" https://api",
		`curl -H "x-api-key: $API_KEY" https://api`,
		"TOKEN={{secret:GH}} gh repo list",
		"TOKEN='{{secret:GH}}' ./run.sh",
		"TOKEN=${OPENAI_API_KEY} ./run.sh",
		"export GITHUB_TOKEN=$(pass show gh/token)",
		`export GITHUB_TOKEN="$(pass show gh/token)"`,
		`export GITHUB_TOKEN='pass show gh/token'`,
		`export TOKEN="some pass phrase with spaces"`,
		"export API_KEY=os.getenv('X') ./run.sh",
		"export API_KEY=process.env.TOKEN ./run.sh",
		"export API_KEY=$ENV{TOKEN} ./run.sh",
		`--token "$(cat /tmp/some/very/long/secret/file/path/here.txt)"`,
		`--token '$(cat /tmp/some/very/long/secret/file/path/here.txt)'`,
	}
	for _, in := range cases {
		got, findings := Mask(in)
		if got != in {
			t.Errorf("Mask(%q) = %q, want unchanged", in, got)
		}
		if len(findings) != 0 {
			t.Errorf("Mask(%q) findings = %+v, want none", in, findings)
		}
	}
}

// The invariant part 2 exists to protect, in the owner's terms: a command
// carrying a vault reference goes through Mask byte for byte. The durable
// text is the reference — a command that resolves on another machine must
// not be shredded into a mask on the way into the ledger.
func TestMaskLeavesReferencesByteForByte(t *testing.T) {
	cases := []string{
		`curl -H "Authorization: Bearer {{secret:OPENAI}}" https://api`,
		"TOKEN={{secret:GH}} gh repo list",
		"export GITHUB_TOKEN={{secret:GH}} && ./run.sh",
		`deploy --token "{{secret:db-password}}" --region eu`,
		"echo {{secret:with space in name}}",
	}
	for _, in := range cases {
		got, findings := Mask(in)
		if got != in {
			t.Errorf("Mask(%q) = %q, want the reference intact byte for byte", in, got)
		}
		if len(findings) != 0 {
			t.Errorf("Mask(%q) findings = %+v, want none — a reference is not a secret", in, findings)
		}
	}
}

// The prefix boundary guard: a vendor prefix inside a word is not a key.
func TestMaskPrefixBoundaryGuard(t *testing.T) {
	cases := []string{
		"mysk-proj-abcdefghijklmnopqrstuvwxyz",
		"prefix_ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
		"mxoxp-token-abcdefghijklmnopqrstuvwxyz1234567890-suffix",
		"xsk-proj-abcdefghijklmnopqrstuvwxyz",
		"AKIAIOSFODNN7EXAMPLEa",
	}
	for _, in := range cases {
		got, _ := Mask(in)
		if got != in {
			t.Errorf("Mask(%q) = %q, want unchanged (boundary guard)", in, got)
		}
	}
}

// Overlap resolution is deterministic and precise: when a token sits inside a
// higher-entropy value position, the recognised kind wins and the recorded
// finding is exactly the replacement that was made.
func TestMaskOverlapResolutionDeterministic(t *testing.T) {
	in := "deploy --token sk-proj-abcdefghijklmnopqrstuvwxyz123456"
	got, findings := Mask(in)
	want := "deploy --token sk-p...3456"
	if got != want {
		t.Errorf("Mask(%q) = %q, want %q", in, got, want)
	}
	if len(findings) != 1 || findings[0].Kind != KindOpenAI {
		t.Fatalf("findings = %+v, want exactly one openai finding (the recognised prefix beats the position heuristic)", findings)
	}
	// Deterministic across calls.
	got2, findings2 := Mask(in)
	if got2 != got || !reflect.DeepEqual(findings2, findings) {
		t.Fatalf("Mask is not deterministic: %q vs %q, %+v vs %+v", got2, got, findings2, findings)
	}
}

// Findings are byte offsets into the original input, so a UTF-8 command's
// offsets stay correct. The invariant that binds the findings to the mask:
// every finding span slices the input, no finding's original text survives
// into the masked output, and everything outside the spans is untouched.
func TestMaskFindingsAreByteOffsetsAndReproduceMask(t *testing.T) {
	in := "выполнить TOKEN=abcdefghijklmnopqrstuvwxyz123456"
	got, findings := Mask(in)
	if !strings.Contains(got, "TOKEN=abcd...3456") {
		t.Fatalf("Mask(%q) = %q, want the token masked", in, got)
	}
	if len(findings) != 1 {
		t.Fatalf("findings = %+v, want one", findings)
	}
	// The finding start must be the byte offset: "выполнить " is 9 runes and
	// 9*2+1 = 19 bytes into the string.
	if findings[0].Start != 19 {
		t.Errorf("Start = %d, want 19 (byte offset past the UTF-8 prefix)", findings[0].Start)
	}
	f := findings[0]
	if f.End <= f.Start || f.End > len(in) {
		t.Fatalf("span [%d:%d] does not slice the input (len %d)", f.Start, f.End, len(in))
	}
	if strings.Contains(got, in[f.Start:f.End]) {
		t.Errorf("the finding's original text survives in the output: %q", in[f.Start:f.End])
	}
	if !strings.HasPrefix(got, "выполнить ") || !strings.HasSuffix(got, "") {
		t.Errorf("text outside the finding span was touched: %q", got)
	}
}

// A UTF-8 secret value is masked without splitting runes: the masked output
// must remain valid UTF-8 and keep the right head/tail runes.
func TestMaskRuneSafeValue(t *testing.T) {
	// 32 Cyrillic runes in a credential value position.
	in := "deploy --token абвгдежзиклмнопрстуфхцчшщъыьэюяя"
	got, findings := Mask(in)
	if len(findings) != 1 || findings[0].Kind != KindHighEntropy {
		t.Fatalf("findings = %+v, want one high-entropy", findings)
	}
	if !strings.HasPrefix(got, "deploy --token абвг...эюяя") {
		t.Errorf("Mask(%q) = %q, want the rune-safe mask", in, got)
	}
	if strings.ContainsRune(got, '\uFFFD') {
		t.Errorf("masked output contains a replacement rune: %q", got)
	}
}

// A long bare word after a non-credential flag or in a plain argument
// position is not masked, even at 40+ characters.
func TestMaskLongBareWordsLeftAlone(t *testing.T) {
	cases := []string{
		"run --batch abcdefghijklmnopqrstuvwxyz1234567890",
		"tool name=abcdefghijklmnopqrstuvwxyz1234567890",
	}
	for _, in := range cases {
		got, findings := Mask(in)
		if got != in {
			t.Errorf("Mask(%q) = %q, want unchanged", in, got)
		}
		if len(findings) != 0 {
			t.Errorf("Mask(%q) findings = %+v, want none", in, findings)
		}
	}
}

// Every Kind in the closed vocabulary is exercised by at least one golden
// case above; this pins the vocabulary itself so a new kind is a deliberate
// addition, never a silent one.
func TestKindVocabulary(t *testing.T) {
	want := []Kind{
		KindOpenAI, KindGitHubPAT, KindSlack, KindAWSAccessKey, KindGitLab,
		KindJWT, KindPrivateKey, KindURLUserinfo, KindDBConnstring,
		KindAuthHeader, KindEnvAssignment, KindHighEntropy,
	}
	if !reflect.DeepEqual(allKinds(), want) {
		t.Errorf("vocabulary = %v, want %v — a new kind is a deliberate addition", allKinds(), want)
	}
}

func allKinds() []Kind {
	return []Kind{
		KindOpenAI, KindGitHubPAT, KindSlack, KindAWSAccessKey, KindGitLab,
		KindJWT, KindPrivateKey, KindURLUserinfo, KindDBConnstring,
		KindAuthHeader, KindEnvAssignment, KindHighEntropy,
	}
}

// A reference NAME that looks like a vendor key is still a NAME. Found by the
// vault-ui worker's probe: `{{secret:sk-proj-mine}}` came back from the store
// as `{{secret:sk-p...mine}}`, a reference that can never resolve — the exact
// invariant the package exists to protect, broken by the one rule family that
// deliberately skipped the isReference guard.
func TestMaskNeverReachesInsideAReference(t *testing.T) {
	for _, in := range []string{
		`curl -H "Authorization: Bearer {{secret:sk-proj-mine}}" https://api.example.com`,
		`TOKEN={{secret:ghp_teamwide}} gh repo list`,
		`curl -H "x-api-key: {{secret:AKIAIOSFODNN7EXAMPLE}}" https://api.example.com`,
		`echo {{secret:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9}}`,
	} {
		if got, findings := Mask(in); got != in {
			t.Errorf("Mask(%q)\n = %q\nwant it unchanged (findings %+v)", in, got, findings)
		}
	}
}

// And the guard is not a blanket amnesty: a real key sitting NEXT to a
// reference is still masked.
func TestMaskStillCatchesAKeyBesideAReference(t *testing.T) {
	in := `curl -H "A: {{secret:mine}}" -H "B: sk-proj-abcdef1234567890" x`
	got, findings := Mask(in)
	if !strings.Contains(got, `{{secret:mine}}`) {
		t.Errorf("the reference was altered: %q", got)
	}
	if strings.Contains(got, "sk-proj-abcdef1234567890") {
		t.Errorf("the literal key survived: %q", got)
	}
	if len(findings) != 1 {
		t.Errorf("findings = %+v, want exactly the literal key", findings)
	}
}

// An Authorization header whose credential has not been typed yet. Found in
// the product: deleting a key to paste a new one leaves
// `Authorization: Bearer ` on screen, and this PANICKED — the scheme group is
// optional, an absent group's indexes are -1, and the replacement sliced the
// input as [:-1], taking the record handler down with it. The second half is
// the false positive it exposed: a lone scheme word is not a credential.
func TestAuthHeaderWithNoCredentialYet(t *testing.T) {
	for _, in := range []string{
		`curl -H "Authorization: Bearer " https://api`,
		`curl -H "Authorization: Bearer" https://api`,
		`curl -H "Authorization: Basic " https://api`,
		`curl -H "Authorization: " https://api`,
		`curl -H "Authorization:" https://api`,
		`curl -H "Proxy-Authorization: Digest " https://api`,
	} {
		got, findings := Mask(in)
		if got != in {
			t.Errorf("Mask(%q) = %q, want unchanged — no credential was typed", in, got)
		}
		if len(findings) != 0 {
			t.Errorf("Mask(%q) findings = %+v, want none", in, findings)
		}
	}
}

// And the header still masks a real credential, with and without a scheme.
func TestAuthHeaderStillMasksARealCredential(t *testing.T) {
	cases := map[string]string{
		`curl -H "Authorization: Bearer abcdefghijklmnop" x`: `curl -H "Authorization: Bearer abcd...mnop" x`,
		`curl -H "Authorization: abcdefghijklmnop" x`:        `curl -H "Authorization: abcd...mnop" x`,
	}
	for in, want := range cases {
		if got, _ := Mask(in); got != want {
			t.Errorf("Mask(%q) = %q, want %q", in, got, want)
		}
	}
}
