# Deferred Work

## Replace matching wildcard known_hosts entries

- source_spec: `spec-nocx-shat-route-host-keys.md`
- summary: `TrustHostKey` should remove an obsolete wildcard hostname pattern that matches a directly trusted host before appending the accepted specific key.
- evidence: `internal/ssh/ssh_real.go:490-506` compares known_hosts names literally, while `golang.org/x/crypto/ssh/knownhosts` applies `*` and `?` wildcard matching. A line such as `*.example.com ssh-ed25519 <old-key>` therefore survives accepting a changed key for `db.example.com`, leaving the rejected old key valid. This predates the route-specific jump-host change; opaque jump-route identities cannot match wildcard patterns.
