package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"image-observer/internal/classification"
	"image-observer/internal/imgfile"
	"image-observer/internal/imgread"
	"image-observer/internal/logging"
	"image-observer/internal/settings"
	"image-observer/internal/state"
	"image-observer/internal/thumb"
)

type App struct {
	ctx            context.Context
	classification *classification.Service
}

func NewApp() *App {
	return &App{
		classification: classification.NewService(
			classification.NewFileRepository(),
			classification.NewFileScanner(),
		),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// OpenFolderDialog opens the native folder selection dialog.
// Returns the selected absolute path, or an empty string if the user cancelled.
func (a *App) OpenFolderDialog() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "フォルダを選択",
	})
}

// GetThumbnail returns a thumbnail for the given image path.
// See spec-thumbnail.md §3.3 for behavior contract.
func (a *App) GetThumbnail(path string, size int, mode string) (thumb.Result, error) {
	return thumb.Get(path, size, mode)
}

// ReadImage returns the original image bytes plus its dimensions.
// See spec-tab-imageview-3a.md §3.2 for behavior contract.
func (a *App) ReadImage(path string) (imgread.Result, error) {
	return imgread.Read(path)
}

// GetImageInfo returns image dimensions only (header read).
// Used as a pre-flight check (e.g., size threshold) before opening a tab.
// See spec-error-handling.md §2.1.
func (a *App) GetImageInfo(path string) (imgread.Info, error) {
	return imgread.ReadInfo(path)
}

// GetState returns the persisted session state, or defaults on failure.
// See spec-tab-imageview-3c.md §3.4.
func (a *App) GetState() (state.StateData, error) {
	return state.Load(), nil
}

// SaveState persists the given session state.
// See spec-tab-imageview-3c.md §3.4.
func (a *App) SaveState(s state.StateData) error {
	return state.Save(s)
}

// LoadClassification reads (and merges with the folder contents) the sidecar
// metadata for the given folder. See spec-classification.md §3.7.
func (a *App) LoadClassification(folderPath string) (*classification.LoadResult, error) {
	return a.classification.Load(folderPath)
}

// SaveClassification writes the full entry list to JSON. expectedMtime is the
// mtime the frontend received from the most recent Load (or Update); pass 0 to
// force overwrite after the user resolves a conflict.
func (a *App) SaveClassification(folderPath string, entries []classification.Entry, expectedMtime int64) (classification.SaveOutput, error) {
	mtime, err := a.classification.Save(folderPath, entries, expectedMtime)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// UpdateClassificationEntry replaces (or appends) a single entry by Filename.
func (a *App) UpdateClassificationEntry(folderPath string, entry classification.Entry, expectedMtime int64) (classification.SaveOutput, error) {
	mtime, err := a.classification.UpdateEntry(folderPath, entry, expectedMtime)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// CreateEmptyClassification creates a brand-new sidecar populated from the
// folder's image files (all entries blank).
func (a *App) CreateEmptyClassification(folderPath string) (classification.SaveOutput, error) {
	mtime, err := a.classification.CreateEmpty(folderPath)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// PreviewChildSidecars scans the parent folder's immediate children for
// existing sidecars and reports what could be merged. Used for the one-time
// "merge from children" prompt; see spec-classification.md §5.12.
func (a *App) PreviewChildSidecars(folderPath string) (*classification.MergePreview, error) {
	return a.classification.PreviewChildSidecars(folderPath)
}

// MergeChildSidecars consumes child sidecars and writes a parent sidecar with
// filenames prefixed by their child folder name. Returns ErrAlreadyExists if
// the parent already has a sidecar (frontend should gate the call).
func (a *App) MergeChildSidecars(folderPath string) (classification.SaveOutput, error) {
	mtime, err := a.classification.MergeChildSidecars(folderPath)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// DeleteImage sends a single image file to the OS recycle bin (Windows) or
// removes it outright (non-windows dev builds — see internal/imgfile.Trash).
// `folderPath` is the absolute folder currently open in the list tab and
// `filename` is the POSIX-relative path (may include subdirectories, e.g.
// "child1/foo.png") so it matches the entry shape stored in the sidecar.
//
// Sidecar JSON updates are intentionally NOT done here: the frontend calls
// SaveClassification separately so the existing mtime-conflict resolution
// (see classification.SaveJSON / ErrConflict) keeps working without
// duplication. See docs/spec-image-delete.md §6.2.
func (a *App) DeleteImage(folderPath, filename string) error {
	cleanedFolder := strings.TrimSpace(folderPath)
	cleanedName := strings.TrimSpace(filename)
	if cleanedFolder == "" || cleanedName == "" {
		return fmt.Errorf("delete: folderPath and filename must not be empty")
	}
	if !filepath.IsAbs(cleanedFolder) {
		return fmt.Errorf("delete: folderPath must be absolute: %q", cleanedFolder)
	}
	// Reject path traversal in `filename`. Sidecar entries use POSIX-relative
	// names produced by classification.scanner, so any escape attempt
	// (absolute path, leading "../") would only show up if a tampered IPC
	// request is sent. We compute the join, then verify with filepath.Rel
	// that the result still lives under cleanedFolder. A naive
	// `strings.Contains(name, "..")` rejects innocent names like
	// `v1..final.png` so we don't use that.
	cleanedNameOS := filepath.FromSlash(cleanedName)
	if filepath.IsAbs(cleanedNameOS) {
		return fmt.Errorf("delete: filename must be relative: %q", cleanedName)
	}
	absPath := filepath.Join(cleanedFolder, cleanedNameOS)
	rel, err := filepath.Rel(cleanedFolder, absPath)
	if err != nil {
		return fmt.Errorf("delete: filename resolves outside folder: %q (%w)", cleanedName, err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("delete: filename must not escape folder: %q", cleanedName)
	}
	if err := imgfile.Trash(absPath); err != nil {
		logging.Error("imgfile", "delete failed",
			"folder", cleanedFolder, "filename", cleanedName, "err", err.Error())
		return err
	}
	logging.Info("imgfile", "deleted",
		"folder", cleanedFolder, "filename", cleanedName, "mode", "trash")
	return nil
}

// classificationError tags conflict errors with a "CONFLICT:" prefix so the
// frontend can detect them via error.message and show the resolution dialog.
func classificationError(err error) error {
	if errors.Is(err, classification.ErrConflict) {
		return fmt.Errorf("CONFLICT: %w", err)
	}
	return err
}

// LogEvent receives a single log line from the frontend and records it in the
// shared app log. `level` is "debug"|"info"|"warn"|"error"; unknown values
// fall back to INFO. `data` is a free-form string (typically JSON) that the
// frontend wants attached as a single key=value field; empty means none.
//
// This is the only Wails-side hook for frontend logging. The frontend wraps
// it in `shared/utils/logger.ts` to add a ring buffer + window.onerror hook.
func (a *App) LogEvent(level, category, message, data string) {
	l, _ := logging.ParseLevel(level)
	if data == "" {
		logging.Log(l, category, message)
		return
	}
	logging.Log(l, category, message, "data", data)
}

// GetLogPath exposes the active log file path so the frontend (or a future
// settings UI) can show / open it.
func (a *App) GetLogPath() string {
	return logging.LogPath()
}

// GetSettings returns the current persisted user settings.
func (a *App) GetSettings() settings.SettingsData {
	return settings.Load()
}

// UpdateSettings validates, saves, and applies the new settings. The
// returned struct is the canonical post-save state (for the frontend to
// rehydrate its store with). Side effects: log-level changes take effect
// immediately on the Go side.
func (a *App) UpdateSettings(s settings.SettingsData) (settings.SettingsData, error) {
	if err := settings.Save(s); err != nil {
		logging.Warn("settings", "save rejected", "err", err.Error())
		return settings.SettingsData{}, err
	}
	saved := settings.Load()
	if lvl, ok := logging.ParseLevel(saved.LogLevel); ok {
		logging.SetLevel(lvl)
	}
	logging.Info("settings", "updated",
		"logLevel", saved.LogLevel,
		"multiSelectMode", saved.MultiSelectMode,
		"wheelMode", saved.WheelMode)
	return saved, nil
}

// ResetSettings restores the in-memory defaults and persists them.
// Convenience wrapper to keep the "Reset to defaults" UI button trivial.
func (a *App) ResetSettings() (settings.SettingsData, error) {
	return a.UpdateSettings(settings.DefaultSettings())
}
