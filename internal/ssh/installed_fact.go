package ssh

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/storage"
)

// The installed fact (2026-08-05 delivery-modes design §5.4): backend-owned,
// persisted across restarts, keyed by the RESOLVED destination identity —
// the ssh -G answer for the exact argv (host, port, user, and the
// -F/-o/-J/-l/-p the user typed), never the hostname string. It records the
// protocol version and generation last observed, and is written only from a
// passport the renderer accepted. It is invalidated when a connection that
// expected installed-script produces no passport — that is how a host whose
// bundle rotted bootstraps again instead of failing forever.

// InstalledFact is one observed installation: the protocol version, script
// version and generation of the integration bundle committed on the far
// host, as the accepted passport reported them.
type InstalledFact struct {
	// Identity is the resolved destination key (IdentityKey). It is stored
	// with the fact so a document can be audited without an external map.
	Identity string `json:"identity"`
	// Protocol is the passport's protocolVersion, as a string — the wire's
	// canonical spelling ("1"), compared by exact string equality.
	Protocol string `json:"protocol"`
	// ScriptVersion is the passport's scriptVersion, preserved verbatim.
	ScriptVersion string `json:"scriptVersion"`
	// Generation is the committed generation the passport named (e.g. "v10").
	Generation string `json:"generation"`
	// ObservedAt is when the passport was accepted.
	ObservedAt time.Time `json:"observedAt"`
}

// factDocument is the on-disk envelope. Version 1 is the initial format; a
// document carrying any other version is treated as corrupt — fail-closed
// to "nothing installed" — rather than partially trusted.
type factDocument struct {
	Version int                      `json:"version"`
	Facts   map[string]InstalledFact `json:"facts"`
}

const factDocumentVersion = 1

// InstalledFactStore persists installed facts as one atomic JSON document.
// It is the memory that makes the second connection to a host cheaper than
// the first: the delivery planner chooses the compact installed line only
// when the fact says installed and protocol-compatible; anything else
// bootstraps.
//
// Fail-closed contract: a missing, corrupt, unreadable or future-versioned
// document reads as "no facts" (every host bootstraps), and a failed write
// is an error the caller logs while the in-memory state stays equal to the
// durable state — a lost fact degrades to a bootstrap, never to a compact
// line that cannot be proven.
type InstalledFactStore struct {
	docStore storage.DocumentStore
	docName  string
	log      log.Logger

	mu     sync.Mutex
	facts  map[string]InstalledFact
	loaded bool
}

// NewInstalledFactStore creates a store persisting under docName in
// docStore. Callers MUST provide a logger; the store uses it for one-time
// corruption warnings and has no other output path.
func NewInstalledFactStore(logger log.Logger, docStore storage.DocumentStore, docName string) *InstalledFactStore {
	return &InstalledFactStore{
		docStore: docStore,
		docName:  docName,
		log:      logger,
		facts:    make(map[string]InstalledFact),
	}
}

// Get returns the fact for a resolved identity. A missing, corrupt or
// unreadable document is "not installed" — the planner must bootstrap.
func (s *InstalledFactStore) Get(identity string) (InstalledFact, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	f, ok := s.facts[identity]
	return f, ok
}

// Record durably persists an observed installation. Only after the write
// succeeds does the in-memory state change, so a failed write leaves Get
// answering "not installed" — the caller reports the error and the next
// connection bootstraps.
func (s *InstalledFactStore) Record(fact InstalledFact) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	next := make(map[string]InstalledFact, len(s.facts)+1)
	for k, v := range s.facts {
		next[k] = v
	}
	next[fact.Identity] = fact
	if err := s.writeDoc(next); err != nil {
		return err
	}
	s.facts = next
	return nil
}

// Invalidate durably forgets a resolved identity's installation. Used when a
// connection that expected installed-script produced no passport: the host's
// bundle rotted, and the next connection must bootstrap again.
func (s *InstalledFactStore) Invalidate(identity string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	next := make(map[string]InstalledFact, len(s.facts))
	for k, v := range s.facts {
		if k != identity {
			next[k] = v
		}
	}
	if err := s.writeDoc(next); err != nil {
		return err
	}
	s.facts = next
	return nil
}

// All returns every recorded fact, ordered by identity so a surface that
// enumerates the footprint (P10) never depends on Go map iteration order.
// Same fail-closed reading as Get: a missing, corrupt or unreadable
// document is an empty list — nothing is claimed installed.
func (s *InstalledFactStore) All() []InstalledFact {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	out := make([]InstalledFact, 0, len(s.facts))
	for _, f := range s.facts {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Identity < out[j].Identity })
	return out
}

// loadLocked reads the document once, on first use. Corruption of any kind
// degrades to an empty store with a one-time warning: never a partially
// trusted fact, never a compact line on the strength of a torn file.
func (s *InstalledFactStore) loadLocked() {
	if s.loaded {
		return
	}
	s.facts = make(map[string]InstalledFact)
	var doc factDocument
	found, err := s.docStore.Read(s.docName, &doc)
	switch {
	case err != nil:
		s.log.Warn("installed-fact store unreadable; treating every host as not installed",
			"document", s.docName, "error", err)
	case found && doc.Version != factDocumentVersion:
		s.log.Warn("installed-fact store has an unknown schema version; treating every host as not installed",
			"document", s.docName, "version", doc.Version)
	case found && doc.Facts != nil:
		s.facts = doc.Facts
	}
	s.loaded = true
}

// writeDoc persists the whole map atomically (DocumentStore.Write: temp
// file, fsync, rename). The map is committed to memory only by the caller
// after this returns nil.
func (s *InstalledFactStore) writeDoc(facts map[string]InstalledFact) error {
	if err := s.docStore.Write(s.docName, factDocument{Version: factDocumentVersion, Facts: facts}); err != nil {
		return fmt.Errorf("installed-fact store: persist %s: %w", s.docName, err)
	}
	return nil
}
