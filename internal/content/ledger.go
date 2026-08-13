package content

// Schema v1 of the one authoritative ledger (nocx-rtg0.2), per ADR-0019,
// ADR-0020 and design §5.2. The types here are the public repository seam:
// ContentDB.Ledger() returns a LedgerRepository, the only writer of the v1
// tables. The interim command_history table and CommandHistoryRepository are
// untouched by this surface — they are the live path until nocx-rtg0.3 cuts
// the wire protocol over to ledger.* (design §6.2), and nothing may write
// both (ADR-0019 §4).
//
// Until that cutover the v1 write path has NO PRODUCTION CALLER — only
// tests. Stated loudly because the same shape shipped once before
// (nocx-rtg0: ContentDB.Add reachable only from its own tests while a
// reachable read path hid the unreachable write): the v1 tables are
// schema-complete and test-proven, and deliberately not wired into the
// transport until nocx-rtg0.3.

import "context"

// ── closed enums; each mirrors a CHECK constraint in schemaV1 ─────────────

type EntryKind string

const (
	EntryShell  EntryKind = "shell"
	EntryAgent  EntryKind = "agent"
	EntryAction EntryKind = "action"
)

// Phase is the entry lifecycle (design §3.7): open until execution is
// confirmed, bound while an execution runs, closed once the outcome is
// known. Owned by the driver; the store only records and sweeps.
type Phase string

const (
	PhaseOpen   Phase = "open"
	PhaseBound  Phase = "bound"
	PhaseClosed Phase = "closed"
)

type EntryStatus string

const (
	EntryPending     EntryStatus = "pending"
	EntryRunning     EntryStatus = "running"
	EntrySuccess     EntryStatus = "success"
	EntryFailure     EntryStatus = "failure"
	EntryInterrupted EntryStatus = "interrupted"
	EntryUnknown     EntryStatus = "unknown"
)

// Relation is the edge vocabulary (design §3.4).
type Relation string

const (
	RelRerunOf    Relation = "rerun-of"
	RelSupersedes Relation = "supersedes"
	RelCausedBy   Relation = "caused-by"
	RelCites      Relation = "cites"
	RelInSpan     Relation = "in-span"
)

type MediaType string

const (
	MediaVT       MediaType = "application/vt"
	MediaText     MediaType = "text/plain"
	MediaMarkdown MediaType = "text/markdown"
	MediaJSON     MediaType = "application/json"
)

type ArtifactState string

const (
	ArtifactOpen   ArtifactState = "open"
	ArtifactSealed ArtifactState = "sealed"
)

// Truncation is the primary reason an artifact does not hold the whole
// stream (design §3.5): a cap dropped the middle, a gap lost a range,
// suppression means capture was refused by policy.
type Truncation string

const (
	TruncCap        Truncation = "cap"
	TruncGap        Truncation = "gap"
	TruncSuppressed Truncation = "suppressed"
)

type Sensitivity string

const (
	SensitivityNormal    Sensitivity = "normal"
	SensitivitySensitive Sensitivity = "sensitive"
)

// Criticality gates behaviour (design §3.1) and is therefore contextual —
// it lives on the environment observation, never on the host.
type Criticality string

const (
	CriticalityRoutine   Criticality = "routine"
	CriticalitySensitive Criticality = "sensitive"
	CriticalityCritical  Criticality = "critical"
)

type EnvironmentKind string

const (
	EnvLocal     EnvironmentKind = "local"
	EnvSSH       EnvironmentKind = "ssh"
	EnvContainer EnvironmentKind = "container"
	EnvUnknown   EnvironmentKind = "unknown"
)

// Interactivity is the execution's input policy (ADR-0020 §2, §3);
// awaiting-takeover is the protocol transition where the human owns the
// lane and the agent is demoted, not evicted.
type Interactivity string

const (
	InteractivityNone          Interactivity = "none"
	InteractivityStdin         Interactivity = "stdin"
	InteractivityTTY           Interactivity = "tty"
	InteractivityAwaitTakeover Interactivity = "awaiting-takeover"
)

// TerminationReason distinguishes the five outcomes a single status plus
// exit code cannot (ADR-0020 §4): the command failed, the executor timed
// out, the transport vanished, the user killed it, the agent declined.
type TerminationReason string

const (
	TermCompleted     TerminationReason = "completed"
	TermFailed        TerminationReason = "failed"
	TermTimeout       TerminationReason = "timeout"
	TermTransportGone TerminationReason = "transport-gone"
	TermUserKilled    TerminationReason = "user-killed"
	TermAgentDeclined TerminationReason = "agent-declined"
	TermInterrupted   TerminationReason = "interrupted"
)

// GrantPolicy is the autonomy preset the workspace mints (ADR-0020 §7).
type GrantPolicy string

const (
	GrantAskEveryTime GrantPolicy = "ask-every-time"
	GrantAskOnMutate  GrantPolicy = "ask-on-mutate"
	GrantAutonomous   GrantPolicy = "autonomous"
)

type ResourceKind string

const (
	ResourceEnvironment ResourceKind = "environment"
	ResourceSession     ResourceKind = "session"
	ResourcePath        ResourceKind = "path"
	ResourceCredential  ResourceKind = "credential"
	ResourceDestination ResourceKind = "destination"
	ResourceTool        ResourceKind = "tool"
)

// CaptureMethod records whether artifact text came from terminal cells, from
// raw output, from serialized block HTML, or was never captured (ADR-0019
// §6: derived text must be able to say how it was taken).
type CaptureMethod string

const (
	CaptureTerminalCells  CaptureMethod = "terminal-cells"
	CaptureRawOutput      CaptureMethod = "raw-output"
	CaptureSerializedHTML CaptureMethod = "serialized-html"
	CaptureNone           CaptureMethod = "none"
)

type Stream string

const (
	StreamStdout   Stream = "stdout"
	StreamStderr   Stream = "stderr"
	StreamCombined Stream = "combined"
)

// ── records ───────────────────────────────────────────────────────────────

// Workspace is narrative and presentation scope (ADR-0020 §5): which
// sessions read as one story. It mints default grants from its policy; it is
// never the enforcement object.
type Workspace struct {
	ID   string
	Name string
}

// Session is a restore key, never a recall filter (ADR-0019 §5): it names
// "that tab". An entry outlives its session (ON DELETE SET NULL).
type Session struct {
	ID          string // server-authoritative (AD-7)
	WorkspaceID string
}

// Environment is the durable identity of where work happens (design §3.1,
// amended): kind, endpoint and profile only. Mutable facts — branch,
// container id, privilege, criticality — live in Observations, so old
// entries are never reinterpreted with today's facts.
type Environment struct {
	ID        string
	Kind      EnvironmentKind
	Endpoint  *string // canonical user@host:port; nil for local
	ProfileID *string
	Payload   string // identity facets JSON (sparse extension only)
}

// Observation is one versioned snapshot of an environment's mutable facts.
// Append-only: version ascends per environment and an execution pins the
// observation current when it started.
type Observation struct {
	ID            int64 // filled on read; the row identity executions pin
	EnvironmentID string
	Version       int
	ObservedAt    int64  // backend wall clock, display only
	Confidence    string // JSON per-facet: asserted | derived | unknown
	Criticality   Criticality
	Payload       string // facet values JSON: branch, containerId, privilege, …
}

// SubmitEntry carries the client-minted intent. The client id is an
// UNTRUSTED idempotency key: the store binds it to Client and a digest of
// the submitted content, so a replay of the same id aliases the same intent
// and a replay with different content is refused (ErrIDConflict).
type SubmitEntry struct {
	ID             string // client-minted UUIDv7
	Client         string // client identity binding the idempotency key
	EnvironmentID  string
	SessionID      *string
	Cwd            string
	Kind           EntryKind
	Intent         string
	ConversationID *string
	StartedAt      *int64 // frontend monotonic clock — durations only
	EndedAt        *int64
	DurationMs     *int64
	Sensitivity    Sensitivity
	Payload        string // kind payload JSON (sparse extension only)
}

// SubmitResult is the store's answer to Submit: the backend-assigned
// ingest_seq (commit order, NOT causality — ADR-0019 §2), the store-stamped
// wall clock, and whether the id was a replay of the same submission.
type SubmitResult struct {
	ID          string
	IngestSeq   int64
	SubmittedAt int64
	Replayed    bool
}

// StartExecution begins one run of an entry (ADR-0020 §4): a rerun, a
// retry, a takeover and an infrastructure failure are executions of the same
// entry, never new intents. The store pins the environment observation
// current at this moment — a later observation does not move it. Grant, when
// non-nil, is the authority grant recorded on the run: versioned, expiring,
// immutable once execution starts (the workspace minted it; it is not the
// enforcement object).
type StartExecution struct {
	EntryID            string
	Lane               *string
	Attempt            int
	LeaseDeadline      *int64
	InactivityDeadline *int64
	Interactivity      Interactivity
	ProcessGroup       *string
	Executor           *string
	Grant              *Grant
}

// FinishExecution closes one run and the entry with it: the termination
// reason is the execution's fact, the status is the entry's final one.
type FinishExecution struct {
	EndedAt           int64
	TerminationReason TerminationReason
	Status            EntryStatus
}

// Grant is the authority recorded on a run (ADR-0020 §5).
type Grant struct {
	Version   int
	ExpiresAt int64
	Policy    GrantPolicy
	Scopes    []GrantScope
}

// GrantScope is one resource the grant touches — what "this run held a grant
// for these environments and touched these three sessions" is a query over.
type GrantScope struct {
	Kind ResourceKind
	ID   string
}

// AppendArtifact creates one artifact of an execution, with its capture
// provenance (ADR-0019 §6). Content arrives via AppendChunk; an artifact is
// never one BLOB.
type AppendArtifact struct {
	ExecutionID    int64
	ID             string // client-minted UUIDv7
	MediaType      MediaType
	DerivedFrom    *string
	Pinned         bool
	Truncated      *Truncation
	CaptureMethod  CaptureMethod
	CaptureVersion int
	TerminalCols   *int
	TerminalRows   *int
	Stream         *Stream
	ByteOffset     *int64
	ByteEnd        *int64
	Encoding       string
	Gaps           []Gap
	Payload        string
}

// Gap is one dropped byte range in a captured stream.
type Gap struct {
	Start  int64  `json:"start"`
	End    int64  `json:"end"`
	Reason string `json:"reason"`
}

// Edge is one relation between entries (design §3.4): the difference
// between a log and a memory. Cheap, one narrow table.
type Edge struct {
	From string
	To   string
	Rel  Relation
}

// LedgerEntrySummary is one row of the timeline: enough to page and render
// the recall flow without hauling executions.
type LedgerEntrySummary struct {
	ID            string
	IngestSeq     int64
	EnvironmentID string
	Cwd           string
	Kind          EntryKind
	Intent        string
	Phase         Phase
	Status        EntryStatus
	SubmittedAt   int64
}

// LedgerEntry is the recall-shaped read: the entry with every execution and
// each execution's pinned observation, grant and artifacts.
type LedgerEntry struct {
	ID             string
	IngestSeq      int64
	Client         string
	Digest         string
	EnvironmentID  string
	SessionID      *string
	Cwd            string
	Kind           EntryKind
	Intent         string
	Phase          Phase
	Status         EntryStatus
	ConversationID *string
	SubmittedAt    int64
	StartedAt      *int64
	EndedAt        *int64
	DurationMs     *int64
	Sensitivity    Sensitivity
	ReviewedAt     *int64
	Payload        string
	Executions     []Execution
}

// Execution is one run: lease bounds, interactivity policy, process group,
// start/end, termination reason and executor identity. Artifacts attach to
// the execution, not to the intent.
type Execution struct {
	ID                 int64
	EntryID            string
	Lane               *string
	Attempt            int
	Observation        Observation
	LeaseDeadline      *int64
	InactivityDeadline *int64
	Interactivity      Interactivity
	ProcessGroup       *string
	StartedAt          *int64
	EndedAt            *int64
	TerminationReason  *TerminationReason
	Executor           *string
	Grant              *Grant
	Artifacts          []Artifact
}

// Artifact is one capture of an execution, with provenance. Chunks carries
// the bodies in seq order; it is nil on artifacts embedded in LedgerEntry
// (the recall read must not haul bytes — Artifact fetches them).
type Artifact struct {
	ID             string
	ExecutionID    int64
	MediaType      MediaType
	DerivedFrom    *string
	State          ArtifactState
	ByteLen        int64
	ChunkCount     int
	Pinned         bool
	Truncated      *Truncation
	CaptureMethod  CaptureMethod
	CaptureVersion int
	TerminalCols   *int
	TerminalRows   *int
	Stream         *Stream
	ByteOffset     *int64
	ByteEnd        *int64
	Encoding       string
	Gaps           []Gap
	Payload        string
	Chunks         [][]byte
}

// LedgerRepository is the typed repository for schema v1 (ADR-0019,
// ADR-0020, design §5.2). It is the ONLY writer of the v1 tables; the
// interim CommandHistoryRepository writes command_history, and nothing may
// write both. The write path has no production caller until nocx-rtg0.3.
type LedgerRepository interface {
	// CreateWorkspace records a narrative scope.
	CreateWorkspace(ctx context.Context, ws Workspace) error
	// CreateSession records a restore key under a workspace.
	CreateSession(ctx context.Context, sess Session) error
	// DeleteSession removes a restore key; entries keep their rows and
	// lose the reference (ON DELETE SET NULL — an entry outlives its
	// session, ADR-0019 §5).
	DeleteSession(ctx context.Context, id string) error
	// EnsureEnvironment records durable identity; the first write wins
	// (identity is derived from the facets, so a changed identity is a
	// new id, not an UPDATE).
	EnsureEnvironment(ctx context.Context, env Environment) error
	// RecordObservation appends one versioned observation and returns its
	// row identity — what an execution pins. Append-only: a later
	// observation never rewrites an earlier one.
	RecordObservation(ctx context.Context, obs Observation) (int64, error)
	// Submit accepts an intent as an open entry and returns the
	// backend-assigned ingest_seq. Two entries in the same millisecond
	// still get distinct, ordered sequences — wall time is not a key.
	// Idempotent for (id, client, digest): a replay returns the original
	// row; the same id with different content is ErrIDConflict.
	Submit(ctx context.Context, in SubmitEntry) (SubmitResult, error)
	// Entry is the recall read: the entry, its executions, each
	// execution's pinned observation and grant, and its artifacts
	// (metadata only — no chunk bodies). Nil when no row carries id.
	Entry(ctx context.Context, id string) (*LedgerEntry, error)
	// ListEntries returns the limit newest entries, newest first, ordered
	// by ingest_seq — commit order, never by wall clock.
	ListEntries(ctx context.Context, limit int) ([]LedgerEntrySummary, error)
	// DeleteEntry removes an entry; edges referencing it and its
	// executions (and their artifacts, chunks and grant) cascade. A pin
	// protects against background eviction, not against this.
	DeleteEntry(ctx context.Context, id string) error
	// StartExecution begins one run, pinning the environment observation
	// current at this moment, and returns the execution's row identity.
	// Fails when the entry's environment has no observation yet — there
	// is nothing to pin, and an unpinned execution would be
	// reinterpreted later with today's facts.
	StartExecution(ctx context.Context, in StartExecution) (int64, error)
	// FinishExecution closes the run with its termination reason and
	// closes the entry with its final status.
	FinishExecution(ctx context.Context, executionID int64, end FinishExecution) error
	// AppendArtifact creates one artifact of an execution (never a BLOB:
	// content arrives chunked).
	AppendArtifact(ctx context.Context, in AppendArtifact) (string, error)
	// AppendChunk appends one chunk to an artifact and maintains its
	// byte_len (logical content bytes — the retention budget's unit).
	AppendChunk(ctx context.Context, artifactID string, body []byte) error
	// Artifact returns one artifact with its chunk bodies, or nil when no
	// artifact carries id.
	Artifact(ctx context.Context, id string) (*Artifact, error)
	// AddEdge records one relation between two entries.
	AddEdge(ctx context.Context, e Edge) error
	// Edges returns every edge touching entryID, in either direction.
	Edges(ctx context.Context, entryID string) ([]Edge, error)
}
