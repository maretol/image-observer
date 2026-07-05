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
)

//go:embed all:frontend/dist
var assets embed.FS

// Version は build 時の release tag。-ldflags "-X main.Version=..." で注入、未タグ build は "dev" のまま。
var Version = "dev"

func main() {
	// まず logging: 以降の panic / state-load 問題をファイルに残すため。
	if err := logging.Init(); err != nil {
		// logging 自体が失敗。log ファイルが無いので stderr に fallback。
		log.Printf("logging init failed: %v", err)
	}
	defer logging.Close()

	defer func() {
		if r := recover(); r != nil {
			logging.Error("app", "panic recovered",
				"value", fmt.Sprint(r),
				"stack", string(debug.Stack()))
			// 再 raise してプロセスが非ゼロ終了するように。
			panic(r)
		}
	}()

	logging.Info("app", "starting", "version", Version)

	// 永続ユーザー設定を適用 (settings UI の log level が Init() の env-var 解決を上書き)。
	userSettings := settings.Load()
	if lvl, ok := logging.ParseLevel(userSettings.LogLevel); ok {
		logging.SetLevel(lvl)
		logging.Info("app", "settings applied",
			"logLevel", userSettings.LogLevel,
			"multiSelectMode", userSettings.MultiSelectMode)
	}

	// worker pool は起動時 1 回。worker 数変更は再起動必須 (thumb.InitWorkerPool 参照)。
	thumb.InitWorkerPool(userSettings.ThumbnailWorkerCount)
	logging.Info("app", "thumb worker pool sized",
		"workerCount", thumb.CurrentWorkerCount(),
		"setting", userSettings.ThumbnailWorkerCount)

	app := NewApp()

	// window 表示前にサイズを決めるため永続 state を先に load。位置は runtime API が要るので startup 後に復元。
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
			// never-positioned sentinel (初回 / state 欠落) は復元 geometry が無いので Wails 既定 placement に
			// 任せ restore を skip する (#129: (-1,-1) 適用で左上隅に押し込まれる)。
			posUnset := persisted.Window.X == state.WindowPositionUnset &&
				persisted.Window.Y == state.WindowPositionUnset
			if !posUnset {
				// Windows: native placement をフル復元 (#129)。下の Wails-runtime 経路は multi-monitor で
				// primary monitor に置いてしまう。winplacement.Restore は非 Windows で no-op (ok=false → #86 fallback)。
				if winplacement.Restore(persisted.Window) {
					return
				}
				// 本物の負座標 (左/上の secondary monitor) は有効なのでこの fallback でも復元 (#129)。
				runtime.WindowSetPosition(ctx, persisted.Window.X, persisted.Window.Y)
			}
			// 最大化 state は最後に復元し unmaximize が永続 geometry に戻るように (#86)。frontend polling は
			// 最大化中この 4 field を凍結するので非最大化 session の値のまま。
			if persisted.Window.Maximized {
				runtime.WindowMaximise(ctx)
			}
		},
		OnBeforeClose: func(_ context.Context) (prevent bool) {
			// Windows: window がまだ存在する間に native placement を捕捉 (OnShutdown は遅すぎ HWND 消失の恐れ)、
			// window field だけ永続化 (#129)。Capture は非 Windows で no-op (ok=false — frontend polling が所有, #86)。
			if w, ok := winplacement.Capture(); ok {
				if err := state.SaveWindow(w); err != nil {
					logging.Warn("app", "save window placement failed", "err", err.Error())
				}
			}
			return false // window を閉じさせる
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
