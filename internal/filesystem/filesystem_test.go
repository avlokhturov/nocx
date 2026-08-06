package filesystem

import (
	"io/fs"
	"testing"
	"time"
)

func TestKindOf(t *testing.T) {
	cases := []struct {
		name string
		mode fs.FileMode
		want Kind
	}{
		{"regular", 0o644, KindRegular},
		{"directory", fs.ModeDir | 0o755, KindDir},
		{"symlink", fs.ModeSymlink, KindSymlink},
		{"fifo", fs.ModeNamedPipe | 0o600, KindOther},
		{"socket", fs.ModeSocket, KindOther},
		{"block device", fs.ModeDevice, KindOther},
		{"char device", fs.ModeDevice | fs.ModeCharDevice, KindOther},
		{"irregular", fs.ModeIrregular, KindOther},
	}
	for _, tc := range cases {
		if got := KindOf(tc.mode); got != tc.want {
			t.Errorf("KindOf(%s) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// TestCanOpenIsTheSpecTable pins the §5.1 openability table row by row.
func TestCanOpenIsTheSpecTable(t *testing.T) {
	cases := []struct {
		kind, link Kind
		open, exp  bool
	}{
		{KindRegular, KindOther, true, false},
		{KindSymlink, KindRegular, true, false},
		{KindDir, KindOther, false, true},
		{KindSymlink, KindDir, false, true},
		{KindSymlink, KindOther, false, false}, // broken
		{KindOther, KindOther, false, false},
		{KindSymlink, KindSymlink, false, false}, // unresolved chain: deny both
	}
	for _, tc := range cases {
		if got := CanOpen(tc.kind, tc.link); got != tc.open {
			t.Errorf("CanOpen(%q, %q) = %v, want %v", tc.kind, tc.link, got, tc.open)
		}
		if got := CanExpand(tc.kind, tc.link); got != tc.exp {
			t.Errorf("CanExpand(%q, %q) = %v, want %v", tc.kind, tc.link, got, tc.exp)
		}
	}
}

func entryWith(transform func(*Entry)) Entry {
	e := Entry{
		Name:       "f.txt",
		Path:       "/d/f.txt",
		Kind:       KindRegular,
		LinkTarget: "",
		LinkKind:   KindOther,
		Size:       10,
		ModTime:    time.Unix(1_700_000_000, 0),
		Mode:       0o644,
	}
	if transform != nil {
		transform(&e)
	}
	return e
}

func TestComputeRevStableForUnchangedListing(t *testing.T) {
	es := []Entry{entryWith(nil), entryWith(func(e *Entry) { e.Name = "a.txt" })}
	rev1 := ComputeRev("/d", es)
	rev2 := ComputeRev("/d", es)
	if rev1 != rev2 {
		t.Fatalf("digest changed for an unchanged listing: %s vs %s", rev1, rev2)
	}
	if rev1 == "" || len(rev1) != 64 {
		t.Fatalf("digest not a sha256 hex: %q", rev1)
	}
}

// TestComputeRevSensitiveToEveryField pins the spec's claim: each entry's
// name, size, mtime, mode, kind, LinkTarget and LinkKind participate, and so
// does the canonical directory identity. The two last entry fields are the
// point — a symlink retargeted to another file of the same size and kind must
// change the digest.
func TestComputeRevSensitiveToEveryField(t *testing.T) {
	base := ComputeRev("/d", []Entry{entryWith(nil)})
	mutate := func(f func(*Entry)) string {
		return ComputeRev("/d", []Entry{entryWith(f)})
	}
	fields := []struct {
		name string
		f    func(*Entry)
	}{
		{"name", func(e *Entry) { e.Name = "g.txt" }},
		{"size", func(e *Entry) { e.Size = 11 }},
		{"mtime", func(e *Entry) { e.ModTime = time.Unix(1_700_000_001, 0) }},
		{"mode", func(e *Entry) { e.Mode = 0o600 }},
		{"kind", func(e *Entry) { e.Kind = KindOther }},
		{"linktarget", func(e *Entry) { e.LinkTarget = "/elsewhere/f.txt" }},
		{"linkkind", func(e *Entry) { e.LinkKind = KindDir }},
	}
	for _, tc := range fields {
		if got := mutate(tc.f); got == base {
			t.Errorf("digest insensitive to %s", tc.name)
		}
	}
	// The spec's exact case: a symlink retargeted to another file of the same
	// size and kind. Name, size, mtime, mode and kind all unchanged; only the
	// target moved.
	same := entryWith(func(e *Entry) {
		e.Kind = KindSymlink
		e.LinkKind = KindRegular
	})
	revA := ComputeRev("/d", []Entry{same})
	other := same
	other.LinkTarget = "/other/file.txt"
	if got := ComputeRev("/d", []Entry{other}); got == revA {
		t.Error("digest unchanged after symlink retarget to a same-size same-kind file")
	}
	// The canonical directory identity participates: a retargeted parent with
	// identical children still moves the digest (spec D9, Listing.Canonical).
	if got := ComputeRev("/other-dir", []Entry{same}); got == revA {
		t.Error("digest unchanged after the canonical identity changed")
	}
	// Length-prefixing: no concatenation collision between name and target.
	// "ab"+"c" and "a"+"bc" would collide if fields were joined raw.
	ab := entryWith(func(e *Entry) { e.Name = "ab"; e.LinkTarget = "c" })
	ba := entryWith(func(e *Entry) { e.Name = "a"; e.LinkTarget = "bc" })
	if ComputeRev("/d", []Entry{ab}) == ComputeRev("/d", []Entry{ba}) {
		t.Error("length-prefixing failed: name/target concatenations collided")
	}
}
