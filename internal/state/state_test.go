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
	if s.Layout.Root.Kind != "leaf" {
		t.Errorf("default root kind: got %q, want leaf", s.Layout.Root.Kind)
	}
	if s.Layout.ActiveID != s.Layout.Root.ID {
		t.Errorf("default activeId: got %q, want %q", s.Layout.ActiveID, s.Layout.Root.ID)
	}
}

func TestSaveLoadState_RoundTripLeafRoot(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.Window = WindowState{Width: 1600, Height: 900, X: 100, Y: 50}
	in.Layout = LayoutState{
		Root: LayoutNodeState{
			Kind: "leaf", ID: "L1",
			Tabs: []TabState{
				{Path: "/a.jpg", Zoom: 1.5, PanX: 10, PanY: 20},
				{Path: "/b.png", Zoom: 0.5, PanX: -5, PanY: -3},
			},
			ActiveIndex: 1,
		},
		ActiveID: "L1",
	}

	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if out.Window.Width != 1600 || out.Window.Height != 900 {
		t.Errorf("Window size mismatch")
	}
	if out.Layout.ActiveID != "L1" {
		t.Errorf("ActiveID roundtrip: got %q", out.Layout.ActiveID)
	}
	if len(out.Layout.Root.Tabs) != 2 || out.Layout.Root.Tabs[0].Zoom != 1.5 {
		t.Errorf("Tab data mismatch: %+v", out.Layout.Root.Tabs)
	}
	if out.Layout.Root.ActiveIndex != 1 {
		t.Errorf("ActiveIndex roundtrip: got %d", out.Layout.Root.ActiveIndex)
	}
}

func TestSaveLoadState_RoundTripSplitTree(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.Layout = LayoutState{
		Root: LayoutNodeState{
			Kind: "split", ID: "S1", Direction: "col", Ratio: 0.4,
			A: &LayoutNodeState{
				Kind: "split", ID: "S2", Direction: "row", Ratio: 0.6,
				A: &LayoutNodeState{
					Kind: "leaf", ID: "L1",
					Tabs:        []TabState{{Path: "/x.jpg", Zoom: 1, PanX: 0, PanY: 0}},
					ActiveIndex: 0,
				},
				B: &LayoutNodeState{
					Kind: "leaf", ID: "L2",
					Tabs: []TabState{}, ActiveIndex: -1,
				},
			},
			B: &LayoutNodeState{
				Kind: "leaf", ID: "L3",
				Tabs:        []TabState{{Path: "/y.png", Zoom: 2, PanX: 100, PanY: 50}},
				ActiveIndex: 0,
			},
		},
		ActiveID: "L3",
	}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if out.Layout.Root.Kind != "split" || out.Layout.Root.Direction != "col" {
		t.Errorf("Split root mismatch: %+v", out.Layout.Root)
	}
	if out.Layout.Root.Ratio != 0.4 {
		t.Errorf("Split ratio mismatch: %v", out.Layout.Root.Ratio)
	}
	if out.Layout.ActiveID != "L3" {
		t.Errorf("ActiveID mismatch: %q", out.Layout.ActiveID)
	}
	// Drill down: A->A is L1
	if out.Layout.Root.A.A.ID != "L1" || len(out.Layout.Root.A.A.Tabs) != 1 {
		t.Errorf("Deep node mismatch: %+v", out.Layout.Root.A.A)
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
	if s.Version != StateSchemaVersion || s.Layout.Root.Kind != "leaf" {
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
	if s.Version != StateSchemaVersion || s.Layout.Root.Kind != "leaf" {
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

func TestValidateState_ClampLeafActiveIndex(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Layout = LayoutState{
		Root: LayoutNodeState{
			Kind: "leaf", ID: "L",
			Tabs:        []TabState{{Path: "/a", Zoom: 1, PanX: 0, PanY: 0}},
			ActiveIndex: 99,
		},
		ActiveID: "L",
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.Layout.Root.ActiveIndex != 0 {
		t.Errorf("expected activeIndex clamped to 0, got %d", s.Layout.Root.ActiveIndex)
	}
}

func TestValidateState_ResetTinyZoom(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Layout = LayoutState{
		Root: LayoutNodeState{
			Kind: "leaf", ID: "L",
			Tabs:        []TabState{{Path: "/a", Zoom: 0.001, PanX: 9999, PanY: 9999}},
			ActiveIndex: 0,
		},
		ActiveID: "L",
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.Layout.Root.Tabs[0].Zoom != 1.0 {
		t.Errorf("tiny zoom should be reset to 1.0, got %v", s.Layout.Root.Tabs[0].Zoom)
	}
}

func TestValidateState_ClampSplitRatio(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Layout = LayoutState{
		Root: LayoutNodeState{
			Kind: "split", ID: "S", Direction: "col", Ratio: 0.001,
			A: &LayoutNodeState{Kind: "leaf", ID: "L1", Tabs: []TabState{}, ActiveIndex: -1},
			B: &LayoutNodeState{Kind: "leaf", ID: "L2", Tabs: []TabState{}, ActiveIndex: -1},
		},
		ActiveID: "L1",
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.Layout.Root.Ratio != 0.05 {
		t.Errorf("ratio should be clamped to 0.05, got %v", s.Layout.Root.Ratio)
	}
}

func TestValidateState_ResetMissingActiveID(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Layout = LayoutState{
		Root: LayoutNodeState{
			Kind: "split", ID: "S", Direction: "col", Ratio: 0.5,
			A: &LayoutNodeState{Kind: "leaf", ID: "L1", Tabs: []TabState{}, ActiveIndex: -1},
			B: &LayoutNodeState{Kind: "leaf", ID: "L2", Tabs: []TabState{}, ActiveIndex: -1},
		},
		ActiveID: "missing",
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	// Falls back to first DFS leaf.
	if s.Layout.ActiveID != "L1" {
		t.Errorf("activeId should fall back to first leaf, got %q", s.Layout.ActiveID)
	}
}

func TestValidateState_DuplicateNodeIDs_FallsBack(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Layout = LayoutState{
		Root: LayoutNodeState{
			Kind: "split", ID: "X", Direction: "col", Ratio: 0.5,
			A: &LayoutNodeState{Kind: "leaf", ID: "X", Tabs: []TabState{}, ActiveIndex: -1},
			B: &LayoutNodeState{Kind: "leaf", ID: "Y", Tabs: []TabState{}, ActiveIndex: -1},
		},
		ActiveID: "X",
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	// Duplicate IDs → fall back to default (single leaf root).
	if s.Layout.Root.ID != "root-0" {
		t.Errorf("expected fallback to default layout, got root id %q", s.Layout.Root.ID)
	}
}

func TestValidateState_InvalidKind_FallsBack(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Layout = LayoutState{
		Root:     LayoutNodeState{Kind: "garbage", ID: "G"},
		ActiveID: "G",
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.Layout.Root.Kind != "leaf" || s.Layout.Root.ID != "root-0" {
		t.Errorf("expected default fallback, got %+v", s.Layout.Root)
	}
}

func TestLoadState_V3FallsBackToDefault(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	// v3 schema (with grid, no layout)
	v3 := []byte(`{
		"version": 3,
		"rootPath": "/old",
		"leftPaneWidth": 300,
		"grid": { "rows": 1, "cols": 1, "rowSizes": [1.0], "colSizes": [1.0],
			"active": {"row":0,"col":0},
			"panels": [{"tabs":[],"activeIndex":-1}] },
		"topTab": "viewer"
	}`)
	if err := os.WriteFile(p, v3, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Errorf("expected schema v%d, got %d", StateSchemaVersion, s.Version)
	}
	if s.TopTab != "list" {
		t.Errorf("default TopTab = %q, want list", s.TopTab)
	}
	if s.Layout.Root.Kind != "leaf" {
		t.Errorf("expected default leaf root, got kind %q", s.Layout.Root.Kind)
	}
}

func TestLoadState_V1FallsBackToDefault(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(`{"version":1,"rootPath":"/old","leftPaneWidth":300}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Errorf("expected schema v%d, got %d", StateSchemaVersion, s.Version)
	}
	if s.Layout.Root.Kind != "leaf" {
		t.Errorf("v1 fallback should produce default leaf root, got kind %q", s.Layout.Root.Kind)
	}
}

func TestLoadState_V4FallsBackToDefault(t *testing.T) {
	// v4 had RootPath / LeftPaneWidth fields. v5 dropped them, so v4 payloads
	// must fall back to defaults.
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	v4 := []byte(`{
		"version": 4,
		"rootPath": "/old",
		"leftPaneWidth": 300,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"layout": {"root":{"kind":"leaf","id":"L","tabs":[],"activeIndex":-1},"activeId":"L"},
		"topTab": "list",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, v4, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Errorf("expected schema v%d, got %d", StateSchemaVersion, s.Version)
	}
}

func TestDefaultData_V5Fields(t *testing.T) {
	d := DefaultData()
	if d.Version != 5 {
		t.Errorf("Version = %d, want 5", d.Version)
	}
	if d.TopTab != "list" {
		t.Errorf("TopTab = %q, want list", d.TopTab)
	}
	if d.Layout.Root.Kind != "leaf" {
		t.Errorf("default root kind: got %q, want leaf", d.Layout.Root.Kind)
	}
	if d.Layout.Root.ActiveIndex != -1 {
		t.Errorf("empty leaf activeIndex must be -1, got %d", d.Layout.Root.ActiveIndex)
	}
	if d.List.Filter.Confidence != "all" {
		t.Errorf("default Confidence = %q, want all", d.List.Filter.Confidence)
	}
	if d.List.Filter.Tags == nil {
		t.Errorf("default Tags must be non-nil empty slice")
	}
	if d.List.CollapsedGroups == nil {
		t.Errorf("default CollapsedGroups must be non-nil empty slice")
	}
}

func TestSaveLoadState_CollapsedGroupsRoundTrip(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.List.CollapsedGroups = []string{"child1", "child2/sub"}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if len(out.List.CollapsedGroups) != 2 ||
		out.List.CollapsedGroups[0] != "child1" ||
		out.List.CollapsedGroups[1] != "child2/sub" {
		t.Errorf("CollapsedGroups roundtrip: %v", out.List.CollapsedGroups)
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

func TestSaveLoadState_TopTabAndFilterRoundTrip(t *testing.T) {
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
