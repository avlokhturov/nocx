package loginshell

import (
	"os"
	"os/user"
	"time"
)

// accountLookupTimeout bounds the one subprocess this package runs. It is on
// the tab-open path, and the account database is not always local: a machine
// bound to a directory service can make the lookup a network round trip, and a
// terminal that will not open a tab because a directory server is unreachable
// is worse than one that starts $SHELL. Generous enough that a healthy lookup
// never trips it, short enough that a wedged one costs a noticeable pause and
// not a hang.
const accountLookupTimeout = 3 * time.Second

// currentUsername names the account whose record is read. os/user first — it
// is the kernel's answer via getpwuid — with the environment as the fallback
// that covers a build without cgo, where os/user on darwin cannot consult
// Directory Services and answers from an /etc/passwd that does not list
// ordinary macOS users at all.
func currentUsername() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if name := os.Getenv("USER"); name != "" {
		return name
	}
	return os.Getenv("LOGNAME")
}
