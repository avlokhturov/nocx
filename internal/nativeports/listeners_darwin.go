//go:build darwin

package nativeports

// macOS: lsof — a documented fallback, not a kernel read. The native route
// is libproc (proc_listpids/proc_pidfdinfo), which needs cgo; the decision
// and its evidence are in .internal/reports/nocx-wzc4.8.md. lsof ships with
// every macOS base system (/usr/sbin/lsof) and its -nP -iTCP -sTCP:LISTEN
// dialect is stable across releases; the parse below mirrors the discovery
// domain's address shapes so the wire renders identically to the remote
// ladder's lsof rung. When lsof is absent the read reports ErrToolMissing —
// a terminal degrade to the unavailable state, never a convincing empty
// list.
//
// The exec is bounded: a fixed absolute path (never shelled), a 5s timeout,
// output capped at 1 MiB.
import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/shady2k/nocx/internal/discovery"
)

const probeName = "darwin-lsof"

const (
	lsofPath      = "/usr/sbin/lsof"
	lsofOutputCap = 1 << 20 // 1 MiB
	lsofTimeout   = 5 * time.Second
)

func listeners(ctx context.Context) ([]discovery.Listener, error) {
	ctx, cancel := context.WithTimeout(ctx, lsofTimeout)
	defer cancel()

	proc := exec.CommandContext(ctx, lsofPath, "-nP", "-iTCP", "-sTCP:LISTEN")
	stdout, err := proc.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := proc.Start(); err != nil {
		if os.IsNotExist(err) {
			return nil, ErrToolMissing
		}
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(stdout, lsofOutputCap+1))
	truncated := len(data) > lsofOutputCap
	if truncated {
		data = data[:lsofOutputCap]
	}
	waitErr := proc.Wait()
	if readErr != nil {
		return nil, readErr
	}
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) && ee.ExitCode() == 1 {
			// lsof exits 1 when nothing matches: a valid empty table,
			// exactly like the remote ladder's lsof rung.
			return []discovery.Listener{}, nil
		}
		return nil, waitErr
	}
	if truncated {
		// A table past the cap is unreadable, not "all of it": the sample
		// degrades like a remote table cut short.
		return nil, errors.New("lsof output exceeds the 1 MiB capture cap")
	}
	return parseLsofOutput(data), nil
}

// parseLsofOutput parses `lsof -nP -iTCP -sTCP:LISTEN`: columns COMMAND PID
// USER FD TYPE DEVICE SIZE/OFF NODE NAME, where NAME is "TCP <addr> (LISTEN)"
// — the protocol prefix and state suffix are part of the NAME column, so
// taking the last field yields "(LISTEN)", not the address. Mirrors
// internal/discovery/parse.go's parseLsof exactly so the addresses land on
// the wire in the same shapes the remote ladder's lsof rung produces.
func parseLsofOutput(data []byte) []discovery.Listener {
	var out []discovery.Listener
	for i, line := range strings.Split(string(data), "\n") {
		if i == 0 {
			continue // header
		}
		fields := strings.Fields(line)
		if len(fields) < 9 {
			continue
		}
		// NAME is everything from field 8 onward, joined: "TCP *:22 (LISTEN)".
		name := strings.Join(fields[8:], " ")
		addr, found := strings.CutSuffix(name, " (LISTEN)")
		if !found {
			continue
		}
		// Strip the "TCP " protocol prefix to get the bare address.
		addr = strings.TrimPrefix(addr, "TCP ")
		host, port, ok := splitHostPort(addr)
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		out = append(out, discovery.Listener{
			Family:  familyOf(host),
			Address: host,
			Port:    port,
			Process: discovery.Process{Evidence: discovery.EvidenceKnown, Name: fields[0], PID: pid},
		})
	}
	return out
}

// splitHostPort and familyOf mirror the discovery domain's own helpers so
// the addresses land on the wire in exactly the remote ladder's shapes
// ("127.0.0.1", "::1", "*").
func splitHostPort(s string) (host string, port int, ok bool) {
	if strings.HasPrefix(s, "[") {
		close := strings.IndexByte(s, ']')
		if close < 0 {
			return "", 0, false
		}
		rest := s[close+1:]
		if !strings.HasPrefix(rest, ":") {
			return "", 0, false
		}
		p, err := strconv.Atoi(rest[1:])
		if err != nil || p < 0 || p > 65535 {
			return "", 0, false
		}
		return s[1:close], p, true
	}
	i := strings.LastIndexByte(s, ':')
	if i <= 0 || i == len(s)-1 {
		return "", 0, false
	}
	p, err := strconv.Atoi(s[i+1:])
	if err != nil || p < 0 || p > 65535 {
		return "", 0, false
	}
	return s[:i], p, true
}

func familyOf(host string) discovery.AddressFamily {
	if strings.Contains(host, ":") || strings.HasPrefix(host, "[") {
		return discovery.FamilyIPv6
	}
	return discovery.FamilyIPv4
}
