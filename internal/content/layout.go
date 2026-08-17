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
// PRODUCTION CALLERS: none yet. The container lifecycle landed with
// nocx-isoph.3 — creation-with-content, the dissolution of a container with
// its last member, the move and the replacement tab — and nocx-isoph.2 is
// what puts those calls on the wire; until then this surface is reachable
// only from its own tests, and `deadcode -whylive
// github.com/shady2k/nocx/internal/content.sqliteContent.MovePane` answers
// "reachable only through reflection", the same as every other method here.
// That answer is the tool's limit rather than a finding: RTA counts a method
// a live interface value can hold as reachable, so it cannot tell a wired
// write path from an unwired one, and `deadcode -filter
// 'nocx/internal/content'` has always printed nothing for this package
// (ledger.go's header says the same, for the same reason). This is exactly the shape that shipped once before under a green
// "deadcode is empty" (nocx-rtg0), so the honest statement lives next to the
// seam and is kept current by hand.

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

// Replacement is the identity of the tab that appears when the last tab in
// the APPLICATION closes (nocx-isoph.3, §4.4 of the workspaces UX design). It
// is a parameter rather than something the backend invents for two reasons,
// and both are §7: a tab and a pane id are minted by the frontend, and they
// must survive a restart, so they cannot come from a backend instance.
//
// It is consulted ONLY when the close would otherwise leave no tab anywhere.
// Every other close ignores it, so a caller that always passes one is not
// asking for a tab it will not get.
type Replacement struct {
	// TabID and PaneID are client-minted UUIDv7, like every other id here,
	// and equally untrusted: an id already taken fails the whole close.
	TabID  string
	PaneID string
	// Cwd is where the replacement pane opens. Empty is legal and means the
	// backend process's own directory, which is what an unconfigured local
	// shell already inherits.
	Cwd string
}

// LayoutRepository is the typed repository for the layout chain (ADR-0011 §1:
// each entity declares its own typed repository, no generic Repository[T]).
//
// THE LIFECYCLE IS THE SIGNATURE, not a sweep (nocx-isoph.3, design §4.1 and
// §4.4). A workspace exists only while it holds at least one tab; a tab only
// while it holds at least one pane. Neither rule needs lifecycle code because
// neither empty state is reachable: creation is always creation-with-content
// — which is why CreateWorkspace takes a first tab and CreateTab a first pane
// — and the container's row goes in the SAME TRANSACTION that removes its
// last member. There is no reaper, no periodic check and no "empty" flag,
// because there is no interval in which an empty container exists to find.
//
// There is no method that changes a tab's parent, and that absence is load
// bearing: the lineage edge is verified at ADMISSION and never revisited,
// which is what makes it immutable rather than merely unwritten-again. It is
// also what makes a cycle unreachable through this seam — a parent must
// already exist, and a new id cannot already be an ancestor — so the walk
// internal/lineage runs at CreateTab is there for the depth bound and for the
// day a mover is added. MovePane moves a pane between TABS and is not that
// mover: it touches panes.tab_id and nothing on tabs.
type LayoutRepository interface {
	// CreateWorkspace records one workspace TOGETHER WITH its first tab and
	// that tab's first pane, in one transaction. A call with no first tab is
	// ErrNoFirstTab and a call with no first pane ErrNoFirstPane: an empty
	// workspace was proposed and rejected by the owner — it has no meaning,
	// and refusing it also removes the "open a tab somewhere it does not
	// belong, then move it out" path. An id already taken FAILS; it never
	// overwrites (§7).
	//
	// The first tab's WorkspaceID and the first pane's TabID may be left
	// empty: this call is what creates those containers. Naming a DIFFERENT
	// one is ErrMismatchedContainer rather than a silent re-parent.
	CreateWorkspace(ctx context.Context, ws Workspace, firstTab Tab, firstPane Pane) error
	// Workspaces returns every workspace in position order.
	Workspaces(ctx context.Context) ([]Workspace, error)
	// DeleteWorkspace removes a workspace; its tabs, and their panes, go with
	// it (ON DELETE CASCADE — a tab has no meaning outside a workspace), and
	// so do the sessions recorded under it. If it held the last tabs in the
	// application, the replacement is minted in the same transaction.
	//
	// The DEFAULT workspace is refused with ErrDefaultWorkspace. It never
	// renders, so nothing can offer the affordance, and its row is where the
	// replacement tab goes and where the ledger records every session nobody
	// named a workspace for.
	DeleteWorkspace(ctx context.Context, id string, next Replacement) error
	// CreateTab records one tab under an existing workspace TOGETHER WITH its
	// first pane. This is §4.4's "dragging a pane out of a tab mints a tab
	// for it" — the pane is what the tab is minted around, so a tab with no
	// pane is ErrNoFirstPane. A lineage parent that names no tab, that names
	// the tab itself, or that would join a chain longer than lineage.MaxDepth
	// is refused and nothing is written.
	CreateTab(ctx context.Context, tab Tab, firstPane Pane) error
	// Tabs returns one workspace's tabs in position order.
	Tabs(ctx context.Context, workspaceID string) ([]Tab, error)
	// DeleteTab removes a tab; its panes go with it, and any tab that records
	// it as its lineage parent keeps its row with a null parent — the honest
	// "provenance lost" state (ON DELETE SET NULL, the same choice
	// artifacts.derived_from makes and for the same reason). Cascading would
	// delete a tab the user still has open; RESTRICT would make a tab that
	// ever spawned another undeletable, and §4.4 removes tabs automatically.
	//
	// If it was its workspace's last tab the workspace goes with it, and if
	// it was the application's last the replacement is minted — all in the
	// one transaction.
	DeleteTab(ctx context.Context, id string, next Replacement) error
	// CreatePane records one pane under an existing tab: a SPLIT, the one
	// creation that adds a member to a container that already exists. The
	// first pane of a tab arrives with the tab, through CreateTab.
	CreatePane(ctx context.Context, pane Pane) error
	// MovePane changes which tab a pane is in — §4.4's other direction —
	// and removes the tab it leaves empty, in the same transaction. The
	// pane's identity, its cwd, its blocks and its live pipe are untouched,
	// because only a reference moved: this is an UPDATE of one column on the
	// row that was already there, never a delete and an insert.
	//
	// A move whose destination tab is in ANOTHER WORKSPACE is refused with
	// ErrCrossWorkspaceMove. Whether that is allowed is open (§12 q. 5, and
	// §4.4 of the workspaces design), the atomicity model for a subtree move
	// is undesigned, and the inherited requirement is that a partial move
	// FAILS CLOSED. Refusing the whole move is the form of failing closed
	// that leaves the pane in exactly one place.
	MovePane(ctx context.Context, paneID, tabID string) error
	// Panes returns one tab's panes in id order. A pane has no stored
	// position: §5 gives the member a SHARE and the set a direction, and
	// nothing else. Ordering within a tab becomes a user-visible operation
	// with drag (nocx-8m2x6), and that is where the column belongs if it
	// turns out to be needed — inventing it here would put it in the wire
	// contract and the whole chain before anything can say what it means.
	Panes(ctx context.Context, tabID string) ([]Pane, error)
	// DeletePane removes a pane — and with it the tab it was the last pane
	// of, the workspace that tab was the last tab of, and, if that emptied
	// the application, mints the replacement. One transaction, whichever of
	// those rungs it reaches.
	DeletePane(ctx context.Context, id string, next Replacement) error
}
