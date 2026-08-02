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
//
// ValueStart/ValueEnd bound the CREDENTIAL inside the finding, by byte
// offset into the same input: the thing a capture holds and a save stores.
// For whole-match rules they equal the finding span; for structural rules
// (env assignment, auth header, db connstring, URL userinfo, high-entropy)
// they are the value token, surrounding quotes stripped. The value itself
// never appears in a finding — these are offsets only.
type Finding struct {
	Kind  Kind
	Start int
	End   int
	// ValueStart/ValueEnd bound the credential inside the finding.
	ValueStart int
	ValueEnd   int
}

// Segment is the durable shape of one replacement: where it landed in the
// MASKED string, and the head/tail the mask shows. Prefix/Suffix are
// exactly the text already visible in the masked command (the head-4/tail-4
// maskSecret keeps, "" when the mask shows no material) — a segment never
// carries secret material.
type Segment struct {
	Start, End int
	Prefix     string
	Suffix     string
}

// Mask returns the input with every detected secret replaced and the
// findings describing exactly those replacements. The masked string and the
// findings are computed from one deterministic pass: the finding list is
// exactly the set of replacements made, so a caller can report
// count-and-kinds without ever re-deriving them.
func Mask(s string) (masked string, findings []Finding) {
	masked, findings, _ = MaskWithSegments(s)
	return masked, findings
}

// MaskWithSegments is Mask plus, per finding, the segment the durable row
// keeps: the replacement's span in the MASKED string (byte offsets, safe to
// slice masked[start:end]) and the head/tail the mask shows. The findings
// and the segments are parallel and in the same order. Callers that only
// need the masked text and the facts use Mask; the store seam needs the
// segments so a later save can find the span to rewrite.
func MaskWithSegments(s string) (masked string, findings []Finding, segs []Segment) {
	ms := detectMatches(s)
	var b strings.Builder
	b.Grow(len(s))
	last := 0
	findings = make([]Finding, 0, len(ms))
	segs = make([]Segment, 0, len(ms))
	for _, m := range ms {
		b.WriteString(s[last:m.start])
		outStart := b.Len()
		b.WriteString(m.repl)
		last = m.end
		findings = append(findings, Finding{
			Kind:       m.kind,
			Start:      m.start,
			End:        m.end,
			ValueStart: m.valStart,
			ValueEnd:   m.valEnd,
		})
		segs = append(segs, Segment{
			Start:  outStart + m.segStart,
			End:    outStart + m.segEnd,
			Prefix: maskHead(s[m.valStart:m.valEnd], m.wholeMasked),
			Suffix: maskTail(s[m.valStart:m.valEnd], m.wholeMasked),
		})
	}
	b.WriteString(s[last:])
	return b.String(), findings, segs
}

// maskHead and maskTail are the head-4/tail-4 the mask keeps for a value,
// or "" when the mask shows no material: a value below the 12-rune floor
// becomes "***", and wholeMasked rules (private keys, db-connstring and URL
// passwords) show a fixed placeholder regardless.
func maskHead(value string, wholeMasked bool) string {
	if wholeMasked {
		return ""
	}
	r := []rune(value)
	if len(r) < 12 {
		return ""
	}
	return string(r[:4])
}

func maskTail(value string, wholeMasked bool) string {
	if wholeMasked {
		return ""
	}
	r := []rune(value)
	if len(r) < 12 {
		return ""
	}
	return string(r[len(r)-4:])
}

// valueSpanOf returns the value's byte span, stripping one pair of
// surrounding matching quotes so the SAVED credential is the inner text —
// TOKEN="abc" stores abc, not "abc".
func valueSpanOf(input string, start, end int) (int, int) {
	if end-start >= 2 {
		q := input[start]
		if (q == '\'' || q == '"') && input[end-1] == q {
			return start + 1, end - 1
		}
	}
	return start, end
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

// candidate is one match of one rule: the byte span, the credential's own
// span within it, the span of the value's MASK within the replacement, and
// the replacement itself.
type candidate struct {
	start, end       int
	valStart, valEnd int
	// segStart/segEnd bound the masked value WITHIN repl — the part the
	// durable row's segment covers. For whole-match rules they span the
	// whole repl; for composite rules (env-assign, auth header, db
	// connstring, URL userinfo, high-entropy) they are the value's mask
	// only, so a save can rewrite the value and keep the context
	// (OPENAI_TOKEN= stays, the token becomes the reference).
	segStart, segEnd int
	// wholeMasked marks rules whose mask shows no head/tail material (a
	// fixed placeholder): private-key blocks, db-connstring and URL
	// passwords. The segment's prefix/suffix are "" for these.
	wholeMasked bool
	repl        string
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
			repl := maskSecret(input[start:end])
			out = append(out, candidate{start: start, end: end, valStart: start, valEnd: end, segStart: 0, segEnd: len(repl), repl: repl})
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
		out = append(out, candidate{start: loc[0], end: loc[1], valStart: loc[0], valEnd: loc[1], segStart: 0, segEnd: len("[REDACTED PRIVATE KEY]"), wholeMasked: true, repl: "[REDACTED PRIVATE KEY]"})
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
		repl := maskSecret(input[loc[0]:loc[1]])
		out = append(out, candidate{start: loc[0], end: loc[1], valStart: loc[0], valEnd: loc[1], segStart: 0, segEnd: len(repl), repl: repl})
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
		head := input[loc[2]:loc[3]]
		repl := head + "***" + input[loc[6]:loc[7]]
		out = append(out, candidate{
			start:       loc[0],
			end:         loc[1],
			valStart:    loc[4],
			valEnd:      loc[5],
			segStart:    len(head),
			segEnd:      len(head) + 3,
			wholeMasked: true,
			repl:        repl,
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
		repl := input[loc[2]:loc[3]] + "://" + input[loc[4]:loc[5]] + ":***@"
		out = append(out, candidate{
			start:       loc[0],
			end:         loc[1],
			valStart:    loc[6],
			valEnd:      loc[7],
			segStart:    len(repl) - 4,
			segEnd:      len(repl) - 1,
			wholeMasked: true,
			repl:        repl,
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

// isAuthScheme reports whether the word is an authentication SCHEME rather
// than a credential — the vocabulary RFC 7235 registers, plus the two AWS
// uses. A scheme standing alone means the credential has not been typed yet.
func isAuthScheme(word string) bool {
	switch strings.ToLower(word) {
	case "bearer", "basic", "token", "digest", "negotiate", "ntlm", "aws4-hmac-sha256", "hoba":
		return true
	}
	return false
}

func findAuthHeader(input string) []candidate {
	var out []candidate
	for _, loc := range authHeaderRE.FindAllStringSubmatchIndex(input, -1) {
		token := input[loc[6]:loc[7]]
		if isReference(token) {
			continue
		}
		// The scheme group is OPTIONAL, so it may not participate — and an
		// absent group's indexes are -1, which sliced the input as [:-1] and
		// PANICKED. `curl -H "Authorization: Bearer "`, an ordinary line the
		// moment somebody deletes the key to paste a new one, took the whole
		// record handler down with it.
		scheme := ""
		if loc[4] >= 0 {
			scheme = input[loc[4]:loc[5]]
		}
		// With no scheme group, a lone scheme WORD is what the token matched:
		// there is no credential in `Authorization: Bearer` and offering to
		// store the word "Bearer" is worse than saying nothing.
		if scheme == "" && isAuthScheme(token) {
			continue
		}
		head := input[loc[2]:loc[3]]
		repl := head + scheme + maskSecret(token)
		out = append(out, candidate{
			start:    loc[0],
			end:      loc[1],
			valStart: loc[6],
			valEnd:   loc[7],
			segStart: len(head) + len(scheme),
			segEnd:   len(repl),
			repl:     repl,
		})
	}
	for _, loc := range secretHeaderRE.FindAllStringSubmatchIndex(input, -1) {
		value := input[loc[4]:loc[5]]
		if isReference(value) {
			continue
		}
		head := input[loc[2]:loc[3]]
		repl := head + maskSecret(value)
		out = append(out, candidate{
			start:    loc[0],
			end:      loc[1],
			valStart: loc[4],
			valEnd:   loc[5],
			segStart: len(head),
			segEnd:   len(repl),
			repl:     repl,
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
		vs, ve := valueSpanOf(input, loc[6], loc[7])
		repl := key + sep + maskTokenValue(value)
		qoff := 0
		if vs != loc[6] {
			qoff = 1 // the value was quoted; the mask sits inside the quotes
		}
		out = append(out, candidate{
			start:    loc[0],
			end:      loc[1],
			valStart: vs,
			valEnd:   ve,
			segStart: len(key) + len(sep) + qoff,
			segEnd:   len(repl) - qoff,
			repl:     repl,
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
		vs, ve := 0, 0
		qoff := 0
		switch {
		case loc[6] >= 0:
			repl += "'" + maskSecret(value) + "'"
			vs, ve = valueSpanOf(input, loc[6], loc[7])
			qoff = 1
		case loc[8] >= 0:
			repl += `"` + maskSecret(value) + `"`
			vs, ve = valueSpanOf(input, loc[8], loc[9])
			qoff = 1
		default:
			repl += maskSecret(value)
			vs, ve = loc[10], loc[11]
		}
		out = append(out, candidate{
			start:    loc[0],
			end:      loc[1],
			valStart: vs,
			valEnd:   ve,
			segStart: len(flag) + len(sep) + qoff,
			segEnd:   len(repl) - qoff,
			repl:     repl,
		})
	}
	return out
}

// ── the deterministic pass ─────────────────────────────────────────────────

type match struct {
	kind             Kind
	start, end       int
	valStart, valEnd int
	segStart, segEnd int
	wholeMasked      bool
	repl             string
}

// referenceSpanRE is a `{{secret:NAME}}` reference, whole. Everything inside
// one is OFF LIMITS to every rule.
//
// isReference guards a rule that masks a value it did not recognise, and that
// was thought to be enough — a vendor prefix is a literal key wherever it
// appears, so those rules deliberately skipped the guard. Inside a reference
// it is not: an inventory NAME may legally start with `sk-`, and
// `{{secret:sk-proj-mine}}` came back from the store as
// `{{secret:sk-p...mine}}` — a reference that can never resolve, which is the
// invariant this package exists to protect. So the exclusion belongs to the
// deterministic pass rather than to any one rule: a rule added later cannot
// forget what it never has to remember.
var referenceSpanRE = regexp.MustCompile(`\{\{secret:[^}]*\}\}`)

func detectMatches(input string) []match {
	var kept []match
	refs := referenceSpanRE.FindAllStringIndex(input, -1)
	inReference := func(c candidate) bool {
		for _, r := range refs {
			if c.start < r[1] && r[0] < c.end {
				return true
			}
		}
		return false
	}
	for _, r := range rules {
		for _, c := range r.find(input) {
			if inReference(c) || overlapsAny(c, kept) {
				continue
			}
			kept = append(kept, match{kind: r.kind, start: c.start, end: c.end, valStart: c.valStart, valEnd: c.valEnd, segStart: c.segStart, segEnd: c.segEnd, wholeMasked: c.wholeMasked, repl: c.repl})
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
		findings = append(findings, Finding{
			Kind:       m.kind,
			Start:      m.start,
			End:        m.end,
			ValueStart: m.valStart,
			ValueEnd:   m.valEnd,
		})
	}
	return findings
}

// ── wire conversion ─────────────────────────────────────────────────────────

// ToUTF16Span converts byte offsets in s to UTF-16 code-unit offsets — the
// positions CodeMirror and JS string slicing use. A rune outside the BMP
// counts two units, a combining mark or Cyrillic letter one, so the wire
// offsets diverge from Go's byte offsets exactly where the renderer would
// decorate the wrong text on any line with an emoji, a combining mark or
// Cyrillic before the credential. Convert once, at the wire.
func ToUTF16Span(s string, start, end int) (u16start, u16end int) {
	units := 0
	for i, r := range s {
		if i == start {
			u16start = units
		}
		if i == end {
			u16end = units
			break
		}
		units++
		if r > 0xFFFF {
			units++
		}
	}
	if start >= len(s) {
		u16start = units
	}
	if end >= len(s) {
		u16end = units
	}
	return u16start, u16end
}

// ── the suggested name ──────────────────────────────────────────────────────

// The URL schemes a credential can be sent to: the web schemes plus the
// database families the detector already knows. The host derivation looks
// for any of these in the invocation containing the credential.
var urlAuthorityRE = regexp.MustCompile(
	`(?:https?|wss?|ftp|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://([^\s/"';()]+)`,
)

// SuggestName derives the vault name a detected credential should be saved
// under (ADR-0016): the host of the command invocation that contains the
// credential-bearing argument, else the environment variable name, else the
// kind. The host is the word the user would search for — the owner's
// analogy is Bitwarden, which names an entry after the site you logged into.
//
// The invocation boundary is deliberate: |, &&, ||, ; and a command
// substitution each start another command, and a payload URL or a proxy
// host in another command is not the target. Ambiguity falls back rather
// than guessing — a boring name beats a confidently wrong one on a
// production credential.
func SuggestName(line string, f Finding) string {
	depth, quoted := scanLine(line)
	start, end, d := invocationOf(line, depth, quoted, f)
	if h := hostOf(line, depth, start, end, d); h != "" {
		return h
	}
	if f.Kind == KindEnvAssignment {
		if k := envKeyOf(line, f); k != "" {
			return k
		}
	}
	return string(f.Kind)
}

// scanLine walks the line tracking nesting depth and quote state so the
// name derivation can bound an invocation without parsing a grammar it does
// not own. depth[i] rises inside $(...), `...` and bare ( ... ) and falls
// at the matching close; quoted[i] is true inside quotes (and for a
// backslash-escaped byte), so a ; or | inside quotes never splits and an
// escaped one never does either.
func scanLine(line string) (depth []int, quoted []bool) {
	depth = make([]int, len(line)+1)
	quoted = make([]bool, len(line)+1)
	d := 0
	var q byte
	for i := 0; i < len(line); i++ {
		depth[i] = d
		c := line[i]
		if q != 0 {
			quoted[i] = true
			if c == '\\' && q == '"' {
				i++
				if i < len(line) {
					depth[i] = d
					quoted[i] = true
				}
				continue
			}
			if c == q {
				q = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			q = c
			quoted[i] = true
		case '`':
			d++
		case '(':
			d++
		case ')':
			if d > 0 {
				d--
			}
		case '\\':
			i++
			if i < len(line) {
				depth[i] = d
				quoted[i] = true
			}
		}
	}
	depth[len(line)] = d
	return depth, quoted
}

// isSeparator reports whether the byte at i opens a command boundary: |, ;,
// && or || — the brief's list exactly. A bare & (background) or >/|
// redirection is not a boundary.
func isSeparator(line string, i int) bool {
	switch line[i] {
	case '|', ';':
		return true
	case '&':
		return i+1 < len(line) && line[i+1] == '&'
	}
	return false
}

// invocationOf returns the byte region of the command invocation containing
// the finding, plus the finding's nesting depth. The region is bounded by
// separators at that depth and by the region's own parens (a depth-0
// finding's invocation spans the whole top-level segment, including any
// command substitutions in it; a deeper finding's invocation is the
// substitution body it sits in).
func invocationOf(line string, depth []int, quoted []bool, f Finding) (start, end, d int) {
	d = depth[f.Start]
	start, end = f.Start, f.End
	for start > 0 {
		i := start - 1
		if depth[i] < d || (depth[i] == d && !quoted[i] && isSeparator(line, i)) {
			break
		}
		start = i
	}
	for end < len(line) {
		if depth[end] < d || (depth[end] == d && !quoted[end] && isSeparator(line, end)) {
			break
		}
		end++
	}
	return start, end, d
}

// hostOf returns the host of the first URL at the finding's depth inside the
// invocation, or "" when there is none. A URL inside a nested region (a
// command substitution) belongs to another command and is skipped.
func hostOf(line string, depth []int, start, end, d int) string {
	seg := line[start:end]
	for _, loc := range urlAuthorityRE.FindAllStringSubmatchIndex(seg, -1) {
		at := start + loc[0]
		if depth[at] != d {
			continue
		}
		return hostOfAuthority(seg[loc[2]:loc[3]])
	}
	return ""
}

// hostOfAuthority strips userinfo and port from a URL authority:
// user:pass@github.com:22 → github.com.
func hostOfAuthority(authority string) string {
	if i := strings.LastIndex(authority, "@"); i >= 0 {
		authority = authority[i+1:]
	}
	// IPv6 bracket form: [::1]:8080 — the port is after the bracket.
	if strings.HasPrefix(authority, "[") {
		if i := strings.Index(authority, "]"); i >= 0 {
			return authority[:i+1]
		}
	}
	if i := strings.Index(authority, ":"); i >= 0 {
		return authority[:i]
	}
	return authority
}

// envKeyOf extracts the variable name of an env-assignment finding: the
// text between the finding start and the '=' that opens the value,
// normalised to the name a reference would read (lowercase, hyphenated) —
// GITHUB_TOKEN= → github-token.
func envKeyOf(line string, f Finding) string {
	head := line[f.Start:f.ValueStart]
	sep := strings.LastIndex(head, "=")
	if sep < 0 {
		return ""
	}
	key := strings.TrimSpace(head[:sep])
	if key == "" {
		return ""
	}
	return strings.ReplaceAll(strings.ToLower(key), "_", "-")
}
