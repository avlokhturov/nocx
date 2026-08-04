// Package connectfwd replays a connection profile's stored forwards at
// connect time (spec §8, D5): the ports a user always forwards to a given
// host are configured once and are simply there when the connection comes
// up. It is the connect-time hook for the forwards a profile carries — the
// engine only; the transport remains the single place that tracks tunnels
// against a connection's ledger, and this package never registers anything.
//
// The contract that makes it safe to call from the open path (spec §10.11):
// one forward's failure — a busy local port, a refused acquire, an
// unimplemented direction — fails that row only. The session stays open and
// every other stored forward still establishes. Each result carries the
// row's own outcome, including policy-worded reasons from the strategy,
// never flattened to a generic "failed".
package connectfwd

import (
	"context"

	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/tunnel"
)

// Result is one stored forward's connect-time outcome (spec §8): which row,
// the tunnel record when one exists, and the row's failure — never the
// session's. Err carries the visible reason: the bind failure for a busy
// local port, the acquire refusal, or a strategy's policy wording
// (spec §10.14: -R refused by AllowTcpForwarding reports the server's
// refusal, not a generic failure).
type Result struct {
	Index  int
	Spec   profile.ForwardSpec
	Tunnel *tunnel.Tunnel // non-nil when a record was created; nil only for a spec the tunnel layer rejects
	Err    error          // nil while the forward runs
}

// Replay opens every stored forward of a profile at connect time (spec §8,
// D5). Rows are attempted in stored order; a result exists for every row.
//
// Each forward takes its OWN pooled-connection lease through conn (spec
// §7.3) — never the tab's reference — so closing the creating tab tears the
// session down without killing the forwards, and one forward's teardown
// never touches another's. opts are the lease-keying connect options the
// caller resolved for the session (AD-4): the whole resolved ConnectConfig,
// exactly as the tunnel.open path hands it to its connector.
//
// Replay never fails the connection: it returns per-row outcomes and the
// caller keeps the session and surfaces the rows. Rows whose direction the
// tunnel layer has not implemented yet report that as their own outcome —
// they are preserved, never dropped and never coerced to local (spec D4).
func Replay(
	ctx context.Context,
	profileID string,
	forwards []profile.ForwardSpec,
	host string,
	conn tunnel.Connector,
	opts []ssh.ConnectOption,
) []Result {
	results := make([]Result, 0, len(forwards))
	for i, fs := range forwards {
		r := Result{Index: i, Spec: fs}
		t, err := tunnel.New(tunnel.Spec{
			Direction:   tunnel.Direction(fs.Direction),
			Bind:        tunnel.Bind{Host: fs.BindHost, Port: fs.BindPort},
			Destination: fs.Destination,
			Scope:       profileID,
			Provenance:  tunnel.ProvenanceProfile,
		}, conn)
		if err != nil {
			r.Err = err
			results = append(results, r)
			continue
		}
		r.Tunnel = t
		if err := t.Start(ctx, host, opts...); err != nil {
			r.Err = err
		}
		results = append(results, r)
	}
	return results
}
