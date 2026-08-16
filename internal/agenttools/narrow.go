package agenttools

import (
	"context"
	"fmt"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/filesystem"
	"github.com/shady2k/nocx/internal/filesystem/local"
)

// narrowFilesRead is the files.read row's capability constructor (design §5's
// `Narrow: filesystem.ScopedReader`): a read-only view of exactly the grant's
// path scopes, over the local machine's provider. A grant without a path
// scope builds a capability that refuses every read (NewScopedReader with
// zero roots) — the tool can never exceed the grant because it never holds
// more than the grant's paths.
func narrowFilesRead(grant content.Grant) (Capability, error) {
	var paths []string
	for _, s := range grant.Scopes {
		if s.Kind == content.ResourcePath {
			paths = append(paths, s.ID)
		}
	}
	r, err := filesystem.NewScopedReader(context.Background(), local.New(), paths)
	if err != nil {
		return nil, fmt.Errorf("narrow files.read: %w", err)
	}
	return r, nil
}
