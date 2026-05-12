package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func setSettingsFile(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config", "settings.json")
	settingsFilePathOverride = p
	t.Cleanup(func() { settingsFilePathOverride = "" })
	return p
}

func TestLoad_Missing_ReturnsDefaults(t *testing.T) {
	setSettingsFile(t)
	s := Load()
	if s.Version != SettingsSchemaVersion {
		t.Errorf("version: got %d, want %d", s.Version, SettingsSchemaVersion)
	}
	if s.LogLevel != "info" {
		t.Errorf("LogLevel default: got %q, want info", s.LogLevel)
	}
	if s.MultiSelectMode != MultiSelectCheckbox {
		t.Errorf("MultiSelectMode default: got %q, want checkbox", s.MultiSelectMode)
	}
	if s.WheelMode != WheelModeZoom {
		t.Errorf("WheelMode default: got %q, want zoom", s.WheelMode)
	}
	if s.MaxImagePixelsMP != defaultMaxImagePixelsMP {
		t.Errorf("MaxImagePixelsMP default: got %d, want %d", s.MaxImagePixelsMP, defaultMaxImagePixelsMP)
	}
	if s.ThumbnailSize != defaultThumbnailSize {
		t.Errorf("ThumbnailSize default: got %d, want %d", s.ThumbnailSize, defaultThumbnailSize)
	}
	if s.ThumbnailMode != ThumbnailModeLetterbox {
		t.Errorf("ThumbnailMode default: got %q, want letterbox", s.ThumbnailMode)
	}
	if s.ThumbnailWorkerCount != 0 {
		t.Errorf("ThumbnailWorkerCount default: got %d, want 0 (auto)", s.ThumbnailWorkerCount)
	}
	if len(s.TagColors) == 0 {
		t.Errorf("TagColors default should be a non-empty map (defaultTagColors)")
	}
	for k, v := range defaultTagColors {
		if s.TagColors[k] != v {
			t.Errorf("TagColors[%q] = %q, want %q", k, s.TagColors[k], v)
		}
	}
}

func TestSaveLoad_RoundTrip(t *testing.T) {
	setSettingsFile(t)
	in := DefaultSettings()
	in.LogLevel = "debug"
	in.MultiSelectMode = MultiSelectBoth
	in.WheelMode = WheelModeShiftZoom
	in.MaxImagePixelsMP = 500
	in.ThumbnailSize = 384
	in.ThumbnailMode = ThumbnailModeCrop
	in.ThumbnailWorkerCount = 4
	in.TagColors = map[string]string{"alpha": "#abcdef", "beta": "#000000"}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if out.LogLevel != "debug" {
		t.Errorf("LogLevel: got %q", out.LogLevel)
	}
	if out.MultiSelectMode != MultiSelectBoth {
		t.Errorf("MultiSelectMode: got %q", out.MultiSelectMode)
	}
	if out.WheelMode != WheelModeShiftZoom {
		t.Errorf("WheelMode: got %q", out.WheelMode)
	}
	if out.MaxImagePixelsMP != 500 {
		t.Errorf("MaxImagePixelsMP: got %d", out.MaxImagePixelsMP)
	}
	if out.ThumbnailSize != 384 {
		t.Errorf("ThumbnailSize: got %d", out.ThumbnailSize)
	}
	if out.ThumbnailMode != ThumbnailModeCrop {
		t.Errorf("ThumbnailMode: got %q", out.ThumbnailMode)
	}
	if out.ThumbnailWorkerCount != 4 {
		t.Errorf("ThumbnailWorkerCount: got %d", out.ThumbnailWorkerCount)
	}
	if out.TagColors["alpha"] != "#abcdef" || out.TagColors["beta"] != "#000000" {
		t.Errorf("TagColors round-trip: %v", out.TagColors)
	}
}

func TestSave_RejectsInvalid(t *testing.T) {
	setSettingsFile(t)
	bad := DefaultSettings()
	bad.LogLevel = "trace"
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject invalid LogLevel")
	}
	bad = DefaultSettings()
	bad.MultiSelectMode = "lasso"
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject invalid MultiSelectMode")
	}
	bad = DefaultSettings()
	bad.WheelMode = "spin"
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject invalid WheelMode")
	}
	bad = DefaultSettings()
	bad.MaxImagePixelsMP = 0
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject MaxImagePixelsMP = 0")
	}
	bad = DefaultSettings()
	bad.MaxImagePixelsMP = maxMaxImagePixelsMP + 1
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject MaxImagePixelsMP above max")
	}
	bad = DefaultSettings()
	bad.ThumbnailSize = minThumbnailSize - 1
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject ThumbnailSize below min")
	}
	bad = DefaultSettings()
	bad.ThumbnailMode = "wat"
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject invalid ThumbnailMode")
	}
	bad = DefaultSettings()
	bad.ThumbnailWorkerCount = -1
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject negative ThumbnailWorkerCount")
	}
	bad = DefaultSettings()
	bad.TagColors = map[string]string{"x": "not-a-color"}
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject malformed tag color")
	}
}

func TestSave_StampsVersion(t *testing.T) {
	setSettingsFile(t)
	in := DefaultSettings()
	in.Version = 99
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if out.Version != SettingsSchemaVersion {
		t.Errorf("Save should stamp the current schema version, got %d", out.Version)
	}
}

func TestLoad_VersionMismatch_FallsBackToDefaults(t *testing.T) {
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(`{"version":99,"logLevel":"debug","multiSelectMode":"both","wheelMode":"shift-zoom"}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.LogLevel != "info" || s.MultiSelectMode != MultiSelectCheckbox || s.WheelMode != WheelModeZoom {
		t.Errorf("expected defaults on version mismatch, got %+v", s)
	}
	if s.MaxImagePixelsMP != defaultMaxImagePixelsMP {
		t.Errorf("expected default MaxImagePixelsMP on version mismatch, got %d", s.MaxImagePixelsMP)
	}
}

func TestLoad_CorruptJSON_FallsBackToDefaults(t *testing.T) {
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte("{not valid"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.LogLevel != "info" {
		t.Errorf("expected defaults, got %+v", s)
	}
}

func TestLoad_PerFieldFallbackKeepsValidFields(t *testing.T) {
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad, _ := json.Marshal(map[string]any{
		"version":              SettingsSchemaVersion,
		"logLevel":             "garbage",
		"multiSelectMode":      MultiSelectModifier,    // valid
		"wheelMode":            WheelModeShiftZoom,     // valid
		"maxImagePixelsMP":     -5,                     // invalid
		"thumbnailSize":        320,                    // valid
		"thumbnailMode":        "stretch",              // invalid
		"thumbnailWorkerCount": 8,                      // valid
		"tagColors":            map[string]string{"keep": "#abc123", "drop": "garbage"},
	})
	if err := os.WriteFile(p, bad, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.LogLevel != "info" {
		t.Errorf("invalid logLevel should fall back, got %q", s.LogLevel)
	}
	if s.MultiSelectMode != MultiSelectModifier {
		t.Errorf("valid multiSelectMode should be preserved, got %q", s.MultiSelectMode)
	}
	if s.WheelMode != WheelModeShiftZoom {
		t.Errorf("valid wheelMode should be preserved, got %q", s.WheelMode)
	}
	if s.MaxImagePixelsMP != defaultMaxImagePixelsMP {
		t.Errorf("invalid MaxImagePixelsMP should fall back, got %d", s.MaxImagePixelsMP)
	}
	if s.ThumbnailSize != 320 {
		t.Errorf("valid ThumbnailSize should be preserved, got %d", s.ThumbnailSize)
	}
	if s.ThumbnailMode != ThumbnailModeLetterbox {
		t.Errorf("invalid ThumbnailMode should fall back, got %q", s.ThumbnailMode)
	}
	if s.ThumbnailWorkerCount != 8 {
		t.Errorf("valid ThumbnailWorkerCount should be preserved, got %d", s.ThumbnailWorkerCount)
	}
	if s.TagColors["keep"] != "#abc123" {
		t.Errorf("valid tag color should be preserved, got %v", s.TagColors)
	}
	if _, exists := s.TagColors["drop"]; exists {
		t.Errorf("malformed tag color should be dropped, got %v", s.TagColors)
	}
}

func TestLoad_NewFieldsMissing_GetDefaults(t *testing.T) {
	// Simulates upgrading from "settings.json with only the v1-original fields"
	// to a build that knows about the new fields. Per-field fallback should
	// fill in defaults without losing the existing valid values.
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	old, _ := json.Marshal(map[string]any{
		"version":         SettingsSchemaVersion,
		"logLevel":        "warn",
		"multiSelectMode": MultiSelectModifier,
		"wheelMode":       WheelModeShiftZoom,
	})
	if err := os.WriteFile(p, old, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.LogLevel != "warn" || s.MultiSelectMode != MultiSelectModifier || s.WheelMode != WheelModeShiftZoom {
		t.Errorf("existing valid fields should be preserved: %+v", s)
	}
	if s.MaxImagePixelsMP != defaultMaxImagePixelsMP {
		t.Errorf("missing MaxImagePixelsMP should default, got %d", s.MaxImagePixelsMP)
	}
	if s.ThumbnailSize != defaultThumbnailSize {
		t.Errorf("missing ThumbnailSize should default, got %d", s.ThumbnailSize)
	}
	if s.ThumbnailMode != ThumbnailModeLetterbox {
		t.Errorf("missing ThumbnailMode should default, got %q", s.ThumbnailMode)
	}
	if len(s.TagColors) == 0 {
		t.Errorf("missing TagColors should default to defaultTagColors")
	}
}

func TestSave_AtomicNoLingerTmp(t *testing.T) {
	p := setSettingsFile(t)
	if err := Save(DefaultSettings()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(p + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp file should not linger after success")
	}
	if _, err := os.Stat(p); err != nil {
		t.Errorf("settings file should exist, %v", err)
	}
}

func TestValidate_Direct(t *testing.T) {
	good := DefaultSettings()
	if err := Validate(&good); err != nil {
		t.Errorf("default settings should validate, got %v", err)
	}
	bad := DefaultSettings()
	bad.LogLevel = ""
	if err := Validate(&bad); err == nil {
		t.Errorf("empty logLevel should be invalid")
	}
}

func TestIsValidHexColor(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"#000000", true},
		{"#ffffff", true},
		{"#FFFFFF", true},
		{"#abc123", true},
		{"#ABC", false},     // shorthand rejected (frontend readableTextColor only handles 7-char)
		{"abc", false},      // missing #
		{"#zzzzzz", false},  // non-hex
		{"#1234567", false}, // too long
		{"", false},
	}
	for _, c := range cases {
		if got := isValidHexColor(c.in); got != c.want {
			t.Errorf("isValidHexColor(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
