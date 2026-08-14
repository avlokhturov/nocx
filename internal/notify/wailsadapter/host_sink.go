package wailsadapter

import (
	"context"

	"github.com/shady2k/nocx/internal/notify"
)

// HostSink bridges the router to the AttentionHost port: Deliver presents
// the event through the host's banner, and every host failure — including
// notify.ErrUnavailable from an unavailable host — is a failed delivery the
// router records in the outcome. It never selects where an event goes
// (ADR-0029 §2.3): the host is bound at construction.
type HostSink struct {
	// Host is the bound attention surface. Bind notify.UnavailableHost on
	// hosts with no desktop surface: the sink then reports unavailable
	// instead of stalling the pipeline.
	Host notify.AttentionHost
}

func (s HostSink) Deliver(ctx context.Context, d notify.Delivery) error {
	return s.Host.Banner(ctx, d.Event)
}

// LeavesMachine is false: a banner leaves the machine nowhere.
func (HostSink) LeavesMachine() bool { return false }
