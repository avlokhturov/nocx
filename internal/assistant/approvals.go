package assistant

// The approval record (design §7.2): a human's yes binds to ONE exact tool
// proposal — run, attempt, tool name, call id and a hash of the canonical
// arguments — so approving one thing never authorises a changed thing. It
// resumes as a new attempt with a new grant; the approval store is what
// carries the yes across the checkpoint, because the checkpoint itself is
// process-lifetime state (ADR-0028 decision: checkpoints are not records).
// Process-lifetime like the checkpoint: approval does not survive a restart,
// which is already what the recovery rule says.

import "sync"

// Approval is one human yes to one exact proposal.
type Approval struct {
	RunID   string
	Attempt int
	Tool    string
	CallID  string
	ArgHash string
}

type approvalKey struct {
	runID   string
	attempt int
	tool    string
	callID  string
	argHash string
}

// ApprovalStore keeps the pending requests (what the human is being asked)
// and the approvals (what the human said yes to). Both are keyed by the
// exact proposal.
type ApprovalStore struct {
	mu       sync.Mutex
	approved map[approvalKey]bool
	pending  map[approvalKey]bool
}

func newApprovalStore() *ApprovalStore {
	return &ApprovalStore{
		approved: make(map[approvalKey]bool),
		pending:  make(map[approvalKey]bool),
	}
}

// Request records that the human is being asked about this exact proposal.
func (s *ApprovalStore) Request(ap Approval) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending[keyOf(ap)] = true
}

// Approve records a yes to this exact proposal.
func (s *ApprovalStore) Approve(ap Approval) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, keyOf(ap))
	s.approved[keyOf(ap)] = true
}

// IsApproved reports whether this exact proposal was approved.
func (s *ApprovalStore) IsApproved(ap Approval) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.approved[keyOf(ap)]
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
