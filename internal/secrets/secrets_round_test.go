package secrets

// The round's additions to the detector (backend half of the secrets
// redesign): the credential VALUE span inside a finding (what a capture
// holds and a save stores), the masked-span segments the durable row keeps,
// UTF-16 conversion for the renderer, and the host/env/kind name
// derivation. Plus the regression the round exists to pin: absent optional
// regex groups must never slice the input.

import (
	"strings"
	"testing"
	"unicode/utf16"
)

// The panic that started the round, and the absent-group shapes around it.
// `curl -H "Authorization: Bearer "` crashed the record handler (absent
// optional scheme group, index -1, sliced). Fixed on main; these pin it.
func TestMaskAbsentGroupsNeverPanic(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		want  string // the masked line — for these, the line itself
		count int
	}{
		{"trailing space after scheme", `curl -H "Authorization: Bearer "`, `curl -H "Authorization: Bearer "`, 0},
		{"bare header colon", `curl -H "Authorization: "`, `curl -H "Authorization: "`, 0},
		{"scheme alone, no space", `curl -H "Authorization: Bearer"`, `curl -H "Authorization: Bearer"`, 0},
		{"empty token with space", `curl -H "x-api-key: " https://api`, `curl -H "x-api-key: " https://api`, 0},
		{"header value is a scheme word", `curl -H "Authorization: Basic"`, `curl -H "Authorization: Basic"`, 0},
		// The credential actually present: the same rule must still fire.
		{"basic token present", `curl -H "Authorization: Basic dXNlcjpwYXNz" https://api`, `curl -H "Authorization: Basic dXNl...YXNz" https://api`, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, findings := Mask(tc.in)
			if got != tc.want {
				t.Errorf("Mask(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if len(findings) != tc.count {
				t.Errorf("findings = %+v, want %d", findings, tc.count)
			}
		})
	}
}

// A finding's ValueStart/ValueEnd is the CREDENTIAL inside it — the thing a
// capture would hold and a save would store. For whole-match rules it is the
// match; for structural rules it is the value token, quotes stripped.
func TestFindingValueSpans(t *testing.T) {
	cases := []struct {
		name string
		in   string
		kind Kind
		want string // the value the finding names
	}{
		{"vendor prefix is the whole match", "sk-proj-abcdef1234567890", KindOpenAI, "sk-proj-abcdef1234567890"},
		{"jwt is the whole match", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", KindJWT, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"},
		{"env assignment value only", "export OPENAI_TOKEN=abcdefghijklmnopqrstuvwxyz ./run.sh", KindEnvAssignment, "abcdefghijklmnopqrstuvwxyz"},
		{"env assignment quoted value unquoted", `TOKEN="abcdefghijklmnopqrstuvwxyz"`, KindEnvAssignment, "abcdefghijklmnopqrstuvwxyz"},
		{"env assignment single-quoted", `TOKEN='abcdefghijklmnopqrstuvwxyz'`, KindEnvAssignment, "abcdefghijklmnopqrstuvwxyz"},
		{"env assignment short", "TOKEN=short", KindEnvAssignment, "short"},
		{"auth header token only", `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://api`, KindAuthHeader, "abcdefghijklmnopqrstuvwxyz123456"},
		{"secret header value only", `curl -H "x-api-key: abcdefghijklmnopqrstuvwxyz123456" https://api`, KindAuthHeader, "abcdefghijklmnopqrstuvwxyz123456"},
		{"db connstring password only", "postgres://dbuser:dbpass123@db.internal:5432/main", KindDBConnstring, "dbpass123"},
		{"url userinfo password only", "https://user:sup3rs3cret@api.example.com/v1", KindURLUserinfo, "sup3rs3cret"},
		{"high-entropy quoted inner text", `deploy --token='abcdefghijklmnopqrstuvwxyz123456'`, KindHighEntropy, "abcdefghijklmnopqrstuvwxyz123456"},
		{"high-entropy bare value", "deploy --token abcdefghijklmnopqrstuvwxyz123456", KindHighEntropy, "abcdefghijklmnopqrstuvwxyz123456"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, findings := Mask(tc.in)
			if len(findings) != 1 {
				t.Fatalf("findings = %+v, want exactly one", findings)
			}
			f := findings[0]
			if f.Kind != tc.kind {
				t.Fatalf("kind = %q, want %q", f.Kind, tc.kind)
			}
			if got := tc.in[f.ValueStart:f.ValueEnd]; got != tc.want {
				t.Errorf("value = %q, want %q (span [%d:%d])", got, tc.want, f.ValueStart, f.ValueEnd)
			}
			// The value span sits inside the finding span: a finding is
			// offsets only, and the value is a sub-region of it.
			if f.ValueStart < f.Start || f.ValueEnd > f.End || f.ValueStart > f.ValueEnd {
				t.Errorf("value span [%d:%d] outside finding [%d:%d]", f.ValueStart, f.ValueEnd, f.Start, f.End)
			}
		})
	}
}

// MaskWithSegments returns, per finding, the span of its replacement in the
// MASKED string and the head/tail the mask shows — the durable row's shape.
// The masked string pins the text; the segment spans are derived from it by
// index, so a text drift fails here rather than silently re-deriving.
func TestMaskWithSegments(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		// the text that must sit at the segment's span (its exact mask)
		segTexts []string
		segs     []Segment
	}{
		{
			"vendor prefix",
			`curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://api`,
			`curl -H "Authorization: Bearer sk-p...7890" https://api`,
			[]string{"sk-p...7890"},
			[]Segment{{Prefix: "sk-p", Suffix: "7890"}},
		},
		{
			"env assignment keeps its key",
			"export OPENAI_TOKEN=abcdefghijklmnopqrstuvwxyz ./run.sh",
			"export OPENAI_TOKEN=abcd...wxyz ./run.sh",
			[]string{"abcd...wxyz"},
			[]Segment{{Prefix: "abcd", Suffix: "wxyz"}},
		},
		{
			"short value whole masked",
			"TOKEN=short",
			"TOKEN=***",
			[]string{"***"},
			[]Segment{{Prefix: "", Suffix: ""}},
		},
		{
			"url userinfo mask shows no material",
			"https://user:sup3rs3cret@api.example.com/v1",
			"https://user:***@api.example.com/v1",
			[]string{"***"},
			[]Segment{{Prefix: "", Suffix: ""}},
		},
		{
			"two credentials one line",
			`curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://user:sup3rs3cret@api.example.com`,
			`curl -H "Authorization: Bearer sk-p...7890" https://user:***@api.example.com`,
			[]string{"sk-p...7890", "***"},
			[]Segment{{Prefix: "sk-p", Suffix: "7890"}, {Prefix: "", Suffix: ""}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			masked, findings, segs := MaskWithSegments(tc.in)
			if masked != tc.want {
				t.Fatalf("masked = %q, want %q", masked, tc.want)
			}
			if len(findings) != len(tc.segTexts) || len(segs) != len(tc.segTexts) {
				t.Fatalf("findings=%d segs=%d, want %d of each", len(findings), len(segs), len(tc.segTexts))
			}
			for i, want := range tc.segTexts {
				at := strings.Index(masked, want)
				if at < 0 {
					t.Fatalf("mask text %q not found in %q", want, masked)
				}
				if segs[i].Start != at || segs[i].End != at+len(want) {
					t.Errorf("segment %d span = [%d:%d], want [%d:%d] (%q)", i, segs[i].Start, segs[i].End, at, at+len(want), want)
				}
				if segs[i].Prefix != tc.segs[i].Prefix || segs[i].Suffix != tc.segs[i].Suffix {
					t.Errorf("segment %d prefix/suffix = %q/%q, want %q/%q",
						i, segs[i].Prefix, segs[i].Suffix, tc.segs[i].Prefix, tc.segs[i].Suffix)
				}
				if findings[i].Kind == "" {
					t.Errorf("finding %d has empty kind", i)
				}
			}
		})
	}
}

// ToUTF16Span converts byte offsets to the UTF-16 code-unit positions
// CodeMirror and JS string slicing use. The three divergence classes the
// brief names must all convert exactly: emoji (4 bytes, 2 units), combining
// marks (2-3 bytes, 1-2 units), Cyrillic (2 bytes, 1 unit).
func TestToUTF16Span(t *testing.T) {
	// ASCII: identical.
	s := `curl -H "Authorization: Bearer sk-proj-abcdef1234567890"`
	_, findings := Mask(s)
	if len(findings) != 1 {
		t.Fatalf("findings = %+v", findings)
	}
	if a, b := ToUTF16Span(s, findings[0].Start, findings[0].End); a != findings[0].Start || b != findings[0].End {
		t.Errorf("ASCII span = [%d:%d], want byte offsets [%d:%d]", a, b, findings[0].Start, findings[0].End)
	}

	cases := []struct {
		name      string
		in        string
		u16start  int // the value's UTF-16 start
		bytestart int // the value's byte start
	}{
		// 🔥 is 4 bytes, 2 UTF-16 units: byte start 21, unit start 19.
		{"emoji before", `echo "🔥" && TOKEN=abcdefghijklmnopqrstuvwxyz123456`, 19, 21},
		// e + U+0301 combining acute: 3 bytes, 2 units.
		// Cyrillic: 2 bytes, 1 unit each — 9 letters + space + TOKEN= .
		{"cyrillic before", "выполнить TOKEN=abcdefghijklmnopqrstuvwxyz123456", 16, 25},
		{"combining mark before", "TOKEN=e\u0301abcdefghijklmnopqrstuvwxyz123456", 6, 6},
		// units but the opening quote is one byte and one unit, so byte and
		// unit starts coincide here.
		{"emoji inside value", `TOKEN="abc🔥defghijklmnopqrstuvwxyz123456"`, 7, 7},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, findings := Mask(tc.in)
			if len(findings) != 1 {
				t.Fatalf("findings = %+v, want one", findings)
			}
			u16s, _ := ToUTF16Span(tc.in, findings[0].ValueStart, findings[0].ValueEnd)
			if u16s != tc.u16start {
				t.Errorf("value u16 start = %d, want %d", u16s, tc.u16start)
			}
			if tc.bytestart != findings[0].ValueStart {
				t.Errorf("byte start = %d, want %d", findings[0].ValueStart, tc.bytestart)
			}
			// Round trip through the UTF-16 code-unit space: the span must
			// slice the same text JS would slice. []rune counts code points,
			// so astral chars (🔥) would misalign — go through utf16.Encode.
			units := utf16.Encode([]rune(tc.in))
			u16a, u16b := ToUTF16Span(tc.in, findings[0].Start, findings[0].End)
			if got := string(utf16.Decode(units[u16a:u16b])); got != tc.in[findings[0].Start:findings[0].End] {
				t.Errorf("u16 span [%d:%d] = %q, byte span = %q", u16a, u16b, got, tc.in[findings[0].Start:findings[0].End])
			}
		})
	}
}

// SuggestName derives the vault name: the host of the invocation containing
// the credential (never crossing |, &&, ||, ; or a command substitution),
// else the environment variable name, else the kind.
func TestSuggestName(t *testing.T) {
	find := func(t *testing.T, in string) Finding {
		t.Helper()
		_, findings := Mask(in)
		if len(findings) != 1 {
			t.Fatalf("findings = %+v, want exactly one in %q", findings, in)
		}
		return findings[0]
	}
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"host from the invocation", `curl https://openrouter.ai/api/v1 -H "Authorization: Bearer sk-proj-abcdef1234567890"`, "openrouter.ai"},
		{"host verbatim including subdomain", `curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://api.openrouter.ai/v1`, "api.openrouter.ai"},
		{"host with port stripped", `curl https://openrouter.ai:8443/api -H "Authorization: Bearer sk-proj-abcdef1234567890"`, "openrouter.ai"},
		{"host with userinfo stripped", `git push https://user:sup3rs3cret@github.com/org/repo.git`, "github.com"},
		{"host of the first url", `curl -H "Authorization: Bearer sk-proj-abcdef1234567890" "https://first.example" "https://second.example"`, "first.example"},
		{"env variable name", `GITHUB_TOKEN=abcdefghijklmnopqrstuvwxyz123456 gh repo list`, "github-token"},
		{"env variable name lowercased", `export OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456 ./run.sh`, "openai-api-key"},
		{"env variable in its own invocation", `curl https://api.example.com && TOKEN=abcdefghijklmnopqrstuvwxyz123456`, "token"},
		{"pipe: the other invocation's host is not the target", `curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://evil.com | curl https://good.com`, "evil.com"},
		{"pipe: env in the second invocation", `curl https://evil.com | TOKEN=abcdefghijklmnopqrstuvwxyz123456`, "token"},
		{"semicolon splits", `curl https://evil.com; TOKEN=abcdefghijklmnopqrstuvwxyz123456`, "token"},
		{"double amp splits", `curl https://evil.com && TOKEN=abcdefghijklmnopqrstuvwxyz123456`, "token"},
		{"command substitution: outer host is not the target", `curl https://evil.com $(echo hi) -H "Authorization: Bearer sk-proj-abcdef1234567890"`, "evil.com"},
		{"credential inside substitution names the inner host", `echo $(curl https://api.good.com -H "Authorization: Bearer sk-proj-abcdef1234567890") https://evil.com`, "api.good.com"},
		{"semicolon inside quotes does not split", `curl -H "Authorization: Bearer sk-proj-abcdef1234567890" "https://evil.com; https://good.com"`, "evil.com"},
		{"no host no env: the kind", `deploy --token abcdefghijklmnopqrstuvwxyz123456`, "high-entropy"},
		{"bare key: the kind", `sk-proj-abcdef1234567890`, "openai"},
		{"db connstring host is the target", `psql "postgres://dbuser:dbpass123@db.internal:5432/main"`, "db.internal"},
		{"env assignment in the same invocation as a url: host wins", `GITHUB_TOKEN=abcdefghijklmnopqrstuvwxyz123456 curl https://api.example.com`, "api.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SuggestName(tc.in, find(t, tc.in)); got != tc.want {
				t.Errorf("SuggestName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// The failure shapes the brief names for the fuzz/table net: several
// credentials in one line, malformed quoting, empty values, references —
// all must mask without panicking and keep findings consistent with the
// output.
func TestMaskRobustnessShapes(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"several credentials", `TOKEN=abcdefghijklmnopqrstuvwxyz123456 curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://user:sup3rs3cret@api.example.com`},
		{"unterminated quote", `curl -H "Authorization: Bearer sk-proj-abcdef1234567890 https://api`},
		{"unterminated double quote", `TOKEN="abcdefghijklmnopqrstuvwxyz123456`},
		{"empty value quoted", `TOKEN=""`},
		{"empty value bare", `TOKEN=`},
		{"reference intact", `curl -H "Authorization: Bearer {{secret:OPENAI}}" https://api`},
		{"shell expansion intact", `curl -H "Authorization: Bearer $TOKEN" https://api`},
		{"command substitution intact", `curl -H "Authorization: Bearer $(cat /tmp/key)" https://api`},
		{"quoted spaces in value", `TOKEN="abc def ghi jkl mno pqr stu vwx yz 123456"`},
		{"cjk before and inside", "TOKEN=密钥abcdefghijklmnopqrstuvwxyz123456 部署"},
		{"emoji before and inside", `🔥 TOKEN="abc🔥defghijklmnopqrstuvwxyz123456"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			masked, findings, segs := MaskWithSegments(tc.in)
			if len(findings) != len(segs) {
				t.Fatalf("findings %d != segments %d", len(findings), len(segs))
			}
			for i, f := range findings {
				if f.Start < 0 || f.End > len(tc.in) || f.Start > f.End {
					t.Fatalf("finding %d out of range: %+v", i, f)
				}
				if segs[i].Start < 0 || segs[i].End > len(masked) || segs[i].Start > segs[i].End {
					t.Fatalf("segment %d out of range: %+v", i, segs[i])
				}
			}
			// The output contains no raw fragment of any finding's value
			// beyond what the mask shows.
			for _, f := range findings {
				v := tc.in[f.ValueStart:f.ValueEnd]
				if len(v) == 0 {
					continue
				}
				if strings.Contains(masked, v) {
					t.Errorf("masked output contains a raw value %q", v)
				}
			}
		})
	}
}

// FuzzMaskNeverPanics is the belt under the table: any input — absent
// groups, empty values, malformed quoting, Unicode anywhere, references —
// must mask without panicking, and the findings and segments must stay
// consistent with the output they describe.
func FuzzMaskNeverPanics(f *testing.F) {
	seeds := []string{
		`curl -H "Authorization: Bearer "`,
		`curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://api`,
		`TOKEN=""`,
		`TOKEN=`,
		`TOKEN="unterminated`,
		"выполнить TOKEN=密钥abcdefghijklmnopqrstuvwxyz123456 部署",
		`🔥 TOKEN="abc🔥defghijklmnopqrstuvwxyz123456"`,
		`curl -H "Authorization: Bearer {{secret:OPENAI}}" https://api`,
		"sk-proj-abcdef1234567890 | TOKEN=abc12345678901234567890 ; https://user:pass@host",
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		masked, findings, segs := MaskWithSegments(in)
		if len(findings) != len(segs) {
			t.Fatalf("findings %d != segments %d", len(findings), len(segs))
		}
		for i, fnd := range findings {
			if fnd.Start < 0 || fnd.End > len(in) || fnd.Start > fnd.End {
				t.Fatalf("finding %d out of range: %+v", i, fnd)
			}
			if fnd.ValueStart < fnd.Start || fnd.ValueEnd > fnd.End {
				t.Fatalf("finding %d value span outside finding: %+v", i, fnd)
			}
			seg := segs[i]
			if seg.Start < 0 || seg.End > len(masked) || seg.Start > seg.End {
				t.Fatalf("segment %d out of range: %+v", i, seg)
			}
		}
		// The segment text must be exactly the mask the value produced —
		// never a fragment of the value itself. (A one-character value
		// like "*" appears inside its own mask "***"; that is the mask,
		// not a leak, which is why the check is equality, not containment.)
		for i, fnd := range findings {
			v := in[fnd.ValueStart:fnd.ValueEnd]
			segText := masked[segs[i].Start:segs[i].End]
			switch segText {
			case maskOf(v), "***", "[REDACTED PRIVATE KEY]":
			default:
				t.Fatalf("segment text %q is not the mask of %q", segText, v)
			}
		}
		_ = SuggestName(in, Finding{Kind: KindHighEntropy, Start: 0, End: 0, ValueStart: 0, ValueEnd: 0})
	})
}

// maskOf mirrors maskSecret for the fuzz invariant: the mask a value shows.
func maskOf(v string) string {
	r := []rune(v)
	if len(r) < 12 {
		return "***"
	}
	return string(r[:4]) + "..." + string(r[len(r)-4:])
}
