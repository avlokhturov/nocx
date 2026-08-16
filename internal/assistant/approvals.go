package assistant

// The approval record (design §7.2, bead nocx-z9hj4): a human's yes binds to
// ONE exact tool proposal — run, attempt, tool name, call id and a hash of
// the canonical arguments — so approving one thing never authorises a changed
// thing. The approved call runs as its own SUBSEQUENT attempt of the
// proposal's own entry (ADR-0020 decision 4: a retry after approval is an
// execution of the same intent, never a new intent), and the store is what
// carries the yes across the checkpoint, because the checkpoint itself is
// process-lifetime state (ADR-0028 decision: checkpoints are not records).
// Process-lifetime like the checkpoint: approval does not survive a restart,
// which is already what the recovery rule says.
//
// The store also carries the egress gate's retained result (design §7.1 —
// "send it as it is"): the withheld bytes of the finding that suspended the
// run, keyed by the same proposal. A resume that re-ran the tool would repeat
// the effect, so the gate retains the exact result the person was shown and
// the approved resume sends THAT, never a newly produced one.

import "sync"

// Approval is one human decision about one exact proposal.
type Approval struct {
	RunID   string
	Attempt int
	Tool    string
	CallID  string
	ArgHash string
	// EntryID is the ledger row that recorded the proposal — the entry the
	// approved call runs as a SUBSEQUENT attempt of. It is a carrier, NOT
	// part of the binding: the key stays the five binding fields, so a
	// changed argument hashes differently and never resumes under the old
	// approval (nocx-5dldy).
	EntryID string
}

type approvalKey struct {
	runID   string
	attempt int
	tool    string
	callID  string
	argHash string
}

type approvalEntry struct {
	entryID string
}

// retainedValue is the withheld result of an egress finding (design §7.1):
// the exact bytes — or the exact error string — the person was shown, never a
// re-run's freshly produced ones.
type retainedValue struct {
	out      string
	wasError bool
}

// ApprovalStore keeps the pending requests (what the human is being asked),
// the approvals (what the human said yes to) and the retained egress results
// (what was withheld pending the decision). All keyed by the exact proposal.
type ApprovalStore struct {
	mu       sync.Mutex
	approved map[approvalKey]approvalEntry
	pending  map[approvalKey]approvalEntry
	retained map[approvalKey]retainedValue
}

// NewApprovalStore builds the process-lifetime approval store. The transport
// owns one per server and passes it on every Ask, so the run that escalated
// and the run that resumes consult the SAME decisions; the store is what
// carries a yes across the suspension.
func NewApprovalStore() *ApprovalStore {
	return &ApprovalStore{
		approved: make(map[approvalKey]approvalEntry),
		pending:  make(map[approvalKey]approvalEntry),
		retained: make(map[approvalKey]retainedValue),
	}
}

// Request records that the human is being asked about this exact proposal.
func (s *ApprovalStore) Request(ap Approval) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending[keyOf(ap)] = approvalEntry{entryID: ap.EntryID}
}

// Approve records a yes to this exact proposal: the pending ask is answered
// and the proposal moves to approved, so the resume's re-run of the pipeline
// skips the ask. It returns false when the proposal was NOT pending — never
// asked, or already answered — and records nothing: a yes to a question
// nobody was asked is not a decision, and a stale or unknown approval id
// must not resume anything (acceptance criterion 7). The caller (the
// transport's agent.approve) checks IsPending first and treats a false
// return as the honest "unknown approval" refusal.
func (s *ApprovalStore) Approve(ap Approval) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.pending[keyOf(ap)]
	if !ok {
		return false
	}
	delete(s.pending, keyOf(ap))
	// The wire's approve carries only the five binding fields; the entry
	// the proposal was recorded under is the pending record's own.
	if ap.EntryID == "" {
		ap.EntryID = cur.entryID
	}
	s.approved[keyOf(ap)] = approvalEntry{entryID: ap.EntryID}
	return true
}

// IsApproved reports whether this exact proposal was approved.
func (s *ApprovalStore) IsApproved(ap Approval) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.approved[keyOf(ap)]
	return ok
}

// IsPending reports whether the human is CURRENTLY being asked about this
// exact proposal — the source of truth a stale or unknown approval id is
// answered against (acceptance criterion 7): an id that is not pending was
// never asked, or was already answered, and must not resume anything.
func (s *ApprovalStore) IsPending(ap Approval) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.pending[keyOf(ap)]
	return ok
}

// EntryIDFor returns the ledger entry that recorded the proposal — the entry
// the approved call runs as a subsequent attempt of. ok is false when the
// proposal is neither pending nor approved, or was recorded without an entry
// (a nil-ledger run: no durable thread exists).
func (s *ApprovalStore) EntryIDFor(ap Approval) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.approved[keyOf(ap)]; ok && e.entryID != "" {
		return e.entryID, true
	}
	if e, ok := s.pending[keyOf(ap)]; ok && e.entryID != "" {
		return e.entryID, true
	}
	return "", false
}

// Retain holds the withheld result of an egress finding (design §7.1) so the
// approved resume can send the EXACT bytes the person was shown — a resume
// that re-ran the tool would repeat the effect and could produce a different
// result than the one approved. The result is bounded by the ingest bound
// (maxToolResultBytes); it is process-lifetime, like every other piece of the
// approval machinery, and dies with the restart.
func (s *ApprovalStore) Retain(ap Approval, out string, wasError bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.retained[keyOf(ap)] = retainedValue{out: out, wasError: wasError}
}

// RetainedResult returns the withheld result of an egress finding for the
// exact proposal, when one is retained. The approved resume returns it
// instead of re-running the tool.
func (s *ApprovalStore) RetainedResult(ap Approval) (string, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.retained[keyOf(ap)]
	return v.out, v.wasError, ok
}

// ClearRetained drops the retained result: the approved resume has sent it,
// or the run has terminalized — the bytes are no longer needed.
func (s *ApprovalStore) ClearRetained(ap Approval) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.retained, keyOf(ap))
}

func keyOf(ap Approval) approvalKey {
	return approvalKey{
		runID:   ap.RunID,
		attempt: ap.Attempt,
		tool:    ap.Tool,
		callID:  ap.CallID,
		argHash: ap.ArgHash,
	}
}
