package profile

// Secret references, in bulk.
//
// A vault reset destroys the key material for every stored secret at once, and
// after it the credential records must stop claiming to hold any — a reference
// to a secret that cannot exist is a connection telling the user a password is
// saved when nothing can produce it.
//
// This is the only operation in the package that touches every credential, and
// it is deliberately not expressible as a loop over the CRUD methods: the sweep
// has to be one atomic write, or an interruption leaves half the store pointing
// at a vault that has gone.

// SecretReferenceImpact is what a reset costs, in the three quantities that
// mean different things to a user reading a confirmation.
//
// They are counted separately on purpose. "12 secrets" is what is destroyed,
// "7 credentials" is where they were attached, and "9 connections" is what
// behaves differently afterwards — collapsing them into one number would make
// the sentence shorter and wrong.
type SecretReferenceImpact struct {
	// SecretCount is DISTINCT secret references. A secret shared by two
	// versions is one thing the user loses, not two.
	SecretCount int
	// CredentialCount is credentials holding at least one reference.
	// Credentials that store nothing — agent auth, a key read from a path —
	// are not affected and are not counted.
	CredentialCount int
	// ProfileCount is connection profiles using an affected credential.
	ProfileCount int
}

// secretRefFields returns pointers to every field on a credential that can
// hold a secret reference — the record-level fields.
//
// One list, used by both counting and clearing, so the two cannot disagree
// about where a reference may live. They did not disagree here — but the shape
// where a "count" walks one set of fields and a "clear" walks another is how a
// preview promises to destroy 3 things and destroys 5.
func secretRefFields(c *Credential) []*string {
	return []*string{
		&c.SecretID,
		&c.PassphraseSecretID,
		&c.KeyMaterialSecretID,
	}
}

// impactOf computes the impact of clearing every reference in d, without
// modifying it.
func impactOf(d *storeData) SecretReferenceImpact {
	distinct := make(map[string]struct{})
	affected := make(map[string]struct{})

	for i := range d.Credentials {
		c := &d.Credentials[i]
		holds := false
		for _, ref := range secretRefFields(c) {
			if *ref != "" {
				distinct[*ref] = struct{}{}
				holds = true
			}
		}
		if holds {
			affected[c.ID] = struct{}{}
		}
	}

	profiles := 0
	for i := range d.Profiles {
		if _, ok := affected[d.Profiles[i].Options.CredentialID]; ok {
			profiles++
		}
	}

	return SecretReferenceImpact{
		SecretCount:     len(distinct),
		CredentialCount: len(affected),
		ProfileCount:    profiles,
	}
}

// CountSecretReferences reports what clearing every reference would cost,
// changing nothing. It is the preview a confirmation dialog is built from.
//
// It reads the credential records, not the vault: the vault is sealed when a
// reset is wanted — that is why a reset is wanted — and it holds no catalogue
// of what it stores in any case.
func (s *JSONStore) CountSecretReferences() (SecretReferenceImpact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return SecretReferenceImpact{}, err
	}
	return impactOf(d), nil
}

// ClearAllSecretReferences removes every secret reference from every
// credential, in one write, and reports what it cleared.
//
// It clears references only. The credential records, their names, usernames
// and key paths all survive: the user's connections keep
// working and simply stop believing a password is saved. Deleting the records
// would be a different and much larger destruction than the one the user
// agreed to.
//
// Idempotent — the reset is re-runnable after an interruption, and a second
// run reports zero rather than failing.
func (s *JSONStore) ClearAllSecretReferences() (SecretReferenceImpact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return SecretReferenceImpact{}, err
	}

	impact := impactOf(d)
	if impact.SecretCount == 0 {
		// Nothing to clear. Return without a write so a re-run does not
		// rewrite the document for no reason.
		return impact, nil
	}

	for i := range d.Credentials {
		for _, ref := range secretRefFields(&d.Credentials[i]) {
			*ref = ""
		}
	}

	if err := s.writeLocked(d); err != nil {
		return SecretReferenceImpact{}, err
	}
	return impact, nil
}
