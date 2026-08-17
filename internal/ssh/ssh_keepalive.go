package ssh

import (
	"time"
)

// LivenessObserver is told what the keepalive prober learns about the far end
// of ONE connection: false when a probe failed and the connection is still
// being given a chance, true when it answers again (nocx-iarf9).
//
// It is deliberately not told about the give-up. That failure closes the
// transport, which ends every session on it, and the end of a session is
// already reported — with a cause — by the exit notification. Reporting it
// here as well would be a second owner of the same fact.
//
// The observer is bound by whoever built the ConnectConfig, so it carries its
// own idea of which host this is; this package does not name it. That matters
// because the connection is POOLED (AD-4): several tabs to the same principal
// share one transport, and the observer belongs to whichever Connect dialed
// it. What it reports is therefore a fact about a machine, not about one tab —
// which is exactly what a keepalive knows.
type LivenessObserver func(responsive bool)

// keepaliveTarget is the part of *gossh.Client the prober uses. An interface
// so the fold above it can be driven without a server: the failure path is the
// one that matters here and it must not need a host that stops answering on
// cue. *gossh.Client satisfies it as written.
type keepaliveTarget interface {
	SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error)
	Close() error
}

// keepaliveVerdict is what one probe result means.
type keepaliveVerdict int

const (
	// keepaliveSteady: the host answered and had been answering. Nothing to
	// report — a probe that confirms what is already believed must not wake
	// the observer once per tick for the life of every connection.
	keepaliveSteady keepaliveVerdict = iota
	// keepaliveResponsive: the host answered after failing. This is the
	// return out of `unknown`, and the only success worth reporting.
	keepaliveResponsive
	// keepaliveUnresponsive: the probe failed and retries remain. The host is
	// not answering and we have NOT concluded anything — the evidence behind
	// a session reading `unknown` rather than alive or dead.
	keepaliveUnresponsive
	// keepaliveGiveUp: the retries are spent. The connection is closed, which
	// ends its sessions, and the exit notification says so with a cause.
	keepaliveGiveUp
)

// keepaliveTally folds probe results into verdicts. Split out of the goroutine
// so the sequence — fail, fail, give up; fail, succeed, reset — is tested as
// arithmetic rather than as a race against a ticker (AGENTS.md: a test may not
// depend on timing).
type keepaliveTally struct {
	countMax int
	failures int
}

func (t *keepaliveTally) probe(ok bool) keepaliveVerdict {
	if ok {
		if t.failures == 0 {
			return keepaliveSteady
		}
		t.failures = 0
		return keepaliveResponsive
	}
	t.failures++
	// countMax <= 0 keeps its inherited meaning: a single failure closes the
	// connection. There is no window in which the host is merely not
	// answering, so nothing reports `unknown` for such a connection.
	if t.countMax <= 0 || t.failures >= t.countMax {
		return keepaliveGiveUp
	}
	return keepaliveUnresponsive
}

// startKeepalive launches a goroutine that sends keepalive@openssh.com probes
// on the SSH connection at the given interval. It returns a stop function that
// signals the goroutine to exit, and a done channel that is closed when the
// goroutine has terminated (useful in tests to verify clean shutdown). Passing
// a zero interval is a no-op (returns nil, nil).
//
// Each probe requests a reply (wantReply=true). The verdict comes from
// keepaliveTally: a failure with retries left reports the host unresponsive to
// the observer, the last failure closes the connection, and a success reports
// it responsive again. A nil observer is a no-op — the prober behaved this way
// before it had one and must still work when the composition root wires none.
//
// The returned stop function is safe to call only once (close of closed
// channel panics). In practice it is called exactly once from
// pooledSSHConn.Close's closeOnce guard.
func startKeepalive(target keepaliveTarget, interval time.Duration, countMax int, observe LivenessObserver) (func(), <-chan struct{}) {
	if interval <= 0 {
		return nil, nil
	}
	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	report := func(responsive bool) {
		if observe != nil {
			observe(responsive)
		}
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		defer close(doneCh)
		tally := keepaliveTally{countMax: countMax}
		for {
			select {
			case <-ticker.C:
				ok, _, err := target.SendRequest("keepalive@openssh.com", true, nil)
				switch tally.probe(err == nil && ok) {
				case keepaliveGiveUp:
					_ = target.Close()
					return
				case keepaliveUnresponsive:
					report(false)
				case keepaliveResponsive:
					report(true)
				case keepaliveSteady:
				}
			case <-stopCh:
				return
			}
		}
	}()
	return func() { close(stopCh) }, doneCh
}
