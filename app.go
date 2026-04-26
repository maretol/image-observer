package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"image-observer/internal/imgread"
	"image-observer/internal/state"
	"image-observer/internal/thumb"
	"image-observer/internal/tree"
)

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
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

// ListDirectory returns immediate children (one level only) of the given path.
// See spec-folder-tree.md §3.2 for behavior contract.
func (a *App) ListDirectory(path string) ([]tree.Node, error) {
	return tree.List(path)
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
