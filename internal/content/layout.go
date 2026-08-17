package content

// The durable layout chain (nocx-isoph.1), design
// .internal/specs/2026-08-16-tabs-panes-and-blocks-design.md §3, §4.5, §5, §7:
//
//	workspace   flat, never nested — which tabs are one piece of work
//	  └─ tab    the strip entry, and what the user decorates
//	       └─ pane   THE DURABLE IDENTITY: it outlives its shell, its tab and
//	                 the application
//
// This file is the public seam: ContentDB.Layout() returns a
// LayoutRepository, and it is the only writer of the three tables. It owns
// `workspaces` outright — CreateWorkspace used to hang off LedgerRepository,
// and leaving it there while the tab arrived would have given one table two
// repository owners, which is the defect this whole design spends its length
// avoiding. The ledger still READS through the foreign key
// (sessions.workspace_id) and still ensures a fallback default row for a
// session nobody has recorded; nothing else writes these tables.
//
// WHAT IS STORED AND WHAT IS ONLY COMPUTED is the reason the field list looks
// short (§4.5). The activity indicator, the attention indicator and the label
// are computed from the tab's panes and have NO column: attention arrives at
// a PANE — a command failed, a worker asked a question — so a copy on the tab
// would give one fact two owners, and they diverge the first time a pane is
// dragged elsewhere. What is genuinely the tab's own is "I have seen this",
// which duplicates nothing.
//
// PRODUCTION CALLERS: the layout.* JSON-RPC methods (nocx-isoph.2,
// internal/transport/ws_layout_handlers.go, through capability.LayoutService)
// and the open ack's derived workspaceId. nocx-isoph.3 adds the container
// lifecycle on top. That sentence is here rather than in a deadcode run
// because `deadcode` prints nothing for this package and always has — RTA
// reports every method here reachable only through reflection, so the tool
// cannot tell a wired write path from an unwired one (ledger.go's header says
// the same, for the same reason). This is exactly the shape that shipped once
// before under a green "deadcode is empty" (nocx-rtg0), so the honest
// statement lives next to the seam and is kept current by hand.

import "context"

// TabLayout is the direction a tab arranges its panes in. Direction is a
// property of the SET, size a property of the member (§5) — which is why the
// tab needed a row of its own and the display group did not.
//
// Two values, and the cost is stated rather than hidden: no asymmetric
// layouts, ever, until §5's decision is revisited deliberately. Panes do not
// nest, so "B on the left, C and D stacked on the right" is not expressible
// and is not meant to be.
type TabLayout string

const (
	LayoutRow    TabLayout = "row"
	LayoutColumn TabLayout = "column"
)

// PaneKind is where a pane's pipe goes. Deliberately NOT EnvironmentKind,
// which carries `container` and `unknown` as well: those are honest answers
// about where a recorded command RAN, and a pane is a thing the user opens —
// §5 gives it exactly two, and a type that admitted four would make the
// schema's CHECK the only place the difference was written down.
type PaneKind string

const (
	PaneLocal PaneKind = "local"
	PaneSSH   PaneKind = "ssh"
)

// Workspace is which tabs are one piece of work. Flat, never nested (§3):
// there is no parent, and depth comes from lineage on the tab. It binds no
// host, owns no credentials and confers no authority.
type Workspace struct {
	// ID is client-minted UUIDv7 (§7) and therefore UNTRUSTED: the shape is
	// validated, never believed, and an insert on an existing id FAILS rather
	// than overwriting.
	ID string
	// Name is the user's. A workspace, unlike a tab, is always created
	// deliberately, so it always has one.
	Name string
	// Position orders the switcher.
	Position int
}

// Tab is one slot in the strip and what the user decorates. It is the cheap
// wrapper: a tab is minted when a pane is dragged out and removed when its
// last pane leaves (§4.4), and the pane's identity, blocks, history and live
// pipe are untouched in both directions because only a reference moved.
type Tab struct {
	// ID is client-minted UUIDv7 (§7), UNTRUSTED, and never reused.
	ID string
	// WorkspaceID is never null: every tab is in a workspace, and there is
	// one owner of the default (nocx-fraus, moved here from the session by
	// §4.5 — the backend now owns the whole chain and resolves
	// pane → tab → workspace itself).
	WorkspaceID string
	// ParentID is the LINEAGE edge and nothing else (§4.2): who spawned whom,
	// provenance, immutable, never set by hand. It is admitted by
	// internal/lineage — the same rules a session's parent is admitted by —
	// and there is no method that changes it afterwards.
	//
	// The display grouping ("A, B and C are shown together") is the tab's
	// OTHER edge and must never become this column. It is symmetric, has no
	// host and therefore no row (§4.3), and it is set by dragging, which
	// arrives with nocx-8m2x6. Carrying both on one column is the failure
	// AGENTS.md names: the loser goes on advertising what it can no longer
	// deliver.
	ParentID *string
	// Name is nil when nobody named it, which is the normal case: a tab
	// created by a drag was never named by anybody, so demanding a name asks
	// for something the user did not give. The label is then derived from its
	// panes' titles — computed, never stored. A name the user DOES type is
	// stored here and wins.
	Name *string
	// Colour is nil when the tab was never decorated.
	Colour *string
	// Position orders the strip.
	Position int
	// Pinned keeps the tab at the head of the strip.
	Pinned bool
	// Layout is the direction this tab arranges its panes in.
	Layout TabLayout
	// SeenAt is the seen-mark: when the user last looked at this tab, in Unix
	// milliseconds, nil for a tab never seen. It is a TIMESTAMP rather than an
	// "unseen" flag on purpose — the flag is the computed indicator, and
	// storing it would be the very duplication §4.5 refuses. Whether an
	// unseen tab is still unseen after a restart is §12's second open
	// question, and a mark rather than a verdict leaves it open.
	SeenAt *int64
}

// Pane is the durable identity, and everything else about it follows from
// that: it outlives its shell, its tab and the application, and its blocks
// are found by its id after a restart. A pane and its session are two objects
// because D5 says so — the process dies with the backend and the pane does
// not.
type Pane struct {
	// ID is client-minted UUIDv7 (§7). It must survive a restart, so it
	// cannot come from a backend instance.
	ID string
	// TabID is the only edge a pane has. Panes do not nest (§5): there is no
	// parent pane, structurally, so asymmetric geometry is unrepresentable
	// rather than merely unused.
	TabID string
	// Cwd is where the pane's shell is, and what a restore reopens in.
	Cwd string
	// Kind decides restore behaviour, not a dialog (§8): a local pane starts
	// a fresh shell in the same cwd; an ssh pane attempts to reconnect.
	Kind PaneKind
	// Endpoint is the canonical user@host:port an ssh pane applies at; nil
	// for a local pane.
	Endpoint *string
	// SizeShare is this pane's share of its tab's extent. Size is a property
	// of the MEMBER, direction a property of the set (§5).
	SizeShare float64
}

// Created is what a create answers: the stored object, and whether this call
// found the work already done.
//
// Replayed is the visible half of §7's idempotency rule. A create whose
// answer was lost is retried — AD-9 exists because the socket drops — and the
// retry must return the FIRST object rather than mint a second one. Reporting
// which of the two happened is what lets a test assert the property over the
// wire instead of inferring it from the absence of an error.
type Created[T any] struct {
	Object   T
	Replayed bool
}

// LayoutRepository is the typed repository for the layout chain (ADR-0011 §1:
// each entity declares its own typed repository, no generic Repository[T]).
//
// There is no method that changes a tab's parent, and that absence is load
// bearing: the lineage edge is verified at ADMISSION and never revisited,
// which is what makes it immutable rather than merely unwritten-again. It is
// also what makes a cycle unreachable through this seam — a parent must
// already exist, and a new id cannot already be an ancestor — so the walk
// internal/lineage runs at CreateTab is there for the depth bound and for the
// day a mover is added.
type LayoutRepository interface {
	// CreateWorkspace records one workspace. An id already taken by the SAME
	// request is a replay and answers with the row that is already there; an
	// id already taken by a DIFFERENT request is ErrIDConflict. A create
	// never overwrites (§7).
	CreateWorkspace(ctx context.Context, ws Workspace) (Created[Workspace], error)
	// Workspaces returns every workspace in position order.
	Workspaces(ctx context.Context) ([]Workspace, error)
	// RenameWorkspace gives one workspace a new name and returns the stored
	// row. ErrNoSuchWorkspace when the id names none — a rename never
	// creates, because a create is the only thing that may fix an id.
	RenameWorkspace(ctx context.Context, id, name string) (Workspace, error)
	// ReorderWorkspaces takes the WHOLE switcher order and writes positions
	// 0..n-1 from it, in one transaction. ids must be a permutation of every
	// workspace; anything else is ErrNotAPermutation and nothing moves.
	ReorderWorkspaces(ctx context.Context, ids []string) ([]Workspace, error)
	// DeleteWorkspace removes a workspace; its tabs, and their panes, go with
	// it (ON DELETE CASCADE — a tab has no meaning outside a workspace).
	DeleteWorkspace(ctx context.Context, id string) error
	// CreateTab records one tab under an existing workspace, with the same
	// three answers CreateWorkspace gives. A workspace that does not exist is
	// ErrNoSuchWorkspace. A lineage parent that names no tab, that names the
	// tab itself, or that would join a chain longer than lineage.MaxDepth is
	// refused and nothing is written.
	CreateTab(ctx context.Context, tab Tab) (Created[Tab], error)
	// Tabs returns one workspace's tabs in position order.
	Tabs(ctx context.Context, workspaceID string) ([]Tab, error)
	// RenameTab sets or CLEARS the name the user typed. nil is not "no
	// change": it is the tab going back to the label derived from its panes
	// (§4.5), which is a real product state and the normal one.
	RenameTab(ctx context.Context, id string, name *string) (Tab, error)
	// RecolourTab sets or clears the tab's colour; nil is an undecorated tab.
	RecolourTab(ctx context.Context, id string, colour *string) (Tab, error)
	// PinTab keeps a tab at the head of the strip, or stops doing so.
	PinTab(ctx context.Context, id string, pinned bool) (Tab, error)
	// ReorderTabs takes the whole strip order for ONE workspace. ids must be
	// a permutation of that workspace's tabs — a tab belonging to another
	// workspace is not a member, so naming one is ErrNotAPermutation and not
	// a move: reordering a strip never changes membership.
	ReorderTabs(ctx context.Context, workspaceID string, ids []string) ([]Tab, error)
	// DeleteTab removes a tab; its panes go with it, and any tab that records
	// it as its lineage parent keeps its row with a null parent — the honest
	// "provenance lost" state (ON DELETE SET NULL, the same choice
	// artifacts.derived_from makes and for the same reason). Cascading would
	// delete a tab the user still has open; RESTRICT would make a tab that
	// ever spawned another undeletable, and §4.4 removes tabs automatically.
	DeleteTab(ctx context.Context, id string) error
	// CreatePane records one pane under an existing tab, with the same three
	// answers the other two creates give. A tab that does not exist is
	// ErrNoSuchTab.
	CreatePane(ctx context.Context, pane Pane) (Created[Pane], error)
	// MovePane changes a pane's tab and NOTHING else (§4.4): the identity,
	// the cwd, the blocks and the live pipe are untouched, because only a
	// reference moved. That the round trip is lossless by construction is why
	// the durable object is the pane and the tab is the cheap wrapper.
	//
	// The tab left with no panes is NOT removed here. The container lifecycle
	// — the row going in the same transaction as its last member — is
	// nocx-isoph.3, and splitting it across two beads would give one rule two
	// owners.
	MovePane(ctx context.Context, id, tabID string) (Pane, error)
	// WorkspaceForPane walks pane → tab → workspace. This is what §4.5 means
	// by workspaceId moving off the session: the backend owns the whole chain
	// and RESOLVES the answer rather than being told it, so there is one
	// owner of "which workspace is this in" and it cannot go out of step with
	// a pane that was dragged elsewhere.
	WorkspaceForPane(ctx context.Context, paneID string) (string, error)
	// Panes returns one tab's panes in id order. A pane has no stored
	// position: §5 gives the member a SHARE and the set a direction, and
	// nothing else. Ordering within a tab becomes a user-visible operation
	// with drag (nocx-8m2x6), and that is where the column belongs if it
	// turns out to be needed — inventing it here would put it in the wire
	// contract and the whole chain before anything can say what it means.
	Panes(ctx context.Context, tabID string) ([]Pane, error)
	// DeletePane removes a pane.
	DeletePane(ctx context.Context, id string) error
}
