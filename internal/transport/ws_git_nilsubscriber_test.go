package transport

import (
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/session"
)

// A session can close with nobody attached — an AD-9 reconnect gap, or a tab
// shut after its socket dropped. rx.getSubscriber() then hands back a nil
// *wsConn, and the notify path must simply do nothing.
//
// The outbound migration briefly broke this in a way no ordinary reading
// catches: the parameter became the Responder interface, and a nil *wsConn
// stored in an interface is not equal to nil. The `wconn == nil` guard went
// on looking correct while passing, and TryNotify dereferenced a nil
// receiver on a goroutine — a panic that takes the whole backend down, and
// one that only fires when a subscriber happens to be absent, so a green
// suite is no evidence against it.
func TestGitSessionClosed_NilSubscriberIsNotACall(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	s := NewWSServer(logger, newRegWithStub(logger))

	sid := session.ID("00000000000000000000000000000001")

	// One binding, so the notify path is reached rather than skipped for
	// having nothing to say.
	s.gitMu.Lock()
	if s.gitBySession == nil {
		s.gitBySession = map[session.ID]map[string]struct{}{}
	}
	if s.gitBindings == nil {
		s.gitBindings = map[string]*gitBinding{}
	}
	s.gitBySession[sid] = map[string]struct{}{"binding-1": {}}
	s.gitBindings["binding-1"] = &gitBinding{}
	s.gitMu.Unlock()

	var absent *wsConn // exactly what getSubscriber returns with nobody attached
	s.gitSessionClosed(sid, absent)

	// Reaching here without a panic is the assertion. The goroutine the old
	// code spawned would have crashed the process, not failed the test, so
	// there is nothing subtler to check.
	s.gitMu.Lock()
	_, still := s.gitBySession[sid]
	s.gitMu.Unlock()
	if still {
		t.Fatal("the session's git bindings were not cleaned up")
	}
}
