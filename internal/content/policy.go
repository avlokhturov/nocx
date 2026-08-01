package content

import "sync"

// Policy is the live, mutable set of History decisions the user made in
// Settings (design §5.4, brief 2026-08-01). The store consults it per
// operation; the composition root updates it from the settings registry's
// change notifier, so a Settings toggle takes effect without a restart.
//
// The budget (retention size + disk ceiling) is NOT here: it is open-time
// state (auto_vacuum is decided at creation) and lives in Config.Budget.
type Policy struct {
	mu            sync.RWMutex
	enabled       bool
	retentionDays int
	outputEnabled bool
}

// NewPolicy returns the default policy: history kept, no age limit, output
// retained. Output capture is a later epic (nocx-de7); the flag is the seam
// that capture path will gate on.
func NewPolicy() *Policy {
	return &Policy{enabled: true, outputEnabled: true}
}

// SetEnabled flips "keep history at all". When off, Add records nothing.
func (p *Policy) SetEnabled(v bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.enabled = v
}

// Enabled reports whether history is being recorded.
func (p *Policy) Enabled() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.enabled
}

// SetRetentionDays sets the age limit in days; 0 means unbounded by age.
func (p *Policy) SetRetentionDays(d int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.retentionDays = d
}

// RetentionDays returns the age limit in days; 0 means unbounded by age.
func (p *Policy) RetentionDays() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.retentionDays
}

// SetOutputEnabled flips whether command output is retained. Capture is not
// built yet; this is the gate the artifact path (nocx-de7, schema rtg0.2)
// will consult.
func (p *Policy) SetOutputEnabled(v bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.outputEnabled = v
}

// OutputEnabled reports whether command output is retained.
func (p *Policy) OutputEnabled() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.outputEnabled
}
