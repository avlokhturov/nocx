package wailsadapter_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/notify"
	"github.com/shady2k/nocx/internal/notify/wailsadapter"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// harness records every runtime interaction and lets a test control the
// authorization answers, so the adapter's behavior is asserted through the
// seams the real Wails runtime would occupy.
type harness struct {
	sent    []notifications.NotificationOptions
	sendErr error
	cb      func(notifications.NotificationResult)
	// focuses records the session ids handed to the Focus seam — session
	// ids, not tab ids: the backend has no tab id and the renderer is what
	// resolves one (AD-7).
	focuses        []string
	focusErr       error
	available      bool
	requestGranted bool
	requestErr     error
	requestCalls   int
	checkGranted   bool
	checkErr       error
	checkCalls     int
	logBuf         bytes.Buffer
}

func newHarness(t *testing.T, mutate ...func(*harness)) (*harness, *wailsadapter.Host) {
	t.Helper()
	h := &harness{
		available:      true,
		requestGranted: true,
		checkGranted:   true,
	}
	for _, m := range mutate {
		m(h)
	}
	host := wailsadapter.New(wailsadapter.Deps{
		Send: func(opts notifications.NotificationOptions) error {
			h.sent = append(h.sent, opts)
			return h.sendErr
		},
		IsAvailable: func() bool { return h.available },
		RequestAuthorization: func() (bool, error) {
			h.requestCalls++
			return h.requestGranted, h.requestErr
		},
		CheckAuthorization: func() (bool, error) {
			h.checkCalls++
			return h.checkGranted, h.checkErr
		},
		RegisterResponse: func(cb func(notifications.NotificationResult)) {
			h.cb = cb
		},
		Focus: func(sessionID string) error {
			h.focuses = append(h.focuses, sessionID)
			return h.focusErr
		},
		Log: slog.New(slog.NewTextHandler(&h.logBuf, nil)),
	})
	return h, host
}

// event builds a program-originated event the way a source adapter would: a
// KindProgramNotify sequence printed by the program, stamped with the
// programRequest trust class. Every caller wants a routable event — a test
// that wants an unroutable one should build its own zero-valued Event.
func event(sessionID, body string) notify.Event {
	return notify.Event{
		SessionID: sessionID,
		Title:     "build finished",
		Body:      body,
		Kind:      notify.KindProgramNotify,
		Trust:     notify.TrustProgramRequest,
	}
}

// grant moves an available host into the granted state through the control
// path, the way the settings control would.
func grant(t *testing.T, host *wailsadapter.Host) {
	t.Helper()
	if _, err := host.RequestAuthorization(context.Background()); err != nil {
		t.Fatalf("RequestAuthorization: %v", err)
	}
}

// TestBannerBodyArrivesVerbatim: a body containing a double quote and one
// containing a newline reach the banner unmangled. The body is never spliced
// into another syntax — it is the exact string the runtime receives, both in
// the options struct and after the JSON encoding the Wails darwin bridge
// applies to the payload.
func TestBannerBodyArrivesVerbatim(t *testing.T) {
	bodies := []string{
		`he said "hello" and it mattered`,
		"line one\nline two",
		`"quoted" and "then" a newline`,
	}
	for _, body := range bodies {
		t.Run(body, func(t *testing.T) {
			h, host := newHarness(t)
			grant(t, host)

			ev := event("s1", body)
			if err := host.Banner(context.Background(), ev); err != nil {
				t.Fatalf("Banner: %v", err)
			}
			if len(h.sent) != 1 {
				t.Fatalf("sent %d notifications, want 1", len(h.sent))
			}
			opts := h.sent[0]
			if opts.Body != body {
				t.Errorf("body mangled in options: got %q want %q", opts.Body, body)
			}
			if opts.Title != ev.Title {
				t.Errorf("title mangled in options: got %q want %q", opts.Title, ev.Title)
			}
			if got := opts.Data["sessionId"]; got != ev.SessionID {
				t.Errorf("click payload sessionId: got %v want %q", got, ev.SessionID)
			}

			// The Wails darwin bridge JSON-encodes the options (the Data
			// payload into userInfo, the body as a plain string); the body
			// must survive that encoding byte-identical.
			raw, err := json.Marshal(opts)
			if err != nil {
				t.Fatalf("json.Marshal(options): %v", err)
			}
			var back notifications.NotificationOptions
			if err := json.Unmarshal(raw, &back); err != nil {
				t.Fatalf("json.Unmarshal: %v", err)
			}
			if back.Body != body {
				t.Errorf("body mangled by JSON round-trip: got %q want %q", back.Body, body)
			}
			if back.Title != ev.Title {
				t.Errorf("title mangled by JSON round-trip: got %q want %q", back.Title, ev.Title)
			}
		})
	}
}

// TestClickFocusesOriginatingSession: the callback decode and the focus call
// are each asserted, and the value handed on is the session id the banner
// carried — verbatim, with no tab id derived from it. Both the empty and the
// Wails-normalized default action identifiers mean "the banner body was
// clicked".
func TestClickFocusesOriginatingSession(t *testing.T) {
	for _, action := range []string{"", "DEFAULT_ACTION"} {
		t.Run("action="+action, func(t *testing.T) {
			h, _ := newHarness(t)
			if h.cb == nil {
				t.Fatal("click callback was not registered")
			}
			h.cb(notifications.NotificationResult{Response: notifications.NotificationResponse{
				ActionIdentifier: action,
				UserInfo:         map[string]interface{}{"sessionId": "s42"},
			}})

			if len(h.focuses) != 1 || h.focuses[0] != "s42" {
				t.Errorf("focus call: got %v want [s42]", h.focuses)
			}
		})
	}
}

// TestClickMalformedPayloadNoFocus: a malformed or unknown callback payload
// is handled without panic and without focusing an arbitrary tab.
func TestClickMalformedPayloadNoFocus(t *testing.T) {
	cases := []struct {
		name    string
		result  notifications.NotificationResult
		wantLog string
	}{
		{"response error", notifications.NotificationResult{Error: errors.New("callback exploded")}, "notification response error"},
		{"unknown action", notifications.NotificationResult{Response: notifications.NotificationResponse{
			ActionIdentifier: "com.apple.UNNotificationDismissActionIdentifier",
			UserInfo:         map[string]interface{}{"sessionId": "s1"},
		}}, "notification response has an unknown action"},
		{"nil user info", notifications.NotificationResult{Response: notifications.NotificationResponse{}}, "notification response carries no usable session id"},
		{"empty user info", notifications.NotificationResult{Response: notifications.NotificationResponse{
			UserInfo: map[string]interface{}{},
		}}, "notification response carries no usable session id"},
		{"session id wrong type", notifications.NotificationResult{Response: notifications.NotificationResponse{
			UserInfo: map[string]interface{}{"sessionId": float64(42)},
		}}, "notification response carries no usable session id"},
		{"session id empty string", notifications.NotificationResult{Response: notifications.NotificationResponse{
			UserInfo: map[string]interface{}{"sessionId": ""},
		}}, "notification response carries no usable session id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newHarness(t)
			h.cb(tc.result)
			if len(h.focuses) != 0 {
				t.Errorf("focused %v, want none", h.focuses)
			}
			if !strings.Contains(h.logBuf.String(), tc.wantLog) {
				t.Errorf("expected log %q, got %q", tc.wantLog, h.logBuf.String())
			}
		})
	}
}

// TestClickUnknownSession: a click naming a session nothing owns any more is
// still handed to Focus — resolving a session id to a tab is the renderer's
// job, so the adapter cannot know it is stale — and Focus saying so is a
// logged failure, not a panic and not a focus of something else.
func TestClickUnknownSession(t *testing.T) {
	h, _ := newHarness(t, func(h *harness) { h.focusErr = errors.New("no tab holds session gone") })
	if h.cb == nil {
		t.Fatal("click callback was not registered")
	}
	h.cb(notifications.NotificationResult{Response: notifications.NotificationResponse{
		UserInfo: map[string]interface{}{"sessionId": "gone"},
	}})
	if len(h.focuses) != 1 || h.focuses[0] != "gone" {
		t.Errorf("focus call: got %v want [gone]", h.focuses)
	}
	if !strings.Contains(h.logBuf.String(), "focus failed after notification click") {
		t.Errorf("expected a logged focus failure, log: %q", h.logBuf.String())
	}
	if !strings.Contains(h.logBuf.String(), "gone") {
		t.Errorf("expected the failure to name the session, log: %q", h.logBuf.String())
	}
}

// TestClickWithoutResolver: a host constructed with no focus path logs the
// inability loudly and never panics.
func TestClickWithoutResolver(t *testing.T) {
	var buf bytes.Buffer
	var cb func(notifications.NotificationResult)
	host := wailsadapter.New(wailsadapter.Deps{
		IsAvailable:          func() bool { return true },
		RequestAuthorization: func() (bool, error) { return true, nil },
		CheckAuthorization:   func() (bool, error) { return true, nil },
		RegisterResponse: func(c func(notifications.NotificationResult)) {
			cb = c
		},
		Log: slog.New(slog.NewTextHandler(&buf, nil)),
	})
	cb(notifications.NotificationResult{Response: notifications.NotificationResponse{
		UserInfo: map[string]interface{}{"sessionId": "s1"},
	}})
	// No panic above is part of the assertion: the host has no focus path to
	// call, and the inability is logged, never acted on blindly.
	if !strings.Contains(buf.String(), "notification click cannot be honored: no focus path is wired") {
		t.Errorf("expected a logged resolver warning, log: %q", buf.String())
	}
	_ = host
}

// TestClickFocusFailure: a focus call that fails is logged — the click is
// honored as far as it can be, and the failure is visible, not swallowed.
func TestClickFocusFailure(t *testing.T) {
	h, _ := newHarness(t, func(h *harness) { h.focusErr = errors.New("tab manager busy") })
	h.cb(notifications.NotificationResult{Response: notifications.NotificationResponse{
		UserInfo: map[string]interface{}{"sessionId": "s42"},
	}})
	if len(h.focuses) != 1 || h.focuses[0] != "s42" {
		t.Errorf("focus call: got %v want [s42]", h.focuses)
	}
	if !strings.Contains(h.logBuf.String(), "focus failed after notification click") {
		t.Errorf("expected a logged focus failure, log: %q", h.logBuf.String())
	}
}

// TestPermissionStates: each of the three states produces a distinct,
// asserted behavior — none is a silent no-op.
func TestPermissionStates(t *testing.T) {
	t.Run("unavailable", func(t *testing.T) {
		h, host := newHarness(t, func(h *harness) { h.available = false })
		if got := host.Permission(); got != wailsadapter.PermissionUnavailable {
			t.Fatalf("Permission: got %v want unavailable", got)
		}
		err := host.Banner(context.Background(), event("s1", "body"))
		if !errors.Is(err, notify.ErrUnavailable) {
			t.Errorf("Banner: got %v want ErrUnavailable", err)
		}
		if len(h.sent) != 0 {
			t.Errorf("sent %d notifications on an unavailable host, want 0", len(h.sent))
		}
		if _, err := host.RequestAuthorization(context.Background()); !errors.Is(err, notify.ErrUnavailable) {
			t.Errorf("RequestAuthorization: got %v want ErrUnavailable", err)
		}
		// AND THE OS IS NEVER TOUCHED. Every assertion above is about the
		// answer; this one is about the call not being made, and it is the
		// one that matters most on macOS, where reading authorization from a
		// process that has no bundle throws an Objective-C exception and
		// aborts the application rather than returning an error Go can see.
		// The startup resolve calls Refresh, so this is the exact path that
		// killed every unbundled run before the composition root began
		// passing ServiceStartup's verdict in through IsAvailable.
		if _, err := host.Refresh(context.Background()); !errors.Is(err, notify.ErrUnavailable) {
			t.Errorf("Refresh: got %v want ErrUnavailable", err)
		}
		if h.checkCalls != 0 || h.requestCalls != 0 {
			t.Errorf("reached the OS on an unavailable host: %d check(s), %d request(s), want 0 and 0",
				h.checkCalls, h.requestCalls)
		}
	})

	t.Run("never requested", func(t *testing.T) {
		h, host := newHarness(t)
		if got := host.Permission(); got != wailsadapter.PermissionNotDetermined {
			t.Fatalf("Permission: got %v want notDetermined", got)
		}
		err := host.Banner(context.Background(), event("s1", "body"))
		if !errors.Is(err, wailsadapter.ErrNotRequested) {
			t.Errorf("Banner: got %v want ErrNotRequested", err)
		}
		if len(h.sent) != 0 {
			t.Errorf("sent %d notifications without authorization, want 0", len(h.sent))
		}
	})

	t.Run("control request grants", func(t *testing.T) {
		h, host := newHarness(t)
		if _, err := host.RequestAuthorization(context.Background()); err != nil {
			t.Fatalf("RequestAuthorization: %v", err)
		}
		if got := host.Permission(); got != wailsadapter.PermissionGranted {
			t.Fatalf("Permission: got %v want granted", got)
		}
		if h.requestCalls != 1 {
			t.Errorf("requestCalls: got %d want 1", h.requestCalls)
		}
		if err := host.Banner(context.Background(), event("s1", "body")); err != nil {
			t.Fatalf("Banner after grant: %v", err)
		}
		if len(h.sent) != 1 {
			t.Errorf("sent %d notifications, want 1", len(h.sent))
		}
	})

	t.Run("denied", func(t *testing.T) {
		h, host := newHarness(t, func(h *harness) { h.requestGranted = false })
		perm, err := host.RequestAuthorization(context.Background())
		if !errors.Is(err, wailsadapter.ErrDenied) {
			t.Fatalf("RequestAuthorization: got %v (%v) want ErrDenied", err, perm)
		}
		if got := host.Permission(); got != wailsadapter.PermissionDenied {
			t.Fatalf("Permission: got %v want denied", got)
		}
		// A denial is final: the second request must not touch the OS again.
		if _, err = host.RequestAuthorization(context.Background()); !errors.Is(err, wailsadapter.ErrDenied) {
			t.Errorf("second RequestAuthorization: got %v want ErrDenied", err)
		}
		if h.requestCalls != 1 {
			t.Errorf("requestCalls: got %d want 1 (no re-prompt after denial)", h.requestCalls)
		}
		err = host.Banner(context.Background(), event("s1", "body"))
		if !errors.Is(err, wailsadapter.ErrDenied) {
			t.Errorf("Banner: got %v want ErrDenied", err)
		}
		if len(h.sent) != 0 {
			t.Errorf("sent %d notifications while denied, want 0", len(h.sent))
		}
	})

	t.Run("denied is distinct from never requested", func(t *testing.T) {
		_, host1 := newHarness(t, func(h *harness) { h.requestGranted = false })
		_, errDenied := host1.RequestAuthorization(context.Background())
		_, host2 := newHarness(t)
		errNotRequested := host2.Banner(context.Background(), event("s1", "body"))
		if errors.Is(errDenied, wailsadapter.ErrNotRequested) || errors.Is(errNotRequested, wailsadapter.ErrDenied) {
			t.Error("denied and never-requested failures are not distinct")
		}
	})

	t.Run("request transport error keeps notDetermined", func(t *testing.T) {
		_, host := newHarness(t, func(h *harness) {
			h.requestGranted = false
			h.requestErr = errors.New("delegate timeout")
		})
		if _, err := host.RequestAuthorization(context.Background()); err == nil {
			t.Fatal("RequestAuthorization: want error")
		}
		if got := host.Permission(); got != wailsadapter.PermissionNotDetermined {
			t.Errorf("Permission after transport error: got %v want notDetermined", got)
		}
	})
}

// TestRefreshObservesSystemSettings: Refresh is the only path that sees a
// change made in System Settings while the app runs, and it still
// discriminates denied from never-requested by whether authorization was
// requested through the host.
func TestRefreshObservesSystemSettings(t *testing.T) {
	t.Run("granted in settings", func(t *testing.T) {
		_, host := newHarness(t)
		perm, err := host.Refresh(context.Background())
		if err != nil {
			t.Fatalf("Refresh: %v", err)
		}
		if perm != wailsadapter.PermissionGranted {
			t.Errorf("Refresh: got %v want granted", perm)
		}
	})

	t.Run("revoked in settings after grant", func(t *testing.T) {
		_, host := newHarness(t, func(h *harness) { h.checkGranted = false })
		grant(t, host)
		perm, err := host.Refresh(context.Background())
		if err != nil {
			t.Fatalf("Refresh: %v", err)
		}
		if perm != wailsadapter.PermissionDenied {
			t.Errorf("Refresh after revoke: got %v want denied", perm)
		}
	})

	t.Run("check false but never requested is notDetermined", func(t *testing.T) {
		_, host := newHarness(t, func(h *harness) { h.checkGranted = false })
		perm, err := host.Refresh(context.Background())
		if err != nil {
			t.Fatalf("Refresh: %v", err)
		}
		if perm != wailsadapter.PermissionNotDetermined {
			t.Errorf("Refresh: got %v want notDetermined", perm)
		}
	})

	t.Run("check error keeps state", func(t *testing.T) {
		_, host := newHarness(t, func(h *harness) { h.checkErr = errors.New("delegate timeout") })
		if _, err := host.Refresh(context.Background()); err == nil {
			t.Fatal("Refresh: want error")
		}
		if got := host.Permission(); got != wailsadapter.PermissionNotDetermined {
			t.Errorf("Permission after check error: got %v want notDetermined", got)
		}
	})
}

// TestBannerHonorsCancelledContext: an invocation whose deadline has passed
// returns the context error without touching the OS.
func TestBannerHonorsCancelledContext(t *testing.T) {
	h, host := newHarness(t)
	grant(t, host)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := host.Banner(ctx, event("s1", "body")); !errors.Is(err, context.Canceled) {
		t.Errorf("Banner: got %v want context.Canceled", err)
	}
	if len(h.sent) != 0 {
		t.Errorf("sent %d notifications on a cancelled invocation, want 0", len(h.sent))
	}
}

// TestBannerSendFailure: when the underlying runtime call fails, the banner
// reports that failure — the adapter never swallows a failed send.
func TestBannerSendFailure(t *testing.T) {
	sendErr := errors.New("darwin bridge refused")
	h, host := newHarness(t, func(h *harness) { h.sendErr = sendErr })
	grant(t, host)
	if err := host.Banner(context.Background(), event("s1", "body")); !errors.Is(err, sendErr) {
		t.Errorf("Banner: got %v want %v", err, sendErr)
	}
	if len(h.sent) != 1 {
		t.Errorf("sent %d notifications, want 1", len(h.sent))
	}
}

// TestBadgeBounceReportedLoudly: the dock badge and the attention bounce are
// a different task (nocx-3a40); the Wails host reports the absence instead
// of silently doing nothing.
func TestBadgeBounceReportedLoudly(t *testing.T) {
	_, host := newHarness(t)
	if err := host.Badge(context.Background(), 3); !errors.Is(err, wailsadapter.ErrBadgeBounce) {
		t.Errorf("Badge: got %v want ErrBadgeBounce", err)
	}
	if err := host.Bounce(context.Background()); !errors.Is(err, wailsadapter.ErrBadgeBounce) {
		t.Errorf("Bounce: got %v want ErrBadgeBounce", err)
	}
}
