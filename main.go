package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"image-observer/internal/state"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
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
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
