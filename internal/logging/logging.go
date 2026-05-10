// Package logging provides a small, dependency-free file logger for both Go
// and frontend log events. Output is a single rotated file under
// `os.UserCacheDir()/image-observer/logs/app.log` (Windows: %LOCALAPPDATA%\…).
//
// Log lines look like this (tab-separated category↔message):
//
//	2026-05-10T17:30:12.345+09:00 INFO  dnd.start	src=L1 idx=0 path=/img/foo.png
//	2026-05-10T17:30:13.012+09:00 WARN  dnd.refused	reason=panel-limit panels=16
//
// Level resolution (most-specific wins):
//  1. env var IMAGE_OBSERVER_LOG_LEVEL ("debug"|"info"|"warn"|"error")
//  2. file <UserConfigDir>/image-observer/log_level.txt with one of the same
//     tokens
//  3. default INFO
//
// SetLevel() can be called at runtime to override (intended for the future
// settings UI).
package logging

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

// Tunables. The defaults aim for "small enough that grep stays fast, big
// enough to capture an hour of dragging without rolling".
const (
	maxFileSize int64 = 2 * 1024 * 1024 // 2 MB per file
	keepBackups       = 2               // app.log + .1 + .2 = 3 files total
)

var (
	mu      sync.Mutex
	file    *os.File
	level   = LevelInfo
	logPath string
	closed  = true
)

// Init opens (and rotates if oversized) the log file, resolves the level, and
// redirects Go's standard log package to the same file. Safe to call once at
// startup. Subsequent calls are no-ops.
func Init() error {
	mu.Lock()
	defer mu.Unlock()
	if !closed {
		return nil
	}

	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return fmt.Errorf("user cache dir: %w", err)
	}
	dir := filepath.Join(cacheDir, "image-observer", "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir logs: %w", err)
	}
	logPath = filepath.Join(dir, "app.log")

	level = resolveLevelLocked()

	// Rotate up front if the existing file is already over the cap (e.g., the
	// previous run died before its own rotation point).
	if info, err := os.Stat(logPath); err == nil && info.Size() >= maxFileSize {
		if err := rotateLocked(); err != nil {
			return fmt.Errorf("pre-rotate: %w", err)
		}
	}

	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	file = f
	closed = false

	// Send Go's std logger here too, so existing log.Printf calls (and Wails
	// runtime warnings) end up in the same place. Lines from log.Printf keep
	// Go's default `YYYY/MM/DD HH:MM:SS` prefix; that's tolerable since both
	// formats are timestamped.
	log.SetOutput(lockedWriter{})

	writeLocked(LevelInfo, "app", "logger initialized",
		[]any{"level", LevelName(level), "path", logPath})
	return nil
}

// Close flushes and closes the underlying file. Safe to call multiple times.
func Close() error {
	mu.Lock()
	defer mu.Unlock()
	if closed || file == nil {
		return nil
	}
	writeLocked(LevelInfo, "app", "logger closing", nil)
	err := file.Close()
	file = nil
	closed = true
	// Detach std logger to avoid writes to a closed file.
	log.SetOutput(io.Discard)
	return err
}

// SetLevel adjusts the runtime threshold. Calls below the threshold become
// no-ops. Intended to be wired to a future settings UI.
func SetLevel(l Level) {
	mu.Lock()
	defer mu.Unlock()
	level = l
}

// CurrentLevel returns the active threshold. Mostly for diagnostics.
func CurrentLevel() Level {
	mu.Lock()
	defer mu.Unlock()
	return level
}

// LogPath returns the absolute path of the active log file. Empty before Init.
func LogPath() string {
	mu.Lock()
	defer mu.Unlock()
	return logPath
}

// ParseLevel maps a level token (case-insensitive) to a Level. Unknown
// strings return (LevelInfo, false).
func ParseLevel(s string) (Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug, true
	case "info":
		return LevelInfo, true
	case "warn", "warning":
		return LevelWarn, true
	case "error", "err":
		return LevelError, true
	}
	return LevelInfo, false
}

// LevelName returns the canonical 5-character-padded label.
func LevelName(l Level) string {
	switch l {
	case LevelDebug:
		return "DEBUG"
	case LevelInfo:
		return "INFO "
	case LevelWarn:
		return "WARN "
	case LevelError:
		return "ERROR"
	}
	return "?    "
}

// Debug / Info / Warn / Error are the public emitters. `kv` is a flat
// (key, value, key, value, ...) sequence; non-string keys are skipped.
func Debug(category, message string, kv ...any) {
	emit(LevelDebug, category, message, kv)
}
func Info(category, message string, kv ...any) {
	emit(LevelInfo, category, message, kv)
}
func Warn(category, message string, kv ...any) {
	emit(LevelWarn, category, message, kv)
}
func Error(category, message string, kv ...any) {
	emit(LevelError, category, message, kv)
}

// Log dispatches by Level, useful when the level was parsed from a string.
func Log(l Level, category, message string, kv ...any) {
	emit(l, category, message, kv)
}

// ─── internals ───────────────────────────────────────────────────────

func emit(l Level, category, message string, kv []any) {
	mu.Lock()
	defer mu.Unlock()
	if closed || l < level {
		return
	}
	// Rotate proactively before writing if we're at the size threshold.
	if file != nil {
		if info, err := file.Stat(); err == nil && info.Size() >= maxFileSize {
			_ = rotateLocked()
		}
	}
	writeLocked(l, category, message, kv)
}

func writeLocked(l Level, category, message string, kv []any) {
	if file == nil {
		return
	}
	var b strings.Builder
	b.WriteString(time.Now().Format("2006-01-02T15:04:05.000-07:00"))
	b.WriteString(" ")
	b.WriteString(LevelName(l))
	b.WriteString(" ")
	b.WriteString(category)
	b.WriteString("\t")
	b.WriteString(message)
	for i := 0; i+1 < len(kv); i += 2 {
		k, ok := kv[i].(string)
		if !ok {
			continue
		}
		b.WriteString(" ")
		b.WriteString(k)
		b.WriteString("=")
		b.WriteString(formatValue(kv[i+1]))
	}
	b.WriteString("\n")
	_, _ = file.WriteString(b.String())
}

func formatValue(v any) string {
	s := fmt.Sprintf("%v", v)
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, " \t\"\n\r") {
		s = strings.ReplaceAll(s, `\`, `\\`)
		s = strings.ReplaceAll(s, `"`, `\"`)
		s = strings.ReplaceAll(s, "\n", `\n`)
		s = strings.ReplaceAll(s, "\r", `\r`)
		return `"` + s + `"`
	}
	return s
}

// rotateLocked: app.log → app.log.1 → app.log.2 → discard.
// On Windows, you cannot rename a file that's open for writing, so we close
// the current file first, then rename, then reopen. Caller holds mu.
func rotateLocked() error {
	if file != nil {
		_ = file.Close()
		file = nil
	}

	oldest := fmt.Sprintf("%s.%d", logPath, keepBackups)
	_ = os.Remove(oldest)
	for i := keepBackups - 1; i >= 1; i-- {
		src := fmt.Sprintf("%s.%d", logPath, i)
		dst := fmt.Sprintf("%s.%d", logPath, i+1)
		if _, err := os.Stat(src); err == nil {
			if err := os.Rename(src, dst); err != nil {
				return err
			}
		}
	}
	if _, err := os.Stat(logPath); err == nil {
		if err := os.Rename(logPath, logPath+".1"); err != nil {
			return err
		}
	}

	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	file = f
	return nil
}

func resolveLevelLocked() Level {
	if v := strings.TrimSpace(os.Getenv("IMAGE_OBSERVER_LOG_LEVEL")); v != "" {
		if l, ok := ParseLevel(v); ok {
			return l
		}
	}
	if cfg, err := os.UserConfigDir(); err == nil {
		path := filepath.Join(cfg, "image-observer", "log_level.txt")
		if data, err := os.ReadFile(path); err == nil {
			if l, ok := ParseLevel(string(data)); ok {
				return l
			}
		}
	}
	return LevelInfo
}

// lockedWriter funnels writes from Go's std logger through our mutex so they
// don't interleave with our own emits to the same file.
type lockedWriter struct{}

func (lockedWriter) Write(p []byte) (int, error) {
	mu.Lock()
	defer mu.Unlock()
	if file == nil {
		return len(p), nil
	}
	return file.Write(p)
}

// ─── test hooks ──────────────────────────────────────────────────────

// resetForTest unwinds Init so a test can drive a fresh logger pointed at a
// temp directory. Not exported.
func resetForTest() {
	mu.Lock()
	defer mu.Unlock()
	if file != nil {
		_ = file.Close()
		file = nil
	}
	logPath = ""
	level = LevelInfo
	closed = true
	log.SetOutput(io.Discard)
}
