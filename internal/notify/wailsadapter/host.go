// Package wailsadapter implements the AttentionHost port (spec §2.2) with the
// Wails desktop runtime (spec §8): banners via runtime.SendNotification with
// a routing payload in opts.Data, click-to-tab via OnNotificationResponse,
// and the three permission states of spec §6.4.
//
// The dock badge and the attention bounce are deliberately NOT here: Wails
// v2.13 exposes neither, and they are the nocx-3a40 cgo task. Host.Badge and
// Host.Bounce report that absence loudly rather than pretending to deliver.
//
// The banner body is passed to the runtime verbatim — it is never spliced
// into any other syntax. The old osascript path in pkg/mac sprintfed the
// body into an AppleScript string literal, so a body containing a double
// quote broke the banner; runtime.SendNotification treats the body as data.
package wailsadapter

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/shady2k/nocx/internal/notify"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The three permission states of spec §6.4, as observed through the Wails
// runtime. A silent no-op for any of them is the defect this task exists to
// prevent: each failure is a distinct error the product can show.
type Permission int

const (
	// PermissionUnavailable: this host has no notification surface
	// (IsNotificationAvailable is false) — the banner row is unavailable
	// and says why.
	PermissionUnavailable Permission = iota

	// PermissionNotDetermined: the host is available but authorization has
	// never been requested. The control requests it — RequestAuthorization
	// is the only path that prompts macOS.
	PermissionNotDetermined

	// PermissionDenied: authorization was requested and refused. macOS
	// suppresses display and nocx cannot re-prompt after a denial; only
	// System Settings can change this state.
	PermissionDenied

	// PermissionGranted: banners deliver.
	PermissionGranted
)

// Errors the host reports per permission state, and for the surfaces Wails
// does not implement. Each is distinct so the product can render each state
// differently instead of swallowing it.
var (
	// ErrNotRequested is the NotDetermined failure: the banner is refused
	// because authorization has never been requested — sending anyway would
	// be a silent no-op, since macOS drops notifications from unauthorized
	// apps. The settings control requests it.
	ErrNotRequested = errors.New("notify: notification authorization has not been requested; request it from the settings control")

	// ErrDenied is the Denied failure: macOS is suppressing display and the
	// app cannot re-prompt. The only fix is System Settings.
	ErrDenied = errors.New("notify: macOS is suppressing notification display — enable notifications for nocx in System Settings")

	// ErrBadgeBounce is the dock badge and attention bounce: Wails v2.13
	// exposes neither, and they are the nocx-3a40 cgo task. The absence is
	// loud, not silent.
	ErrBadgeBounce = errors.New("notify: dock badge and attention bounce are not implemented by the Wails host")
)

// payloadKey is the Data/UserInfo key carrying the event's addressing session
// id. The name matches the wire contract's sessionId field: it is addressing,
// not attribution (AD-7 — session-id is server-authoritative).
const payloadKey = "sessionId"

// defaultActionIdentifier is the Wails-normalized identifier of a click on
// the banner body (the macOS default action). Categories are never registered
// by this adapter, so any other identifier is unknown and must not focus a
// tab.
const defaultActionIdentifier = "DEFAULT_ACTION"

// Deps are the host's dependencies. Send, IsAvailable, RequestAuthorization,
// CheckAuthorization and RegisterResponse default to their runtime
// counterparts; Lookup and Focus come from the composition root, which owns
// the session registry and tab focus.
type Deps struct {
	// Send presents one banner. The adapter passes the app context, which
	// the Wails runtime uses to locate its frontend; the invocation's
	// deadline is enforced by the adapter, not by the runtime call.
	Send func(ctx context.Context, opts runtime.NotificationOptions) error

	// IsAvailable reports whether this host has a notification surface.
	IsAvailable func(ctx context.Context) bool

	// RequestAuthorization asks the OS for authorization (spec §6.4: "the
	// control requests it"). Returns granted and any transport error.
	RequestAuthorization func(ctx context.Context) (bool, error)

	// CheckAuthorization re-reads the current authorization status.
	CheckAuthorization func(ctx context.Context) (bool, error)

	// RegisterResponse installs the notification click callback.
	RegisterResponse func(ctx context.Context, callback func(result runtime.NotificationResult))

	// Lookup resolves a session id to the tab that owns it. Required: a
	// click cannot focus without it.
	Lookup func(sessionID string) (tab string, ok bool)

	// Focus brings the tab to the foreground. Required.
	Focus func(tabID string) error

	// Log receives click-callback diagnostics. Defaults to slog.Default().
	Log *slog.Logger
}

// Host is the Wails implementation of notify.AttentionHost.
type Host struct {
	appCtx context.Context
	log    *slog.Logger

	send             func(ctx context.Context, opts runtime.NotificationOptions) error
	isAvailable      func(ctx context.Context) bool
	requestAuth      func(ctx context.Context) (bool, error)
	checkAuth        func(ctx context.Context) (bool, error)
	registerResponse func(ctx context.Context, callback func(result runtime.NotificationResult))
	lookup           func(sessionID string) (tab string, ok bool)
	focus            func(tabID string) error

	mu        sync.Mutex
	perm      Permission
	requested bool // authorization has been requested through this host and answered
}

// New builds the host. ctx must be the context from the Wails lifecycle
// hooks — the runtime functions locate the frontend through a context value,
// so a bare context.Background() is a fatal error in the default seams.
func New(ctx context.Context, deps Deps) *Host {
	h := &Host{appCtx: ctx, log: deps.Log}
	if h.log == nil {
		h.log = slog.Default()
	}
	if deps.Send != nil {
		h.send = deps.Send
	} else {
		h.send = runtime.SendNotification
	}
	if deps.IsAvailable != nil {
		h.isAvailable = deps.IsAvailable
	} else {
		h.isAvailable = runtime.IsNotificationAvailable
	}
	if deps.RequestAuthorization != nil {
		h.requestAuth = deps.RequestAuthorization
	} else {
		h.requestAuth = runtime.RequestNotificationAuthorization
	}
	if deps.CheckAuthorization != nil {
		h.checkAuth = deps.CheckAuthorization
	} else {
		h.checkAuth = runtime.CheckNotificationAuthorization
	}
	if deps.RegisterResponse != nil {
		h.registerResponse = deps.RegisterResponse
	} else {
		h.registerResponse = runtime.OnNotificationResponse
	}
	h.lookup = deps.Lookup
	h.focus = deps.Focus

	if !h.isAvailable(ctx) {
		h.perm = PermissionUnavailable
	} else {
		// Available and never requested: the initial state of spec §6.4.
		h.perm = PermissionNotDetermined
	}

	h.registerResponse(ctx, h.handleResponse)
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

	granted, err := h.requestAuth(h.appCtx)
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
	granted, err := h.checkAuth(h.appCtx)
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

	opts := runtime.NotificationOptions{
		Title: ev.Title,
		Body:  ev.Body,
		Data:  map[string]interface{}{payloadKey: ev.SessionID},
	}
	return h.send(h.appCtx, opts)
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
func (h *Host) handleResponse(result runtime.NotificationResult) {
	if result.Error != nil {
		h.log.Warn("notification response error", "error", result.Error)
		return
	}
	resp := result.Response

	// Only a click on the banner body is "focus the tab". This adapter
	// never registers categories, so any action identifier other than the
	// default is unknown.
	if resp.ActionIdentifier != "" && resp.ActionIdentifier != defaultActionIdentifier {
		h.log.Warn("notification response has an unknown action", "action", resp.ActionIdentifier)
		return
	}

	sessionID, ok := resp.UserInfo[payloadKey].(string)
	if !ok || sessionID == "" {
		h.log.Warn("notification response carries no usable session id", "userInfo", resp.UserInfo)
		return
	}
	if h.lookup == nil || h.focus == nil {
		h.log.Error("notification click cannot be honored: no tab resolver is wired")
		return
	}
	tab, ok := h.lookup(sessionID)
	if !ok {
		h.log.Warn("notification response names an unknown session", "sessionId", sessionID)
		return
	}
	if err := h.focus(tab); err != nil {
		h.log.Warn("focus failed after notification click", "tab", tab, "error", err)
	}
}
