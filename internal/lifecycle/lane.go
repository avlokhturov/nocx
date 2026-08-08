package lifecycle

import "time"

// LifecycleState is the per-lane authority axis (ADR-0024 decision 6):
// Native | PromptReady(domain) | Running(attempt) | Desynchronized(domain) |
// Lost. The buffer axis is deliberately absent — it belongs to the renderer,
// never to this kernel.
type LifecycleState uint8

const (
	LifecycleNative LifecycleState = iota + 1
	LifecyclePromptReady
	LifecycleRunning
	LifecycleDesynchronized
	LifecycleLost
)

// laneState is one input-routing lane: a stack of domains (bottom → top, the
// top being the active one when Established) plus the derived lifecycle.
type laneState struct {
	lane             LaneID
	stack            []DomainID
	lifecycle        LifecycleState
	lifecycleDomain  DomainID
	lifecycleAttempt AttemptID
	helloFailures    []time.Time // failed-handshake timestamps (rate limit)
}

// top returns the top of the stack, or "" if empty.
func (ls *laneState) top() DomainID {
	if len(ls.stack) == 0 {
		return ""
	}
	return ls.stack[len(ls.stack)-1]
}

// LaneSnapshot is the read model of one lane: its lifecycle and the domain
// stack, plus every open attempt on the lane. Projection layers consume this;
// there is no current-domain singleton accessor anywhere in the package.
type LaneSnapshot struct {
	Lane         LaneID
	Lifecycle    LifecycleState
	Domain       DomainID    // the domain the lifecycle refers to
	Attempt      AttemptID   // the attempt Running refers to
	Stack        []DomainID  // bottom → top; top is active when Established
	OpenAttempts []AttemptID // sorted, for determinism
}
