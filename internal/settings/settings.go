// Package settings はユーザー設定を永続化する (state の一時 session state とは別)。保存先は
// <UserConfigDir>/image-observer/settings.json。
//
// 不明/不正な field 値は file 全体でなく per-field 既定に fallback (1 つの悪い値が他を吹き飛ばさない)。
// schema version 不一致は full default に fallback。将来 field は per-field fallback で加算追加し version を
// bump しない。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"os"
	"path/filepath"
	"strings"
)

// SettingsSchemaVersion は JSON 形が互換なく変わったとき bump する。旧版は defaults に fallback (v1 に migration なし)。
const SettingsSchemaVersion = 1

// SettingsData.MultiSelectMode の許容値。
const (
	MultiSelectCheckbox = "checkbox" // case A のみ (Phase 4 v1.4 既定)
	MultiSelectModifier = "modifier" // case B: Ctrl/Shift+click のみ
	MultiSelectBoth     = "both"     // 両モード
)

// SettingsData.WheelMode の許容値。
const (
	WheelModeZoom      = "zoom"       // 既定: ホイールでズーム
	WheelModeShiftZoom = "shift-zoom" // ホイールでパン、Shift+ホイールでズーム
)

// SettingsData.ThumbnailMode の許容値。
const (
	ThumbnailModeLetterbox = "letterbox"
	ThumbnailModeCrop      = "crop"
)

// SettingsData.WatchMode の許容値。
const (
	WatchModeAuto = "auto" // 既定: folder を開いたら fsnotify watcher を開始
	WatchModeOff  = "off"  // watcher を開始しない; 手動 reload
)

// SettingsData.DuplicateDetectMode の許容値 (#136, spec-duplicate-detection.md §7.1)。
const (
	DuplicateDetectAuto = "auto" // 既定: folder を開いたらダブり検出を自動実行
	DuplicateDetectOff  = "off"  // 検出しない (ハッシュ計算も IPC も走らない)
)

// 数値 field の既定 / 境界 (garbage を弾きつつ正当な調整は妨げない緩さ)。MaxThumbnailWorkerCount を
// export するのは thumb の auto (NumCPU/2) 分岐を同じ上限に抑えるため。
const (
	defaultMaxImagePixelsMP = 200 // 200 MP ~ 14000×14000 px 画像
	maxMaxImagePixelsMP     = 4000
	defaultThumbnailSize    = 256
	minThumbnailSize        = 32
	maxThumbnailSize        = 1024
	MaxThumbnailWorkerCount = 64
	// UIScale は app root に CSS zoom で適用する整数 percent。UI picker は 4 tier だが settings.json で
	// 任意値も可。
	defaultUIScalePercent = 100
	minUIScalePercent     = 75
	maxUIScalePercent     = 150
	// DuplicateThreshold はダブり判定のハミング距離上限 (0 = 知覚的に同一のみ)。0 が正当値なので
	// 「欠落」との区別は Load の probe で行う (EditAutoSave と同じ理屈)。
	defaultDuplicateThreshold = 5
	minDuplicateThreshold     = 0
	maxDuplicateThreshold     = 16
	// MaxViewers はビューアタブの追加上限 (#148)。既定 8 はフロント viewers.ts の
	// MAX_VIEWERS と対。MaxViewersHardCap を export するのは state.json 復元の truncate 上界
	// (state.maxViewersHard) と同値であることを state 側テストで担保するため。
	defaultMaxViewers = 8
	minMaxViewers     = 1
	MaxViewersHardCap = 32
)

// SettingsData.LogLevel の許容値。
var validLogLevels = map[string]struct{}{
	"debug": {}, "info": {}, "warn": {}, "error": {},
}

var validMultiSelectModes = map[string]struct{}{
	MultiSelectCheckbox: {},
	MultiSelectModifier: {},
	MultiSelectBoth:     {},
}

var validWheelModes = map[string]struct{}{
	WheelModeZoom:      {},
	WheelModeShiftZoom: {},
}

var validThumbnailModes = map[string]struct{}{
	ThumbnailModeLetterbox: {},
	ThumbnailModeCrop:      {},
}

var validWatchModes = map[string]struct{}{
	WatchModeAuto: {},
	WatchModeOff:  {},
}

var validDuplicateDetectModes = map[string]struct{}{
	DuplicateDetectAuto: {},
	DuplicateDetectOff:  {},
}

// defaultTagColors は tagColors 未設定時の seed palette (frontend が同一リテラルを持つ)。未 export なのは
// Go map が参照型で、export すると importer が seed を mutate し DefaultSettings() を壊すため。caller は
// cloneTagColors で clone して公開する。
var defaultTagColors = map[string]string{
	"iroha":   "#1976d2",
	"kaguya":  "#f9a825",
	"yachiyo": "#c2185b",
	"roka":    "#388e3c",
	"mami":    "#fb8c00",
	"mikado":  "#d32f2f",
	"shugo":   "#7b1fa2",
	"fumei":   "#757575",
}

// SettingsData は永続 (& Wails 公開) 形。新 field は DefaultSettings に default 付きで足す。JSON は
// camelCase 直列化。非自明な field:
//   - ThumbnailWorkerCount: 0 = auto (NumCPU/2)、正 = 明示 cap; 再起動必須 (worker pool は起動時 1 回)
//   - WatchMode: "auto" | "off" — 分類タブの fsnotify auto-merge を駆動 (spec-folder-watch.md)
type SettingsData struct {
	Version              int               `json:"version"`
	LogLevel             string            `json:"logLevel"`
	MultiSelectMode      string            `json:"multiSelectMode"`
	WheelMode            string            `json:"wheelMode"`
	MaxImagePixelsMP     int               `json:"maxImagePixelsMP"`
	ThumbnailSize        int               `json:"thumbnailSize"`
	ThumbnailMode        string            `json:"thumbnailMode"`
	ThumbnailWorkerCount int               `json:"thumbnailWorkerCount"`
	TagColors            map[string]string `json:"tagColors"`
	UIScalePercent       int               `json:"uiScalePercent"`
	WatchMode            string            `json:"watchMode"`
	// EditAutoSave は save モードを駆動 (#105)。true (既定) = blur/radio で自動 save、false = 手動のみ。
	// 欠落 (#105 前 build) と明示 false は Load の probe で区別する。
	EditAutoSave bool `json:"editAutoSave"`
	// DuplicateDetectMode / DuplicateThreshold はダブり検出を駆動 (#136,
	// spec-duplicate-detection.md §7.1)。threshold は 0 が正当値 (知覚的に同一のみ) のため、
	// 欠落 (#136 前 build) は Load の probe で既定 5 に倒す。
	DuplicateDetectMode string `json:"duplicateDetectMode"`
	DuplicateThreshold  int    `json:"duplicateThreshold"`
	// MaxViewers はビューアタブの追加上限 (#148, spec-viewer-max-count.md)。追加時 gate のみで、
	// 下げても open 中の viewer は閉じない (state.json 復元の truncate は maxViewersHard=32 側)。
	// 欠落 (ゼロ値 0) は範囲外なので probe 不要で既定 8 に落ちる。
	MaxViewers int `json:"maxViewers"`
}

// settingsFilePathOverride はテストが user config dir 外へ redirect するため。
var settingsFilePathOverride string

func settingsFilePath() (string, error) {
	if settingsFilePathOverride != "" {
		return settingsFilePathOverride, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "image-observer", "settings.json"), nil
}

// DefaultSettings は in-memory defaults を返す。
func DefaultSettings() SettingsData {
	return SettingsData{
		Version:              SettingsSchemaVersion,
		LogLevel:             "info",
		MultiSelectMode:      MultiSelectCheckbox,
		WheelMode:            WheelModeZoom,
		MaxImagePixelsMP:     defaultMaxImagePixelsMP,
		ThumbnailSize:        defaultThumbnailSize,
		ThumbnailMode:        ThumbnailModeLetterbox,
		ThumbnailWorkerCount: 0, // auto
		TagColors:            cloneTagColors(defaultTagColors),
		UIScalePercent:       defaultUIScalePercent,
		WatchMode:            WatchModeAuto,
		EditAutoSave:         true,
		DuplicateDetectMode:  DuplicateDetectAuto,
		DuplicateThreshold:   defaultDuplicateThreshold,
		MaxViewers:           defaultMaxViewers,
	}
}

// Load は永続 settings を返す。欠落 / parse / version 不一致は DefaultSettings に fallback。個々の不正
// field は既定に reset し他 field は保持。
func Load() SettingsData {
	path, err := settingsFilePath()
	if err != nil {
		log.Printf("settings: cannot determine settings path: %v", err)
		return DefaultSettings()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("settings: read failed: %v", err)
		}
		return DefaultSettings()
	}
	var s SettingsData
	if err := json.Unmarshal(data, &s); err != nil {
		log.Printf("settings: parse failed (using defaults): %v", err)
		return DefaultSettings()
	}
	if s.Version != SettingsSchemaVersion {
		log.Printf("settings: version mismatch (got %d, want %d), using defaults",
			s.Version, SettingsSchemaVersion)
		return DefaultSettings()
	}
	// bool の「欠落」と明示 false を区別する: encoding/json は欠落 bool を false で埋め、EditAutoSave
	// (#105 既定 true) が #105 前 build の upgrade で silent に manual に化ける。raw map に 2 度目 decode して
	// key の有無を見る。
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		log.Printf("settings: probe decode failed (treating bool fields as present): %v", err)
		probe = nil
	}
	applyFieldDefaults(&s, probe)
	return s
}

// Save は settings を settings.json に atomic に書く。書く前に検証し既知の不正値を永続化しない。
func Save(s SettingsData) error {
	if err := Validate(&s); err != nil {
		return err
	}
	s.Version = SettingsSchemaVersion
	path, err := settingsFilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Validate は最初の不正 field エラーを返す。主に frontend からの Save 用 (Load 済みは補正済みで通る)。
func Validate(s *SettingsData) error {
	if _, ok := validLogLevels[s.LogLevel]; !ok {
		return errors.New("invalid logLevel: " + s.LogLevel)
	}
	if _, ok := validMultiSelectModes[s.MultiSelectMode]; !ok {
		return errors.New("invalid multiSelectMode: " + s.MultiSelectMode)
	}
	if _, ok := validWheelModes[s.WheelMode]; !ok {
		return errors.New("invalid wheelMode: " + s.WheelMode)
	}
	if s.MaxImagePixelsMP < 1 || s.MaxImagePixelsMP > maxMaxImagePixelsMP {
		return fmt.Errorf("maxImagePixelsMP out of range (1..%d)", maxMaxImagePixelsMP)
	}
	if s.ThumbnailSize < minThumbnailSize || s.ThumbnailSize > maxThumbnailSize {
		return fmt.Errorf("thumbnailSize out of range (%d..%d)",
			minThumbnailSize, maxThumbnailSize)
	}
	if _, ok := validThumbnailModes[s.ThumbnailMode]; !ok {
		return errors.New("invalid thumbnailMode: " + s.ThumbnailMode)
	}
	if s.ThumbnailWorkerCount < 0 || s.ThumbnailWorkerCount > MaxThumbnailWorkerCount {
		return fmt.Errorf("thumbnailWorkerCount out of range (0..%d)", MaxThumbnailWorkerCount)
	}
	if s.UIScalePercent < minUIScalePercent || s.UIScalePercent > maxUIScalePercent {
		return fmt.Errorf("uiScalePercent out of range (%d..%d)",
			minUIScalePercent, maxUIScalePercent)
	}
	if _, ok := validWatchModes[s.WatchMode]; !ok {
		return errors.New("invalid watchMode: " + s.WatchMode)
	}
	if _, ok := validDuplicateDetectModes[s.DuplicateDetectMode]; !ok {
		return errors.New("invalid duplicateDetectMode: " + s.DuplicateDetectMode)
	}
	if s.DuplicateThreshold < minDuplicateThreshold || s.DuplicateThreshold > maxDuplicateThreshold {
		return fmt.Errorf("duplicateThreshold out of range (%d..%d)",
			minDuplicateThreshold, maxDuplicateThreshold)
	}
	if s.MaxViewers < minMaxViewers || s.MaxViewers > MaxViewersHardCap {
		return fmt.Errorf("maxViewers out of range (%d..%d)", minMaxViewers, MaxViewersHardCap)
	}
	for k, v := range s.TagColors {
		if !isValidHexColor(v) {
			return fmt.Errorf("tagColors[%q] is not a valid #rrggbb color: %q", k, v)
		}
	}
	return nil
}

// applyFieldDefaults は許容集合に無い field を既定へ in-place patch する。probe は bool field の raw key
// 有無を運ぶ (nil なら全 bool を「あり」扱い、直接構築テスト用)。
func applyFieldDefaults(s *SettingsData, probe map[string]json.RawMessage) {
	if _, ok := validLogLevels[s.LogLevel]; !ok {
		s.LogLevel = "info"
	}
	if _, ok := validMultiSelectModes[s.MultiSelectMode]; !ok {
		s.MultiSelectMode = MultiSelectCheckbox
	}
	if _, ok := validWheelModes[s.WheelMode]; !ok {
		s.WheelMode = WheelModeZoom
	}
	if s.MaxImagePixelsMP < 1 || s.MaxImagePixelsMP > maxMaxImagePixelsMP {
		s.MaxImagePixelsMP = defaultMaxImagePixelsMP
	}
	if s.ThumbnailSize < minThumbnailSize || s.ThumbnailSize > maxThumbnailSize {
		s.ThumbnailSize = defaultThumbnailSize
	}
	if _, ok := validThumbnailModes[s.ThumbnailMode]; !ok {
		s.ThumbnailMode = ThumbnailModeLetterbox
	}
	if s.ThumbnailWorkerCount < 0 || s.ThumbnailWorkerCount > MaxThumbnailWorkerCount {
		s.ThumbnailWorkerCount = 0
	}
	if s.UIScalePercent < minUIScalePercent || s.UIScalePercent > maxUIScalePercent {
		s.UIScalePercent = defaultUIScalePercent
	}
	if _, ok := validWatchModes[s.WatchMode]; !ok {
		s.WatchMode = WatchModeAuto
	}
	if _, ok := validDuplicateDetectModes[s.DuplicateDetectMode]; !ok {
		s.DuplicateDetectMode = DuplicateDetectAuto
	}
	if s.DuplicateThreshold < minDuplicateThreshold || s.DuplicateThreshold > maxDuplicateThreshold {
		s.DuplicateThreshold = defaultDuplicateThreshold
	}
	if s.MaxViewers < minMaxViewers || s.MaxViewers > MaxViewersHardCap {
		s.MaxViewers = defaultMaxViewers
	}
	// nil (field 無し) は defaults を seed。明示的な空 {} は「override 無し」の保存値としてそのまま保持
	// (frontend が DEFAULT_PALETTE に fallback する)。
	if s.TagColors == nil {
		s.TagColors = cloneTagColors(defaultTagColors)
	} else {
		// 不正色の entry は落とし残りは保持 (Load の per-field-fallback 意図に沿う)。
		for k, v := range s.TagColors {
			if !isValidHexColor(v) {
				delete(s.TagColors, k)
			}
		}
	}
	// EditAutoSave: 欠落 (probe に key 無し) は既定 true 扱いにし #105 前 build の upgrade で silent に
	// manual 化しないように。明示 true/false は保持。JSON null は第 3 case — key は「あり」だが *bool 再 decode
	// で nil になるので欠落同様 true に倒す (他 field の「不正→default」と揃える)。
	if probe != nil {
		raw, present := probe["editAutoSave"]
		if !present {
			s.EditAutoSave = true
		} else {
			var bp *bool
			if err := json.Unmarshal(raw, &bp); err != nil || bp == nil {
				s.EditAutoSave = true
			}
		}
	}
	// DuplicateThreshold: 0 が正当値 (知覚的に同一のみ) なので、欠落 (#136 前 build の JSON) が
	// encoding/json のゼロ値 0 として silent に「最厳格」に化けないよう probe で区別する
	// (EditAutoSave と同じ理屈)。JSON null も欠落同様に既定へ倒す。
	if probe != nil {
		raw, present := probe["duplicateThreshold"]
		if !present {
			s.DuplicateThreshold = defaultDuplicateThreshold
		} else {
			var ip *int
			if err := json.Unmarshal(raw, &ip); err != nil || ip == nil {
				s.DuplicateThreshold = defaultDuplicateThreshold
			}
		}
	}
}

func cloneTagColors(src map[string]string) map[string]string {
	out := make(map[string]string, len(src))
	maps.Copy(out, src)
	return out
}

// isValidHexColor は "#rrggbb" (大小 hex) を受ける。短縮 "#rgb" は意図的に拒否: frontend の
// readableTextColor は 7 文字形のみ扱うので、"#rgb" を許すと silent に壊れる。
func isValidHexColor(s string) bool {
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for _, c := range strings.ToLower(s[1:]) {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
