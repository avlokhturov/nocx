package transport

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/git/local"
)

// git.log against a REAL repository that has a commit. Every other git.log
// test drives a stub repo, so all of them stayed green while the Git panel
// rendered an empty Commits list in e2e — the gap this closes.
func TestGitLog_RealRepoReturnsItsCommits(t *testing.T) {
	dir := func() string {
		d, evalErr := filepath.EvalSymlinks(t.TempDir())
		if evalErr != nil {
			t.Fatalf("resolving the temp dir: %v", evalErr)
		}
		return d
	}()
	initRealGitRepo(t, dir)

	e := newGitTestEnv(t, WithGitRepoFactory(local.NewFactory()))
	sid := e.openSession(t, 1)

	openResp := jsonrpcCallWithID(t, e.conn, "git.open", map[string]any{
		"sessionId": sid, "cwd": dir,
	}, 2)
	var open struct {
		Result struct {
			State     string `json:"state"`
			BindingID string `json:"bindingId"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(openResp, &open); err != nil {
		t.Fatalf("git.open unmarshal: %v", err)
	}
	if open.Error != nil {
		t.Fatalf("git.open: %+v", open.Error)
	}
	if open.Result.State != "ok" {
		t.Fatalf("git.open state = %q, want ok", open.Result.State)
	}

	logResp := jsonrpcCallWithID(t, e.conn, "git.log", map[string]any{
		"bindingId": open.Result.BindingID,
	}, 3)
	var got struct {
		Result struct {
			Log struct {
				Entries []struct {
					Subject string `json:"subject"`
				} `json:"entries"`
				Total int `json:"total"`
			} `json:"log"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(logResp, &got); err != nil {
		t.Fatalf("git.log unmarshal: %v", err)
	}
	if got.Error != nil {
		t.Fatalf("git.log answered an error: %+v", got.Error)
	}
	// initRealGitRepo makes at least one commit. An empty log here is the
	// e2e failure reproduced: the panel renders a commitless branch for a
	// repository that has commits.
	if len(got.Result.Log.Entries) == 0 {
		t.Fatal("git.log returned no entries for a repository with a commit — the Commits list renders empty")
	}
}

// The Git panel does not call one method and wait; it opens, then asks for
// the log and the remote. Those share the git domain gate, so they
// serialise — and real git is not a stub. If the conflict wait is too tight
// for real subprocess work, a later call is refused and the panel renders a
// commitless branch, which is what e2e saw.
func TestGitPanelCallsInFlightTogetherAreNotRefused(t *testing.T) {
	dir := func() string {
		d, evalErr := filepath.EvalSymlinks(t.TempDir())
		if evalErr != nil {
			t.Fatalf("resolving the temp dir: %v", evalErr)
		}
		return d
	}()
	initRealGitRepo(t, dir)

	e := newGitTestEnv(t, WithGitRepoFactory(local.NewFactory()))
	sid := e.openSession(t, 1)
	openResp := jsonrpcCallWithID(t, e.conn, "git.open", map[string]any{"sessionId": sid, "cwd": dir}, 2)
	var open struct {
		Result struct {
			BindingID string `json:"bindingId"`
		} `json:"result"`
	}
	if err := json.Unmarshal(openResp, &open); err != nil {
		t.Fatalf("git.open unmarshal: %v", err)
	}

	// Fire the panel's follow-ups back to back without reading between them,
	// the way the renderer does.
	for i, method := range []string{"git.log", "git.remote", "git.status", "git.log"} {
		resp := jsonrpcCallWithID(t, e.conn, method, map[string]any{"bindingId": open.Result.BindingID}, 10+i)
		var env struct {
			Error *jsonrpcErrorObj `json:"error"`
		}
		if err := json.Unmarshal(resp, &env); err != nil {
			t.Fatalf("%s unmarshal: %v", method, err)
		}
		if env.Error != nil {
			t.Fatalf("%s was refused: %+v — the panel renders this as empty", method, env.Error)
		}
	}
}
