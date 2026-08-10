// Package lifecycle owns the authenticated command lifecycle model
// (ADR-0024, decisions 2, 3, 5, 6, 7 and 8; see docs/lifecycle-protocol.md).
//
// This is the pure kernel: it contains no transport, no shell code, no
// internal/pty or internal/ssh imports. A transport adapter delivers
// authenticated envelopes via Kernel.Ingest and loss notifications via
// Kernel.TransportLost; the kernel answers over the adapter's Port with
// accept and refresh_request envelopes. Everything else — domain identity,
// epochs, capabilities, sequence rules, the attempt model, the domain stack,
// desynchronization and snapshot reconciliation — lives here, so no transport
// implementation can choose the domain model by accident.
package lifecycle
