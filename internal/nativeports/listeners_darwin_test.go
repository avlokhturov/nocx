//go:build darwin

package nativeports

import (
	"testing"

	"github.com/shady2k/nocx/internal/discovery"
)

// lsofFixture mirrors internal/discovery/parse_test.go's fixture so the
// darwin parser is tested against the exact NAME column shape real lsof
// produces: "TCP <addr> (LISTEN)", not the bare address the old
// last-field assumption expected.
const lsofFixture = `COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
sshd      1234 root    3u  IPv4  12345      0t0 12345 TCP *:22 (LISTEN)
node      4321 dev     11u  IPv6  54321      0t0 54321 TCP [::1]:3000 (LISTEN)`

func TestParseLsofOutput(t *testing.T) {
	got := parseLsofOutput([]byte(lsofFixture))
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2; %+v", len(got), got)
	}
	if got[0].Port != 22 || got[0].Address != "*" {
		t.Errorf("row 0 = %s:%d, want *:22", got[0].Address, got[0].Port)
	}
	if got[0].Process.PID != 1234 || got[0].Process.Name != "sshd" {
		t.Errorf("row 0 process = %+v, want sshd/1234", got[0].Process)
	}
	if got[0].Process.Evidence != discovery.EvidenceKnown {
		t.Errorf("row 0 evidence = %q, want known", got[0].Process.Evidence)
	}
	if got[1].Port != 3000 || got[1].Address != "::1" {
		t.Errorf("row 1 = %s:%d, want [::1]:3000", got[1].Address, got[1].Port)
	}
	if got[1].Family != discovery.FamilyIPv6 {
		t.Errorf("row 1 family = %q, want IPv6", got[1].Family)
	}
}
