package filesystem

import "io/fs"

// KindOf classifies an fs.FileMode's type bits. The default branch catches
// named pipes, sockets, devices (character and block — ModeDevice with or
// without ModeCharDevice) and irregular files, none of which may be opened or
// expanded.
func KindOf(m fs.FileMode) Kind {
	switch m & fs.ModeType {
	case 0:
		return KindRegular
	case fs.ModeDir:
		return KindDir
	case fs.ModeSymlink:
		return KindSymlink
	default:
		return KindOther
	}
}

// CanOpen is the openability table of spec §5.1, as one function so there is
// a single place that decides. link is meaningful only when kind is
// KindSymlink and is then the link's resolved kind; the caller must read both
// from metadata at call time, never from a value a caller was handed — a
// symlink can be retargeted between a list and a read, and this table is the
// only guard between "open a file" and "block forever on a FIFO somebody
// swapped in".
//
//	Kind                   Open   Expand
//	regular                yes    —
//	symlink → regular      yes    —
//	dir                    —      yes
//	symlink → dir          —      yes, unless cyclic (frontend, D9)
//	broken symlink, other  no     no
func CanOpen(kind, link Kind) bool {
	switch kind {
	case KindRegular:
		return true
	case KindSymlink:
		return link == KindRegular
	default:
		return false // dir, other — including broken symlinks (link == KindOther)
	}
}

// CanExpand reports whether a row may be expanded — the same table, second
// column.
func CanExpand(kind, link Kind) bool {
	switch kind {
	case KindDir:
		return true
	case KindSymlink:
		return link == KindDir
	default:
		return false
	}
}
