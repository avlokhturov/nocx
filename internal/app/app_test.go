package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/settings"
)

func TestNew(t *testing.T) {
	a, err := New(WithLogFilePath(filepath.Join(t.TempDir(), "nocx.log")))
	if err != nil {
		t.Fatalf("New() returned error: %v", err)
	}
	if a == nil {
		t.Fatal("New() returned nil app")
	}
}

func TestNew_AllModulesInjected(t *testing.T) {
	a, err := New(WithLogFilePath(filepath.Join(t.TempDir(), "nocx.log")))
	if err != nil {
		t.Fatalf("New() returned error: %v", err)
	}

	if a.Logger == nil {
		t.Error("Logger is nil")
	}
	if a.Pty == nil {
		t.Error("Pty is nil")
	}
	if a.Session == nil {
		t.Error("Session is nil")
	}
	if a.Transport == nil {
		t.Error("Transport is nil")
	}
	if a.ShellIntegration == nil {
		t.Error("ShellIntegration is nil")
	}
}

func TestStartShutdown(t *testing.T) {
	a, err := New(WithLogFilePath(filepath.Join(t.TempDir(), "nocx.log")))
	if err != nil {
		t.Fatalf("New() returned error: %v", err)
	}

	ctx := context.Background()
	if err := a.Start(ctx); err != nil {
		t.Fatalf("Start() returned error: %v", err)
	}
	if a.WSPort() == 0 {
		t.Fatal("WSPort() == 0 after Start")
	}

	a.Shutdown(ctx)
}

func TestWSPortBeforeStart(t *testing.T) {
	a, err := New(WithLogFilePath(filepath.Join(t.TempDir(), "nocx.log")))
	if err != nil {
		t.Fatalf("New() returned error: %v", err)
	}
	if a.WSPort() != 0 {
		t.Fatalf("expected 0 before Start, got %d", a.WSPort())
	}
}

// ── History settings → store wiring ──────────────────────────────────────

// The two-number budget flows from the History settings (MiB) into the
// store's byte budget; a zero or inverted configuration is refused so the
// store stays closed rather than shipping an unbounded database.
func TestBudgetFromSettings(t *testing.T) {
	fd := &appFakeDoc{}
	reg := settings.New(fd, nil)
	_ = reg.SetNumber(settings.HistoryRetentionMiB, 256)
	_ = reg.SetNumber(settings.HistoryDiskCeilingMiB, 1024)

	b, err := budgetFromSettings(reg)
	if err != nil {
		t.Fatalf("budgetFromSettings: %v", err)
	}
	if b.RetentionBytes != 256<<20 {
		t.Errorf("RetentionBytes = %d, want 256 MiB", b.RetentionBytes)
	}
	if b.DiskCeilingBytes != 1024<<20 {
		t.Errorf("DiskCeilingBytes = %d, want 1024 MiB", b.DiskCeilingBytes)
	}
	if err := b.Validate(); err != nil {
		t.Fatalf("assembled budget invalid: %v", err)
	}

	// Inverted configuration is refused, not shipped.
	_ = reg.SetNumber(settings.HistoryRetentionMiB, 2048) // above the ceiling
	if _, err := budgetFromSettings(reg); err == nil {
		t.Fatal("inverted budget accepted")
	}
}

// The live policy flows from the History settings, and the settings change
// notifier updates it — a toggle applies without a restart.
func TestPolicyFromSettingsAndLiveUpdates(t *testing.T) {
	fd := &appFakeDoc{}
	reg := settings.New(fd, nil)
	_ = reg.SetBool(settings.HistoryEnabled, false)
	_ = reg.SetNumber(settings.HistoryRetentionDays, 30)
	_ = reg.SetBool(settings.HistoryOutputEnabled, false)

	p := policyFromSettings(reg)
	if p.Enabled() {
		t.Error("policy enabled despite history.enabled=false")
	}
	if p.RetentionDays() != 30 {
		t.Errorf("RetentionDays = %d, want 30", p.RetentionDays())
	}
	if p.OutputEnabled() {
		t.Error("policy output enabled despite history.outputEnabled=false")
	}

	// Live: the notifier re-reads the registry after a mutation.
	reg.AddNotifier(func(_ int, keys []string) {
		for _, k := range keys {
			switch k {
			case settings.HistoryEnabled.Key():
				if v, err := reg.GetBool(settings.HistoryEnabled); err == nil {
					p.SetEnabled(v)
				}
			case settings.HistoryRetentionDays.Key():
				if v, err := reg.GetNumber(settings.HistoryRetentionDays); err == nil {
					p.SetRetentionDays(int(v))
				}
			}
		}
	})
	_ = reg.SetBool(settings.HistoryEnabled, true)
	_ = reg.SetNumber(settings.HistoryRetentionDays, 7)
	if !p.Enabled() {
		t.Error("policy not live-updated for history.enabled")
	}
	if p.RetentionDays() != 7 {
		t.Errorf("RetentionDays = %d after live update, want 7", p.RetentionDays())
	}
}

// appFakeDoc is a minimal in-memory DocumentStore for settings.New.
type appFakeDoc struct {
	data map[string][]byte
}

func (f *appFakeDoc) Read(name string, into any) (bool, error) {
	b, ok := f.data[name]
	if !ok || b == nil {
		return false, nil
	}
	return true, json.Unmarshal(b, into)
}

func (f *appFakeDoc) Write(name string, doc any) error {
	b, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	if f.data == nil {
		f.data = make(map[string][]byte)
	}
	f.data[name] = b
	return nil
}

func (f *appFakeDoc) Delete(name string) error {
	delete(f.data, name)
	return nil
}

// TestNew_LogFile: a running session can say where the log lives. The
// pinned path is reported by LogFilePath, the file exists, and its first
// line names the path — a reader who finds the file learns where it is.
func TestNew_LogFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nocx.log")
	a, err := New(WithLogFilePath(path))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer a.Shutdown(context.Background())

	if got := a.LogFilePath(); got != path {
		t.Errorf("LogFilePath() = %q, want %q", got, path)
	}
	b, err := os.ReadFile(path) // #nosec G304 — the test's own temp path.
	if err != nil {
		t.Fatalf("log file was not written: %v", err)
	}
	if !bytes.Contains(b, []byte("backend log file")) || !bytes.Contains(b, []byte(path)) {
		t.Errorf("log file does not name its own path; content:\n%s", b)
	}
	if !bytes.Contains(b, []byte("application initialized")) {
		t.Errorf("log file missing the initialization line; content:\n%s", b)
	}
}

// TestNew_LogFileDisabled: an empty pinned path disables file logging and
// LogFilePath reports it — nothing is written anywhere unexpected.
func TestNew_LogFileDisabled(t *testing.T) {
	a, err := New(WithLogFilePath(""))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer a.Shutdown(context.Background())

	if got := a.LogFilePath(); got != "" {
		t.Errorf("LogFilePath() = %q, want \"\" when file logging is disabled", got)
	}
}

// TestNew_LogFileStderrOnlyOnFailure: when the pinned directory cannot be
// created, the app still starts — fail-open, stderr only — and says the
// path is unavailable.
func TestNew_LogFileUnavailableStartsAnyway(t *testing.T) {
	// A path whose parent is a regular file cannot be a directory.
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	a, err := New(WithLogFilePath(filepath.Join(blocker, "nocx.log")))
	if err != nil {
		t.Fatalf("New must fail open when the log file cannot be opened: %v", err)
	}
	defer a.Shutdown(context.Background())
	if got := a.LogFilePath(); got != "" {
		t.Errorf("LogFilePath() = %q, want \"\" when the file could not be opened", got)
	}
}
