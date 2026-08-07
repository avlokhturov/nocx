package transport

// shell.openUrl tests (brief, nocx-hc0m): the control-plane seam the
// renderer reaches the system browser through. The four states: unwired
// (the dev-web harness — -32601), a non-http(s) URL refused at the seam,
// an opener that fails (its error surfaces), and the success path (the
// opener receives exactly the URL it was handed).

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

// fakeUrlOpener records the URLs it was asked to open.
type fakeUrlOpener struct {
	mu    sync.Mutex
	urls  []string
	err   error
	calls int
}

func (f *fakeUrlOpener) OpenURL(_ context.Context, url string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.urls = append(f.urls, url)
	return f.err
}

func (f *fakeUrlOpener) opened() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.urls...)
}

// TestShellOpenUrl_UnwiredAnswersUnavailable — the dev-web harness has no
// Wails runtime; the method must report itself unavailable (-32601) rather
// than silently doing nothing, so the surface can toast the failure.
func TestShellOpenUrl_UnwiredAnswersUnavailable(t *testing.T) {
	h := newInventoryHarness(t)
	resp := jsonrpcCall(t, h.conn, "shell.openUrl", map[string]any{"url": "https://github.com/shady2k/nocx"})
	var errResult struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResult); err != nil {
		t.Fatalf("shell.openUrl: unmarshal: %v", err)
	}
	if errResult.Error == nil || errResult.Error.Code != -32601 {
		t.Fatalf("unwired shell.openUrl = %+v, want -32601", errResult.Error)
	}
}

// TestShellOpenUrl_RefusesNonHttpURLs — a scheme the shell would happily
// open (file:, javascript:) is not a URL this panel may ever send a user
// to; the refusal happens at the seam, before the opener is consulted.
func TestShellOpenUrl_RefusesNonHttpURLs(t *testing.T) {
	h := newInventoryHarness(t)
	opener := &fakeUrlOpener{}
	h.ws.SetUrlOpener(opener)
	for _, url := range []string{
		"javascript:alert(1)",
		"file:///etc/passwd",
		"ftp://example.com/x",
		"",
		"not a url",
	} {
		resp := jsonrpcCall(t, h.conn, "shell.openUrl", map[string]any{"url": url})
		var errResult struct {
			Error *jsonrpcErrorObj `json:"error"`
		}
		if err := json.Unmarshal(resp, &errResult); err != nil {
			t.Fatalf("shell.openUrl %q: unmarshal: %v", url, err)
		}
		if errResult.Error == nil || errResult.Error.Code != -32602 {
			t.Fatalf("shell.openUrl %q = %+v, want -32602", url, errResult.Error)
		}
	}
	if got := opener.opened(); len(got) != 0 {
		t.Fatalf("opener was consulted for refused URLs: %v", got)
	}
}

// TestShellOpenUrl_OpenerFailureSurfaces — the browser open is a real
// external call, and its failure is an error the surface must see, never a
// silent no-op.
func TestShellOpenUrl_OpenerFailureSurfaces(t *testing.T) {
	h := newInventoryHarness(t)
	opener := &fakeUrlOpener{err: errors.New("no browser")}
	h.ws.SetUrlOpener(opener)
	resp := jsonrpcCall(t, h.conn, "shell.openUrl", map[string]any{"url": "https://github.com/shady2k/nocx"})
	var errResult struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResult); err != nil {
		t.Fatalf("shell.openUrl: unmarshal: %v", err)
	}
	if errResult.Error == nil || errResult.Error.Code != -32603 {
		t.Fatalf("failing opener = %+v, want -32603", errResult.Error)
	}
	if !strings.Contains(errResult.Error.Message, "no browser") {
		t.Fatalf("message = %q, want the opener's own words", errResult.Error.Message)
	}
}

// TestShellOpenUrl_SuccessDeliversTheURL — the success path: the opener
// receives exactly the URL the renderer asked to open, and the result is
// the empty object (the files.reveal shape).
func TestShellOpenUrl_SuccessDeliversTheURL(t *testing.T) {
	h := newInventoryHarness(t)
	opener := &fakeUrlOpener{}
	h.ws.SetUrlOpener(opener)
	resp := jsonrpcCall(t, h.conn, "shell.openUrl", map[string]any{"url": "https://github.com/shady2k/nocx/tree/main"})
	var envelope struct {
		Result json.RawMessage  `json:"result"`
		Error  *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &envelope); err != nil {
		t.Fatalf("shell.openUrl: unmarshal: %v", err)
	}
	if envelope.Error != nil {
		t.Fatalf("shell.openUrl: %+v", envelope.Error)
	}
	if string(envelope.Result) != "{}" {
		t.Fatalf("result = %s, want {}", envelope.Result)
	}
	if got := opener.opened(); len(got) != 1 || got[0] != "https://github.com/shady2k/nocx/tree/main" {
		t.Fatalf("opener received %v, want the one URL", got)
	}
}
