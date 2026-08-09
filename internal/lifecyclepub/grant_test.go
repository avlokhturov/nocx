package lifecyclepub_test

import (
	"testing"

	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclepub"
)

func requestEvt(rid lifecycle.RequestID, env, host, user string, port int) lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindDomainRequest, DomainRequest: &lifecycle.DomainRequest{
		RequestID: rid, Env: env, Host: host, User: user, Port: port,
	}}
}

// grantFrom returns the first domain_grant the port received, failing the
// test when none arrived.
func grantFrom(t *testing.T, port *recordingPort) lifecycle.Envelope {
	t.Helper()
	for i := range port.sent {
		if port.sent[i].Event.Kind == lifecycle.KindDomainGrant {
			return port.sent[i]
		}
	}
	t.Fatalf("no grant delivered to the port; sent kinds=%v", port.kinds())
	return lifecycle.Envelope{}
}

// TestPublisherGrantEnrichedAndDelivered is the composition seam the shell
// depends on: a validated domain_request produces exactly one grant on the
// parent's port, addressed to the parent, carrying the request echo, the
// child's identity (minted by the builder through the kernel — the kernel
// stays the sole minter) and the opaque bootstrap. The child is a real
// Pending domain under the parent.
func TestPublisherGrantEnrichedAndDelivered(t *testing.T) {
	k := lifecycle.New(lifecycle.Options{})
	var pub *lifecyclepub.Publisher
	pub = lifecyclepub.New(k, lifecyclepub.WithGrantBuilder(func(req lifecyclepub.GrantRequest) (lifecyclepub.GrantBootstrap, error) {
		h, err := pub.RequestDomain(req.Lane, &req.Parent, "T")
		if err != nil {
			return lifecyclepub.GrantBootstrap{}, err
		}
		return lifecyclepub.GrantBootstrap{Domain: h.Domain, Epoch: h.Epoch, Bootstrap: "opaque-sudo-launch"}, nil
	}))
	r := &recorder{}
	pub.SetEmitter(r)
	port := &recordingPort{}
	if err := pub.BindTransport("T", port); err != nil {
		t.Fatal(err)
	}
	h, err := pub.RequestDomain("L", nil, "T")
	if err != nil {
		t.Fatal(err)
	}
	mustIngest(t, pub, "T", env("L", h, 1, helloEvt()))
	mustAckEstablishment(t, pub, r, "L", h)

	mustIngest(t, pub, "T", env("L", h, 2, requestEvt("r-dom-1-0", lifecycle.EnvSudo, "", "", 0)))

	grant := grantFrom(t, port)
	// The grant addresses the PARENT: the adapter routes it to the parent's
	// connection by this tuple.
	if grant.Domain != h.Domain || grant.Epoch != h.Epoch || grant.Capability != h.Capability {
		t.Fatalf("grant must be addressed to the parent, got dom=%s epoch=%d", grant.Domain, grant.Epoch)
	}
	g := grant.Event.DomainGrant
	if g == nil {
		t.Fatal("grant payload missing")
	}
	if g.RequestID != "r-dom-1-0" || g.Env != lifecycle.EnvSudo || g.Bootstrap != "opaque-sudo-launch" {
		t.Fatalf("grant payload wrong: %+v", g)
	}
	// The child exists, minted under the parent on the same transport.
	child, ok := k.Domain(g.Domain)
	if !ok {
		t.Fatalf("child domain %s not minted", g.Domain)
	}
	if child.Parent == nil || *child.Parent != h.Domain {
		t.Fatalf("child must carry the parent, got %+v", child.Parent)
	}
	if child.Epoch != g.Epoch || child.State != lifecycle.DomainPending {
		t.Fatalf("child must be Pending at its minted epoch, got state=%v epoch=%d", child.State, child.Epoch)
	}
}

// TestPublisherGrantRefusedDeliversEmptyBootstrap: a builder failure is the
// honest refusal — the parent receives the grant echo with an empty
// bootstrap and runs its command conventionally; nothing is minted, and the
// pump does not panic.
func TestPublisherGrantRefusedDeliversEmptyBootstrap(t *testing.T) {
	k := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(k, lifecyclepub.WithGrantBuilder(func(req lifecyclepub.GrantRequest) (lifecyclepub.GrantBootstrap, error) {
		return lifecyclepub.GrantBootstrap{}, lifecycle.ErrBadRequest
	}))
	r := &recorder{}
	pub.SetEmitter(r)
	port := &recordingPort{}
	if err := pub.BindTransport("T", port); err != nil {
		t.Fatal(err)
	}
	h, err := pub.RequestDomain("L", nil, "T")
	if err != nil {
		t.Fatal(err)
	}
	mustIngest(t, pub, "T", env("L", h, 1, helloEvt()))
	mustAckEstablishment(t, pub, r, "L", h)

	mustIngest(t, pub, "T", env("L", h, 2, requestEvt("r-dom-1-0", lifecycle.EnvSSH, "box", "", 22)))

	grant := grantFrom(t, port)
	g := grant.Event.DomainGrant
	if g.Bootstrap != "" || g.Domain != "" || g.Epoch != 0 {
		t.Fatalf("refused grant must be the empty-bootstrap echo, got %+v", g)
	}
	if g.RequestID != "r-dom-1-0" || g.Env != lifecycle.EnvSSH || g.Host != "box" {
		t.Fatalf("refused grant must echo the request, got %+v", g)
	}
}

// TestPublisherGrantWithoutBuilderDeliversEcho: no builder wired (tests, or
// a server without the composition seam) answers every request with the
// empty-bootstrap refusal — the parent stays conventional, never hung.
func TestPublisherGrantWithoutBuilderDeliversEcho(t *testing.T) {
	k := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(k)
	r := &recorder{}
	pub.SetEmitter(r)
	port := &recordingPort{}
	if err := pub.BindTransport("T", port); err != nil {
		t.Fatal(err)
	}
	h, err := pub.RequestDomain("L", nil, "T")
	if err != nil {
		t.Fatal(err)
	}
	mustIngest(t, pub, "T", env("L", h, 1, helloEvt()))
	mustAckEstablishment(t, pub, r, "L", h)

	mustIngest(t, pub, "T", env("L", h, 2, requestEvt("r-dom-1-0", lifecycle.EnvSu, "", "", 0)))

	grant := grantFrom(t, port)
	g := grant.Event.DomainGrant
	if g.Bootstrap != "" || g.RequestID != "r-dom-1-0" {
		t.Fatalf("no-builder grant must be the empty-bootstrap echo, got %+v", g)
	}
}
