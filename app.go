package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"image-observer/internal/classification"
	"image-observer/internal/imgread"
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

// classificationError tags conflict errors with a "CONFLICT:" prefix so the
// frontend can detect them via error.message and show the resolution dialog.
func classificationError(err error) error {
	if errors.Is(err, classification.ErrConflict) {
		return fmt.Errorf("CONFLICT: %w", err)
	}
	return err
}
