package transport

// The unified control-plane registration: every JSON-RPC control method is
// declared once, at server construction, as a methodSpec pairing the method
// with the submission that runs it. handleControlFrame has no branch and no
// switch: it looks the method up and calls registration.Submission.TrySubmit
// — the submission decides whether the work runs now (immediate), on a worker
// goroutine under the lane (admission-backed), or never (refused, which the
// caller answers with the saturation error / notification).
//
// The ingress-critical set is closed and VALIDATED at construction. A handler
// that wrongly claims immediate recreates the original bug: a blocking
// handler on the read loop freezes every tab on the socket. The methods below
// are the complete set that must never queue — the reason is concrete for the
// resolvers: RequestUnlock and RequestConnectionPassword block until their
// resolution arrives over the same socket the read loop consumes, so a
// resolution queued behind a full lane would deadlock the ask. ack is ring
// trimming, bounded bookkeeping whose delay would close the AD-10 credit
// window. Nothing else may pair an immediate disposition with a handler.

import (
	"context"
	"fmt"

	"github.com/shady2k/nocx/internal/transport/control"
)

// ingressCriticalMethods is the closed set of methods that run inline on the
// read loop via control.ImmediateSubmission. buildMethodSpecs enforces the
// set in both directions: a method in it must be registered immediate, and no
// other method may be. The set is deliberate and closed — a handler that
// wrongly claims immediate recreates the original bug (a blocking handler on
// the read loop freezes every tab).
var ingressCriticalMethods = map[string]struct{}{
	"ack":                          {},
	"vault.unlockResolved":         {},
	"connections.passwordResolved": {},
}

// methodSpec declares one control method at server construction: the
// submission that runs it and the per-connection handler builder. The
// builder receives the connection's own wsConn and connState and returns the
// handler closure — handlers are constructed types holding their capability
// and Responder, never the *WSServer, so a handler cannot reach a store it
// was not constructed with.
type methodSpec struct {
	method     string
	submission control.Submission
	build      func(w *wsConn, state *connState) handlerFunc
}

// controlMethod is one connection's answer to one control method: the shared
// submission and the connection-scoped handler closure.
type controlMethod struct {
	submission control.Submission
	handle     func(ctx context.Context, req jsonrpcRequest)
}

// buildMethodSpecs validates and indexes the registration set. It rejects
// duplicate methods and any registration that pairs an ingress-critical
// disposition with a method outside the closed set (or a non-immediate
// disposition with a method inside it). The validation happens once, at
// construction, so a wrong claim fails the server build rather than freezing
// a socket at runtime.
func buildMethodSpecs(specs []methodSpec) (map[string]methodSpec, error) {
	m := make(map[string]methodSpec, len(specs))
	for _, spec := range specs {
		if _, dup := m[spec.method]; dup {
			return nil, fmt.Errorf("transport: duplicate registration for control method %q", spec.method)
		}
		_, immediate := spec.submission.(control.ImmediateSubmission)
		if immediate {
			if _, critical := ingressCriticalMethods[spec.method]; !critical {
				return nil, fmt.Errorf(
					"transport: method %q registered with an immediate submission — "+
						"the ingress-critical set is closed (%d methods); a handler that wrongly "+
						"claims it freezes the read loop", spec.method, len(ingressCriticalMethods))
			}
		} else if _, critical := ingressCriticalMethods[spec.method]; critical {
			return nil, fmt.Errorf(
				"transport: ingress-critical method %q registered without an immediate "+
					"submission — its resolution must never queue behind the lane", spec.method)
		}
		m[spec.method] = spec
	}
	return m, nil
}

// connMethods materialises the per-connection handler set from the server's
// validated specs. It is called once per connection, after the connState
// exists; the handlers capture the connection's Responder, never the server.
func connMethods(specs map[string]methodSpec, w *wsConn, state *connState) map[string]controlMethod {
	m := make(map[string]controlMethod, len(specs))
	for name, spec := range specs {
		m[name] = controlMethod{submission: spec.submission, handle: spec.build(w, state)}
	}
	return m
}

// handlerFunc is the per-connection form of a control handler: the request
// context and the decoded request. It is what a methodSpec's builder returns.
type handlerFunc func(ctx context.Context, req jsonrpcRequest)

// reg declares one control method: the submission that runs it and the
// per-connection handler builder. The builder receives the connection's
// wsConn and connState and returns the handler — a constructed type holding
// its capability and Responder, never the server.
func reg(sub control.Submission, method string, build func(w *wsConn, state *connState) handlerFunc) methodSpec {
	return methodSpec{method: method, submission: sub, build: build}
}

// regResponder declares a method whose handler needs only the connection's
// Responder — the common case. Handlers that need connection identity
// (subscriber registration, capture tab id, tunnel ownership) use reg with
// the *wsConn directly.
func regResponder(sub control.Submission, method string, build func(r Responder) handlerFunc) methodSpec {
	return reg(sub, method, func(w *wsConn, _ *connState) handlerFunc { return build(w) })
}

// methodClassFor maps a refused method to its coarse server-side class for
// the control.saturated notification. The class is server vocabulary (the
// schema's "never the raw method name"): the first dot-segment, with the
// session-plane methods mapped to "session".
func methodClassFor(method string) string {
	for i := range len(method) {
		if method[i] == '.' {
			prefix := method[:i]
			if class, ok := coarseMethodClasses[prefix]; ok {
				return class
			}
			return prefix
		}
	}
	return "session"
}

// coarseMethodClasses maps the known method-name prefixes to their coarse
// classes. Unknown prefixes pass through as their own segment; the classes
// exist so the renderer groups refusals by product area, never by raw method.
var coarseMethodClasses = map[string]string{
	"profiles":    "config",
	"groups":      "config",
	"settings":    "config",
	"secrets":     "secrets",
	"vault":       "vault",
	"git":         "git",
	"files":       "fs",
	"fs":          "fs",
	"history":     "history",
	"export":      "export",
	"shell":       "shell",
	"sshConfig":   "ssh",
	"tunnel":      "tunnel",
	"ports":       "ports",
	"dialog":      "dialog",
	"connections": "connections",
	"sessions":    "session",
}
