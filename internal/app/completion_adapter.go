package app

import (
	"context"

	"github.com/shady2k/nocx/internal/completion"
	"github.com/shady2k/nocx/internal/ssh"
)

// discoveryConnAdapter adapts ssh.DiscoveryConn to completion.ExecConn so
// the SSH completer can run its completion script through the same
// pooled connection lane the discovery ladder uses.
type discoveryConnAdapter struct {
	inner ssh.DiscoveryConn
}

func (a *discoveryConnAdapter) Exec(ctx context.Context, cmd string) (*completion.ExecResult, error) {
	r, err := a.inner.Exec(ctx, cmd)
	if err != nil {
		return nil, err
	}
	return &completion.ExecResult{
		Stdout:     r.Stdout,
		Stderr:     r.Stderr,
		ExitStatus: r.ExitStatus,
		Truncated:  r.Truncated,
	}, nil
}

func (a *discoveryConnAdapter) Close() error {
	return a.inner.Close()
}

// sshExecConnProvider returns an ExecConnProvider backed by the SSH
// client's DiscoveryConn. The host is the session's remote hostname;
// the SSH client resolves it through ~/.ssh/config and acquires an
// owned pooled lease that shares the session's connection when the
// pool keys match.
func sshExecConnProvider(client *ssh.RealClient) completion.ExecConnProvider {
	return func(ctx context.Context, host string) (completion.ExecConn, error) {
		dc, err := client.DiscoveryConn(ctx, host)
		if err != nil {
			return nil, err
		}
		return &discoveryConnAdapter{inner: dc}, nil
	}
}
