package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"image-observer/internal/settings"
)

func setStateFile(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config", "state.json")
	stateFilePathOverride = p
	t.Cleanup(func() { stateFilePathOverride = "" })
	return p
}

// firstLayout returns the layout of the first viewer in s. Tests covering
// per-viewer layout invariants use this to keep the assertion paths short.
func firstLayout(s StateData) LayoutState {
	if len(s.Viewers) == 0 {
		return LayoutState{}
	}
	return s.Viewers[0].Layout
}

func TestLoadState_Missing_ReturnsDefaults(t *testing.T) {
	setStateFile(t)
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Errorf("version: got %d, want %d", s.Version, StateSchemaVersion)
	}
	if len(s.Viewers) != 1 {
		t.Fatalf("expected 1 default viewer, got %d", len(s.Viewers))
	}
	if firstLayout(s).Root.Kind != "leaf" {
		t.Errorf("default root kind: got %q, want leaf", firstLayout(s).Root.Kind)
	}
	if firstLayout(s).ActiveID != firstLayout(s).Root.ID {
		t.Errorf("default activeId: got %q, want %q", firstLayout(s).ActiveID, firstLayout(s).Root.ID)
	}
	if s.ActiveViewerID != s.Viewers[0].ID {
		t.Errorf("activeViewerID: got %q, want %q", s.ActiveViewerID, s.Viewers[0].ID)
	}
	if s.Viewers[0].Name != defaultViewerName {
		t.Errorf("default viewer name: got %q, want %q", s.Viewers[0].Name, defaultViewerName)
	}
}

func TestSaveLoadState_RoundTripLeafRoot(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.Window = WindowState{Width: 1600, Height: 900, X: 100, Y: 50}
	in.Viewers[0].Layout = LayoutState{
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
	if firstLayout(out).ActiveID != "L1" {
		t.Errorf("ActiveID roundtrip: got %q", firstLayout(out).ActiveID)
	}
	if len(firstLayout(out).Root.Tabs) != 2 || firstLayout(out).Root.Tabs[0].Zoom != 1.5 {
		t.Errorf("Tab data mismatch: %+v", firstLayout(out).Root.Tabs)
	}
	if firstLayout(out).Root.ActiveIndex != 1 {
		t.Errorf("ActiveIndex roundtrip: got %d", firstLayout(out).Root.ActiveIndex)
	}
}

func TestSaveLoadState_RoundTripSplitTree(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.Viewers[0].Layout = LayoutState{
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
	if firstLayout(out).Root.Kind != "split" || firstLayout(out).Root.Direction != "col" {
		t.Errorf("Split root mismatch: %+v", firstLayout(out).Root)
	}
	if firstLayout(out).Root.Ratio != 0.4 {
		t.Errorf("Split ratio mismatch: %v", firstLayout(out).Root.Ratio)
	}
	if firstLayout(out).ActiveID != "L3" {
		t.Errorf("ActiveID mismatch: %q", firstLayout(out).ActiveID)
	}
	// Drill down: A->A is L1
	if firstLayout(out).Root.A.A.ID != "L1" || len(firstLayout(out).Root.A.A.Tabs) != 1 {
		t.Errorf("Deep node mismatch: %+v", firstLayout(out).Root.A.A)
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
	if s.Version != StateSchemaVersion || firstLayout(s).Root.Kind != "leaf" {
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
	if s.Version != StateSchemaVersion || firstLayout(s).Root.Kind != "leaf" {
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
	bad.Viewers[0].Layout = LayoutState{
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
	if firstLayout(s).Root.ActiveIndex != 0 {
		t.Errorf("expected activeIndex clamped to 0, got %d", firstLayout(s).Root.ActiveIndex)
	}
}

func TestValidateState_ResetTinyZoom(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Viewers[0].Layout = LayoutState{
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
	if firstLayout(s).Root.Tabs[0].Zoom != 1.0 {
		t.Errorf("tiny zoom should be reset to 1.0, got %v", firstLayout(s).Root.Tabs[0].Zoom)
	}
}

func TestValidateState_ClampSplitRatio(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Viewers[0].Layout = LayoutState{
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
	if firstLayout(s).Root.Ratio != 0.05 {
		t.Errorf("ratio should be clamped to 0.05, got %v", firstLayout(s).Root.Ratio)
	}
}

func TestValidateState_ResetMissingActiveID(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Viewers[0].Layout = LayoutState{
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
	if firstLayout(s).ActiveID != "L1" {
		t.Errorf("activeId should fall back to first leaf, got %q", firstLayout(s).ActiveID)
	}
}

func TestValidateState_DuplicateNodeIDs_FallsBack(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Viewers[0].Layout = LayoutState{
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
	if firstLayout(s).Root.ID != "root-0" {
		t.Errorf("expected fallback to default layout, got root id %q", firstLayout(s).Root.ID)
	}
}

func TestValidateState_InvalidKind_FallsBack(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.Viewers[0].Layout = LayoutState{
		Root:     LayoutNodeState{Kind: "garbage", ID: "G"},
		ActiveID: "G",
	}
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if firstLayout(s).Root.Kind != "leaf" || firstLayout(s).Root.ID != "root-0" {
		t.Errorf("expected default fallback, got %+v", firstLayout(s).Root)
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
	if firstLayout(s).Root.Kind != "leaf" {
		t.Errorf("expected default leaf root, got kind %q", firstLayout(s).Root.Kind)
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
	if firstLayout(s).Root.Kind != "leaf" {
		t.Errorf("v1 fallback should produce default leaf root, got kind %q", firstLayout(s).Root.Kind)
	}
}

func TestLoadState_V4FallsBackToDefault(t *testing.T) {
	// v4 had RootPath / LeftPaneWidth fields. v5 dropped them, so v4 payloads
	// must fall back to defaults. Use distinguishing values (topTab "viewer",
	// layout root id "L") so the assertions actually catch a "values survived
	// instead of falling back" regression.
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	v4 := []byte(`{
		"version": 4,
		"rootPath": "/old",
		"leftPaneWidth": 300,
		"window": {"width":1600,"height":900,"x":42,"y":42},
		"layout": {"root":{"kind":"leaf","id":"L","tabs":[],"activeIndex":-1},"activeId":"L"},
		"topTab": "viewer",
		"list": {"folderPath":"/old","filter":{"tags":["t"],"confidence":"high","query":"q"},"collapsedGroups":["g"]}
	}`)
	if err := os.WriteFile(p, v4, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Errorf("expected schema v%d, got %d", StateSchemaVersion, s.Version)
	}
	if firstLayout(s).Root.ID != defaultRootKey {
		t.Errorf("expected default layout root id %q, got %q (v4 payload survived)", defaultRootKey, firstLayout(s).Root.ID)
	}
	if s.TopTab != "list" {
		t.Errorf("expected default TopTab \"list\", got %q (v4 payload survived)", s.TopTab)
	}
	if s.List.FolderPath != "" {
		t.Errorf("expected default empty FolderPath, got %q (v4 payload survived)", s.List.FolderPath)
	}
	if s.Window.Width != 1024 || s.Window.Height != 768 {
		t.Errorf("expected default window size 1024x768, got %dx%d (v4 payload survived)", s.Window.Width, s.Window.Height)
	}
}

// ---- v5 → v6 migration -----------------------------------------------------

func TestLoadState_V5MigratesLosslessly(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	// v5 payload with non-default values across every field so a regression
	// where any field gets dropped during migration is visible.
	v5 := []byte(`{
		"version": 5,
		"window": {"width":1600,"height":900,"x":42,"y":42},
		"layout": {
			"root": {
				"kind": "split", "id": "S1", "direction": "col", "ratio": 0.3,
				"a": {"kind":"leaf","id":"L1","tabs":[{"path":"/a.jpg","zoom":1.5,"panX":10,"panY":20}],"activeIndex":0},
				"b": {"kind":"leaf","id":"L2","tabs":[],"activeIndex":-1}
			},
			"activeId": "L1"
		},
		"topTab": "viewer",
		"list": {"folderPath":"/img","filter":{"tags":["t1","t2"],"confidence":"high","query":"q"},"collapsedGroups":["g1"]}
	}`)
	if err := os.WriteFile(p, v5, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Version != StateSchemaVersion {
		t.Fatalf("Version: got %d, want %d", s.Version, StateSchemaVersion)
	}
	if len(s.Viewers) != 1 {
		t.Fatalf("expected 1 viewer after v5 migration, got %d", len(s.Viewers))
	}
	v := s.Viewers[0]
	if v.ID == "" {
		t.Errorf("migrated viewer needs a non-empty id")
	}
	if v.Name != defaultViewerName {
		t.Errorf("migrated viewer name: got %q, want %q", v.Name, defaultViewerName)
	}
	if v.Layout.Root.Kind != "split" || v.Layout.Root.ID != "S1" {
		t.Errorf("layout root not preserved: %+v", v.Layout.Root)
	}
	if v.Layout.ActiveID != "L1" {
		t.Errorf("layout activeId not preserved: %q", v.Layout.ActiveID)
	}
	if s.ActiveViewerID != v.ID {
		t.Errorf("activeViewerID: got %q, want %q", s.ActiveViewerID, v.ID)
	}
	if s.Window.Width != 1600 {
		t.Errorf("window not preserved: %+v", s.Window)
	}
	if s.TopTab != "viewer" {
		t.Errorf("topTab not preserved: %q", s.TopTab)
	}
	if s.List.FolderPath != "/img" || len(s.List.Filter.Tags) != 2 {
		t.Errorf("list not preserved: %+v", s.List)
	}
}

func TestLoadState_V5InvalidLayoutFallsBack(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	// v5 with a structurally broken layout (split missing children).
	v5 := []byte(`{
		"version": 5,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"layout": {"root":{"kind":"split","id":"S","direction":"col","ratio":0.5},"activeId":"S"},
		"topTab": "list",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, v5, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	// Default fallback: 1 viewer with the canonical empty leaf root.
	if firstLayout(s).Root.ID != defaultRootKey {
		t.Errorf("expected default fallback, got %+v", firstLayout(s).Root)
	}
}

// ---- v6 -------------------------------------------------------------------

func TestSaveLoadState_V6MultipleViewersRoundTrip(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.Viewers = []ViewerState{
		{
			ID:     "v-a",
			Name:   "ビューア 1",
			Layout: LayoutState{Root: LayoutNodeState{Kind: "leaf", ID: "L-a", Tabs: []TabState{{Path: "/a.jpg", Zoom: 1, PanX: 0, PanY: 0}}, ActiveIndex: 0}, ActiveID: "L-a"},
		},
		{
			ID:     "v-b",
			Name:   "デザインレビュー",
			Layout: LayoutState{Root: LayoutNodeState{Kind: "leaf", ID: "L-b", Tabs: []TabState{}, ActiveIndex: -1}, ActiveID: "L-b"},
		},
	}
	in.ActiveViewerID = "v-b"
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if len(out.Viewers) != 2 {
		t.Fatalf("expected 2 viewers, got %d", len(out.Viewers))
	}
	if out.Viewers[0].ID != "v-a" || out.Viewers[1].ID != "v-b" {
		t.Errorf("viewer order/IDs not preserved: %+v", out.Viewers)
	}
	if out.Viewers[1].Name != "デザインレビュー" {
		t.Errorf("viewer name not preserved: %q", out.Viewers[1].Name)
	}
	if out.ActiveViewerID != "v-b" {
		t.Errorf("activeViewerID: got %q, want v-b", out.ActiveViewerID)
	}
	if out.Viewers[0].Layout.Root.Tabs[0].Path != "/a.jpg" {
		t.Errorf("viewer 0 tabs not preserved: %+v", out.Viewers[0].Layout.Root.Tabs)
	}
}

func TestValidateState_V6EmptyViewersGetsDefault(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	// version=6, viewers explicitly empty.
	payload := []byte(`{
		"version": 6,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"viewers": [],
		"activeViewerId": "",
		"topTab": "list",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, payload, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if len(s.Viewers) != 1 {
		t.Fatalf("expected 1 viewer after empty-array fallback, got %d", len(s.Viewers))
	}
	if s.ActiveViewerID != s.Viewers[0].ID {
		t.Errorf("activeViewerID should fall back to viewers[0]")
	}
}

func TestValidateState_V6ActiveViewerIDMismatch_FallsBackToFirst(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	payload := []byte(`{
		"version": 6,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"viewers": [
			{"id":"v-x","name":"X","layout":{"root":{"kind":"leaf","id":"L1","tabs":[],"activeIndex":-1},"activeId":"L1"}},
			{"id":"v-y","name":"Y","layout":{"root":{"kind":"leaf","id":"L2","tabs":[],"activeIndex":-1},"activeId":"L2"}}
		],
		"activeViewerId": "missing",
		"topTab": "viewer",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, payload, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.ActiveViewerID != "v-x" {
		t.Errorf("expected activeViewerID to fall back to first (v-x), got %q", s.ActiveViewerID)
	}
}

func TestValidateState_V6DuplicateViewerID_FallsBack(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	payload := []byte(`{
		"version": 6,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"viewers": [
			{"id":"dup","name":"A","layout":{"root":{"kind":"leaf","id":"L1","tabs":[],"activeIndex":-1},"activeId":"L1"}},
			{"id":"dup","name":"B","layout":{"root":{"kind":"leaf","id":"L2","tabs":[],"activeIndex":-1},"activeId":"L2"}}
		],
		"activeViewerId": "dup",
		"topTab": "list",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, payload, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	// Default fallback yields exactly 1 viewer with the canonical name.
	if len(s.Viewers) != 1 || s.Viewers[0].Name != defaultViewerName {
		t.Errorf("expected default fallback on duplicate viewer ID, got %+v", s.Viewers)
	}
}

func TestValidateState_V6NameSanitization(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	// Long name (>32 runes), then empty/whitespace name, then control chars.
	long := strings.Repeat("あ", 100) // 100 runes → must be truncated to 32
	payload := []byte(`{
		"version": 6,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"viewers": [
			{"id":"v1","name":"` + long + `","layout":{"root":{"kind":"leaf","id":"L1","tabs":[],"activeIndex":-1},"activeId":"L1"}},
			{"id":"v2","name":"   ","layout":{"root":{"kind":"leaf","id":"L2","tabs":[],"activeIndex":-1},"activeId":"L2"}},
			{"id":"v3","name":"hi\nthere","layout":{"root":{"kind":"leaf","id":"L3","tabs":[],"activeIndex":-1},"activeId":"L3"}}
		],
		"activeViewerId": "v1",
		"topTab": "list",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, payload, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if len(s.Viewers) != 3 {
		t.Fatalf("expected 3 viewers, got %d", len(s.Viewers))
	}
	if cnt := utf8RuneCount(s.Viewers[0].Name); cnt != maxNameLen {
		t.Errorf("v1 name should be truncated to %d runes, got %d (name=%q)", maxNameLen, cnt, s.Viewers[0].Name)
	}
	if s.Viewers[1].Name != "ビューア 2" {
		t.Errorf("v2 whitespace-only name should fall back to 'ビューア 2', got %q", s.Viewers[1].Name)
	}
	if s.Viewers[2].Name != "hithere" {
		t.Errorf("v3 control chars should be stripped, got %q", s.Viewers[2].Name)
	}
}

// v6ViewersStateJSON builds a v6 state.json body with n minimal viewers (id "v-0"..).
func v6ViewersStateJSON(n int) string {
	var sb strings.Builder
	sb.WriteString(`{"version":6,"window":{"width":1024,"height":768,"x":-1,"y":-1},"viewers":[`)
	for i := range n {
		if i > 0 {
			sb.WriteString(",")
		}
		id := strconv.Itoa(i)
		sb.WriteString(`{"id":"v-` + id + `","name":"V","layout":{"root":{"kind":"leaf","id":"L-` + id + `","tabs":[],"activeIndex":-1},"activeId":"L-` + id + `"}}`)
	}
	sb.WriteString(`],"activeViewerId":"v-0","topTab":"list","list":{"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}}`)
	return sb.String()
}

func TestValidateState_V6TooManyViewers_Truncated(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	// maxViewersHard+1 viewers — one over the hard cap.
	if err := os.WriteFile(p, []byte(v6ViewersStateJSON(maxViewersHard+1)), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if len(s.Viewers) != maxViewersHard {
		t.Errorf("expected %d viewers after truncation, got %d", maxViewersHard, len(s.Viewers))
	}
}

// TestValidateState_ViewersOverDefaultSetting_Preserved pins the add-gate policy (#148,
// spec-viewer-max-count.md §7): 復元時の truncate はハードキャップのみで、設定上限 (既定 8) を
// 超える viewer 数でも session を破壊しない。
func TestValidateState_ViewersOverDefaultSetting_Preserved(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(v6ViewersStateJSON(12)), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if len(s.Viewers) != 12 {
		t.Errorf("12 viewers (over default setting 8, under hard cap) should be preserved, got %d", len(s.Viewers))
	}
}

// TestMaxViewersHardMatchesSettings は truncate 上界と settings の Validate 上界のドリフトを
// 検知する (AGENTS.md D-1)。ずれると「settings が許した上限まで開く → 再起動で truncate」が起きる。
func TestMaxViewersHardMatchesSettings(t *testing.T) {
	if maxViewersHard != settings.MaxViewersHardCap {
		t.Errorf("maxViewersHard (%d) must equal settings.MaxViewersHardCap (%d)",
			maxViewersHard, settings.MaxViewersHardCap)
	}
}

// utf8RuneCount counts runes — broken out so the long-name assertion stays
// readable. Avoids importing unicode/utf8 here just for one call.
func utf8RuneCount(s string) int {
	n := 0
	for range s {
		n++
	}
	return n
}

func TestDefaultData_V6Fields(t *testing.T) {
	d := DefaultData()
	if d.Version != StateSchemaVersion {
		t.Errorf("Version = %d, want %d", d.Version, StateSchemaVersion)
	}
	if d.TopTab != "list" {
		t.Errorf("TopTab = %q, want list", d.TopTab)
	}
	if len(d.Viewers) != 1 {
		t.Fatalf("default viewers len = %d, want 1", len(d.Viewers))
	}
	if d.Viewers[0].Name != defaultViewerName {
		t.Errorf("default viewer name = %q, want %q", d.Viewers[0].Name, defaultViewerName)
	}
	if d.ActiveViewerID != d.Viewers[0].ID {
		t.Errorf("ActiveViewerID mismatch: %q vs %q", d.ActiveViewerID, d.Viewers[0].ID)
	}
	if firstLayout(d).Root.Kind != "leaf" {
		t.Errorf("default root kind: got %q, want leaf", firstLayout(d).Root.Kind)
	}
	if firstLayout(d).Root.ActiveIndex != -1 {
		t.Errorf("empty leaf activeIndex must be -1, got %d", firstLayout(d).Root.ActiveIndex)
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

func TestSaveLoadState_MaximizedRoundTrip(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.Window = WindowState{Width: 1280, Height: 720, X: 50, Y: 80, Maximized: true}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if !out.Window.Maximized {
		t.Errorf("Maximized flag did not survive round-trip: %+v", out.Window)
	}
	if out.Window.Width != 1280 || out.Window.Height != 720 || out.Window.X != 50 || out.Window.Y != 80 {
		t.Errorf("restore geometry not preserved alongside Maximized: %+v", out.Window)
	}
}

func TestLoadState_LegacyV6_NoMaximizedField_DefaultsToFalse(t *testing.T) {
	// v6 payloads written before issue #86 do not have the `maximized` field.
	// JSON unmarshal must leave it at the zero value (false) so existing
	// non-maximized sessions stay non-maximized.
	p := setStateFile(t)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	payload := []byte(`{
		"version": 6,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"viewers": [
			{"id":"v1","name":"V","layout":{"root":{"kind":"leaf","id":"L1","tabs":[],"activeIndex":-1},"activeId":"L1"}}
		],
		"activeViewerId": "v1",
		"topTab": "list",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, payload, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Window.Maximized {
		t.Errorf("legacy v6 payload without `maximized` field should load as Maximized=false, got %+v", s.Window)
	}
}

func TestLoadState_V5MigrationLeavesMaximizedFalse(t *testing.T) {
	// v5 had no maximized concept; migrated payloads must come through with
	// Maximized=false (the previous geometry is preserved verbatim).
	p := setStateFile(t)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	v5 := []byte(`{
		"version": 5,
		"window": {"width":1600,"height":900,"x":42,"y":42},
		"layout": {"root":{"kind":"leaf","id":"L","tabs":[],"activeIndex":-1},"activeId":"L"},
		"topTab": "list",
		"list": {"folderPath":"","filter":{"tags":[],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, v5, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.Window.Maximized {
		t.Errorf("v5 migration should yield Maximized=false, got %+v", s.Window)
	}
	if s.Window.Width != 1600 {
		t.Errorf("v5 window geometry not preserved: %+v", s.Window)
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
	// Tag-filter mode (the realistic state the app persists when tags are
	// selected): untaggedOnly is false and exclusive with the tag set.
	in.List.Filter = ListFilterState{
		Tags:         []string{"iroha", "kaguya"},
		UntaggedOnly: false,
		Confidence:   "high",
		Query:        "フグ",
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
	if out.List.Filter.UntaggedOnly {
		t.Errorf("UntaggedOnly roundtrip (tag mode): got true, want false")
	}
	if out.List.Filter.Query != "フグ" {
		t.Errorf("Query roundtrip: %q", out.List.Filter.Query)
	}
}

func TestSaveLoadState_UntaggedOnlyModeRoundTrip(t *testing.T) {
	// Untagged-filter mode (#116) is exclusive with tags, so the realistic
	// persisted shape is tags=[] & untaggedOnly=true — verify that round-trips.
	setStateFile(t)
	in := DefaultData()
	in.List.FolderPath = "/img"
	in.List.Filter = ListFilterState{
		Tags:         []string{},
		UntaggedOnly: true,
		Confidence:   "all",
		Query:        "",
	}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if !out.List.Filter.UntaggedOnly {
		t.Errorf("UntaggedOnly roundtrip: got false, want true")
	}
	if len(out.List.Filter.Tags) != 0 {
		t.Errorf("untagged mode should persist empty Tags, got %v", out.List.Filter.Tags)
	}
}

func TestLoadState_LegacyV6_NoUntaggedOnlyField_DefaultsToFalse(t *testing.T) {
	// v6 payloads written before issue #116 do not have the `untaggedOnly`
	// field. JSON unmarshal must leave it at the zero value (false) — this is
	// the additive-without-bump compatibility guarantee (spec-untagged-filter
	// §5.3): the schema version stays 6 and existing sessions load lossless.
	p := setStateFile(t)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	payload := []byte(`{
		"version": 6,
		"window": {"width":1024,"height":768,"x":-1,"y":-1},
		"viewers": [
			{"id":"v1","name":"V","layout":{"root":{"kind":"leaf","id":"L1","tabs":[],"activeIndex":-1},"activeId":"L1"}}
		],
		"activeViewerId": "v1",
		"topTab": "list",
		"list": {"folderPath":"/img","filter":{"tags":["iroha"],"confidence":"all","query":""},"collapsedGroups":[]}
	}`)
	if err := os.WriteFile(p, payload, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := Load()
	if s.List.Filter.UntaggedOnly {
		t.Errorf("legacy v6 payload without `untaggedOnly` should load as false, got true")
	}
	// The rest of the filter must survive untouched (no version bump / fallback).
	if len(s.List.Filter.Tags) != 1 || s.List.Filter.Tags[0] != "iroha" {
		t.Errorf("legacy v6 filter Tags not preserved: %v", s.List.Filter.Tags)
	}
}

// TestSaveWindow_PreservesOtherFields verifies the Go OnBeforeClose window
// capture (issue #129) overwrites only the window field and leaves the
// frontend-owned viewer / list / topTab state intact.
func TestSaveWindow_PreservesOtherFields(t *testing.T) {
	setStateFile(t)

	seed := DefaultData()
	seed.TopTab = "viewer"
	seed.List.FolderPath = "/tmp/photos"
	seed.Viewers[0].Name = "マイビューア"
	if err := Save(seed); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	// A secondary-monitor placement (negative X) that the buggy runtime restore
	// could not reach.
	want := WindowState{X: -1920, Y: 100, Width: 1280, Height: 1024, Maximized: true}
	if err := SaveWindow(want); err != nil {
		t.Fatalf("SaveWindow: %v", err)
	}

	got := Load()
	if got.Window != want {
		t.Errorf("window: got %+v, want %+v", got.Window, want)
	}
	if got.TopTab != "viewer" {
		t.Errorf("topTab clobbered: got %q, want viewer", got.TopTab)
	}
	if got.List.FolderPath != "/tmp/photos" {
		t.Errorf("list folderPath clobbered: got %q", got.List.FolderPath)
	}
	if got.Viewers[0].Name != "マイビューア" {
		t.Errorf("viewer name clobbered: got %q", got.Viewers[0].Name)
	}
}

// TestSaveWindow_MissingFile_SeedsDefaults documents the accepted behaviour
// when SaveWindow runs before any full state has been persisted: Load falls
// back to defaults, so the file is seeded with defaults plus the given window.
func TestSaveWindow_MissingFile_SeedsDefaults(t *testing.T) {
	setStateFile(t)

	want := WindowState{X: 10, Y: 20, Width: 800, Height: 600}
	if err := SaveWindow(want); err != nil {
		t.Fatalf("SaveWindow: %v", err)
	}

	got := Load()
	if got.Window != want {
		t.Errorf("window: got %+v, want %+v", got.Window, want)
	}
	if got.Version != StateSchemaVersion {
		t.Errorf("version: got %d, want %d", got.Version, StateSchemaVersion)
	}
	if len(got.Viewers) != 1 {
		t.Errorf("expected one default viewer seeded, got %d", len(got.Viewers))
	}
}

// TestSaveWindow_ConcurrentWithSave hammers Save and SaveWindow from many
// goroutines at once (mirrors the OnBeforeClose SaveWindow racing the frontend
// SaveState binding, issue #129 review). stateMu must serialize them: the file
// stays valid (never a torn / lost-update read) and `go test -race` reports no
// data race on the read-modify-write path.
func TestSaveWindow_ConcurrentWithSave(t *testing.T) {
	p := setStateFile(t)
	if err := Save(DefaultData()); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			// t.Errorf is safe to call concurrently; wg.Wait() below joins all
			// goroutines before the test returns, so no late report is lost.
			if err := Save(DefaultData()); err != nil {
				t.Errorf("Save: %v", err)
			}
		}()
		go func(i int) {
			defer wg.Done()
			if err := SaveWindow(WindowState{Width: 1024, Height: 768, X: i, Y: i}); err != nil {
				t.Errorf("SaveWindow: %v", err)
			}
		}(i)
	}
	wg.Wait()

	// Read the file raw rather than via Load: Load would mask a torn write by
	// silently falling back to DefaultData (which trivially satisfies the
	// assertions below). The bytes themselves must be valid JSON — proof that
	// stateMu serialized the atomic writes and none interleaved mid-rename.
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read state file: %v", err)
	}
	var parsed StateData
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("state file is not valid JSON after concurrent writes: %v\n%s", err, raw)
	}
	if parsed.Version != StateSchemaVersion {
		t.Errorf("version: got %d, want %d", parsed.Version, StateSchemaVersion)
	}
	if len(parsed.Viewers) == 0 {
		t.Errorf("viewers empty after concurrent writes: %+v", parsed)
	}
	if parsed.Window.Width != 1024 || parsed.Window.Height != 768 {
		t.Errorf("window size clobbered: got %+v", parsed.Window)
	}
}

// #144: Sort は additive field。round-trip / 既定 manual / 不正値・欠落の fallback を pin。
func TestSaveLoadState_SortRoundTrip(t *testing.T) {
	setStateFile(t)
	in := DefaultData()
	in.List.Sort = SortMtimeDesc
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out := Load()
	if out.List.Sort != SortMtimeDesc {
		t.Errorf("Sort roundtrip: %q", out.List.Sort)
	}
}

func TestValidateState_SortClamped(t *testing.T) {
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	bad := DefaultData()
	bad.List.Sort = "bogus"
	data, _ := json.Marshal(bad)
	os.WriteFile(p, data, 0o644)
	s := Load()
	if s.List.Sort != SortManual {
		t.Errorf("invalid Sort not clamped to manual, got %q", s.List.Sort)
	}
}

func TestLoadState_LegacyV6_NoSortField_DefaultsToManual(t *testing.T) {
	// #144 追加前の v6 state.json (sort field 無し) が manual に落ちること (無バンプ
	// additive の後方互換)。struct を Marshal すると sort が必ず載るため raw JSON を削って作る。
	p := setStateFile(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	in := DefaultData()
	data, _ := json.Marshal(in)
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	list, ok := raw["list"].(map[string]any)
	if !ok {
		t.Fatal("list field missing")
	}
	delete(list, "sort")
	legacy, _ := json.Marshal(raw)
	os.WriteFile(p, legacy, 0o644)
	s := Load()
	if s.List.Sort != SortManual {
		t.Errorf("legacy state without sort: got %q, want %q", s.List.Sort, SortManual)
	}
}

func TestDefaultData_SortIsManual(t *testing.T) {
	if got := DefaultData().List.Sort; got != SortManual {
		t.Errorf("default Sort = %q, want %q", got, SortManual)
	}
}

// AGENTS.md D-1 drift detector: これらのリテラルは frontend
// features/classification/sortMode.ts に複製されている (vitest 側の pin 断言と対)。
func TestSortModeValues(t *testing.T) {
	pairs := map[string]string{
		SortManual:    "manual",
		SortNameAsc:   "nameAsc",
		SortNameDesc:  "nameDesc",
		SortMtimeAsc:  "mtimeAsc",
		SortMtimeDesc: "mtimeDesc",
	}
	for got, want := range pairs {
		if got != want {
			t.Errorf("sort mode literal drift: %q != %q", got, want)
		}
	}
}
