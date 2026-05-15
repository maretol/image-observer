package state

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// StateSchemaVersion is bumped to 6: replaces the single `Layout` field with
// `Viewers []ViewerState` + `ActiveViewerID` so the user can keep multiple
// independent viewer layouts (issue #11). v5 payloads are migrated lossless
// (the single layout is wrapped into one viewer); earlier versions fall back
// to DefaultData.
const StateSchemaVersion = 6

// Multi-viewer constants. MaxViewers ties to the `Ctrl+Shift+2..9` keybinding
// range (= 8 viewers selectable by digit). MaxNameLen is rune-counted, not
// byte-counted, so Japanese names get 32 characters' worth of latitude.
const (
	maxViewers          = 8
	maxNameLen          = 32
	defaultViewerName   = "ビューア 1"
	defaultViewerNamePat = "ビューア %d"
)

type StateData struct {
	Version        int           `json:"version"`
	Window         WindowState   `json:"window"`
	Viewers        []ViewerState `json:"viewers"`
	ActiveViewerID string        `json:"activeViewerId"`
	TopTab         string        `json:"topTab"` // "list" | "viewer"
	List           ListTabState  `json:"list"`
}

// ViewerState is one user-named viewer. Each viewer holds an independent BSP
// layout; switching viewers is purely a UI-level swap of the `Layout` shown.
type ViewerState struct {
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Layout LayoutState `json:"layout"`
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

// LayoutState is the persisted form of one viewer's BSP layout tree. ActiveID
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
	v := defaultViewer()
	return StateData{
		Version:        StateSchemaVersion,
		Window:         WindowState{Width: 1024, Height: 768, X: -1, Y: -1},
		Viewers:        []ViewerState{v},
		ActiveViewerID: v.ID,
		TopTab:         "list",
		List:           defaultListTabState(),
	}
}

func defaultViewer() ViewerState {
	return ViewerState{
		ID:     newViewerID(),
		Name:   defaultViewerName,
		Layout: defaultLayoutState(),
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

// fallbackViewerIDCounter monotonically tags `crypto/rand`-failure fallback
// IDs so that even in that exceedingly rare case (entropy unavailable) we
// don't hand out colliding viewer IDs — `validateState` rejects duplicate
// IDs as corrupt and would drop the user's entire viewer set to defaults.
var fallbackViewerIDCounter atomic.Uint64

// newViewerID returns a per-viewer identifier. Frontend uses
// `crypto.randomUUID()`; on the Go side (DefaultData / v5 migration) we
// produce a 16-byte UUID-v4-shaped hex string with a `v-` prefix so the
// origin is greppable in logs / state.json. The spec only requires
// uniqueness, not RFC-4122 wire compliance — both forms ride the same
// `string` JSON field and validateState only checks emptiness + uniqueness.
func newViewerID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Extremely rare path. Mix wall-clock nanoseconds with a
		// process-local counter so successive fallback IDs stay unique
		// (a static "viewer-fallback" string would collide on the second
		// call and trigger a defaults-fallback validateState rejection).
		c := fallbackViewerIDCounter.Add(1)
		return fmt.Sprintf("v-fallback-%d-%d", time.Now().UnixNano(), c)
	}
	// Set version (4) and variant (10xx) bits so the string is recognizable
	// as a UUID even though we skip RFC dashes.
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return "v-" + hex.EncodeToString(buf[:])
}

// Load returns the persisted session state, falling back to DefaultData on
// any failure (missing file, parse error, version mismatch, validation failure).
//
// v5 payloads are migrated to v6 in-memory before validation runs; older
// versions are not migrated and yield a default-data fallback.
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

	// Peek at the version field so we can route to the v5 migration before
	// the strict v6 unmarshal would fail on the missing `viewers` field.
	var probe struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		log.Printf("state: parse failed (using defaults): %v", err)
		return DefaultData()
	}

	switch probe.Version {
	case StateSchemaVersion:
		var s StateData
		if err := json.Unmarshal(data, &s); err != nil {
			log.Printf("state: parse failed (using defaults): %v", err)
			return DefaultData()
		}
		if err := validateState(&s); err != nil {
			log.Printf("state: validation failed (%v), using defaults", err)
			return DefaultData()
		}
		return s
	case 5:
		s, err := migrateV5(data)
		if err != nil {
			log.Printf("state: v5 migration failed (%v), using defaults", err)
			return DefaultData()
		}
		if err := validateState(&s); err != nil {
			log.Printf("state: post-migration validation failed (%v), using defaults", err)
			return DefaultData()
		}
		log.Printf("state: migrated v5 → v6 (%d viewer)", len(s.Viewers))
		return s
	default:
		log.Printf("state: version %d not supported (need %d or 5), using defaults", probe.Version, StateSchemaVersion)
		return DefaultData()
	}
}

// validateState applies soft fixes (clamp into range, sanitize names) and
// returns an error when the structure is too corrupt to recover (caller falls
// back to defaults).
func validateState(s *StateData) error {
	// Window sanity.
	if s.Window.Width < 200 {
		s.Window.Width = 1024
	}
	if s.Window.Height < 200 {
		s.Window.Height = 768
	}

	// Viewers: enforce 1..maxViewers, unique IDs, sanitized names, valid layouts.
	if len(s.Viewers) == 0 {
		s.Viewers = []ViewerState{defaultViewer()}
	}
	if len(s.Viewers) > maxViewers {
		s.Viewers = s.Viewers[:maxViewers]
	}
	seenIDs := make(map[string]struct{}, len(s.Viewers))
	for i := range s.Viewers {
		v := &s.Viewers[i]
		if v.ID == "" {
			return errors.New("viewer missing id")
		}
		if _, dup := seenIDs[v.ID]; dup {
			return fmt.Errorf("duplicate viewer id: %s", v.ID)
		}
		seenIDs[v.ID] = struct{}{}
		v.Name = sanitizeViewerName(v.Name, i)
		if err := validateLayoutTree(&v.Layout); err != nil {
			return fmt.Errorf("viewer %s layout invalid: %w", v.ID, err)
		}
	}

	// Resolve activeViewerId.
	if !slices.ContainsFunc(s.Viewers, func(v ViewerState) bool { return v.ID == s.ActiveViewerID }) {
		s.ActiveViewerID = s.Viewers[0].ID
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

// sanitizeViewerName trims, drops control characters, and rune-truncates to
// maxNameLen. Empty results fall back to "ビューア N" using the supplied
// index (0-based, displayed as 1-based).
func sanitizeViewerName(raw string, index int) string {
	trimmed := strings.TrimSpace(raw)
	// Drop control characters (newline / tab / etc) — viewer names live in a
	// single-line UI.
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, trimmed)
	if cleaned == "" {
		return fmt.Sprintf(defaultViewerNamePat, index+1)
	}
	if utf8.RuneCountInString(cleaned) > maxNameLen {
		// Truncate at rune boundary.
		runes := []rune(cleaned)
		cleaned = string(runes[:maxNameLen])
	}
	return cleaned
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
