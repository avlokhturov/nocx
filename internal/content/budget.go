package content

// Budget is the two-number storage budget (design §5.4, nocx-rtg0.11).
// "Total size" is two numbers because DELETE reduces logical content and not
// the file, and WAL can exceed the main database — a UI that promises 5 GB
// over a 12 GB file has shipped a defect. CompactionFloor is not a third
// product knob: spec §5.4 names hysteresis as part of the disk ceiling's
// definition. The values are a product decision made by the composition root
// (the settings surface, ADR-0018 §5.4), never by this package: a zero
// budget is rejected, not silently treated as "unlimited".
type Budget struct {
	// RetentionBytes is the logical retained-content budget: the number the
	// user reasons about, and what eviction acts on.
	RetentionBytes int64

	// DiskCeilingBytes is the physical ceiling over the main database plus
	// WAL. Exceeding it triggers compaction, not more deletion.
	DiskCeilingBytes int64

	// CompactionFloor is the fraction of DiskCeilingBytes at which an
	// in-progress compaction stops (the hysteresis that keeps a database
	// from bouncing on and off the ceiling), in (0, 1).
	CompactionFloor float64
}

// Validate reports whether the budget is usable. A zero or inverted budget
// is a configuration error, not a meaning: the store refuses to open with
// one.
func (b Budget) Validate() error {
	switch {
	case b.RetentionBytes <= 0:
		return &BudgetError{"retention budget must be positive"}
	case b.DiskCeilingBytes <= 0:
		return &BudgetError{"disk ceiling must be positive"}
	case b.DiskCeilingBytes < b.RetentionBytes:
		return &BudgetError{"disk ceiling must not be below the retention budget"}
	case b.CompactionFloor <= 0 || b.CompactionFloor >= 1:
		return &BudgetError{"compaction floor must be in (0, 1)"}
	}
	return nil
}

// BudgetError is a configuration error in the two-number budget.
type BudgetError struct{ msg string }

func (e *BudgetError) Error() string { return "content: budget: " + e.msg }
