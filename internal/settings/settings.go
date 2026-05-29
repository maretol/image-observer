// Package settings persists user-configurable preferences (as opposed to the
// transient session state in `internal/state`). Stored at
// `<UserConfigDir>/image-observer/settings.json`. Frontend reads the live
// values via Wails bindings (`GetSettings` / `UpdateSettings`).
//
// Schema v1 starts intentionally small (LogLevel, MultiSelectMode). Future
// fields (theme, key bindings, …) are added here additively with per-field
// fallback so the schema version need not bump for cosmetic additions.
//
// On load, unknown / invalid values fall back to the field default rather
// than the entire file — this keeps a single bad value from blowing away
// the user's other preferences. Schema version mismatch DOES fall back to
// the full default (same posture as `internal/state`).
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

// SettingsSchemaVersion is bumped when the JSON shape changes incompatibly.
// Older versions fall back to defaults (no migration in v1).
const SettingsSchemaVersion = 1

// Allowed values for SettingsData.MultiSelectMode.
const (
	MultiSelectCheckbox = "checkbox" // case A only (Phase 4 v1.4 default)
	MultiSelectModifier = "modifier" // case B: Ctrl/Shift+click only
	MultiSelectBoth     = "both"     // both modes wired up
)

// Allowed values for SettingsData.WheelMode.
const (
	WheelModeZoom      = "zoom"       // default: wheel zooms (current behavior)
	WheelModeShiftZoom = "shift-zoom" // wheel pans, Shift+wheel zooms
)

// Allowed values for SettingsData.ThumbnailMode.
const (
	ThumbnailModeLetterbox = "letterbox"
	ThumbnailModeCrop      = "crop"
)

// Allowed values for SettingsData.WatchMode.
const (
	WatchModeAuto = "auto" // default: start fsnotify watcher when a folder opens
	WatchModeOff  = "off"  // never start the watcher; user reloads manually
)

// Defaults / bounds for the numeric fields. Bounds are intentionally generous
// — the goal is to catch garbage (negative / absurdly huge) without preventing
// legitimate tuning.
//
// MaxThumbnailWorkerCount is exported so internal/thumb can keep its auto
// (NumCPU/2) branch capped at the same ceiling — without that pairing, auto
// could spawn more workers than any explicit user setting on a large host.
const (
	defaultMaxImagePixelsMP = 200 // 200 MP ~ a 14000×14000 px image
	maxMaxImagePixelsMP     = 4000
	defaultThumbnailSize    = 256
	minThumbnailSize        = 32
	maxThumbnailSize        = 1024
	MaxThumbnailWorkerCount = 64
	// UIScale is stored as an integer percent applied via CSS `zoom` on the
	// app root. Bounds are intentionally generous; the UI picker only exposes
	// the 4 standard tiers but power users can set anything in this range via
	// settings.json.
	defaultUIScalePercent = 100
	minUIScalePercent     = 75
	maxUIScalePercent     = 150
)

// Allowed values for SettingsData.LogLevel.
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

// defaultTagColors is the seed palette used when settings.json has no
// `tagColors` field. The frontend ships an identical literal so that
// uninstalled / clean-config users see consistent badge colors before
// touching settings. Lowercase hex with leading "#".
//
// Unexported because Go maps are reference types — exporting would let any
// importer mutate the seed palette at runtime and silently corrupt every
// future DefaultSettings() call. Same-package callers (DefaultSettings /
// applyFieldDefaults) clone via cloneTagColors before exposing.
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

// SettingsData is the persisted (and Wails-exposed) shape. Add new fields
// here with sane defaults in `DefaultSettings`. Fields are JSON-serialized
// in camelCase so the frontend can use them without renaming.
//
// New fields (kept on schema v1 via per-field fallback):
//   - MaxImagePixelsMP: pre-flight pixel-count limit for the viewer (in MP)
//   - ThumbnailSize / ThumbnailMode: defaults for thumbnail generation
//   - ThumbnailWorkerCount: 0 = auto (NumCPU/2), positive = explicit cap;
//     restart-required (the worker pool is initialized once at startup)
//   - TagColors: tag-name → CSS color override for the classification badges
//   - UIScalePercent: global UI scale as an integer percent (100 = native)
//   - WatchMode: "auto" | "off" — drives the fsnotify auto-merge in the
//     classification tab (see docs/spec-folder-watch.md)
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
	// EditAutoSave drives the SampleEditPane save mode (#105).
	// true (default) → save on individual input blur / radio change.
	// false           → manual save only (button / Cmd+Ctrl+Enter), the
	//                   pre-#105 behavior.
	// Field absence in the JSON (upgrading from a build before #105) is
	// distinguished from an explicit `false` via the probe in `Load` — see
	// the comment near the probe call below.
	EditAutoSave bool `json:"editAutoSave"`
}

// settingsFilePathOverride lets tests redirect away from the user config dir.
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

// DefaultSettings returns the in-memory defaults. Callers (main.go, tests,
// the "reset to defaults" UI button) construct fresh settings from here.
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
	}
}

// Load returns the persisted settings, falling back to DefaultSettings on a
// missing file, parse error, or schema version mismatch. Individual invalid
// field values are reset to their default but other fields are preserved.
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
	// Distinguish "field absent in JSON" from an explicit `false` for bool
	// fields. Go's encoding/json fills missing bools with the zero value
	// (`false`), which for EditAutoSave (#105 default = true) would mean
	// "upgrading from a pre-#105 build silently switches the user into manual
	// mode". The cheap fix is to decode the same blob a second time into a
	// raw map and check key presence; the perf cost (~kB file) is negligible
	// vs the UX bug of a silent default flip.
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		log.Printf("settings: probe decode failed (treating bool fields as present): %v", err)
		probe = nil
	}
	applyFieldDefaults(&s, probe)
	return s
}

// Save atomically writes the given settings to settings.json. Validates
// before writing so we never persist a known-bad value.
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

// Validate returns the first invalid-field error encountered. Settings
// passed through `Load` are already field-default-corrected so they're
// expected to validate; this is mainly for `Save` from the frontend.
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
	for k, v := range s.TagColors {
		if !isValidHexColor(v) {
			return fmt.Errorf("tagColors[%q] is not a valid #rrggbb color: %q", k, v)
		}
	}
	return nil
}

// applyFieldDefaults patches each field's value to its default if the
// loaded value isn't in the allowed set. Mutates in place.
//
// `probe` carries the raw key presence for bool fields whose zero value is
// indistinguishable from an explicit false. Pass nil to treat all bool
// fields as present (e.g. during direct construction tests where Load's
// probe is not available).
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
	// nil (field absent in JSON, e.g. upgrading from a build before this
	// field existed) seeds the defaults so the user starts with badge colors.
	// An explicit empty `{}` is preserved verbatim — that is the user's stored
	// "I want no overrides" value, and the frontend's setKnownTagColors falls
	// back to its own DEFAULT_PALETTE for the live render either way.
	if s.TagColors == nil {
		s.TagColors = cloneTagColors(defaultTagColors)
	} else {
		// Drop entries with malformed colors but preserve the rest. This
		// matches the per-field-fallback intent of the rest of Load.
		for k, v := range s.TagColors {
			if !isValidHexColor(v) {
				delete(s.TagColors, k)
			}
		}
	}
	// EditAutoSave: bool zero value (`false`) is indistinguishable from "field
	// missing in JSON" without a probe. Treat missing as the default (true) so
	// users upgrading from a pre-#105 build don't silently land in manual mode.
	// Explicit `false` (key present, value false) is preserved.
	//
	// JSON `null` is a third case: encoding/json leaves a bool field at its
	// zero value when the source is null, AND the key is "present" in the
	// raw probe map. Without the *bool re-decode below, a corrupted
	// `editAutoSave: null` would silently land in manual mode (false) —
	// which is the opposite of the "invalid field → field default" rule the
	// other per-field branches follow. Treat null like missing (fall back
	// to true), keep true / false as decoded (PR #109 round 4 #8).
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
}

func cloneTagColors(src map[string]string) map[string]string {
	out := make(map[string]string, len(src))
	maps.Copy(out, src)
	return out
}

// isValidHexColor accepts "#rrggbb" with lowercase or uppercase hex digits.
// Shorthand "#rgb" is intentionally rejected: the frontend's readableTextColor
// helper only handles 7-char form, so allowing "#rgb" would silently break it.
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
