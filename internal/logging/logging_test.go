package logging

import (
	stdlog "log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// withTempCacheDir points os.UserCacheDir lookups at a temp dir for the
// duration of the test. Wails-internal use of XDG_CACHE_HOME makes this
// override cleanly via the env on Linux; for Windows tests in CI we'd need
// LOCALAPPDATA, but the dev env is Linux-only so XDG is sufficient here.
func withTempCacheDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir) // resolveLevelLocked also reads UserConfigDir
	t.Setenv("IMAGE_OBSERVER_LOG_LEVEL", "")
	resetForTest()
	t.Cleanup(resetForTest)
	return dir
}

func TestInit_CreatesFileAndWritesInitMessage(t *testing.T) {
	withTempCacheDir(t)
	if err := Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if LogPath() == "" {
		t.Fatal("expected non-empty LogPath after Init")
	}
	if err := Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	data, err := os.ReadFile(LogPath())
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(data), "logger initialized") {
		t.Errorf("expected init line, got %q", string(data))
	}
}

func TestEmit_LevelFiltering(t *testing.T) {
	withTempCacheDir(t)
	if err := Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	SetLevel(LevelWarn)
	Debug("test", "debug-line")
	Info("test", "info-line")
	Warn("test", "warn-line")
	Error("test", "error-line")
	Close()

	data, _ := os.ReadFile(LogPath())
	s := string(data)
	if strings.Contains(s, "debug-line") {
		t.Error("DEBUG below threshold should not appear")
	}
	if strings.Contains(s, "info-line") {
		t.Error("INFO below threshold should not appear")
	}
	if !strings.Contains(s, "warn-line") {
		t.Error("WARN should appear")
	}
	if !strings.Contains(s, "error-line") {
		t.Error("ERROR should appear")
	}
}

func TestEmit_KeyValueFormatting(t *testing.T) {
	withTempCacheDir(t)
	Init()
	Info("dnd", "start", "src", "L1", "idx", 0, "path", "/img/a b c.png")
	Close()

	data, _ := os.ReadFile(LogPath())
	s := string(data)
	if !strings.Contains(s, "src=L1") {
		t.Errorf("missing src=L1 in %q", s)
	}
	if !strings.Contains(s, "idx=0") {
		t.Errorf("missing idx=0 in %q", s)
	}
	if !strings.Contains(s, `path="/img/a b c.png"`) {
		t.Errorf("expected quoted path with spaces, got %q", s)
	}
}

func TestEmit_SkipsNonStringKeys(t *testing.T) {
	withTempCacheDir(t)
	Init()
	Info("test", "msg", 42, "ignored", "k2", "v2")
	Close()
	data, _ := os.ReadFile(LogPath())
	s := string(data)
	if strings.Contains(s, "42=ignored") {
		t.Error("non-string key should be skipped")
	}
	if !strings.Contains(s, "k2=v2") {
		t.Errorf("expected k2=v2 after skipping bad pair, got %q", s)
	}
}

func TestRotate_PreOnInit(t *testing.T) {
	dir := withTempCacheDir(t)
	logsDir := filepath.Join(dir, "image-observer", "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	stale := filepath.Join(logsDir, "app.log")
	big := strings.Repeat("x", int(maxFileSize)+1)
	if err := os.WriteFile(stale, []byte(big), 0o644); err != nil {
		t.Fatalf("write stale: %v", err)
	}
	if err := Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	Close()

	if _, err := os.Stat(stale + ".1"); err != nil {
		t.Errorf("expected app.log.1 after pre-rotate, err=%v", err)
	}
}

func TestRotate_TriggersOnSizeAndKeepsLimit(t *testing.T) {
	withTempCacheDir(t)
	Init()
	// Drive the log past 2× the cap with sizable lines so rotate fires twice.
	chunk := strings.Repeat("y", 4096)
	for range 1500 { // 1500 * 4 KB ≈ 6 MB → 2-3 rotations
		Info("test", chunk)
	}
	Close()

	logsDir := filepath.Dir(LogPath())
	files, _ := os.ReadDir(logsDir)
	logCount := 0
	for _, f := range files {
		if strings.HasPrefix(f.Name(), "app.log") {
			logCount++
		}
	}
	if logCount > keepBackups+1 { // app.log + .1 + .2 = 3
		t.Errorf("expected ≤ %d log files, got %d", keepBackups+1, logCount)
	}
	if logCount < 2 {
		t.Errorf("expected at least one rotation, got %d files", logCount)
	}
}

func TestParseLevel(t *testing.T) {
	cases := map[string]Level{
		"debug":   LevelDebug,
		"DEBUG":   LevelDebug,
		" info ":  LevelInfo,
		"warn":    LevelWarn,
		"warning": LevelWarn,
		"error":   LevelError,
		"err":     LevelError,
	}
	for in, want := range cases {
		got, ok := ParseLevel(in)
		if !ok || got != want {
			t.Errorf("ParseLevel(%q) = (%d, %v), want (%d, true)", in, got, ok, want)
		}
	}
	if _, ok := ParseLevel("garbage"); ok {
		t.Errorf("ParseLevel(garbage) should return ok=false")
	}
}

func TestResolveLevel_EnvWins(t *testing.T) {
	withTempCacheDir(t)
	t.Setenv("IMAGE_OBSERVER_LOG_LEVEL", "debug")
	if err := Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if CurrentLevel() != LevelDebug {
		t.Errorf("expected DEBUG via env, got %v", CurrentLevel())
	}
	Close()
}

func TestResolveLevel_FileFallback(t *testing.T) {
	dir := withTempCacheDir(t)
	cfgDir := filepath.Join(dir, "image-observer")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "log_level.txt"), []byte("warn\n"), 0o644); err != nil {
		t.Fatalf("write level file: %v", err)
	}
	if err := Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if CurrentLevel() != LevelWarn {
		t.Errorf("expected WARN via log_level.txt, got %v", CurrentLevel())
	}
	Close()
}

func TestEmit_ConcurrentSafe(t *testing.T) {
	withTempCacheDir(t)
	Init()
	defer Close()
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for j := range 50 {
				Info("concurrent", "msg", "g", g, "j", j)
			}
		}(i)
	}
	wg.Wait()
	// Just ensure the file is non-empty and readable.
	data, err := os.ReadFile(LogPath())
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(data) == 0 {
		t.Error("expected log content from concurrent writers")
	}
}

func TestStdLogRedirect(t *testing.T) {
	withTempCacheDir(t)
	Init()
	// Verify std log.Printf lands in our file.
	osLog := "REDIRECTED_FROM_STD_LOG"
	osLog2 := "another redirected line"
	stdPrintf(osLog)
	stdPrintf(osLog2)
	Close()

	data, _ := os.ReadFile(LogPath())
	s := string(data)
	if !strings.Contains(s, osLog) || !strings.Contains(s, osLog2) {
		t.Errorf("expected std log lines to land in app.log, got %q", s)
	}
}

// stdPrintf goes through Go's std log, which Init redirects to our file.
func stdPrintf(msg string) {
	stdlog.Printf("%s", msg)
}
