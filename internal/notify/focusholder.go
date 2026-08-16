package notify

import "sync"

// FocusHolder is a Focus whose source is bound after the policy is built,
// and whose unbound state is "nothing is focused".
//
// It exists for the same ordering reason as HostHolder, and for one more: the
// backend does not know what the user is looking at. Focus is the renderer's
// fact — which tab is active, whether the window is frontmost — and no channel
// reports it to the backend yet (nocx-jiwq.2). Until one does, this holder
// answers "no window focused, no session focused" and suppression therefore
// never suppresses.
//
// That default is deliberate and it is the safe direction. Suppression exists
// to avoid interrupting someone who is already watching the pane; getting it
// wrong in this direction shows a notification the user did not strictly need,
// and getting it wrong in the other direction silently swallows one they did.
// Debounce and coalescing need no focus at all and work fully from the start.
//
// Safe for concurrent use: Set arrives from whatever reports focus while
// raises are already flowing.
type FocusHolder struct {
	mu       sync.RWMutex
	windowed bool
	session  string
}

// Set records the current attention state: whether the app window is
// frontmost, and which session the user is looking at ("" for none).
func (f *FocusHolder) Set(windowFocused bool, focusedSession string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.windowed = windowFocused
	f.session = focusedSession
}

func (f *FocusHolder) WindowFocused() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.windowed
}

func (f *FocusHolder) FocusedSession() string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.session
}
