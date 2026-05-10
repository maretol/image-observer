package state

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
)

// StateSchemaVersion is bumped to 2 in Phase 4 (top-level tabs + classification list).
// v1 → v2: no migration; v1 files fall back to defaults via Load().
const StateSchemaVersion = 2

type StateData struct {
	Version int `json:"version"`
	// RootPath / LeftPaneWidth are v1 leftovers kept for JSON-compatibility.
	// v2 frontends do not read them (left pane was removed in Phase 4).
	RootPath      string       `json:"rootPath"`
	LeftPaneWidth int          `json:"leftPaneWidth"`
	Window        WindowState  `json:"window"`
	Grid          GridState    `json:"grid"`
	TopTab        string       `json:"topTab"` // "list" | "viewer"
	List          ListTabState `json:"list"`
}

// ListTabState holds per-folder UI state for the list (classification) tab.
type ListTabState struct {
	FolderPath string          `json:"folderPath"`
	Filter     ListFilterState `json:"filter"`
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

type GridState struct {
	Rows     int          `json:"rows"`
	Cols     int          `json:"cols"`
	RowSizes []float64    `json:"rowSizes"`
	ColSizes []float64    `json:"colSizes"`
	Active   PanelCoordSt `json:"active"`
	Panels   []PanelState `json:"panels"`
}

type PanelCoordSt struct {
	Row int `json:"row"`
	Col int `json:"col"`
}

type PanelState struct {
	Tabs        []TabState `json:"tabs"`
	ActiveIndex int        `json:"activeIndex"`
}

type TabState struct {
	Path string  `json:"path"`
	Zoom float64 `json:"zoom"`
	PanX float64 `json:"panX"`
	PanY float64 `json:"panY"`
}

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
		Grid:          defaultGridState(),
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
	}
}

func defaultGridState() GridState {
	return GridState{
		Rows:     1,
		Cols:     1,
		RowSizes: []float64{1.0},
		ColSizes: []float64{1.0},
		Active:   PanelCoordSt{Row: 0, Col: 0},
		Panels:   []PanelState{{Tabs: []TabState{}, ActiveIndex: -1}},
	}
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
	g := &s.Grid
	if g.Rows < 1 || g.Cols < 1 {
		return errors.New("grid size out of range")
	}
	if len(g.Panels) != g.Rows*g.Cols {
		return errors.New("panels count mismatch with rows*cols")
	}
	if len(g.RowSizes) != g.Rows {
		g.RowSizes = equalSizesGo(g.Rows)
	}
	if len(g.ColSizes) != g.Cols {
		g.ColSizes = equalSizesGo(g.Cols)
	}
	if g.Active.Row < 0 || g.Active.Row >= g.Rows ||
		g.Active.Col < 0 || g.Active.Col >= g.Cols {
		g.Active = PanelCoordSt{Row: 0, Col: 0}
	}
	for i := range g.Panels {
		p := &g.Panels[i]
		if p.Tabs == nil {
			p.Tabs = []TabState{}
		}
		if len(p.Tabs) == 0 {
			p.ActiveIndex = -1
		} else if p.ActiveIndex < 0 || p.ActiveIndex >= len(p.Tabs) {
			p.ActiveIndex = 0
		}
		// Reset obviously bad zoom values; frontend will treat zoom<=0 as
		// "needs initial fit" via convertGridState().
		for j := range p.Tabs {
			t := &p.Tabs[j]
			if t.Zoom > 0 && (t.Zoom < 0.01 || t.Zoom > 100) {
				t.Zoom = 1.0
				t.PanX = 0
				t.PanY = 0
			}
		}
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
	switch s.List.Filter.Confidence {
	case "all", "high", "mid", "low":
		// ok
	default:
		s.List.Filter.Confidence = "all"
	}
	return nil
}

func equalSizesGo(n int) []float64 {
	out := make([]float64, n)
	if n <= 0 {
		return out
	}
	v := 1.0 / float64(n)
	for i := range out {
		out[i] = v
	}
	return out
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
