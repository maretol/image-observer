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
	"image-observer/internal/watcher"
)

type App struct {
	ctx            context.Context
	classification *classification.Service
	watch          *watcher.Manager
}

func NewApp() *App {
	a := &App{
		classification: classification.NewService(
			classification.NewFileRepository(),
			classification.NewFileScanner(),
		),
	}
	// Manager を早期構築し Start/Stop binding が常に非 nil receiver を持つように。EventsEmit は ctx が
	// 要るので emit callback は a を閉じ込み a.ctx を lazy 読み。event 名は watcher が単一ソースで frontend が
	// ミラー、vitest が両リテラルを pin する。
	a.watch = watcher.NewManager(func(p watcher.ChangedPayload) {
		if a.ctx == nil {
			return
		}
		runtime.EventsEmit(a.ctx, watcher.ClassificationChangedEvent, p)
	})
	return a
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown は active な folder watch を tear down し、終了時の inotify FD / goroutine leak を防ぐ。
// ctx は未使用 (watcher は自前の stop channel で lifecycle 管理)。
func (a *App) shutdown(_ context.Context) {
	_ = a.watch.Stop()
}

// OpenFolderDialog はネイティブのフォルダ選択ダイアログを開く。選択した絶対 path、キャンセル時は空文字。
func (a *App) OpenFolderDialog() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "フォルダを選択",
	})
}

// GetThumbnail は画像 path のサムネイルを返す (contract: spec-thumbnail.md §3.3)。
func (a *App) GetThumbnail(path string, size int, mode string) (thumb.Result, error) {
	return thumb.Get(path, size, mode)
}

// ReadImage は元画像のバイト列と寸法を返す (contract: spec-tab-imageview-3a.md §3.2)。
func (a *App) ReadImage(path string) (imgread.Result, error) {
	return imgread.Read(path)
}

// GetImageInfo は寸法のみ返す (header 読み)。タブを開く前の pre-flight (サイズ閾値等) 用
// (spec-error-handling.md §2.1)。
func (a *App) GetImageInfo(path string) (imgread.Info, error) {
	return imgread.ReadInfo(path)
}

// GetState は永続 session state を返す (失敗時は defaults, spec-tab-imageview-3c.md §3.4)。
func (a *App) GetState() (state.StateData, error) {
	return state.Load(), nil
}

// SaveState は session state を永続化する (spec-tab-imageview-3c.md §3.4)。
func (a *App) SaveState(s state.StateData) error {
	return state.Save(s)
}

// LoadClassification は sidecar メタデータを読み folder 内容とマージする (spec-classification.md §3.7)。
func (a *App) LoadClassification(folderPath string) (*classification.LoadResult, error) {
	return a.classification.Load(folderPath)
}

// SaveClassification は全 entry を JSON へ書く。expectedMtime は直近 Load/Update で frontend が
// 受け取った mtime。conflict 解決後の強制上書きは 0 を渡す。
func (a *App) SaveClassification(folderPath string, entries []classification.Entry, expectedMtime int64) (classification.SaveOutput, error) {
	mtime, err := a.classification.Save(folderPath, entries, expectedMtime)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// UpdateClassificationEntry は Filename で 1 entry を置換 (無ければ追加) する。
func (a *App) UpdateClassificationEntry(folderPath string, entry classification.Entry, expectedMtime int64) (classification.SaveOutput, error) {
	mtime, err := a.classification.UpdateEntry(folderPath, entry, expectedMtime)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// CreateEmptyClassification は folder の画像から新規 sidecar を作る (全 entry 空)。
func (a *App) CreateEmptyClassification(folderPath string) (classification.SaveOutput, error) {
	mtime, err := a.classification.CreateEmpty(folderPath)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// PreviewChildSidecars は親フォルダの直下の子の sidecar を走査し merge 候補を報告する。
// 一度きりの「子から merge」prompt 用 (spec-classification.md §5.12)。
func (a *App) PreviewChildSidecars(folderPath string) (*classification.MergePreview, error) {
	return a.classification.PreviewChildSidecars(folderPath)
}

// MergeChildSidecars は子 sidecar を取り込み、filename を子フォルダ名で prefix して親 sidecar を
// 書く。親に既に sidecar があれば ErrAlreadyExists (frontend が gate すべき)。
func (a *App) MergeChildSidecars(folderPath string) (classification.SaveOutput, error) {
	mtime, err := a.classification.MergeChildSidecars(folderPath)
	if err != nil {
		return classification.SaveOutput{}, classificationError(err)
	}
	return classification.SaveOutput{Mtime: mtime}, nil
}

// DeleteImage は画像 1 枚を OS ゴミ箱 (Windows) か os.Remove (非 windows dev) で削除する。filename は
// sidecar entry 形の POSIX 相対 path ("child1/foo.png" 等)。sidecar 更新はここでせず frontend の
// SaveClassification に委ね、既存の mtime-conflict 解決を重複なく生かす (spec-image-delete.md §6.2)。
func (a *App) DeleteImage(folderPath, filename string) error {
	cleanedFolder := strings.TrimSpace(folderPath)
	cleanedName := strings.TrimSpace(filename)
	if cleanedFolder == "" || cleanedName == "" {
		return fmt.Errorf("delete: folderPath and filename must not be empty")
	}
	if !filepath.IsAbs(cleanedFolder) {
		return fmt.Errorf("delete: folderPath must be absolute: %q", cleanedFolder)
	}
	// path traversal を拒否 (escape 試行は改竄 IPC でしか現れない)。join 後に filepath.Rel で folder 配下に
	// 残るか検証。素朴な strings.Contains(name, "..") は v1..final.png のような無害名も弾くので使わない。
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

// StartFolderWatch は folderPath の watcher を開始 (再開) する。quiet window ごとに
// ClassificationChangedEvent を emit (spec-folder-watch.md)。同 folder は no-op、別 folder なら旧 watch を
// 先に stop。エラーは非致命 (frontend は degraded mode = 手動 reload 扱い)。WatchMode 尊重は frontend の責任。
func (a *App) StartFolderWatch(folderPath string) error {
	// TrimSpace は空/空白入力を弾くためだけ。以降は元の folderPath を渡す — frontend は un-trimmed 文字列で
	// self-echo 照合するし、黙って trim すると別 folder に監視が切り替わりうる。
	if strings.TrimSpace(folderPath) == "" {
		return fmt.Errorf("watcher: folderPath must not be empty")
	}
	if !filepath.IsAbs(folderPath) {
		return fmt.Errorf("watcher: folderPath must be absolute: %q", folderPath)
	}
	if err := a.watch.Start(folderPath); err != nil {
		logging.Warn("watcher", "start failed",
			"folder", folderPath, "err", err.Error())
		return err
	}
	return nil
}

// StopFolderWatch は active な watch を tear down する。冪等 (未監視でも nil)。
func (a *App) StopFolderWatch() error {
	return a.watch.Stop()
}

// classificationError は conflict エラーに "CONFLICT:" prefix を付け、frontend が error.message で
// 検出して解決 dialog を出せるようにする。
func classificationError(err error) error {
	if errors.Is(err, classification.ErrConflict) {
		return fmt.Errorf("CONFLICT: %w", err)
	}
	return err
}

// LogEvent は frontend の 1 ログ行を共有 app log に記録する。level 不明は INFO、data は空でなければ
// 1 key=value として付ける。frontend logging の唯一の Wails hook。
func (a *App) LogEvent(level, category, message, data string) {
	l, _ := logging.ParseLevel(level)
	if data == "" {
		logging.Log(l, category, message)
		return
	}
	logging.Log(l, category, message, "data", data)
}

// GetLogPath は active なログファイル path を返す。
func (a *App) GetLogPath() string {
	return logging.LogPath()
}

// GetSettings は現在の永続ユーザー設定を返す。
func (a *App) GetSettings() settings.SettingsData {
	return settings.Load()
}

// UpdateSettings は新設定を検証・保存・適用し、保存後の canonical state を返す。log-level 変更は Go 側で即時反映。
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

// ResetSettings は in-memory defaults に戻して永続化する。
func (a *App) ResetSettings() (settings.SettingsData, error) {
	return a.UpdateSettings(settings.DefaultSettings())
}
