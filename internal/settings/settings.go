// Package settings persists user-configurable preferences (as opposed to the
// transient session state in `internal/state`). Stored at
// `<UserConfigDir>/image-observer/settings.json`. Frontend reads the live
// values via Wails bindings (`GetSettings` / `UpdateSettings`).
//
// Schema v1 starts intentionally small (LogLevel, MultiSelectMode). Future
// fields (theme, max_pixels, known tag palette, key bindings, …) are added
// as Phase H sub-stages move them out of hardcoded constants.
//
// On load, unknown / invalid values fall back to the field default rather
// than the entire file — this keeps a single bad value from blowing away
// the user's other preferences. Schema version mismatch DOES fall back to
// the full default (same posture as `internal/state`).
package settings

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
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

// Allowed values for SettingsData.LogLevel.
var validLogLevels = map[string]struct{}{
	"debug": {}, "info": {}, "warn": {}, "error": {},
}

var validMultiSelectModes = map[string]struct{}{
	MultiSelectCheckbox: {},
	MultiSelectModifier: {},
	MultiSelectBoth:     {},
}

// SettingsData is the persisted (and Wails-exposed) shape. Add new fields
// here with sane defaults in `DefaultSettings`. Fields are JSON-serialized
// in camelCase so the frontend can use them without renaming.
type SettingsData struct {
	Version         int    `json:"version"`
	LogLevel        string `json:"logLevel"`
	MultiSelectMode string `json:"multiSelectMode"`
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
		Version:         SettingsSchemaVersion,
		LogLevel:        "info",
		MultiSelectMode: MultiSelectCheckbox,
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
	applyFieldDefaults(&s)
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
	return nil
}

// applyFieldDefaults patches each field's value to its default if the
// loaded value isn't in the allowed set. Mutates in place.
func applyFieldDefaults(s *SettingsData) {
	if _, ok := validLogLevels[s.LogLevel]; !ok {
		s.LogLevel = "info"
	}
	if _, ok := validMultiSelectModes[s.MultiSelectMode]; !ok {
		s.MultiSelectMode = MultiSelectCheckbox
	}
}
