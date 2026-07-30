package vault

import (
	"fmt"

	"github.com/shady2k/nocx/internal/storage"
)

const vaultDocName = "vault.json"

var vaultModule = storage.Module{
	Name:    "vault",
	Current: 1,
}

// Document is the on-disk shape of the vault document. It holds key material,
// provider configuration and a recovery journal. There is no catalogue:
// routing lives inside the secret reference itself (§4.1), and credential
// metadata is the single owner of entry names and kinds — a reviewer can
// confirm the absence of catalogue fields by reading this struct.
type Document struct {
	Version         storage.SchemaVersion `json:"schemaVersion"`
	Instance        string                `json:"instance"`
	DefaultProvider ProviderID            `json:"defaultProvider"`
	Passphrase      *Envelope             `json:"passphrase,omitempty"`
	Recovery        *Envelope             `json:"recovery,omitempty"`
	HasOSKey        bool                  `json:"hasOSKey"`
	AutoSealMinutes int                   `json:"autoSealMinutes"`
	PreferredUnseal string                `json:"preferredUnseal"`
	Journal         []JournalEntry        `json:"journal,omitempty"`
}

// loadDocument reads the vault document from the store. When the document does
// not exist it returns (Document{}, false, nil) — a missing vault means
// "uninitialized", not a failure.
func loadDocument(store storage.DocumentStore) (Document, bool, error) {
	var doc Document
	found, err := store.Read(vaultDocName, &doc)
	if err != nil {
		return Document{}, false, err
	}
	if !found {
		return Document{}, false, nil
	}
	// A document written by a newer build is refused rather than read
	// partially. Silently loading it would let this binary drop fields it does
	// not know about on the next save — and the fields most likely to be added
	// here are key envelopes, so the loss would be unrecoverable.
	if doc.Version > vaultModule.Current {
		return Document{}, false, fmt.Errorf("%w: vault document is version %d, this build understands %d",
			storage.ErrVersionTooNew, doc.Version, vaultModule.Current)
	}
	return doc, true, nil
}

// saveDocument writes the vault document to the store, stamping the module's
// current schema version. The caller never sets Version: it is the module's to
// own, and a document that failed to record it would be indistinguishable from
// one written before versioning existed.
func saveDocument(store storage.DocumentStore, doc Document) error {
	doc.Version = vaultModule.Current
	return store.Write(vaultDocName, &doc)
}
