package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"runtime/debug"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"image-observer/internal/logging"
	"image-observer/internal/settings"
	"image-observer/internal/state"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is the build-time release tag, injected via:
//   go build -ldflags "-X main.Version=v0.1.0"
// (Wails forwards `-ldflags` from `wails build`.) Untagged builds (local
// `wails dev` / `wails build` without a flag) leave it as the dev sentinel.
var Version = "dev"

func main() {
	// Logging first: any later panic / state-load issue should land in the file.
	if err := logging.Init(); err != nil {
		// Logging itself failed; the user has no log file to inspect, so fall
		// back to stderr (visible in dev terminal, ignored in packaged builds).
		log.Printf("logging init failed: %v", err)
	}
	defer logging.Close()

	defer func() {
		if r := recover(); r != nil {
			logging.Error("app", "panic recovered",
				"value", fmt.Sprint(r),
				"stack", string(debug.Stack()))
			// Re-raise so the process still exits non-zero.
			panic(r)
		}
	}()

	logging.Info("app", "starting", "version", Version)

	// Apply persisted user settings: e.g., the log level the user picked in
	// the settings UI overrides the env-var-resolved level chosen at Init().
	userSettings := settings.Load()
	if lvl, ok := logging.ParseLevel(userSettings.LogLevel); ok {
		logging.SetLevel(lvl)
		logging.Info("app", "settings applied",
			"logLevel", userSettings.LogLevel,
			"multiSelectMode", userSettings.MultiSelectMode)
	}

	app := NewApp()

	// Load persisted state up front so we can size the window before showing it.
	// Window position needs runtime API and is restored after startup.
	persisted := state.Load()

	width := persisted.Window.Width
	height := persisted.Window.Height
	if width < 200 {
		width = 1024
	}
	if height < 200 {
		height = 768
	}

	err := wails.Run(&options.App{
		Title:     "image-observer",
		Width:     width,
		Height:    height,
		MinWidth:  400,
		MinHeight: 300,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup: func(ctx context.Context) {
			app.startup(ctx)
			if persisted.Window.X >= 0 && persisted.Window.Y >= 0 {
				runtime.WindowSetPosition(ctx, persisted.Window.X, persisted.Window.Y)
			}
		},
		Bind: []any{
			app,
		},
	})

	if err != nil {
		logging.Error("app", "wails.Run failed", "err", err.Error())
	}
	logging.Info("app", "exiting")
}
