// Package wailsadapter implements the AttentionHost port (spec §2.2) with the
// Wails desktop runtime (spec §8): banners via the v3 notifications service
// with a routing payload in opts.Data, click-to-tab via OnNotificationResponse,
// and the three permission states of spec §6.4.
//
// The dock badge and the attention bounce are deliberately NOT here: Wails
// v3.0.0-beta.9 exposes neither, and they are the nocx-3a40 cgo task. Host.Badge
// and Host.Bounce report that absence loudly rather than pretending to deliver.
//
// The banner body is passed to the runtime verbatim — it is never spliced
// into any other syntax. The old osascript path in pkg/mac sprintfed the
// body into an AppleScript string literal, so a body containing a double
// quote broke the banner; the v3 notifications service treats the body as
// data (absence_test.go guards the path).
package wailsadapter

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"github.com/shady2k/nocx/internal/notify"
)

// The three permission states of spec §6.4, as observed through the Wails
// runtime. A silent no-op for any of them is the defect this task exists to
// prevent: each failure is a distinct error the product can show.
type Permission int

const (
	// PermissionUnavailable means no notification surface exists at all.
	PermissionUnavailable Permission = iota
	// PermissionNotDetermined means the surface exists and authorization has
	// never been requested.
	PermissionNotDetermined
	// PermissionGranted means banners may be presented.
	PermissionGranted
	// PermissionDenied means the user refused; macOS will not re-prompt.
	PermissionDenied
)

// String names the state for a log line. The composition root records which
// state it resolved at startup, and a bare integer there is unreadable.
func (p Permission) String() string {
	switch p {
	case PermissionUnavailable:
		return "unavailable"
	case PermissionNotDetermined:
		return "not-determined"
	case PermissionGranted:
		return "granted"
	case PermissionDenied:
		return "denied"
	}
	return "unknown"
}

// Errors the host reports per permission state, and for the surfaces Wails
// does not implement. Each is distinct so the product can render each state
// differently instead of swallowing it.
var (
	// ErrDenied is returned when the user has refused authorization.
	ErrDenied = errors.New("notification authorization denied")
	// ErrNotRequested is returned when a banner is attempted before any
	// authorization request.
	ErrNotRequested = errors.New("notification authorization not requested")
	// ErrBadgeBounce is returned for the dock badge and attention bounce,
	// which the Wails runtime does not implement.
	ErrBadgeBounce = errors.New("dock badge and attention bounce are not implemented by the Wails host (nocx-3a40)")
)

// payloadKey is the Data/UserInfo key carrying the event's addressing session
// id. The name matches the wire contract's sessionId field: it is addressing,
// not attribution (AD-7 — session-id is server-authoritative).
const payloadKey = "sessionId"

// Deps are the host's dependencies. Send, IsAvailable, RequestAuthorization,
// CheckAuthorization and RegisterResponse default to their runtime
// counterparts; Focus comes from the composition root, which owns the shell
// and the only channel to the renderer.
//
// Service is the v3 notifications service the default seams bind to. It may
// be nil only when every func seam is supplied: the defaults resolve through
// it, and New falls back to the package singleton.
type Deps struct {
	// Service is the v3 notifications service the default seams bind to.
	Service *notifications.NotificationService

	// Send presents one banner.
	Send func(opts notifications.NotificationOptions) error

	// IsAvailable reports whether this host has a notification surface.
	IsAvailable func() bool

	// RequestAuthorization asks the OS for authorization (spec §6.4: "the
	// control requests it"). Returns granted and any transport error.
	RequestAuthorization func() (bool, error)

	// CheckAuthorization re-reads the current authorization status.
	CheckAuthorization func() (bool, error)

	// RegisterResponse installs the notification click callback.
	RegisterResponse func(callback func(result notifications.NotificationResult))

	// Focus brings the clicked notification's session to the foreground.
	// Required: without it a click has nowhere to land.
	//
	// It takes the session id the banner carried and nothing else. The
	// backend has no tab id: sessionId is the addressing identity on the
	// wire (AD-7 — session-id is server-authoritative) and the renderer is
	// what resolves it to a tab. A sessionID→tab step inside this adapter
	// would be a second addressing identity that no part of the backend can
	// own, which is why the earlier Lookup seam was unsuppliable and every
	// click was therefore discarded.
	Focus func(sessionID string) error

	// Log receives click-callback diagnostics. Defaults to slog.Default().
	Log *slog.Logger
}

// Host is the Wails implementation of notify.AttentionHost.
type Host struct {
	log *slog.Logger

	send             func(opts notifications.NotificationOptions) error
	isAvailable      func() bool
	requestAuth      func() (bool, error)
	checkAuth        func() (bool, error)
	registerResponse func(callback func(result notifications.NotificationResult))
	focus            func(sessionID string) error

	mu        sync.Mutex
	perm      Permission
	requested bool // authorization has been requested through this host and answered
}

// New builds the host.
func New(deps Deps) *Host {
	h := &Host{log: deps.Log}
	if h.log == nil {
		h.log = slog.Default()
	}
	if deps.Service == nil {
		deps.Service = notifications.New()
	}
	if deps.Send != nil {
		h.send = deps.Send
	} else {
		h.send = deps.Service.SendNotification
	}
	if deps.IsAvailable != nil {
		h.isAvailable = deps.IsAvailable
	} else {
		// v3.0.0-beta.9 exposes no availability probe — the notifications
		// service folds unavailability into ServiceStartup (macOS) and
		// per-call send errors (Linux, where a missing org.freedesktop
		// Notifications daemon makes SendNotification fail). The default
		// therefore reports available and every failure surfaces at send
		// time, loudly; PermissionUnavailable stays reachable through this
		// seam where a caller has real knowledge.
		h.isAvailable = func() bool { return true }
	}
	if deps.RequestAuthorization != nil {
		h.requestAuth = deps.RequestAuthorization
	} else {
		h.requestAuth = deps.Service.RequestNotificationAuthorization
	}
	if deps.CheckAuthorization != nil {
		h.checkAuth = deps.CheckAuthorization
	} else {
		h.checkAuth = deps.Service.CheckNotificationAuthorization
	}
	if deps.RegisterResponse != nil {
		h.registerResponse = deps.RegisterResponse
	} else {
		h.registerResponse = deps.Service.OnNotificationResponse
	}
	h.focus = deps.Focus

	if !h.isAvailable() {
		h.perm = PermissionUnavailable
	} else {
		// Available and never requested: the initial state of spec §6.4.
		h.perm = PermissionNotDetermined
	}

	h.registerResponse(h.handleResponse)
	return h
}

// Permission reports the current authorization state.
func (h *Host) Permission() Permission {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.perm
}

// RequestAuthorization is the control's path to prompt macOS (spec §6.4: the
// state "authorization never requested" is resolved by the control requesting
// it). It returns the resulting Permission. A denial is final for this
// process: macOS cannot be re-prompted after a denial, so a second call on
// PermissionDenied returns ErrDenied without touching the OS.
func (h *Host) RequestAuthorization(ctx context.Context) (Permission, error) {
	if err := ctx.Err(); err != nil {
		return h.Permission(), err
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	switch h.perm {
	case PermissionUnavailable:
		return h.perm, notify.ErrUnavailable
	case PermissionGranted:
		return h.perm, nil
	case PermissionDenied:
		return h.perm, ErrDenied
	}

	granted, err := h.requestAuth()
	if err != nil {
		// A transport failure is not a denial: the state stays
		// NotDetermined and the caller may ask again.
		return h.perm, err
	}
	h.requested = true
	if granted {
		h.perm = PermissionGranted
		return h.perm, nil
	}
	h.perm = PermissionDenied
	return h.perm, ErrDenied
}

// Refresh re-reads authorization from the OS. It is the only path that
// observes a change made in System Settings while the app runs. A check
// that returns false is Denied only if authorization was previously
// requested through this host; otherwise it is still NotDetermined.
func (h *Host) Refresh(ctx context.Context) (Permission, error) {
	if err := ctx.Err(); err != nil {
		return h.Permission(), err
	}
	if h.Permission() == PermissionUnavailable {
		return h.Permission(), notify.ErrUnavailable
	}
	granted, err := h.checkAuth()
	if err != nil {
		return h.Permission(), err
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	switch {
	case granted:
		h.perm = PermissionGranted
	case h.requested:
		h.perm = PermissionDenied
	default:
		h.perm = PermissionNotDetermined
	}
	return h.perm, nil
}

// Banner presents one banner. The three permission states fail distinctly —
// none silently — and a granted host passes title and body to the runtime
// verbatim, with the session id in opts.Data for the click callback.
func (h *Host) Banner(ctx context.Context, ev notify.Event) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	switch h.Permission() {
	case PermissionUnavailable:
		return notify.ErrUnavailable
	case PermissionNotDetermined:
		return ErrNotRequested
	case PermissionDenied:
		return ErrDenied
	}

	opts := notifications.NotificationOptions{
		Title: ev.Title,
		Body:  ev.Body,
		Data:  map[string]interface{}{payloadKey: ev.SessionID},
	}
	return h.send(opts)
}

// Badge reports the dock badge as unimplemented by the Wails host. The badge
// is the nocx-3a40 cgo task; a loud error beats a silent no-op.
func (h *Host) Badge(context.Context, int) error { return ErrBadgeBounce }

// Bounce reports the attention bounce as unimplemented by the Wails host.
// Same absence, same loud error.
func (h *Host) Bounce(context.Context) error { return ErrBadgeBounce }

// handleResponse decodes a notification click and focuses the originating
// tab. Every malformed or unknown payload is logged and ignored — never
// panicked on, never allowed to focus an arbitrary tab.
func (h *Host) handleResponse(result notifications.NotificationResult) {
	if result.Error != nil {
		h.log.Warn("notification response error", "error", result.Error)
		return
	}
	resp := result.Response

	// Only a click on the banner body is "focus the tab". This adapter
	// never registers categories, so any action identifier other than the
	// default is unknown.
	if resp.ActionIdentifier != "" && resp.ActionIdentifier != notifications.DefaultActionIdentifier {
		h.log.Warn("notification response has an unknown action", "action", resp.ActionIdentifier)
		return
	}

	sessionID, ok := resp.UserInfo[payloadKey].(string)
	if !ok || sessionID == "" {
		h.log.Warn("notification response carries no usable session id", "userInfo", resp.UserInfo)
		return
	}
	if h.focus == nil {
		h.log.Error("notification click cannot be honored: no focus path is wired", "sessionId", sessionID)
		return
	}
	if err := h.focus(sessionID); err != nil {
		h.log.Warn("focus failed after notification click", "sessionId", sessionID, "error", err)
	}
}
