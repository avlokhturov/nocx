package capability

// The layout domain (nocx-isoph.2): the workspaces.*, tabs.* and panes.*
// methods by which the frontend ASKS the backend to create, move and destroy
// the objects it used to own itself (design
// .internal/specs/2026-08-16-tabs-panes-and-blocks-design.md §4.1).
//
// One operation, one gate: the CONTENT gate, because the layout chain is
// three tables in content's schema v1 and a reorder is a read-modify-write
// over rows the ledger's own writes sit beside. Sharing the gate with the
// ledger and the ask transaction is not an approximation — it is the same
// database and the same single writer goroutine underneath.
//
// It is a separate SERVICE from LedgerService for the reason the ledger is
// separate from the agent's: what a handler may touch is exactly what its own
// surface declares. The layout handler has no business reaching the entry
// phase machine, and the ledger handler none moving a pane.

import (
	"context"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/transport/control"
)

// LayoutService is the layout domain surface. It is deliberately the whole of
// LayoutRepository's write path plus the reads those writes are checked
// against — a create must be able to answer with the row that is already
// there, which is a read — and nothing else.
type LayoutService interface {
	CreateWorkspace(ctx context.Context, ws content.Workspace) (content.Created[content.Workspace], error)
	RenameWorkspace(ctx context.Context, id, name string) (content.Workspace, error)
	ReorderWorkspaces(ctx context.Context, ids []string) ([]content.Workspace, error)
	DeleteWorkspace(ctx context.Context, id string) error

	CreateTab(ctx context.Context, tab content.Tab) (content.Created[content.Tab], error)
	RenameTab(ctx context.Context, id string, name *string) (content.Tab, error)
	RecolourTab(ctx context.Context, id string, colour *string) (content.Tab, error)
	PinTab(ctx context.Context, id string, pinned bool) (content.Tab, error)
	ReorderTabs(ctx context.Context, workspaceID string, ids []string) ([]content.Tab, error)
	DeleteTab(ctx context.Context, id string) error

	CreatePane(ctx context.Context, pane content.Pane) (content.Created[content.Pane], error)
	MovePane(ctx context.Context, id, tabID string) (content.Pane, error)
}

// LayoutOperation is the typed operation for the layout domain. Its gate is
// [content].
type LayoutOperation interface {
	Run(context.Context, func(context.Context, LayoutService) error) error
}

// NewLayoutOperation builds a LayoutOperation that acquires the content gate
// before the execution lane.
func NewLayoutOperation(contentGate, lane control.Admission, db content.ContentDB) LayoutOperation {
	g := &guard{}
	return newOperation[LayoutService](control.NewComposite(contentGate, lane), g, newLayoutService(g, db))
}

func newLayoutService(g *guard, db content.ContentDB) *layoutService {
	return &layoutService{guard: g, layout: db.Layout()}
}

type layoutService struct {
	guard  *guard
	layout content.LayoutRepository
}

func (s *layoutService) CreateWorkspace(ctx context.Context, ws content.Workspace) (content.Created[content.Workspace], error) {
	if err := s.guard.check(); err != nil {
		return content.Created[content.Workspace]{}, err
	}
	return s.layout.CreateWorkspace(ctx, ws)
}

func (s *layoutService) RenameWorkspace(ctx context.Context, id, name string) (content.Workspace, error) {
	if err := s.guard.check(); err != nil {
		return content.Workspace{}, err
	}
	return s.layout.RenameWorkspace(ctx, id, name)
}

func (s *layoutService) ReorderWorkspaces(ctx context.Context, ids []string) ([]content.Workspace, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return s.layout.ReorderWorkspaces(ctx, ids)
}

func (s *layoutService) DeleteWorkspace(ctx context.Context, id string) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	return s.layout.DeleteWorkspace(ctx, id)
}

func (s *layoutService) CreateTab(ctx context.Context, tab content.Tab) (content.Created[content.Tab], error) {
	if err := s.guard.check(); err != nil {
		return content.Created[content.Tab]{}, err
	}
	return s.layout.CreateTab(ctx, tab)
}

func (s *layoutService) RenameTab(ctx context.Context, id string, name *string) (content.Tab, error) {
	if err := s.guard.check(); err != nil {
		return content.Tab{}, err
	}
	return s.layout.RenameTab(ctx, id, name)
}

func (s *layoutService) RecolourTab(ctx context.Context, id string, colour *string) (content.Tab, error) {
	if err := s.guard.check(); err != nil {
		return content.Tab{}, err
	}
	return s.layout.RecolourTab(ctx, id, colour)
}

func (s *layoutService) PinTab(ctx context.Context, id string, pinned bool) (content.Tab, error) {
	if err := s.guard.check(); err != nil {
		return content.Tab{}, err
	}
	return s.layout.PinTab(ctx, id, pinned)
}

func (s *layoutService) ReorderTabs(ctx context.Context, workspaceID string, ids []string) ([]content.Tab, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return s.layout.ReorderTabs(ctx, workspaceID, ids)
}

func (s *layoutService) DeleteTab(ctx context.Context, id string) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	return s.layout.DeleteTab(ctx, id)
}

func (s *layoutService) CreatePane(ctx context.Context, pane content.Pane) (content.Created[content.Pane], error) {
	if err := s.guard.check(); err != nil {
		return content.Created[content.Pane]{}, err
	}
	return s.layout.CreatePane(ctx, pane)
}

func (s *layoutService) MovePane(ctx context.Context, id, tabID string) (content.Pane, error) {
	if err := s.guard.check(); err != nil {
		return content.Pane{}, err
	}
	return s.layout.MovePane(ctx, id, tabID)
}
