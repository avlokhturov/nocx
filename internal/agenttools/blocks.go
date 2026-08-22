package agenttools

import "github.com/shady2k/nocx/internal/content"

// BlockReader is the narrowed capability the block tools execute through
// (nocx-5u3oz.6): the sessions whose finished blocks this run may list and
// read. It holds EXACTLY the grant's ResourceSession scopes and nothing
// else, so a tool holding it can name no other session (ADR-0028 decision 4
// — the dispatcher narrows, it does not check).
//
// The shape is ScreenReader's and Runner's on purpose, and so is the
// division of labour: the session set is the AUTHORITY, while where a block
// actually comes from — the pane's durable ledger record — is
// infrastructure wired at the run (the assistant's BlockSource), never on
// the capability. Its own type is what keeps the three session-scoped tools
// distinguishable where the middleware dispatches by capability type.
type BlockReader struct {
	sessions map[string]struct{}
}

// NewBlockReader builds the narrowed capability from the grant's session
// scopes. A grant with no session scope builds a capability that refuses
// every call — the tool can never exceed the grant because it never holds
// more than the grant.
func NewBlockReader(scopes []content.GrantScope) *BlockReader {
	r := &BlockReader{sessions: make(map[string]struct{})}
	for _, sc := range scopes {
		if sc.Kind == content.ResourceSession && sc.ID != "" {
			r.sessions[sc.ID] = struct{}{}
		}
	}
	return r
}

// Allows reports whether sessionID is inside the grant. The executor checks
// this BEFORE it asks the ledger for anything: a call naming a session
// outside the grant never becomes a query, so no block of another session is
// ever loaded and then filtered.
func (r *BlockReader) Allows(sessionID string) bool {
	if r == nil || sessionID == "" {
		return false
	}
	_, ok := r.sessions[sessionID]
	return ok
}
