// Package logging は Go / frontend 両方の log 用の依存なしファイル logger。出力は
// os.UserCacheDir()/image-observer/logs/app.log の単一 rotate ファイル。
//
// log 行の形 (category↔message は tab 区切り):
//
//	2026-05-10T17:30:12.345+09:00 INFO  dnd.start	src=L1 idx=0 path=/img/foo.png
//	2026-05-10T17:30:13.012+09:00 WARN  dnd.refused	reason=panel-limit panels=16
//
// level 解決 (最も具体的が勝つ):
//  1. env var IMAGE_OBSERVER_LOG_LEVEL
//  2. file <UserConfigDir>/image-observer/log_level.txt
//  3. 既定 INFO
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

// 調整値。既定は「grep が速いくらい小さく、1 時間の drag を rotate せず捕捉できるくらい大きく」を狙う。
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

// Init は log ファイルを開き (超過なら rotate)、level を解決、Go 標準 log を同ファイルへ redirect する。
// 起動時 1 回、以降は no-op。
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

	// 既存ファイルが既に上限超過なら先に rotate (前回 run が rotate 前に死んだ等)。
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

	// Go 標準 logger もここへ送り log.Printf / Wails runtime warning を同じ場所に集める。
	// log.Printf 行は Go 既定 prefix のままだが timestamp 付きなので許容。
	log.SetOutput(lockedWriter{})

	writeLocked(LevelInfo, "app", "logger initialized",
		[]any{"level", LevelName(level), "path", logPath})
	return nil
}

// Close はファイルを flush して閉じる。複数回呼んでも安全。
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
	// 閉じたファイルへの書き込みを避けるため std logger を切り離す。
	log.SetOutput(io.Discard)
	return err
}

// SetLevel は実行時 threshold を調整する。
func SetLevel(l Level) {
	mu.Lock()
	defer mu.Unlock()
	level = l
}

// CurrentLevel は現在の threshold を返す。
func CurrentLevel() Level {
	mu.Lock()
	defer mu.Unlock()
	return level
}

// LogPath は active な log ファイルの絶対 path を返す。Init 前は空。
func LogPath() string {
	mu.Lock()
	defer mu.Unlock()
	return logPath
}

// ParseLevel は level トークン (大小無視) を Level に対応させる。不明な文字列は (LevelInfo, false)。
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

// LevelName は 5 文字 padding の canonical ラベルを返す。
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

// Debug / Info / Warn / Error は public emitter。kv は flat な (key, value, ...) 列で non-string key は skip。
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

// Log は Level で dispatch する。
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
	// size 閾値なら書き込み前に先んじて rotate。
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

// rotateLocked: app.log → app.log.1 → app.log.2 → discard。Windows は書き込み中ファイルを rename
// できないので、現ファイルを閉じ → rename → 再オープン。caller が mu を保持。
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

// lockedWriter は Go 標準 logger の書き込みを我々の mutex 経由に通し、同じファイルへの emit と混ざらないように。
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

// resetForTest は Init を巻き戻しテストが fresh logger を回せるように。
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
