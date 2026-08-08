package lifecycle

// Port is the outbound half of the transport seam, implemented by an adapter.
// The kernel sends exactly two envelope kinds over it: accept and
// refresh_request (docs/lifecycle-protocol.md §3, "two outbound paths"). The
// inbound half is Kernel.Ingest (authenticated envelopes) and
// Kernel.TransportLost / Kernel.NotifyGap (loss and corruption).
//
// The port is deliberately dumb: it has no CurrentDomain accessor and assumes
// nothing about how many domains its transport carries. Send must not call
// back into the kernel; the kernel never invokes Send while holding its lock.
type Port interface {
	// Send publishes an authenticated envelope to the shell on the
	// transport. A failure is best-effort: the shell times out its
	// handshake and the session stays conventional — the safe direction.
	Send(Envelope) error
}
