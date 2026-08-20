package content_test

// The live History policy (nocx-2f0f adds the per-command cap to it).

import (
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// The per-command cap: the store carries the number, the RENDERER applies it
// (it holds the rows and can cut on a character boundary), and a nonsense
// value falls back rather than becoming "keep nothing" — which would be
// output retention off wearing another switch's clothes.
func TestPolicyOutputCap(t *testing.T) {
	p := content.NewPolicy()
	if got := p.OutputCapBytes(); got != content.DefaultOutputCapBytes {
		t.Fatalf("default cap = %d, want %d", got, content.DefaultOutputCapBytes)
	}
	p.SetOutputCapBytes(64 << 10)
	if got := p.OutputCapBytes(); got != 64<<10 {
		t.Fatalf("cap = %d, want %d", got, 64<<10)
	}
	for _, v := range []int{0, -1} {
		p.SetOutputCapBytes(v)
		if got := p.OutputCapBytes(); got != content.DefaultOutputCapBytes {
			t.Fatalf("cap after SetOutputCapBytes(%d) = %d, want the default", v, got)
		}
	}
}
