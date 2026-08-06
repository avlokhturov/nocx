// Package storagetest isolates the profile directories for a test.
//
// It is the other half of the refusal in [storage.NewAppPaths]: under test that
// function resolves nothing until a root is named here, so isolation is not
// something a test author can forget — only something they have not done yet,
// and the error says so.
//
// It lives in its own package rather than as an exported helper on storage so
// that nothing outside a test can reach it. A production binary that imported
// this would not compile against anything useful; there is no exported way to
// name a root from ordinary code.
package storagetest

import (
	"testing"

	"github.com/shady2k/nocx/internal/storage"
)

// Isolate points this test's profile directories at a temporary root and
// returns it. Every role — config, data and cache — moves together and stays
// distinct, and the root is this test's own, so two tests in one run cannot
// meet in it.
//
// The root is removed by t.TempDir's own cleanup, and the environment is
// restored by t.Setenv's, which is also why a test that calls this cannot call
// t.Parallel: the setting is process-wide for as long as it is in force.
func Isolate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv(storage.TestAppDirEnv, root)
	return root
}
