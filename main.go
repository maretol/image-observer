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
	"image-observer/internal/thumb"
	"image-observer/internal/winplacement"
	"image-observer/internal/winrestart"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is the build-time release tag, injected via:
//
//	go build -ldflags "-X main.Version=v0.1.0"
//
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

	// Worker pool sizing happens once at startup; settings UI marks worker-count
	// changes as restart-required (see thumb.InitWorkerPool's safety note).
	thumb.InitWorkerPool(userSettings.ThumbnailWorkerCount)
	logging.Info("app", "thumb worker pool sized",
		"workerCount", thumb.CurrentWorkerCount(),
		"setting", userSettings.ThumbnailWorkerCount)

	// Register with Windows so the OS relaunches us after a crash, hang, or an
	// update reboot (issue #133). Best-effort: a failure only means we will not
	// be auto-restarted, so log and continue. No-op on non-Windows dev builds.
	if err := winrestart.Register(); err != nil {
		logging.Warn("app", "register application restart failed", "err", err.Error())
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
		Title:     "Imago",
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
			// With the never-positioned sentinel (first launch / missing state)
			// there is no real geometry to restore, so let Wails use its default
			// placement — skip both the Win32 restore and the fallback
			// WindowSetPosition (issue #129 review: applying (-1,-1) would shove
			// the window into the top-left corner).
			posUnset := persisted.Window.X == state.WindowPositionUnset &&
				persisted.Window.Y == state.WindowPositionUnset
			if !posUnset {
				// Windows: restore the full native placement (issue #129). The
				// Wails-runtime path below lands the window on the primary
				// monitor on multi-monitor Windows (the bug we fix);
				// SetWindowPlacement puts it back on the correct monitor and
				// also captures the restore rect even while maximized.
				// winplacement.Restore is a no-op (ok=false) on non-Windows,
				// where we keep the #86 fallback.
				if winplacement.Restore(persisted.Window) {
					return
				}
				// Real negative coordinates (a secondary monitor left of /
				// above the primary) are valid and must be restored on this
				// fallback path too (issue #129 review).
				runtime.WindowSetPosition(ctx, persisted.Window.X, persisted.Window.Y)
			}
			// Restore maximized state last so the unmaximize button falls back
			// to the persisted Width/Height/X/Y geometry (issue #86). The
			// frontend's polling freezes those four fields while
			// WindowIsMaximised is true, so they stay representative of the
			// most recent non-maximized session.
			if persisted.Window.Maximized {
				runtime.WindowMaximise(ctx)
			}
		},
		OnBeforeClose: func(_ context.Context) (prevent bool) {
			// Windows: capture the native placement while the window still
			// exists (OnShutdown is too late — the HWND may be gone) and persist
			// only the window field (issue #129). winplacement.Capture is a
			// no-op (ok=false) on non-Windows, where the frontend polling owns
			// the window geometry (#86), so nothing is saved here.
			if w, ok := winplacement.Capture(); ok {
				if err := state.SaveWindow(w); err != nil {
					logging.Warn("app", "save window placement failed", "err", err.Error())
				}
			}
			return false // allow the window to close
		},
		OnShutdown: func(ctx context.Context) {
			app.shutdown(ctx)
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
