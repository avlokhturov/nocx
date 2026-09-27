package ghostty

import "testing"

// TestAltExitScanFindsEveryWayOutOfTheAlternateScreen pins which byte
// sequences split a feed (nocx-2v80t.6): DECRST of 1049, 1047 or 47, alone or
// among other parameters, and nothing else.
func TestAltExitScanFindsEveryWayOutOfTheAlternateScreen(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int // index of the byte that completes the match, or -1
	}{
		{"\x1b[?1049l", 7},
		{"\x1b[?1047l", 7},
		{"\x1b[?47l", 5},
		{"\x1b[?25;1049l", 10},
		{"\x1b[?1049;25l", 10},
		{"text\x1b[?1049lmore", 11},
		{"\x1b[?1049h", -1},  // entering is not leaving
		{"\x1b[?25l", -1},    // another mode
		{"\x1b[?10490l", -1}, // a longer number is another mode
		{"\x1b[1049l", -1},   // ANSI mode, not DEC private
		{"\x1b[?10\x1b[?1049l", 12},
	} {
		var a altExitScan
		got := -1
		for i := 0; i < len(tc.in); i++ {
			if a.step(tc.in[i]) {
				got = i
				break
			}
		}
		if got != tc.want {
			t.Errorf("%q: completed at %d, want %d", tc.in, got, tc.want)
		}
	}
}
