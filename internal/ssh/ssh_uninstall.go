package ssh

import (
	"context"
	"fmt"
)

// UninstallIntegration removes nocx's shell integration from a remote host,
// owning the dial-and-call end to end (P10). It acquires the pooled
// connection the way Connect does — same resolution, authorization and pool
// key — asks the carrier for the remote home over that live connection, and
// delegates UninstallRemote to it. The raw *gossh.Client never leaves
// internal/ssh; callers (the transport) hold only this capability, and every
// future caller that needs to reach a remote host's filesystem goes through
// a capability of the same shape instead of reaching for the client.
//
// The carrier comes from the ConnectConfig the resolver built — a saved
// connection carries the SFTP installer, so uninstall is available exactly
// where nocx owns credentials. A config without one is refused: nothing is
// removed on a guess.
func (rc *RealClient) UninstallIntegration(ctx context.Context, host string, opts ...ConnectOption) (removed, conflicts []string, err error) {
	cfg := &ConnectConfig{}
	for _, o := range opts {
		o(cfg)
	}

	acq, err := rc.acquirePooled(ctx, host, opts)
	if err != nil {
		return nil, nil, fmt.Errorf("ssh: uninstall %s: %w", host, err)
	}
	defer rc.pool.Release(acq.handle)

	if cfg.RemoteInstaller == nil {
		return nil, nil, fmt.Errorf("ssh: uninstall %s: no remote installer wired; nothing can be removed", host)
	}

	remoteHome, err := cfg.RemoteInstaller.GetRemoteHome(acq.client)
	if err != nil {
		return nil, nil, fmt.Errorf("ssh: uninstall %s: remote home: %w", host, err)
	}
	return cfg.RemoteInstaller.UninstallRemote(ctx, acq.client, remoteHome)
}

// compile-time check: the capability is satisfied by *RealClient, which the
// transport wires without an adapter (the signatures are identical).
var _ interface {
	UninstallIntegration(ctx context.Context, host string, opts ...ConnectOption) (removed, conflicts []string, err error)
} = (*RealClient)(nil)
