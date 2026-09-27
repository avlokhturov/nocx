package ghostty

// LEAVING THE ALTERNATE SCREEN IS A MEASUREMENT POINT (nocx-2v80t.6).
//
// The primary's departures are measured by its scrollback depth, and that
// depth can only be read while the primary is the active screen
// (scrollbackLocked). A resize while the alternate screen holds the pane
// reflows the primary underneath it and leaves its baseline unmeasured
// (rebaselineLocked). The feed that switches back then re-baselined over
// ITS OWN scroll: a program that exits and prints more than a screen in one
// chunk lost every row that chunk scrolled — neither reported nor counted.
// Measured on the runtime harness: 21 of 60 rows stored.
//
// So the switch back is a split point, like the fence and the output mark:
// the bytes up to and including it are written and measured on their own,
// which re-baselines the primary BEFORE anything scrolls it, and the rest of
// the feed is measured against that.
//
// The sequences are DECRST of modes 1049, 1047 and 47 — CSI ? Pm l, any of
// them among the parameters — the three ways a program leaves the alternate
// screen.

// altExitScan is the scanner's state: where in CSI ? Pm l it stands, the
// parameter being read, and whether a completed one names an alternate
// screen mode.
type altExitScan struct {
	state int // 0 none, 1 ESC, 2 ESC [, 3 in parameters
	param int
	hit   bool
}

// maxAltParam bounds a parameter's value: anything longer than the largest
// mode named here is not one of them, and an unbounded accumulator is not
// something a byte stream gets to drive.
const maxAltParam = 100000

// step advances the scanner by one byte and reports whether that byte
// completed a sequence leaving the alternate screen.
func (a *altExitScan) step(c byte) bool {
	switch {
	case c == 0x1b:
		*a = altExitScan{state: 1}
	case a.state == 1 && c == '[':
		a.state = 2
	case a.state == 2 && c == '?':
		*a = altExitScan{state: 3}
	case a.state == 3 && c >= '0' && c <= '9':
		if a.param < maxAltParam {
			a.param = a.param*10 + int(c-'0')
		}
	case a.state == 3 && c == ';':
		a.hit = a.hit || isAltScreenMode(a.param)
		a.param = 0
	case a.state == 3 && c == 'l':
		done := a.hit || isAltScreenMode(a.param)
		*a = altExitScan{}
		return done
	default:
		*a = altExitScan{}
	}
	return false
}

func isAltScreenMode(p int) bool { return p == 1049 || p == 1047 || p == 47 }
