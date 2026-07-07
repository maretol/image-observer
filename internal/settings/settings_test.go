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
	if s.UIScalePercent != defaultUIScalePercent {
		t.Errorf("UIScalePercent default: got %d, want %d", s.UIScalePercent, defaultUIScalePercent)
	}
	if s.WatchMode != WatchModeAuto {
		t.Errorf("WatchMode default: got %q, want %q", s.WatchMode, WatchModeAuto)
	}
	if !s.EditAutoSave {
		t.Errorf("EditAutoSave default: got %v, want true", s.EditAutoSave)
	}
	if s.DuplicateDetectMode != DuplicateDetectAuto {
		t.Errorf("DuplicateDetectMode default: got %q, want %q", s.DuplicateDetectMode, DuplicateDetectAuto)
	}
	if s.DuplicateThreshold != defaultDuplicateThreshold {
		t.Errorf("DuplicateThreshold default: got %d, want %d", s.DuplicateThreshold, defaultDuplicateThreshold)
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
	in.UIScalePercent = 125
	in.WatchMode = WatchModeOff
	in.EditAutoSave = false
	in.DuplicateDetectMode = DuplicateDetectOff
	in.DuplicateThreshold = 0
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
	if out.UIScalePercent != 125 {
		t.Errorf("UIScalePercent: got %d", out.UIScalePercent)
	}
	if out.WatchMode != WatchModeOff {
		t.Errorf("WatchMode: got %q", out.WatchMode)
	}
	if out.EditAutoSave != false {
		t.Errorf("EditAutoSave: got %v, want false (round-trip preserves explicit false)", out.EditAutoSave)
	}
	if out.DuplicateDetectMode != DuplicateDetectOff {
		t.Errorf("DuplicateDetectMode: got %q", out.DuplicateDetectMode)
	}
	if out.DuplicateThreshold != 0 {
		t.Errorf("DuplicateThreshold: got %d, want 0 (round-trip preserves explicit zero)", out.DuplicateThreshold)
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
	bad = DefaultSettings()
	bad.UIScalePercent = minUIScalePercent - 1
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject UIScalePercent below min")
	}
	bad = DefaultSettings()
	bad.UIScalePercent = maxUIScalePercent + 1
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject UIScalePercent above max")
	}
	bad = DefaultSettings()
	bad.WatchMode = "polling"
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject invalid WatchMode")
	}
	bad = DefaultSettings()
	bad.DuplicateDetectMode = "sometimes"
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject invalid DuplicateDetectMode")
	}
	bad = DefaultSettings()
	bad.DuplicateThreshold = minDuplicateThreshold - 1
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject DuplicateThreshold below min")
	}
	bad = DefaultSettings()
	bad.DuplicateThreshold = maxDuplicateThreshold + 1
	if err := Save(bad); err == nil {
		t.Errorf("Save should reject DuplicateThreshold above max")
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
		"multiSelectMode":      MultiSelectModifier, // valid
		"wheelMode":            WheelModeShiftZoom,  // valid
		"maxImagePixelsMP":     -5,                  // invalid
		"thumbnailSize":        320,                 // valid
		"thumbnailMode":        "stretch",           // invalid
		"thumbnailWorkerCount": 8,                   // valid
		"tagColors":            map[string]string{"keep": "#abc123", "drop": "garbage"},
		"uiScalePercent":       9999,        // out of range — should fall back
		"watchMode":            "polling",   // invalid → fall back
		"duplicateDetectMode":  "sometimes", // invalid → fall back
		"duplicateThreshold":   99,          // out of range → fall back
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
	if s.UIScalePercent != defaultUIScalePercent {
		t.Errorf("out-of-range UIScalePercent should fall back, got %d", s.UIScalePercent)
	}
	if s.WatchMode != WatchModeAuto {
		t.Errorf("invalid WatchMode should fall back, got %q", s.WatchMode)
	}
	if s.DuplicateDetectMode != DuplicateDetectAuto {
		t.Errorf("invalid DuplicateDetectMode should fall back, got %q", s.DuplicateDetectMode)
	}
	if s.DuplicateThreshold != defaultDuplicateThreshold {
		t.Errorf("out-of-range DuplicateThreshold should fall back, got %d", s.DuplicateThreshold)
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
	if s.UIScalePercent != defaultUIScalePercent {
		t.Errorf("missing UIScalePercent should default, got %d", s.UIScalePercent)
	}
	if s.WatchMode != WatchModeAuto {
		t.Errorf("missing WatchMode should default, got %q", s.WatchMode)
	}
	if !s.EditAutoSave {
		t.Errorf("missing EditAutoSave should default to true (not Go bool zero), got %v", s.EditAutoSave)
	}
	if s.DuplicateDetectMode != DuplicateDetectAuto {
		t.Errorf("missing DuplicateDetectMode should default, got %q", s.DuplicateDetectMode)
	}
	if s.DuplicateThreshold != defaultDuplicateThreshold {
		t.Errorf("missing DuplicateThreshold should default to %d (not Go int zero), got %d",
			defaultDuplicateThreshold, s.DuplicateThreshold)
	}
}

// TestLoad_EditAutoSave_ExplicitFalse_Preserved pins the probe-based key
// presence check in applyFieldDefaults. Without the probe, an explicit
// `"editAutoSave": false` would be indistinguishable from "field missing"
// and snap back to the default `true` — silently overriding a user who
// chose manual mode.
func TestLoad_EditAutoSave_ExplicitFalse_Preserved(t *testing.T) {
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	body, _ := json.Marshal(map[string]any{
		"version":      SettingsSchemaVersion,
		"editAutoSave": false,
	})
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.EditAutoSave != false {
		t.Errorf("explicit false should be preserved (probe path), got %v", s.EditAutoSave)
	}
}

// TestLoad_EditAutoSave_NullValue_DefaultsToTrue covers the third probe case
// (PR #109 round 4 #8): JSON `null` leaves a bool field at the zero value
// during the initial Unmarshal, AND the key is present in the raw probe
// map. Without the *bool re-decode in applyFieldDefaults, a corrupted
// `editAutoSave: null` would silently land in manual mode (false) — the
// opposite of the "invalid field → field default" rule the other per-field
// branches enforce.
func TestLoad_EditAutoSave_NullValue_DefaultsToTrue(t *testing.T) {
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	body := []byte(`{"version":1,"editAutoSave":null}`)
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if !s.EditAutoSave {
		t.Errorf("JSON null should fall back to default (true), got %v", s.EditAutoSave)
	}
}

// TestLoad_DuplicateThreshold_ExplicitZero_Preserved pins the probe-based key
// presence check for the int field (EditAutoSave と同じ理屈, #136)。probe が無いと
// 明示的な `"duplicateThreshold": 0` (知覚的に同一のみ) と「欠落」が区別できず、
// 既定 5 に巻き戻ってユーザーの厳格設定を silent に上書きする。
func TestLoad_DuplicateThreshold_ExplicitZero_Preserved(t *testing.T) {
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	body, _ := json.Marshal(map[string]any{
		"version":            SettingsSchemaVersion,
		"duplicateThreshold": 0,
	})
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.DuplicateThreshold != 0 {
		t.Errorf("explicit zero should be preserved (probe path), got %d", s.DuplicateThreshold)
	}
}

// TestLoad_DuplicateThreshold_NullValue_DefaultsTo5 covers the third probe case
// (EditAutoSave の JSON null と同型): key はあるが null → *int 再 decode で nil →
// 「不正値 → field default」規則に合わせて既定へ倒す。
func TestLoad_DuplicateThreshold_NullValue_DefaultsTo5(t *testing.T) {
	p := setSettingsFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	body := []byte(`{"version":1,"duplicateThreshold":null}`)
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.DuplicateThreshold != defaultDuplicateThreshold {
		t.Errorf("JSON null should fall back to default (%d), got %d",
			defaultDuplicateThreshold, s.DuplicateThreshold)
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

// TestWatchModeValues pins the literal strings of WatchModeAuto / WatchModeOff.
// AGENTS.md D-1: the TS side ships the same literals in
// `frontend/src/features/settings/watchMode.ts` (locked there by
// `watchMode.test.ts`). Renaming one side without the other lets the settings
// UI persist a value that Validate then rejects, silently snapping the user's
// choice back to the default.
func TestWatchModeValues(t *testing.T) {
	if WatchModeAuto != "auto" {
		t.Errorf("WatchModeAuto = %q, want %q (TS side pins the same literal)", WatchModeAuto, "auto")
	}
	if WatchModeOff != "off" {
		t.Errorf("WatchModeOff = %q, want %q (TS side pins the same literal)", WatchModeOff, "off")
	}
}

// TestDuplicateDetectValues pins the DuplicateDetect* literals and the default
// threshold. AGENTS.md D-1: TS 側は
// `frontend/src/features/settings/duplicateDetect.ts` が同じリテラルを持ち
// `duplicateDetect.test.ts` で pin する (watchMode と同じ流儀, #136)。
func TestDuplicateDetectValues(t *testing.T) {
	if DuplicateDetectAuto != "auto" {
		t.Errorf("DuplicateDetectAuto = %q, want %q (TS side pins the same literal)", DuplicateDetectAuto, "auto")
	}
	if DuplicateDetectOff != "off" {
		t.Errorf("DuplicateDetectOff = %q, want %q (TS side pins the same literal)", DuplicateDetectOff, "off")
	}
	if defaultDuplicateThreshold != 5 {
		t.Errorf("defaultDuplicateThreshold = %d, want 5 (TS side pins the same value)", defaultDuplicateThreshold)
	}
	if minDuplicateThreshold != 0 || maxDuplicateThreshold != 16 {
		t.Errorf("threshold bounds = %d..%d, want 0..16 (TS side pins the same values)",
			minDuplicateThreshold, maxDuplicateThreshold)
	}
}
