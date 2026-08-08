package transport

// The files.* control plane (fm-w8): six JSON-RPC methods backed by
// internal/filesystem, plus the files.changed notification.
//
// Two guards, and they are the point of this file:
//
//  1. files.open is authorised by connState (D15) — a connection can open
//     a filesystem only for a session it has opened or reattached to. The
//     global session registry is never the answer: resolving a sessionId
//     through it would let any authenticated socket that learned another
//     connection's session id open that session's filesystem.
//  2. Every later call re-checks, in exactly one place: Registry.Acquire
//     re-checks that the binding's session is in the REQUESTING
//     connection's connState, and takes the use-guard that keeps the
//     binding alive for the call. A handler cannot forget a check it
//     never performs.
//
// The change notification's addressing is the interesting half: the
// destination is resolved at emit time — the binding's session's current
// subscriber (sessionRx.subscriber), never the connection that opened the
// binding, which is destroyed on a WebSocket drop. With no subscriber,
// changes accumulate as a set of dirty paths and are delivered once on
// re-attach (spec §5.2).
//
// Until the watching wave lands (design §6 step 5: fsnotify locally,
// polling over SFTP, both provider-side), the change signal is a
// transport-side digest-poll loop: files.watch installs the provider's
// watch set (whose mode the response reports, degrading honestly to
// polling when the provider refuses), and the loop re-lists each watched
// path, comparing the listing digest — the same comparison the SFTP
// watcher will perform. internal/filesystem is read-only for this wave and
// exposes no watch-event seam, so this loop is the only change signal the
// transport can produce; it is what the files.changed tests drive.

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/shady2k/nocx/internal/filesystem"
	"github.com/shady2k/nocx/internal/session"
)

// FilesystemProviderFactory builds the provider files.open registers for a
// resolved session. rootPath is the optional D2 override — the verified
// OSC 7 cwd — and is empty when the caller omitted it; the provider
// interprets it by its own path rules and falls back to Root() when it is
// absent or unusable. Declared on the transport side so the dependency
// stays filesystem ← transport; wired at the composition root (AD-8), the
// way internal/discovery declares its consumer interfaces. When nil,
// files.open answers an error.
type FilesystemProviderFactory func(sess session.Session, rootPath string) (filesystem.Provider, error)

// filesystemEndpointAttester is the optional attestation surface a provider
// may carry (spec §5.1): the composition root wraps the sftp provider with
// the v1 endpoint id so the binding's endpointId is backend-attested rather
// than client-supplied. A local provider never implements it — an empty
// attestation is what makes files.reveal a local-only capability (D4). The
// transport only reads the seam; it never computes an attestation itself
// (AD-8).
type filesystemEndpointAttester interface {
	EndpointID() string
}

// FilesRevealer shows a path in the OS file manager (files.reveal). The
// Wails runtime seam is a later wave (design §6 step 6); the interface is
// declared now so the handler exists, the local-only guard is enforced,
// and an unwired revealer answers -32601 instead of silently doing
// nothing.
type FilesRevealer interface {
	Reveal(path string) error
}

// defaultFilesPollInterval is the transport-side digest-poll cadence for
// watched paths while the provider-side watchers are absent. Tests shorten
// it through filesPollInterval.
const defaultFilesPollInterval = 500 * time.Millisecond

// filesBinding is the transport's bookkeeping for one binding it issued.
// The filesystem package deliberately exposes neither a binding's session
// nor its endpoint attestation, so the transport records what it itself
// handed to Register at files.open: the session the binding belongs to
// (notification addressing, spec §5.2) and the endpoint attestation
// (files.reveal's local-only guard, D4). endpointID is empty for local
// bindings, which is what makes files.reveal a local-only capability.
type filesBinding struct {
	sessionID  session.ID
	endpointID string
	watcher    *filesWatcher // nil until files.watch
}

// filesWatcher is the transport-side watch state of one binding: the paths
// under observation and their last-seen listing digests, the dirty set
// awaiting a subscriber, and the poll loop that detects change. It holds
// the handle the owning connection's files.watch acquired — the
// authorisation happened there, once — and releases it on stop, before
// the binding is closed, so the use-guard always drains. It never
// references a *wsConn: the notification destination is resolved at emit
// time from the session's current subscriber, which is what survives an
// AD-9 reconnect.
type filesWatcher struct {
	bindingID string
	sessionID session.ID

	mu      sync.Mutex
	paths   map[string]string // path → last seen Rev ("" = watch-time baseline failed; first successful poll announces)
	dirty   map[string]string // path → rev known when it went dirty ("" = unknown); awaiting a subscriber
	handle  filesystem.Handle
	release func()

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}
}

// ── wire shapes (contracts/files.*.schema.json) ──────────────────────────

type filesOpenParams struct {
	SessionID string `json:"sessionId"`
	RootPath  string `json:"rootPath,omitempty"`
}

type filesOpenResult struct {
	BindingID  string          `json:"bindingId"`
	EndpointID *string         `json:"endpointId"` // null for a local binding, never absent
	Root       filesRootResult `json:"root"`
}

type filesRootResult struct {
	Path           string `json:"path"`
	Display        string `json:"display"`
	Inferred       bool   `json:"inferred"`
	InferredReason string `json:"inferredReason"`
}

type filesListParams struct {
	BindingID string `json:"bindingId"`
	Path      string `json:"path"`
	Offset    int    `json:"offset"`
	Limit     int    `json:"limit"`
}

// filesListEntry is one row of a listing. linkTarget/linkKind are present
// only for symlinks — omitempty, never null — and kind closes at the
// schema's enum: an entry whose metadata could not be read collapses to
// "other" (wireKind), never to a plausible size it never had.
type filesListEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	LinkTarget string `json:"linkTarget,omitempty"`
	LinkKind   string `json:"linkKind,omitempty"`
	Size       int64  `json:"size"`
	ModTime    string `json:"modTime"`
	Mode       uint32 `json:"mode"`
}

// The listing result is a discriminated union (D14) — three closed
// branches, one per outcome, never one object with everything optional.
type filesListOK struct {
	State     string           `json:"state"` // "ok"
	Path      string           `json:"path"`
	Canonical string           `json:"canonical"`
	Entries   []filesListEntry `json:"entries"` // never null: [] for an empty directory
	Offset    int              `json:"offset"`
	Total     int              `json:"total"`
	HasMore   bool             `json:"hasMore"`
	Rev       string           `json:"rev"`
}

type filesListTooLarge struct {
	State         string `json:"state"` // "tooLarge"
	ObservedCount int    `json:"observedCount"`
	Limit         int    `json:"limit"`
}

type filesListTimedOut struct {
	State   string `json:"state"`   // "timedOut"
	Timeout int64  `json:"timeout"` // milliseconds
}

type filesReadParams struct {
	BindingID string `json:"bindingId"`
	Path      string `json:"path"`
	MaxBytes  int64  `json:"maxBytes"`
}

type filesReadResult struct {
	Path      string `json:"path"`
	Canonical string `json:"canonical"`
	Text      string `json:"text"`
	Size      int64  `json:"size"`
	ModTime   string `json:"modTime"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
	Lossy     bool   `json:"lossy"`
	Changed   bool   `json:"changed"`
}

type filesWatchParams struct {
	BindingID string   `json:"bindingId"`
	Paths     []string `json:"paths"`
}

type filesWatchResult struct {
	Mode           string `json:"mode"` // "watching" | "polling"
	DegradedReason string `json:"degradedReason,omitempty"`
}

type filesCloseParams struct {
	BindingID string `json:"bindingId"`
}

type filesRevealParams struct {
	BindingID string `json:"bindingId"`
	Path      string `json:"path"`
}

type filesChangedParams struct {
	BindingID string `json:"bindingId"`
	Path      string `json:"path"`
	Rev       string `json:"rev,omitempty"` // absent when nothing has been re-listed
}

// ── dispatcher ────────────────────────────────────────────────────────────

// handleFilesMethod dispatches the files.* control plane. Handlers run on
// the read loop like handleResize and fs.complete: the provider operations
// are bounded by the D14 caps, and a synchronous response keeps the wire
// order the client's request stream expects.
func (s *WSServer) handleFilesMethod(ctx context.Context, wconn Responder, state *connState, req jsonrpcRequest) {
	if s.filesys == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "files not available"})
		return
	}
	switch req.Method {
	case "files.open":
		s.handleFilesOpen(ctx, wconn, state, req)
	case "files.list":
		s.handleFilesList(ctx, wconn, state, req)
	case "files.read":
		s.handleFilesRead(ctx, wconn, state, req)
	case "files.watch":
		s.handleFilesWatch(ctx, wconn, state, req)
	case "files.close":
		s.handleFilesClose(ctx, wconn, state, req)
	case "files.reveal":
		s.handleFilesReveal(ctx, wconn, state, req)
	}
}

// handleFilesOpen resolves a session the requesting connection owns and
// registers a provider for it, minting the binding every later files.*
// call carries. sessionId appears exactly once on the wire — here (D1) —
// and the authorisation is connState's, not the global registry's (D15):
// the same gate handleResize applies, and a connection that learned
// another connection's session id gets a refusal, not a filesystem.
func (s *WSServer) handleFilesOpen(ctx context.Context, wconn Responder, state *connState, req jsonrpcRequest) {
	var params filesOpenParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.SessionID == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: sessionId required"})
		return
	}
	sid := session.ID(params.SessionID)
	if !state.has(sid) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown sessionId"})
		return
	}
	sess, err := s.registry.Get(sid)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown sessionId"})
		return
	}
	if s.filesProviderFor == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: "files.open not available (no provider factory wired)"})
		return
	}
	p, err := s.filesProviderFor(sess, params.RootPath)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	// The endpoint attestation (spec §5.1): local providers carry none —
	// empty is what makes files.reveal local-only (D4) — and the
	// composition root's remote providers attest their destination through
	// the optional seam. A provider that cannot attest registers with an
	// empty id; the frontend keys its viewers on this value, so an empty
	// remote id collapses into the local namespace and is reported loudly
	// by the factory's tests rather than silently here.
	endpointID := ""
	if a, ok := p.(filesystemEndpointAttester); ok {
		endpointID = a.EndpointID()
	}
	bid, err := s.filesys.Register(p, sid, endpointID)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	s.filesMu.Lock()
	s.filesBindings[bid] = &filesBinding{sessionID: sid, endpointID: endpointID}
	set := s.filesBySession[sid]
	if set == nil {
		set = make(map[string]struct{})
		s.filesBySession[sid] = set
	}
	set[bid] = struct{}{}
	s.filesMu.Unlock()

	// The root rides the open result — the panel needs a starting
	// directory before any files.list. The handle is held only for this
	// call: the use-guard covers the root acquisition, and release drops
	// it (spec §5.1: hold it for the call, defer the release).
	h, release, err := s.filesys.Acquire(bid, state)
	if err != nil {
		s.dropFilesBinding(bid, sid)
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	root, err := h.Root(ctx)
	release()
	if err != nil {
		s.dropFilesBinding(bid, sid)
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}

	var ep *string
	if endpointID != "" {
		ep = &endpointID
	}
	_ = wconn.TryResult(req.ID, mustMarshal(filesOpenResult{
		BindingID:  bid,
		EndpointID: ep,
		Root: filesRootResult{
			Path:           root.Path,
			Display:        root.Display,
			Inferred:       root.Inferred,
			InferredReason: root.InferredReason,
		},
	}))
}

// handleFilesList lists one page of one directory. The three D14 outcomes
// are RESULT states, never errors: tooLarge and timedOut are refusals a
// user can reason about, and the discriminated union is the contract.
func (s *WSServer) handleFilesList(ctx context.Context, wconn Responder, state *connState, req jsonrpcRequest) {
	var params filesListParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" || params.Path == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: bindingId and path required"})
		return
	}
	h, release, err := s.filesys.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	defer release()
	listing, err := h.List(ctx, params.Path, filesystem.Page{Offset: params.Offset, Limit: params.Limit})
	if err != nil {
		var tooLarge *filesystem.ErrTooLarge
		var timedOut *filesystem.ErrTimedOut
		switch {
		case errors.As(err, &tooLarge):
			_ = wconn.TryResult(req.ID, mustMarshal(filesListTooLarge{
				State:         "tooLarge",
				ObservedCount: tooLarge.ObservedCount,
				Limit:         tooLarge.Limit,
			}))
		case errors.As(err, &timedOut):
			_ = wconn.TryResult(req.ID, mustMarshal(filesListTimedOut{
				State:   "timedOut",
				Timeout: timedOut.Timeout.Milliseconds(),
			}))
		default:
			_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		}
		return
	}
	entries := make([]filesListEntry, 0, len(listing.Entries))
	for _, e := range listing.Entries {
		entries = append(entries, filesListEntry{
			Name:       e.Name,
			Path:       e.Path,
			Kind:       wireKind(e.Kind),
			LinkTarget: e.LinkTarget,
			LinkKind:   wireKind(e.LinkKind),
			Size:       e.Size,
			ModTime:    wireTime(e.ModTime),
			Mode:       e.Mode,
		})
	}
	_ = wconn.TryResult(req.ID, mustMarshal(filesListOK{
		State:     "ok",
		Path:      listing.Path,
		Canonical: listing.Canonical,
		Entries:   entries,
		Offset:    listing.Offset,
		Total:     listing.Total,
		HasMore:   listing.HasMore,
		Rev:       listing.Rev,
	}))
}

// handleFilesRead reads one file, bounded and streamed (spec §5.1): at
// most min(requested, 2 MiB) plus one byte, so the memory guard holds for
// a 40 GB file. Canonical is the identity the viewer's singletonKey is
// built from.
func (s *WSServer) handleFilesRead(ctx context.Context, wconn Responder, state *connState, req jsonrpcRequest) {
	var params filesReadParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" || params.Path == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: bindingId and path required"})
		return
	}
	h, release, err := s.filesys.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	defer release()
	content, err := h.Read(ctx, params.Path, params.MaxBytes)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(filesReadResult{
		Path:      content.Path,
		Canonical: content.Canonical,
		Text:      content.Text,
		Size:      content.Size,
		ModTime:   wireTime(content.ModTime),
		Truncated: content.Truncated,
		Binary:    content.Binary,
		Lossy:     content.Lossy,
		Changed:   content.Changed,
	}))
}

// handleFilesWatch replaces the binding's watch set (spec §5.2): the
// client sends the set it currently wants and the backend diffs, so
// collapsing a directory cannot leak a watch. The provider-side set is
// swapped atomically by the registry; when the provider refuses (the
// watching wave has not landed), the transport degrades to its own
// digest-poll loop and reports the degradation — the persistent "Polling"
// badge (spec §5.5) — rather than a silent lie. The watch baseline is
// taken synchronously inside the handler, before the response
// (filesBaseline): from the instant the call returns every change is
// delivered, and changes before it are not replayed — inotify semantics.
func (s *WSServer) handleFilesWatch(ctx context.Context, wconn Responder, state *connState, req jsonrpcRequest) {
	var params filesWatchParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: bindingId and paths required"})
		return
	}
	// The binding must be one this transport issued: the notification
	// addressing needs the session it belongs to, and filesystem exposes
	// none of that.
	s.filesMu.Lock()
	b := s.filesBindings[params.BindingID]
	s.filesMu.Unlock()
	if b == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown bindingId"})
		return
	}
	// Authorisation: Acquire re-checks that THIS connection owns the
	// binding's session (D15) — one map lookup, and it is what holds if
	// an id ever reaches a log, a screenshot or a crash report.
	h, release, err := s.filesys.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	mode, err := h.Watch(ctx, params.Paths)
	if err != nil {
		var unavail *filesystem.ErrWatchUnavailable
		if !errors.As(err, &unavail) {
			release()
			_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
			return
		}
		// No reason: ErrWatchUnavailable says the watching wave (nocx-rkk9)
		// has not landed, which is a build-time fact and not a degrade.
		// Polling is the designed and only mode today, it delivers the
		// change signal the user asked for, and the mechanism under it is
		// not their business. A reason here lights the §5.5 badge for every
		// user on every local binding forever — a warning that is always on
		// warns about nothing and teaches the user to ignore the next one.
		// When Live watching exists, a host that cannot have it will carry a
		// reason from the provider and the badge lights for the first time
		// meaningfully.
		mode = filesystem.WatchMode{Kind: filesystem.WatchPolling}
	}
	if len(params.Paths) == 0 {
		// The client wants no watches: the provider set is already empty
		// (the swap above), so stop the loop and drop the guard.
		release()
		s.filesMu.Lock()
		if b.watcher != nil {
			w := b.watcher
			b.watcher = nil
			s.filesMu.Unlock()
			s.stopFilesWatcher(w)
		} else {
			s.filesMu.Unlock()
		}
		_ = wconn.TryResult(req.ID, mustMarshal(filesWatchResultOf(mode)))
		return
	}

	// Take the baseline synchronously, before the response: from the
	// instant files.watch returns, every change is delivered; changes
	// before it are not (inotify semantics). The old first-poll-tick
	// baseline left a 500 ms window where a change was folded into the
	// baseline and never announced. The listing runs on this call's
	// fresh handle, whose guard is held until the branch below releases
	// it (filesBaseline documents the cost shape).
	baseline := s.filesBaseline(h, params.Paths)

	s.filesMu.Lock()
	b = s.filesBindings[params.BindingID]
	if b == nil {
		// Raced with files.close; the binding is gone.
		s.filesMu.Unlock()
		release()
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown bindingId"})
		return
	}
	if b.watcher == nil {
		w := &filesWatcher{
			bindingID: params.BindingID,
			sessionID: b.sessionID,
			paths:     baseline,
			dirty:     make(map[string]string),
			stop:      make(chan struct{}),
			done:      make(chan struct{}),
		}
		w.mu.Lock()
		w.handle = h
		w.release = release
		w.mu.Unlock()
		b.watcher = w
		// Started under filesMu so files.close can never observe a
		// registered watcher whose loop is not yet running: stopping it
		// would wait on a done channel nothing would close.
		go s.filesPollLoop(w)
		s.filesMu.Unlock()
	} else {
		// Replacement (spec §5.2): reset the poll baseline for the new
		// set — every path baselined NOW, since the replace path had the
		// same first-tick gap. The loop keeps its original handle — the
		// guard is already taken — and this call's fresh handle is
		// released, one guard in, one out.
		w := b.watcher
		w.mu.Lock()
		w.paths = baseline
		w.mu.Unlock()
		s.filesMu.Unlock()
		release()
	}
	_ = wconn.TryResult(req.ID, mustMarshal(filesWatchResultOf(mode)))
}

// handleFilesClose closes the binding: its provider released, its watches
// torn down. Ownership is re-checked like every call (D15) — a binding is
// closed by the connection that owns its session, not by whoever knows
// its id. The watcher stops first so the use-guard drains before Close's
// teardown.
func (s *WSServer) handleFilesClose(ctx context.Context, wconn Responder, state *connState, req jsonrpcRequest) {
	var params filesCloseParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: bindingId required"})
		return
	}
	_, release, err := s.filesys.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	release()

	s.filesMu.Lock()
	b := s.filesBindings[params.BindingID]
	delete(s.filesBindings, params.BindingID)
	if b != nil {
		if set := s.filesBySession[b.sessionID]; set != nil {
			delete(set, params.BindingID)
			if len(set) == 0 {
				delete(s.filesBySession, b.sessionID)
			}
		}
	}
	s.filesMu.Unlock()
	if b != nil && b.watcher != nil {
		s.stopFilesWatcher(b.watcher)
	}
	if err := s.filesys.Close(params.BindingID); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

// handleFilesReveal shows a path in the OS file manager. Local bindings
// only: the backend refuses a remote binding rather than silently doing
// nothing, because a UI-only guard is one bug away from being no guard
// (spec §5.2). Without a wired revealer the method answers -32601 — the
// Wails runtime seam is a later wave, and a reveal that did nothing would
// be a silent lie.
func (s *WSServer) handleFilesReveal(ctx context.Context, wconn Responder, state *connState, req jsonrpcRequest) {
	var params filesRevealParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" || params.Path == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: bindingId and path required"})
		return
	}
	_, release, err := s.filesys.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: filesErrorCode(err), Message: err.Error()})
		return
	}
	release()

	s.filesMu.Lock()
	b := s.filesBindings[params.BindingID]
	s.filesMu.Unlock()
	if b == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown bindingId"})
		return
	}
	if b.endpointID != "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: "files.reveal: remote bindings cannot be revealed"})
		return
	}
	if s.revealer == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "files.reveal not available"})
		return
	}
	if err := s.revealer.Reveal(params.Path); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

// ── notification delivery ─────────────────────────────────────────────────

// emitFilesChanged announces one dirty path for a binding. The destination
// is resolved at emit time (spec §5.2) — the binding's session's CURRENT
// subscriber, never the connection that opened the binding, which is
// destroyed on a WebSocket drop: this is what survives an AD-9 reconnect.
// With no subscriber — or a subscriber whose socket is gone (the write
// fails) — the path accumulates in the dirty set, delivered once on the
// next attach. A set, never a queue: a burst that meant one change
// replays as one.
func (s *WSServer) emitFilesChanged(w *filesWatcher, path, rev string) {
	rx := s.getRx(w.sessionID)
	if rx == nil {
		return // the session is gone; the binding is dying with it
	}
	wconn, _ := rx.getSubscriber()
	if wconn == nil {
		w.mu.Lock()
		w.dirty[path] = rev
		w.mu.Unlock()
		return
	}
	if err := wconn.TryNotify("files.changed", mustMarshal(filesChangedParams{
		BindingID: w.bindingID,
		Path:      path,
		Rev:       rev,
	})); err != nil {
		// The subscriber's socket is going down; the change must not be
		// lost with it. Keep the path dirty for the next attach.
		w.mu.Lock()
		w.dirty[path] = rev
		w.mu.Unlock()
		return
	}
	w.mu.Lock()
	delete(w.dirty, path)
	w.mu.Unlock()
}

// flushFilesChanged delivers the dirty paths a session's bindings
// accumulated while no connection was attached, to the connection that
// just attached. One notification per dirty path, then clear — the
// accumulation was a set, so a burst that meant one change delivers once
// (spec §5.2). Called from handleAttach after setSubscriber, so the
// notifications resolve to the new connection.
func (s *WSServer) flushFilesChanged(sid session.ID, wconn Responder) {
	s.filesMu.Lock()
	ids := make([]string, 0, len(s.filesBySession[sid]))
	for id := range s.filesBySession[sid] {
		ids = append(ids, id)
	}
	watchers := make([]*filesWatcher, 0, len(ids))
	for _, id := range ids {
		if b := s.filesBindings[id]; b != nil && b.watcher != nil {
			watchers = append(watchers, b.watcher)
		}
	}
	s.filesMu.Unlock()
	for _, w := range watchers {
		w.mu.Lock()
		dirty := make(map[string]string, len(w.dirty))
		for p, rev := range w.dirty {
			dirty[p] = rev
		}
		w.mu.Unlock()
		for p, rev := range dirty {
			if err := wconn.TryNotify("files.changed", mustMarshal(filesChangedParams{
				BindingID: w.bindingID,
				Path:      p,
				Rev:       rev,
			})); err != nil {
				return // the socket is dying; whatever remains stays dirty
			}
			w.mu.Lock()
			delete(w.dirty, p)
			w.mu.Unlock()
		}
	}
}

// ── the digest-poll watcher ───────────────────────────────────────────────

// filesPollLoop is the transport-side change detector for one binding: it
// re-lists each watched path and compares the listing digest — the same
// comparison the SFTP watcher will perform provider-side when the watching
// wave lands (design §6 step 5). Until then this loop is the only change
// signal, and it is what files.changed delivers.
func (s *WSServer) filesPollLoop(w *filesWatcher) {
	defer close(w.done)
	interval := s.filesPollInterval
	if interval <= 0 {
		interval = defaultFilesPollInterval
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			if !s.filesPollTick(w) {
				return
			}
		}
	}
}

// filesBaseline takes the watch baseline synchronously: one listing per
// path in the new set, inside files.watch, before the response. This is
// the inotify install point — from the instant the call returns, every
// change is delivered, and changes before it are not replayed (the
// first-poll-tick baseline this replaces left a 500 ms blind spot). A path
// whose listing fails is recorded as "" — unbaselined — and the first poll
// that lists it successfully ANNOUNCES rather than folding the change into
// a baseline nobody saw: the safe direction (a false positive re-lists the
// directory; a false negative hides a change forever).
//
// Sequential, one listing per path, and deliberately so: each listing is
// bounded by the D14 caps (entry cap, size cap, the provider's list
// timeout) and, over SFTP, by the operation lane, so N paths cost at most
// N bounded listings — the same per-tick cost the poll loop already pays,
// moved earlier. The watch set is the expanded tree (one directory per
// expand gesture), so N is small in practice, and the reachable provider
// today is local (sub-ms listings); a bounded-concurrent baseline would add
// machinery the loop itself does not have for a case the product does not
// reach.
func (s *WSServer) filesBaseline(h filesystem.Handle, paths []string) map[string]string {
	base := make(map[string]string, len(paths))
	for _, p := range paths {
		// The poll loop is binding-owned, never request-scoped: it runs for
		// the life of the watch (owner: the files binding, bounded by its
		// session per spec §5.1, never by a WebSocket), so it keeps a
		// background context. The closing event is the binding teardown —
		// stopFilesWatcher, filesSessionClosed or filesBindingClosed.
		listing, err := h.List(context.Background(), p, filesystem.Page{Offset: 0, Limit: 1})
		if err != nil {
			s.log.Debug("files watch baseline failed", "path", p, "error", err)
			base[p] = "" // unbaselined: the first successful poll announces
			continue
		}
		base[p] = listing.Rev
	}
	return base
}

// filesPollTick re-lists every watched path once. Returns false when the
// loop must stop: the binding was closed underneath it (a defensive path —
// the transport's own close paths stop the loop first).
func (s *WSServer) filesPollTick(w *filesWatcher) bool {
	w.mu.Lock()
	paths := make([]string, 0, len(w.paths))
	for p := range w.paths {
		paths = append(paths, p)
	}
	h := w.handle
	w.mu.Unlock()
	if h == nil {
		return true
	}
	for _, p := range paths {
		if !s.filesPollPath(w, h, p) {
			return false
		}
	}
	return true
}

// filesPollPath re-lists one watched path and announces a change when the
// listing digest moved. The baseline is taken synchronously inside
// files.watch (filesBaseline), so this loop only ever COMPARES: a change
// after the call is announced, a change before it is not — inotify
// semantics: events before the watch was installed are not replayed. A
// path whose watch-time baseline failed carries "" and the first
// successful listing here ANNOUNCES it (safe direction: a change made
// while the path was unlistable must surface, not fold into a baseline
// nobody saw). Returns false when the binding is gone and the loop must
// stop.
func (s *WSServer) filesPollPath(w *filesWatcher, h filesystem.Handle, path string) bool {
	// Same owner and closing event as filesBaseline: the poll loop is
	// binding-owned (spec §5.1) and outlives any connection, so it runs on
	// a background context until the binding is torn down.
	listing, err := h.List(context.Background(), path, filesystem.Page{Offset: 0, Limit: 1})
	if err != nil {
		var released *filesystem.ErrHandleReleased
		var notFound *filesystem.ErrNotFound
		switch {
		case errors.As(err, &released):
			s.log.Debug("files watcher: binding closed", "binding_id", w.bindingID, "error", err)
			// Clean up asynchronously: this IS the watcher's own
			// goroutine, and stopFilesWatcher waits on it.
			go s.filesBindingClosed(w.bindingID)
			return false
		case errors.As(err, &notFound):
			// The directory is gone. Announce (rev unknown: nothing has
			// been re-listed — the schema's absent-rev case) and stop
			// polling it, so a vanished directory cannot emit forever.
			s.emitFilesChanged(w, path, "")
			w.mu.Lock()
			delete(w.paths, path)
			w.mu.Unlock()
			return true
		default:
			s.log.Debug("files poll error", "binding_id", w.bindingID, "path", path, "error", err)
			return true
		}
	}
	w.mu.Lock()
	prev, ok := w.paths[path]
	if !ok {
		// The set was replaced between the snapshot and the list.
		w.mu.Unlock()
		return true
	}
	if prev == "" {
		// The watch-time baseline failed (filesBaseline records "" for a
		// path it could not list): the first successful listing
		// ANNOUNCES, so a change made while the path was unlistable
		// surfaces instead of folding into a baseline nobody saw — a
		// false positive re-lists the directory; a false negative hides
		// the change forever.
		w.paths[path] = listing.Rev
		w.mu.Unlock()
		s.emitFilesChanged(w, path, listing.Rev)
		return true
	}
	if listing.Rev == prev {
		w.paths[path] = listing.Rev
		w.mu.Unlock()
		return true
	}
	w.paths[path] = listing.Rev
	w.mu.Unlock()
	s.emitFilesChanged(w, path, listing.Rev)
	return true
}

// ── lifecycle ─────────────────────────────────────────────────────────────

// stopFilesWatcher stops a binding's poll loop and releases its handle.
// The release runs WITHOUT waiting for the loop to exit, and that is safe
// by the filesystem package's own contract (binding.go): each Handle
// method takes its own per-call use-guard, a released handle only refuses
// future begin() calls (ErrHandleReleased) while in-flight calls keep
// their guards, and Close waits for the guards, not for the loop. So the
// loop's next List after the release errors and stops it, and the registry
// close never sees a guard held by the watcher. Waiting instead would let
// a notification write hold a close path hostage forever. The enqueue is
// non-blocking (the outbound pump owns the socket), and a subscriber that
// stopped reading while its socket stays open cannot hang the poll loop —
// the frame is dropped and the path stays dirty for the next attach. w.done
// closes when the loop exits; nothing waits on it.
func (s *WSServer) stopFilesWatcher(w *filesWatcher) {
	w.stopOnce.Do(func() { close(w.stop) })
	w.mu.Lock()
	if w.release != nil {
		w.release()
		w.release = nil
	}
	w.mu.Unlock()
}

// filesSessionClosed tears down every binding of a session — closing the
// terminal closes its bindings (spec §5.1): a binding is bounded by its
// session, never by a WebSocket. The watchers stop first (their handles
// release, so the use-guards drain), then the registry closes the
// bindings. Fire-and-forget: the session itself is already dying, and
// nothing awaits this. Idempotent: a session that reaches this twice
// cleans up once.
func (s *WSServer) filesSessionClosed(sid session.ID) {
	s.filesMu.Lock()
	ids := make([]string, 0, len(s.filesBySession[sid]))
	for id := range s.filesBySession[sid] {
		ids = append(ids, id)
	}
	delete(s.filesBySession, sid)
	watchers := make([]*filesWatcher, 0, len(ids))
	for _, id := range ids {
		b := s.filesBindings[id]
		delete(s.filesBindings, id)
		if b != nil && b.watcher != nil {
			watchers = append(watchers, b.watcher)
		}
	}
	s.filesMu.Unlock()
	for _, w := range watchers {
		s.stopFilesWatcher(w)
	}
	if s.filesys != nil {
		s.filesys.CloseSession(sid)
	}
}

// filesBindingClosed removes a binding's bookkeeping and stops its watcher
// — the defensive cleanup when the poll loop discovers the binding was
// closed underneath it (the transport's own close paths stop first, so
// this is a safety net, not the common path).
func (s *WSServer) filesBindingClosed(bid string) {
	s.filesMu.Lock()
	b := s.filesBindings[bid]
	delete(s.filesBindings, bid)
	if b != nil {
		if set := s.filesBySession[b.sessionID]; set != nil {
			delete(set, bid)
			if len(set) == 0 {
				delete(s.filesBySession, b.sessionID)
			}
		}
	}
	s.filesMu.Unlock()
	if b != nil && b.watcher != nil {
		s.stopFilesWatcher(b.watcher)
	}
}

// dropFilesBinding removes a binding from the transport's bookkeeping and
// closes it in the registry. Used on the files.open error paths, where the
// id never reached the client and the provider must not leak.
func (s *WSServer) dropFilesBinding(bid string, sid session.ID) {
	s.filesMu.Lock()
	delete(s.filesBindings, bid)
	if set := s.filesBySession[sid]; set != nil {
		delete(set, bid)
		if len(set) == 0 {
			delete(s.filesBySession, sid)
		}
	}
	s.filesMu.Unlock()
	_ = s.filesys.Close(bid)
}

// ── wire mapping helpers ──────────────────────────────────────────────────

// filesErrorCode maps filesystem domain errors to JSON-RPC codes: the
// request-shaped refusals — a binding the caller cannot use, a path the
// provider rejects, a row that cannot be opened — are invalid-params;
// everything else is internal. The message always carries the domain
// error's own words (permission denied, no such file or directory), which
// is what the panel surfaces.
func filesErrorCode(err error) int {
	switch err.(type) {
	case *filesystem.ErrUnknownBinding, *filesystem.ErrNotOwned,
		*filesystem.ErrInvalidPath, *filesystem.ErrInvalidPage,
		*filesystem.ErrNotFound, *filesystem.ErrNotDir,
		*filesystem.ErrNotRegular, *filesystem.ErrPermission:
		return -32602
	default:
		return -32603
	}
}

// wireKind maps a provider Kind onto the wire enum
// (contracts/files.list.schema.json). The schema closes at
// regular|dir|symlink|other — there is no "unreadable" — and an entry
// whose metadata could not be read must not be rendered as empty plausible
// data nor as a broken link: its open/expand table row is exactly
// "other"'s (do neither), so it collapses there rather than failing the
// contract or lying with a size it never had.
func wireKind(k filesystem.Kind) string {
	if k == filesystem.KindUnreadable {
		return "other"
	}
	return string(k)
}

// wireTime renders a modification time in the schema's ISO-8601 UTC shape.
func wireTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

// filesWatchResultOf maps a provider WatchMode onto the wire shape: the
// schema's mode enum spells "watching" where the provider says "live".
func filesWatchResultOf(m filesystem.WatchMode) filesWatchResult {
	mode := "polling"
	if m.Kind == filesystem.WatchLive {
		mode = "watching"
	}
	return filesWatchResult{Mode: mode, DegradedReason: m.DegradedReason}
}
