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
}

func TestSaveLoad_RoundTrip(t *testing.T) {
	setSettingsFile(t)
	in := DefaultSettings()
	in.LogLevel = "debug"
	in.MultiSelectMode = MultiSelectBoth
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
	if err := os.WriteFile(p, []byte(`{"version":99,"logLevel":"debug","multiSelectMode":"both"}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.LogLevel != "info" || s.MultiSelectMode != MultiSelectCheckbox {
		t.Errorf("expected defaults on version mismatch, got %+v", s)
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
		"version":         SettingsSchemaVersion,
		"logLevel":        "garbage",
		"multiSelectMode": MultiSelectModifier, // valid
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
