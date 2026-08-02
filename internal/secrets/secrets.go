// Package secrets detects credential-shaped text in a command line and masks
// it before it reaches durable history.
//
// The rules are ported from hermes-agent/agent/redact.py (Nous Research, MIT
// — https://github.com/NousResearch/hermes-agent), the redactor Hermes uses
// on logs and tool output. The two halves we need are both there: the vendor
// prefix table with a boundary guard, and the structural rules that catch
// keys with no recognisable prefix.
//
// Rules taken: the vendor prefix table (OpenAI, GitHub, Slack, AWS, GitLab
// families), Authorization / secret headers, JWT shape, private-key blocks,
// database connection strings, URL userinfo (the two-field user:pass@
// form), NAME=value env assignments, and the masking shape mask_secret
// (head 4 / tail 4 / floor 12 — below the floor the whole value becomes
// "***").
//
// Values that NAME a secret are never masked: shell variable expansions
// ($VAR, ${VAR}), command substitutions ($(...), `...`), programmatic env
// lookups (os.getenv, process.env) and vault references ({{secret:NAME}})
// are references, not secrets — masking one loses information and gains
// nothing, and the recalled command stops working. The single isReference
// predicate guards every rule that masks a value it did not itself
// recognise.
//
// Rules left, and why: JSON-field, YAML/colon-config and dotted-key patterns
// (config-file contexts, not command lines); Telegram bot tokens and E.164
// phone numbers (no kind in the closed vocabulary, and the shapes are prone
// to false positives on ports and times); URL query-string redaction and
// form bodies (web-URL query params pass through by design upstream — OAuth
// callbacks and pre-signed links carry their tokens there and must not be
// broken); strict provider-egress redaction (a different boundary than the
// one this package guards); and the vendor prefixes with no kind in the
// closed vocabulary (AIza…, sk_live_…/sk_test_…, SG.…, hf_…, xai-… and the
// rest) — those still land inside structural rules when they appear in a
// credential position, and the kind set is the owner's closed list.
//
// Precision beats recall here, and it is not close: a false positive
// corrupts a command the user will re-run and cannot explain. So the
// high-entropy heuristic fires only in a value position — after a flag that
// names a credential, or after '=' in that flag's own argument — and only at
// length >= 32. A long bare word in a path or a git SHA is not a secret and
// is never masked (golden negative cases in the tests).
package secrets

import (
	"regexp"
	"sort"
	"strings"
)

// Kind is the closed vocabulary of what was masked. The UI reports these
// back ("3 secrets masked: openai, jwt"); a new kind is a deliberate
// addition to the vocabulary, never a silent one.
type Kind string

const (
	KindOpenAI        Kind = "openai"
	KindGitHubPAT     Kind = "github-pat"
	KindSlack         Kind = "slack"
	KindAWSAccessKey  Kind = "aws-access-key"
	KindGitLab        Kind = "gitlab"
	KindJWT           Kind = "jwt"
	KindPrivateKey    Kind = "private-key"
	KindURLUserinfo   Kind = "url-userinfo"
	KindDBConnstring  Kind = "db-connstring"
	KindAuthHeader    Kind = "auth-header"
	KindEnvAssignment Kind = "env-assignment"
	KindHighEntropy   Kind = "high-entropy"
)

// Finding is one secret-shaped region of the input, by byte offset (Start is
// inclusive, End exclusive). Offsets are into the original input and are
// safe to slice with s[Start:End]; the secret's VALUE never appears in a
// finding — kind and offsets are the fact, the matched text is the thing
// being removed.
type Finding struct {
	Kind  Kind
	Start int
	End   int
}

// Mask returns the input with every detected secret replaced and the
// findings describing exactly those replacements. The masked string and the
// findings are computed from one deterministic pass: the finding list is
// exactly the set of replacements made, so a caller can report
// count-and-kinds without ever re-deriving them.
func Mask(s string) (masked string, findings []Finding) {
	ms := detectMatches(s)
	var b strings.Builder
	b.Grow(len(s))
	last := 0
	for _, m := range ms {
		b.WriteString(s[last:m.start])
		b.WriteString(m.repl)
		last = m.end
	}
	b.WriteString(s[last:])
	return b.String(), toFindings(ms)
}

// Detect returns the findings without producing a masked string.
func Detect(s string) []Finding {
	return toFindings(detectMatches(s))
}

// maskSecret is the port of redact.py's mask_secret: preserve the first 4
// and last 4 characters, and below the floor of 12 the whole value becomes
// the placeholder — a four-character head of an eight-character secret is a
// gift to whoever reads the file. Rune-based so a multibyte value is never
// split mid-rune.
func maskSecret(value string) string {
	r := []rune(value)
	if len(r) < 12 {
		return "***"
	}
	return string(r[:4]) + "..." + string(r[len(r)-4:])
}

// maskTokenValue strips one pair of surrounding matching quotes from a
// matched value, masks the inner text, and re-emits the quotes — so
// TOKEN="abc..." keeps its quotes while the value is masked.
func maskTokenValue(value string) string {
	if len(value) >= 2 {
		q := value[0]
		if (q == '\'' || q == '"') && value[len(value)-1] == q {
			return string(q) + maskSecret(value[1:len(value)-1]) + string(q)
		}
	}
	return maskSecret(value)
}

// isReference reports whether value names a secret instead of being one:
// shell variable expansions ($VAR, ${VAR}, $ENV{...}), command
// substitutions ($(...) and `...`), programmatic env lookups
// (os.getenv(...), os.environ..., process.env...) and vault references
// ({{secret:NAME}}). Masking one loses information and gains nothing —
// there was no secret in the text to remove — and the recalled command
// stops working. A leading digit after '$' (the "$2a$10$..." bcrypt shape)
// is not a variable name, so a dollar-prefixed literal is still a secret.
//
// EVERY rule that masks a value it did not itself recognise must consult
// this predicate (or valueIsMaskable, which wraps it): auth-header,
// secret-header, env-assignment, high-entropy, and the password field of
// db-connstring and URL userinfo. A rule added later is exactly what will
// forget. The vendor-prefix rules deliberately do not consult it: sk-… is
// a literal key wherever it appears.
func isReference(value string) bool {
	if strings.HasPrefix(value, "{{secret:") ||
		strings.HasPrefix(value, "os.getenv(") ||
		strings.HasPrefix(value, "os.environ") ||
		strings.HasPrefix(value, "process.env") {
		return true
	}
	if value == "" {
		return false
	}
	switch value[0] {
	case '`':
		return true // `...` command substitution
	case '$':
		if len(value) < 2 {
			return false
		}
		switch value[1] {
		case '{', '(': // ${VAR} braced expansion, $(...) command substitution
			return true
		default: // $NAME named variable expansion
			c := value[1]
			return c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
		}
	}
	return false
}

// valueIsMaskable is the guard every value-masking rule applies to the
// value it captured: a value that names a secret (isReference) has nothing
// to remove, and a value whose opening quote is not closed inside the
// captured token continues past whitespace — the value class cannot see it
// whole, and masking the fragment would corrupt the command, so it is left
// alone either way.
func valueIsMaskable(value string) bool {
	if len(value) >= 1 {
		q := value[0]
		if q == '\'' || q == '"' {
			if len(value) < 2 || value[len(value)-1] != q {
				return false // unterminated in this token — cannot see the value whole
			}
			value = value[1 : len(value)-1]
		}
	}
	return !isReference(value)
}

// ── rules ─────────────────────────────────────────────────────────────────

// candidate is one match of one rule: the byte span and the replacement
// that will be emitted for it.
type candidate struct {
	start, end int
	repl       string
}

type rule struct {
	kind Kind
	find func(input string) []candidate
}

// rules run in this order, and the order is the overlap priority: when two
// rules claim overlapping spans, the earlier rule wins and the later match
// is dropped whole. A recognised vendor prefix inside a value position
// therefore reports its own kind (openai) instead of the position's
// heuristic kind, and the flag that introduced the value is left alone.
var rules = []rule{
	{KindPrivateKey, findPrivateKey},
	{KindOpenAI, prefixFinder(KindOpenAI, `sk-[A-Za-z0-9_-]{10,}`)},
	{KindGitHubPAT, prefixFinder(KindGitHubPAT, `ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gho_[A-Za-z0-9]{10,}|ghu_[A-Za-z0-9]{10,}|ghs_[A-Za-z0-9]{10,}|ghr_[A-Za-z0-9]{10,}`)},
	{KindSlack, prefixFinder(KindSlack, `xapp-\d+-[A-Za-z0-9-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}`)},
	{KindAWSAccessKey, prefixFinder(KindAWSAccessKey, `AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}`)},
	{KindGitLab, prefixFinder(KindGitLab, `glpat-[A-Za-z0-9_\-]{10,}|gloas-[A-Za-z0-9_\-]{10,}|gldt-[A-Za-z0-9_\-]{10,}|glrt-[A-Za-z0-9_.\-]{10,}|glrtr-[A-Za-z0-9_.\-]{10,}|glcbt-[A-Za-z0-9_\-]{10,}|glptt-[A-Za-z0-9_\-]{10,}|glft-[A-Za-z0-9_\-]{10,}|glimt-[A-Za-z0-9_\-]{10,}|glagent-[A-Za-z0-9_\-]{10,}|glsoat-[A-Za-z0-9_\-]{10,}|glffct-[A-Za-z0-9_\-]{10,}|glwt-[A-Za-z0-9_\-]{10,}|GR1348941[A-Za-z0-9_\-]{10,}`)},
	{KindJWT, findJWT},
	{KindDBConnstring, findDBConnstring},
	{KindURLUserinfo, findURLUserinfo},
	{KindAuthHeader, findAuthHeader},
	{KindEnvAssignment, findEnvAssignment},
	{KindHighEntropy, findHighEntropy},
}

// ── vendor prefixes ────────────────────────────────────────────────────────

// prefixFinder returns a rule function that matches one prefix family and
// masks the whole match. The boundary guard is the port of redact.py's
// (?<![A-Za-z0-9_-]) / (?![A-Za-z0-9_-]): a prefix inside a word is not a
// key. RE2 has no lookarounds, so the guard is applied in code.
func prefixFinder(kind Kind, pattern string) func(string) []candidate {
	re := regexp.MustCompile(pattern)
	return func(input string) []candidate {
		var out []candidate
		for _, loc := range re.FindAllStringIndex(input, -1) {
			start, end := loc[0], loc[1]
			if start > 0 && isTokenChar(input[start-1]) {
				continue
			}
			if end < len(input) && isTokenChar(input[end]) {
				continue
			}
			out = append(out, candidate{start: start, end: end, repl: maskSecret(input[start:end])})
		}
		return out
	}
}

func isTokenChar(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_' || b == '-'
}

// ── private key blocks ─────────────────────────────────────────────────────

var privateKeyRE = regexp.MustCompile(`-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----`)

func findPrivateKey(input string) []candidate {
	var out []candidate
	for _, loc := range privateKeyRE.FindAllStringIndex(input, -1) {
		out = append(out, candidate{start: loc[0], end: loc[1], repl: "[REDACTED PRIVATE KEY]"})
	}
	return out
}

// ── JWT ────────────────────────────────────────────────────────────────────

// eyJ... is base64 for "{" — a JWT header. One, two or three dot-separated
// parts are all secrets.
var jwtRE = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){0,2}`)

func findJWT(input string) []candidate {
	var out []candidate
	for _, loc := range jwtRE.FindAllStringIndex(input, -1) {
		out = append(out, candidate{start: loc[0], end: loc[1], repl: maskSecret(input[loc[0]:loc[1]])})
	}
	return out
}

// ── database connection strings ────────────────────────────────────────────

// protocol://user:PASSWORD@host — only the password is masked, the scheme
// and user survive for debuggability. The password class forbids whitespace
// so the match can never span a line break.
var dbConnstrRE = regexp.MustCompile(`((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^:\s]+:)([^@\s]+)(@)`)

func findDBConnstring(input string) []candidate {
	var out []candidate
	for _, loc := range dbConnstrRE.FindAllStringSubmatchIndex(input, -1) {
		password := input[loc[4]:loc[5]]
		if isReference(password) {
			continue
		}
		out = append(out, candidate{
			start: loc[0],
			end:   loc[1],
			repl:  input[loc[2]:loc[3]] + "***" + input[loc[6]:loc[7]],
		})
	}
	return out
}

// ── URL userinfo ───────────────────────────────────────────────────────────

// user:password@ for any web scheme — password masked as ***, user kept.
// The two-field form is unambiguous; a bare scheme://TOKEN@host is not
// handled here because no length floor separates a username from a token,
// and the vendor-prefix families already cover real tokens in URLs
// (https://ghp_...@github.com is masked by the github-pat prefix rule).
var urlUserinfoRE = regexp.MustCompile(`(https?|wss?|ftp)://([^/\s:@]+):([^/\s@]+)@`)

func findURLUserinfo(input string) []candidate {
	var out []candidate
	for _, loc := range urlUserinfoRE.FindAllStringSubmatchIndex(input, -1) {
		password := input[loc[6]:loc[7]]
		if isReference(password) {
			continue
		}
		out = append(out, candidate{
			start: loc[0],
			end:   loc[1],
			repl:  input[loc[2]:loc[3]] + "://" + input[loc[4]:loc[5]] + ":***@",
		})
	}
	return out
}

// ── Authorization and secret headers ───────────────────────────────────────

// "[Proxy-]Authorization:" with any scheme (Bearer, Basic, Token, Digest)
// plus the bare-credential form. The header name and scheme survive; the
// credential token is masked. The token class excludes quotes so a token
// flush against a closing quote is not pulled into the match (masking the
// quote would turn value corruption into syntax corruption).
var authHeaderRE = regexp.MustCompile(`((?:Proxy-)?Authorization:\s*)([A-Za-z][\w.+-]*\s+)?([^\s"']+)`)

// x-api-key style headers carrying a single opaque value. The value class
// excludes quotes for the same reason auth-header's does: a token flush
// against a closing quote must not pull that quote into the match, or
// masking turns value corruption into syntax corruption.
var secretHeaderRE = regexp.MustCompile(`((?:x-api-key|x-goog-api-key|api-key|apikey|x-api-token|x-auth-token|x-access-token)\s*:\s*)([^\s"']+)`)

func findAuthHeader(input string) []candidate {
	var out []candidate
	for _, loc := range authHeaderRE.FindAllStringSubmatchIndex(input, -1) {
		token := input[loc[6]:loc[7]]
		if isReference(token) {
			continue
		}
		out = append(out, candidate{
			start: loc[0],
			end:   loc[1],
			repl:  input[loc[2]:loc[3]] + input[loc[4]:loc[5]] + maskSecret(token),
		})
	}
	for _, loc := range secretHeaderRE.FindAllStringSubmatchIndex(input, -1) {
		value := input[loc[4]:loc[5]]
		if isReference(value) {
			continue
		}
		out = append(out, candidate{
			start: loc[0],
			end:   loc[1],
			repl:  input[loc[2]:loc[3]] + maskSecret(value),
		})
	}
	return out
}

// ── NAME=value assignments ─────────────────────────────────────────────────

// The port of redact.py's _ENV_ASSIGN_RE: an uppercase KEY containing a
// secret keyword (API_KEY, TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL,
// AUTH) tolerates spaces around '='. The KEY CLASS IS THE GUARD: it is
// uppercase-only, so author=Smith, keyboard=abc and lowercase token= are
// never candidates at all — on a command line a lowercase token= is far
// more often a query parameter or a sort key than a credential. A value
// that names a secret (a shell expansion, a command substitution, a
// programmatic env lookup, a {{secret:...}} reference) passes through
// untouched, as does a value whose opening quote is not closed in the same
// token — masking either would lose information or corrupt the command.
var envAssignRE = regexp.MustCompile(`([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,50})(\s*=\s*)(\S+)`)

func findEnvAssignment(input string) []candidate {
	if !strings.Contains(input, "=") {
		return nil
	}
	var out []candidate
	for _, loc := range envAssignRE.FindAllStringSubmatchIndex(input, -1) {
		key := input[loc[2]:loc[3]]
		sep := input[loc[4]:loc[5]]
		value := input[loc[6]:loc[7]]
		if !valueIsMaskable(value) {
			continue
		}
		out = append(out, candidate{
			start: loc[0],
			end:   loc[1],
			repl:  key + sep + maskTokenValue(value),
		})
	}
	return out
}

// ── high-entropy values in credential positions ────────────────────────────

// The heuristic the brief specifies: fires only in a value position — after
// a flag that names a credential, in its '=' or space-separated argument —
// and only at length >= 32. The bare-value class excludes '/' so a long
// path after a flag is never treated as a token. Quoted values are matched
// whole so "--token '...32+ chars...'" is masked without breaking the
// quoting.
var highEntropyRE = regexp.MustCompile(
	`(--(?:token|password|passwd|secret|api-key|apikey|api_key|access-token|access_token|auth-token|auth_token|client-secret|client_secret|key|auth)\b)` +
		`((?:[ \t]*=[ \t]*)|(?:[ \t]+))` +
		`(?:'([^']{32,})'|"([^"]{32,})"|([^\s'"/]{32,}))`,
)

func findHighEntropy(input string) []candidate {
	var out []candidate
	for _, loc := range highEntropyRE.FindAllStringSubmatchIndex(input, -1) {
		flag := input[loc[2]:loc[3]]
		sep := input[loc[4]:loc[5]]
		value := ""
		switch {
		case loc[6] >= 0: // '...'
			value = input[loc[6]:loc[7]]
		case loc[8] >= 0: // "..."
			value = input[loc[8]:loc[9]]
		default: // bare
			value = input[loc[10]:loc[11]]
		}
		if isReference(value) {
			continue
		}
		repl := flag + sep
		switch {
		case loc[6] >= 0:
			repl += "'" + maskSecret(value) + "'"
		case loc[8] >= 0:
			repl += `"` + maskSecret(value) + `"`
		default:
			repl += maskSecret(value)
		}
		out = append(out, candidate{start: loc[0], end: loc[1], repl: repl})
	}
	return out
}

// ── the deterministic pass ─────────────────────────────────────────────────

type match struct {
	kind       Kind
	start, end int
	repl       string
}

func detectMatches(input string) []match {
	var kept []match
	for _, r := range rules {
		for _, c := range r.find(input) {
			if overlapsAny(c, kept) {
				continue
			}
			kept = append(kept, match{kind: r.kind, start: c.start, end: c.end, repl: c.repl})
		}
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].start != kept[j].start {
			return kept[i].start < kept[j].start
		}
		return kept[i].end < kept[j].end
	})
	return kept
}

func overlapsAny(c candidate, kept []match) bool {
	for _, m := range kept {
		if c.start < m.end && m.start < c.end {
			return true
		}
	}
	return false
}

func toFindings(ms []match) []Finding {
	findings := make([]Finding, 0, len(ms))
	for _, m := range ms {
		findings = append(findings, Finding{Kind: m.kind, Start: m.start, End: m.end})
	}
	return findings
}
