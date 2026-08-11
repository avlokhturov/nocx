package lifecycle

import "time"

// DomainState is the authenticated state of one shell instance.
type DomainState uint8

const (
	// DomainPending: minted, awaiting an authenticated hello. No lifecycle
	// events are accepted (decision 3: nothing before accept).
	DomainPending DomainState = iota + 1
	// DomainEstablished: past accept; the only state that can be active.
	DomainEstablished
	// DomainSuspended: yielded the lane to a child; events rejected.
	DomainSuspended
	// DomainDesynchronized: authority held, suspended pending an
	// authenticated snapshot (decision 7).
	DomainDesynchronized
	// DomainClosed: ended cleanly or revoked by budget exhaustion.
	DomainClosed
	// DomainLost: its transport died, or its parent chain was lost.
	DomainLost
)

// Domain is one authenticated shell or helper instance — logical, never an
// alias for a transport (ADR-0024 decision 2). Exported fields are the read
// model; the capability, sequence counter and desync budgets are internal.
type Domain struct {
	ID        DomainID
	Epoch     uint64
	Parent    *DomainID
	Lane      LaneID
	Transport TransportID
	State     DomainState

	capability     Capability
	recovery       FenceNonce // the one-shot recovery fence, minted with the capability
	acceptPending  bool       // hello accepted, accept minted but not yet delivered (decision 9)
	lastSeq        uint64     // last accepted inbound sequence
	desyncBytes    int
	desyncFrames   int
	desyncSince    time.Time
	desyncEpisodes int
	refreshRequest *RequestID // outstanding refresh, if any
}

// DomainHandle is what an establishment request returns: the id, epoch, the
// capability the adapter must substitute into the integration script, and
// the one-shot recovery fence. The capability is the bearer; neither it nor
// the recovery fence is ever exported to the environment — both ride the
// bootstrap script text. The recovery fence is handed to the shell while the
// channel is alive and used exactly once, if the channel dies mid-session:
// the shell writes it to the pty at the next prompt boundary, and nocx
// matches it as the restoration acknowledgement (ADR-0024 decision 8; see
// docs/lifecycle-protocol.md §12). A hostile program cannot forge what it
// never saw; the worst a forged fence can do is force a safe transition to
// native mode, which the ADR's availability bound already accepts.
type DomainHandle struct {
	Domain     DomainID
	Epoch      uint64
	Capability Capability
	Recovery   FenceNonce
}

// DomainRegistry stores domains and their transport bindings. It is keyed by
// domain id and by transport id, and supports several domains on one transport
// (and one domain set spread across several transports for one lane). It is
// not safe for concurrent use except through the Kernel, which serializes it.
type DomainRegistry struct {
	domains      map[DomainID]*Domain
	byTransport  map[TransportID]map[DomainID]struct{}
	epochCounter uint64
}

// NewDomainRegistry returns an empty registry.
func NewDomainRegistry() *DomainRegistry {
	return &DomainRegistry{
		domains:     make(map[DomainID]*Domain),
		byTransport: make(map[TransportID]map[DomainID]struct{}),
	}
}

// Register stores the domain and binds it to its transport.
func (r *DomainRegistry) Register(d *Domain) {
	r.domains[d.ID] = d
	if r.byTransport[d.Transport] == nil {
		r.byTransport[d.Transport] = make(map[DomainID]struct{})
	}
	r.byTransport[d.Transport][d.ID] = struct{}{}
}

// Lookup returns the domain record, if any.
func (r *DomainRegistry) Lookup(id DomainID) (*Domain, bool) {
	d, ok := r.domains[id]
	return d, ok
}

// DomainsOnTransport returns every domain bound to the transport.
func (r *DomainRegistry) DomainsOnTransport(t TransportID) []*Domain {
	var out []*Domain
	for id := range r.byTransport[t] {
		out = append(out, r.domains[id])
	}
	return out
}

// All returns every registered domain.
func (r *DomainRegistry) All() []*Domain {
	out := make([]*Domain, 0, len(r.domains))
	for _, d := range r.domains {
		out = append(out, d)
	}
	return out
}

// nextEpoch returns a fresh, monotonic epoch — never reused, never resumed
// (decision 8: a new session gets a new epoch).
func (r *DomainRegistry) nextEpoch() uint64 {
	r.epochCounter++
	return r.epochCounter
}
