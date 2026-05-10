package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func setStateFile(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config", "state.json")
	stateFilePathOverride = p
	t.Cleanup(func() { stateFilePathOverride = "" })
	return p
}

func TestLoadState_Missing_ReturnsDefaults(t *testing.T) {
	setStateFile(t)
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Errorf("version: got %d, want %d", s.Version, StateSchemaVersion)
	}
	if s.LeftPaneWidth != 280 {
		t.Errorf("leftPaneWidth: got %d", s.LeftPaneWidth)
	}
	if s.Grid.Rows != 1 || s.Grid.Cols != 1 {
		t.Errorf("grid: got %dx%d, want 1x1", s.Grid.Rows, s.Grid.Cols)
	}
	if len(s.Grid.Panels) != 1 {
		t.Errorf("panels count: got %d, want 1", len(s.Grid.Panels))
	}
}

func TestSaveLoadState_RoundTrip(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.RootPath = "/some/path"
	in.LeftPaneWidth = 350
	in.Window = WindowState{Width: 1600, Height: 900, X: 100, Y: 50}
	in.Grid.Rows = 2
	in.Grid.Cols = 2
	in.Grid.RowSizes = []float64{0.4, 0.6}
	in.Grid.ColSizes = []float64{0.5, 0.5}
	in.Grid.Active = PanelCoordSt{Row: 1, Col: 0}
	in.Grid.Panels = []PanelState{
		{Tabs: []TabState{{Path: "/a.jpg", Zoom: 1.5, PanX: 10, PanY: 20}}, ActiveIndex: 0},
		{Tabs: []TabState{}, ActiveIndex: -1},
		{Tabs: []TabState{{Path: "/b.png", Zoom: 0.5, PanX: -5, PanY: -3}}, ActiveIndex: 0},
		{Tabs: []TabState{}, ActiveIndex: -1},
	}

	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if out.RootPath != in.RootPath {
		t.Errorf("RootPath mismatch")
	}
	if out.LeftPaneWidth != 350 {
		t.Errorf("LeftPaneWidth mismatch")
	}
	if out.Window.Width != 1600 || out.Window.Height != 900 {
		t.Errorf("Window size mismatch")
	}
	if out.Grid.Active.Row != 1 || out.Grid.Active.Col != 0 {
		t.Errorf("Active mismatch")
	}
	if len(out.Grid.Panels[0].Tabs) != 1 || out.Grid.Panels[0].Tabs[0].Zoom != 1.5 {
		t.Errorf("Tab data mismatch: %+v", out.Grid.Panels[0])
	}
}

func TestLoadState_CorruptJSON_FallsBackToDefault(t *testing.T) {
	p := setStateFile(t)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(p, []byte("{not valid json"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion || s.LeftPaneWidth != 280 {
		t.Errorf("expected defaults on corrupt JSON, got %+v", s)
	}
}

func TestLoadState_VersionMismatch_FallsBackToDefault(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(`{"version":999}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion || s.LeftPaneWidth != 280 {
		t.Errorf("expected defaults on version mismatch, got %+v", s)
	}
}

func TestSaveState_AtomicNoLingerTmp(t *testing.T) {
	p := setStateFile(t)
	if err := Save(DefaultData()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	tmp := p + ".tmp"
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("tmp file should not exist after success, stat err=%v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Errorf("final file should exist, stat err=%v", err)
	}
}

func TestValidateState_PanelCountMismatch(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Grid.Rows = 2
	bad.Grid.Cols = 2
	// Leave panels at length 1 (default)
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	// Should fall back to default 1x1 because panels count doesn't match rows*cols.
	if s.Grid.Rows != 1 || s.Grid.Cols != 1 {
		t.Errorf("expected default 1x1 fallback, got %dx%d", s.Grid.Rows, s.Grid.Cols)
	}
}

func TestValidateState_ClampActiveOutOfRange(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Grid.Active = PanelCoordSt{Row: 5, Col: 5}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.Grid.Active.Row != 0 || s.Grid.Active.Col != 0 {
		t.Errorf("expected active clamped to (0,0), got (%d,%d)", s.Grid.Active.Row, s.Grid.Active.Col)
	}
}

func TestValidateState_ClampPanelActiveIndex(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Grid.Panels = []PanelState{
		{Tabs: []TabState{{Path: "/a", Zoom: 1, PanX: 0, PanY: 0}}, ActiveIndex: 99},
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.Grid.Panels[0].ActiveIndex != 0 {
		t.Errorf("expected activeIndex clamped to 0, got %d", s.Grid.Panels[0].ActiveIndex)
	}
}

func TestValidateState_ResetTinyZoom(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Grid.Panels = []PanelState{
		{Tabs: []TabState{{Path: "/a", Zoom: 0.001, PanX: 9999, PanY: 9999}}, ActiveIndex: 0},
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.Grid.Panels[0].Tabs[0].Zoom != 1.0 {
		t.Errorf("tiny zoom should be reset to 1.0, got %v", s.Grid.Panels[0].Tabs[0].Zoom)
	}
}

func TestLoadState_V1FallsBackToDefault(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	// v1 schema (no topTab/list, version=1)
	if err := os.WriteFile(p, []byte(`{"version":1,"rootPath":"/old","leftPaneWidth":300}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Errorf("expected schema v%d, got %d", StateSchemaVersion, s.Version)
	}
	if s.TopTab != "list" {
		t.Errorf("default TopTab = %q, want list", s.TopTab)
	}
	if s.RootPath != "" {
		t.Errorf("v1 rootPath should not survive fallback, got %q", s.RootPath)
	}
}

func TestDefaultData_V2Fields(t *testing.T) {
	d := DefaultData()
	if d.Version != 2 {
		t.Errorf("Version = %d, want 2", d.Version)
	}
	if d.TopTab != "list" {
		t.Errorf("TopTab = %q, want list", d.TopTab)
	}
	if d.List.Filter.Confidence != "all" {
		t.Errorf("default Confidence = %q, want all", d.List.Filter.Confidence)
	}
	if d.List.Filter.Tags == nil {
		t.Errorf("default Tags must be non-nil empty slice")
	}
}

func TestValidateState_TopTabClamped(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.TopTab = "bogus"
	bad.List.Filter.Confidence = "weird"
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.TopTab != "list" {
		t.Errorf("TopTab not clamped, got %q", s.TopTab)
	}
	if s.List.Filter.Confidence != "all" {
		t.Errorf("Confidence not clamped, got %q", s.List.Filter.Confidence)
	}
}

func TestSaveLoadState_V2RoundTrip(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.TopTab = "viewer"
	in.List.FolderPath = "/img/folder"
	in.List.Filter = ListFilterState{
		Tags:       []string{"iroha", "kaguya"},
		Confidence: "high",
		Query:      "フグ",
	}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if out.TopTab != "viewer" {
		t.Errorf("TopTab roundtrip: %q", out.TopTab)
	}
	if out.List.FolderPath != "/img/folder" {
		t.Errorf("FolderPath roundtrip: %q", out.List.FolderPath)
	}
	if len(out.List.Filter.Tags) != 2 || out.List.Filter.Tags[0] != "iroha" {
		t.Errorf("Tags roundtrip: %v", out.List.Filter.Tags)
	}
	if out.List.Filter.Query != "フグ" {
		t.Errorf("Query roundtrip: %q", out.List.Filter.Query)
	}
}

func TestValidateState_RowSizesEqualFix(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Grid.Rows = 2
	bad.Grid.Panels = []PanelState{
		{Tabs: []TabState{}, ActiveIndex: -1},
		{Tabs: []TabState{}, ActiveIndex: -1},
	}
	bad.Grid.RowSizes = []float64{1.0} // wrong length, should be soft-fixed
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if len(s.Grid.RowSizes) != 2 {
		t.Errorf("expected RowSizes length 2 after soft fix, got %d", len(s.Grid.RowSizes))
	}
	if s.Grid.RowSizes[0] != 0.5 || s.Grid.RowSizes[1] != 0.5 {
		t.Errorf("expected equal sizes [0.5, 0.5], got %v", s.Grid.RowSizes)
	}
}
