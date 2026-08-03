package content_test

import (
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// The budget is two numbers plus the ceiling's hysteresis parameter. A zero
// or inverted budget is a configuration error, not a meaning: the store
// refuses to open with one, so an unavailable product decision cannot
// silently ship as "unlimited".
func TestBudgetValidation(t *testing.T) {
	cases := []struct {
		name   string
		budget content.Budget
		wantOK bool
	}{
		{"valid", content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8}, true},
		{"zero budget", content.Budget{}, false},
		{"zero retention", content.Budget{RetentionBytes: 0, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8}, false},
		{"zero ceiling", content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 0, CompactionFloor: 0.8}, false},
		{"ceiling below retention", content.Budget{RetentionBytes: 4 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8}, false},
		{"floor at zero", content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0}, false},
		{"floor at one", content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 1}, false},
		{"negative retention", content.Budget{RetentionBytes: -1, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.budget.Validate()
			if c.wantOK && err != nil {
				t.Fatalf("Validate() = %v, want nil", err)
			}
			if !c.wantOK && err == nil {
				t.Fatal("Validate() = nil, want an error")
			}
		})
	}
}

// Open refuses a zero budget: the store must not silently run with no
// retention or disk bound.
func TestOpenRefusesZeroBudget(t *testing.T) {
	_, err := content.Open(t.Context(), content.Config{
		Path:   t.TempDir() + "/content.db",
		Key:    testKey(),
		Budget: content.Budget{},
		Logger: nil,
	})
	if err == nil {
		t.Fatal("Open with a zero budget succeeded, want an error")
	}
}

// Open refuses a short key: the adiantum default construction needs 32 bytes.
func TestOpenRefusesShortKey(t *testing.T) {
	_, err := content.Open(t.Context(), content.Config{
		Path:   t.TempDir() + "/content.db",
		Key:    []byte("too-short"),
		Budget: testBudget,
		Logger: nil,
	})
	if err == nil {
		t.Fatal("Open with a 10-byte key succeeded, want an error")
	}
}
