package state

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"slices"
)

// StateSchemaVersion is bumped to 4 in Phase 5 (viewer flex-layout). The
// fixed rows×cols `Grid` is replaced by a BSP tree `Layout`. Earlier
// versions fall back to DefaultData() — no migration is performed.
const StateSchemaVersion = 4

type StateData struct {
	Version int `json:"version"`
	// RootPath / LeftPaneWidth are v1 leftovers kept for JSON-compatibility.
	// v2+ frontends do not read them (left pane was removed in Phase 4).
	RootPath      string       `json:"rootPath"`
	LeftPaneWidth int          `json:"leftPaneWidth"`
	Window        WindowState  `json:"window"`
	Layout        LayoutState  `json:"layout"`
	TopTab        string       `json:"topTab"` // "list" | "viewer"
	List          ListTabState `json:"list"`
}

// ListTabState holds per-folder UI state for the list (classification) tab.
//
// CollapsedGroups (v3): the directory-group keys (POSIX relative paths from
// the parent folder, "." for the parent's direct files) that the user has
// collapsed in the accordion view.
type ListTabState struct {
	FolderPath      string          `json:"folderPath"`
	Filter          ListFilterState `json:"filter"`
	CollapsedGroups []string        `json:"collapsedGroups"`
}

// ListFilterState mirrors the frontend filter store. Tags are an OR set;
// Confidence is one of "all" | "high" | "mid" | "low".
type ListFilterState struct {
	Tags       []string `json:"tags"`
	Confidence string   `json:"confidence"`
	Query      string   `json:"query"`
}

type WindowState struct {
	Width  int `json:"width"`
	Height int `json:"height"`
	X      int `json:"x"`
	Y      int `json:"y"`
}

// LayoutState is the persisted form of the viewer BSP layout tree. ActiveID
// points to the leaf currently focused (mirrors `Layout.activeId` in TS).
type LayoutState struct {
	Root     LayoutNodeState `json:"root"`
	ActiveID string          `json:"activeId"`
}

// LayoutNodeState is the JSON-serialized form of a SplitNode or LeafNode.
// kind determines which fields are valid; the others are zero-valued and
// omitted via `omitempty` where possible. ActiveIndex intentionally has no
// omitempty so 0 (a valid value for populated leaves) survives round-trips.
type LayoutNodeState struct {
	Kind string `json:"kind"` // "split" | "leaf"
	ID   string `json:"id"`

	// SplitNode-only.
	Direction string           `json:"direction,omitempty"` // "row" | "col"
	Ratio     float64          `json:"ratio,omitempty"`
	A         *LayoutNodeState `json:"a,omitempty"`
	B         *LayoutNodeState `json:"b,omitempty"`

	// LeafNode-only.
	Tabs        []TabState `json:"tabs,omitempty"`
	ActiveIndex int        `json:"activeIndex"`
}

type TabState struct {
	Path string  `json:"path"`
	Zoom float64 `json:"zoom"`
	PanX float64 `json:"panX"`
	PanY float64 `json:"panY"`
}

const (
	minRatio       = 0.05
	defaultRootKey = "root-0"
)

// stateFilePathOverride lets tests redirect away from the user config dir.
var stateFilePathOverride string

func stateFilePath() (string, error) {
	if stateFilePathOverride != "" {
		return stateFilePathOverride, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "image-observer", "state.json"), nil
}

// DefaultData returns the in-memory defaults used when state.json is missing
// or invalid. Exposed so callers (main.go, tests) can construct fresh state.
func DefaultData() StateData {
	return StateData{
		Version:       StateSchemaVersion,
		RootPath:      "",
		LeftPaneWidth: 280,
		Window:        WindowState{Width: 1024, Height: 768, X: -1, Y: -1},
		Layout:        defaultLayoutState(),
		TopTab:        "list",
		List:          defaultListTabState(),
	}
}

func defaultListTabState() ListTabState {
	return ListTabState{
		FolderPath: "",
		Filter: ListFilterState{
			Tags:       []string{},
			Confidence: "all",
			Query:      "",
		},
		CollapsedGroups: []string{},
	}
}

func defaultLayoutState() LayoutState {
	root := LayoutNodeState{
		Kind:        "leaf",
		ID:          defaultRootKey,
		Tabs:        nil,
		ActiveIndex: -1,
	}
	return LayoutState{Root: root, ActiveID: defaultRootKey}
}

// Load returns the persisted session state, falling back to DefaultData on
// any failure (missing file, parse error, version mismatch, validation failure).
func Load() StateData {
	path, err := stateFilePath()
	if err != nil {
		log.Printf("state: cannot determine state path: %v", err)
		return DefaultData()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("state: read failed: %v", err)
		}
		return DefaultData()
	}
	var s StateData
	if err := json.Unmarshal(data, &s); err != nil {
		log.Printf("state: parse failed (using defaults): %v", err)
		return DefaultData()
	}
	if s.Version != StateSchemaVersion {
		log.Printf("state: version mismatch (got %d, want %d), using defaults", s.Version, StateSchemaVersion)
		return DefaultData()
	}
	if err := validateState(&s); err != nil {
		log.Printf("state: validation failed (%v), using defaults", err)
		return DefaultData()
	}
	return s
}

// validateState applies soft fixes (clamp into range) and returns an error when
// the structure is too corrupt to recover (caller falls back to defaults).
func validateState(s *StateData) error {
	if err := validateLayoutTree(&s.Layout); err != nil {
		return err
	}
	if s.LeftPaneWidth < 100 {
		s.LeftPaneWidth = 280
	}
	if s.Window.Width < 200 {
		s.Window.Width = 1024
	}
	if s.Window.Height < 200 {
		s.Window.Height = 768
	}
	if s.TopTab != "list" && s.TopTab != "viewer" {
		s.TopTab = "list"
	}
	if s.List.Filter.Tags == nil {
		s.List.Filter.Tags = []string{}
	}
	if s.List.CollapsedGroups == nil {
		s.List.CollapsedGroups = []string{}
	}
	switch s.List.Filter.Confidence {
	case "all", "high", "mid", "low":
		// ok
	default:
		s.List.Filter.Confidence = "all"
	}
	return nil
}

// validateLayoutTree walks the layout tree, applying soft fixes for ratio /
// activeIndex / zoom and rejecting structural problems (missing kind, duplicate
// id, missing children) that warrant a default fallback.
func validateLayoutTree(l *LayoutState) error {
	if l.Root.Kind == "" {
		return errors.New("layout root has no kind")
	}
	seen := make(map[string]struct{})
	if err := walkLayoutNode(&l.Root, seen); err != nil {
		return err
	}
	// activeId resolution: must point to a leaf in the tree; otherwise
	// default to the first DFS leaf.
	leafIDs := []string{}
	collectLeafIDs(&l.Root, &leafIDs)
	if len(leafIDs) == 0 {
		// Should not happen — at minimum the root must be a leaf or contain
		// leaves. Treat as corrupt.
		return errors.New("layout has no leaves")
	}
	if !slices.Contains(leafIDs, l.ActiveID) {
		l.ActiveID = leafIDs[0]
	}
	return nil
}

func walkLayoutNode(n *LayoutNodeState, seen map[string]struct{}) error {
	if n == nil {
		return errors.New("nil layout node")
	}
	if n.ID == "" {
		return errors.New("layout node missing id")
	}
	if _, dup := seen[n.ID]; dup {
		return errors.New("duplicate layout node id: " + n.ID)
	}
	seen[n.ID] = struct{}{}

	switch n.Kind {
	case "split":
		if n.Direction != "row" && n.Direction != "col" {
			return errors.New("split has invalid direction")
		}
		if n.A == nil || n.B == nil {
			return errors.New("split missing children")
		}
		// Soft fix: clamp ratio.
		n.Ratio = clampRatio(n.Ratio)
		if err := walkLayoutNode(n.A, seen); err != nil {
			return err
		}
		if err := walkLayoutNode(n.B, seen); err != nil {
			return err
		}
	case "leaf":
		if n.Tabs == nil {
			n.Tabs = []TabState{}
		}
		if len(n.Tabs) == 0 {
			n.ActiveIndex = -1
		} else if n.ActiveIndex < 0 || n.ActiveIndex >= len(n.Tabs) {
			n.ActiveIndex = 0
		}
		// Reset obviously bad zoom values; frontend treats zoom<=0 as
		// "needs initial fit".
		for j := range n.Tabs {
			t := &n.Tabs[j]
			if t.Zoom > 0 && (t.Zoom < 0.01 || t.Zoom > 100) {
				t.Zoom = 1.0
				t.PanX = 0
				t.PanY = 0
			}
		}
	default:
		return errors.New("layout node has invalid kind: " + n.Kind)
	}
	return nil
}

func collectLeafIDs(n *LayoutNodeState, out *[]string) {
	if n == nil {
		return
	}
	if n.Kind == "leaf" {
		*out = append(*out, n.ID)
		return
	}
	collectLeafIDs(n.A, out)
	collectLeafIDs(n.B, out)
}

func clampRatio(r float64) float64 {
	if r != r { // NaN check
		return 0.5
	}
	if r < minRatio {
		return minRatio
	}
	if r > 1-minRatio {
		return 1 - minRatio
	}
	return r
}

// Save atomically writes the given state to state.json.
func Save(s StateData) error {
	path, err := stateFilePath()
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
