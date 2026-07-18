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
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// StateSchemaVersion は 6: v5 の単一 Layout を Viewers + ActiveViewerID に置換し複数 viewer layout を
// 保てるように (#11)。v5 は lossless に migrate、それ以前は DefaultData に fallback。
const StateSchemaVersion = 6

// maxViewers=8 は Ctrl+Shift+2..9 のキーバインド範囲。maxNameLen は byte でなく rune 数 (日本語名も 32 文字)。
const (
	maxViewers           = 8
	maxNameLen           = 32
	defaultViewerName    = "ビューア 1"
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

// ViewerState は 1 ユーザー命名 viewer。各 viewer は独立 BSP layout を持つ。
type ViewerState struct {
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Layout LayoutState `json:"layout"`
}

// ListTabState は list (分類) タブの folder ごと UI state。CollapsedGroups は折りたたんだ directory-group
// キー (親からの POSIX 相対 path、親直下は ".")。
type ListTabState struct {
	FolderPath      string          `json:"folderPath"`
	Filter          ListFilterState `json:"filter"`
	CollapsedGroups []string        `json:"collapsedGroups"`
	// Sort は一覧タブのソートモード (#144)。空 / 不正値は SortManual に fallback —
	// schema bump なしの加算追加で v6 は前後方互換 (spec-image-sort.md §7.1)。
	Sort string `json:"sort"`
}

// Sort モードの許容値。手動 (sidecar 配列順) が既定 = 従来挙動。frontend の
// features/classification/sortMode.ts と test 対の pin 断言で同期 (AGENTS.md D-1)。
const (
	SortManual    = "manual"
	SortNameAsc   = "nameAsc"
	SortNameDesc  = "nameDesc"
	SortMtimeAsc  = "mtimeAsc"
	SortMtimeDesc = "mtimeDesc"
)

// ListFilterState は frontend の filter store をミラー。Tags は OR set、Confidence は
// "all" | "high" | "mid" | "low"。UntaggedOnly (#116) はタグ無し entry のみ表示し Tags と排他 —
// schema bump なしの加算追加で v6 は前後方互換 (spec-untagged-filter.md §5.3)。
type ListFilterState struct {
	Tags         []string `json:"tags"`
	UntaggedOnly bool     `json:"untaggedOnly"`
	Confidence   string   `json:"confidence"`
	Query        string   `json:"query"`
}

// WindowState は永続 window geometry。X/Y/W/H は *非最大化* (restore) 値で Maximized は別 bool
// (最大化のまま閉じても restore サイズを保持)。writer は platform 依存: Windows は Go の Win32 capture
// (#129)、非 Windows は frontend polling (#86) (spec-window-placement.md §8)。
type WindowState struct {
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Maximized bool `json:"maximized,omitempty"`
}

// WindowPositionUnset は未配置 window の X/Y sentinel。restore は X と Y が *両方* この値のときだけ位置適用を
// skip する — 本物の負座標 (左/上の secondary monitor) は有効 (#129)。D-2: DefaultData と main.go の
// drift 防止に single-source。
const WindowPositionUnset = -1

// LayoutState は 1 viewer の BSP layout tree の永続形。ActiveID は focus 中の leaf (TS Layout.activeId ミラー)。
type LayoutState struct {
	Root     LayoutNodeState `json:"root"`
	ActiveID string          `json:"activeId"`
}

// LayoutNodeState は SplitNode / LeafNode の JSON 直列化形。kind で有効 field が決まる。ActiveIndex は
// あえて omitempty なし — populated leaf の有効値 0 を round-trip で残すため。
type LayoutNodeState struct {
	Kind string `json:"kind"` // "split" | "leaf"
	ID   string `json:"id"`

	// SplitNode 専用。
	Direction string           `json:"direction,omitempty"` // "row" | "col"
	Ratio     float64          `json:"ratio,omitempty"`
	A         *LayoutNodeState `json:"a,omitempty"`
	B         *LayoutNodeState `json:"b,omitempty"`

	// LeafNode 専用。
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

// stateFilePathOverride はテストが user config dir 外へ redirect するため。
var stateFilePathOverride string

// stateMu は state.json の read-modify-write を直列化する。frontend SaveState と OnBeforeClose の
// SaveWindow (#129) が別 goroutine で走り、無いと Load→Save が並行更新を取りこぼす。exported な
// Load/Save/SaveWindow が取得し *Locked helper は保持前提。
var stateMu sync.Mutex

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

// DefaultData は state.json が無い/不正なときの in-memory defaults を返す。
func DefaultData() StateData {
	v := defaultViewer()
	return StateData{
		Version:        StateSchemaVersion,
		Window:         WindowState{Width: 1024, Height: 768, X: WindowPositionUnset, Y: WindowPositionUnset},
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
		Sort:            SortManual,
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

// fallbackViewerIDCounter は crypto/rand 失敗時の fallback ID を一意に保つ — 衝突 ID は validateState が
// corrupt 扱いし viewer set 全体を defaults に落とすため。
var fallbackViewerIDCounter atomic.Uint64

// newViewerID は viewer 識別子を返す。`v-` prefix 付き UUID-v4 風 hex で、logs / state.json で origin を
// grep できるように。spec は一意性のみ要求 (RFC 準拠不要)。
func newViewerID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// 連続 fallback を一意に保つ (固定文字列だと 2 度目で衝突し validateState が defaults に落とす)。
		c := fallbackViewerIDCounter.Add(1)
		return fmt.Sprintf("v-fallback-%d-%d", time.Now().UnixNano(), c)
	}
	// version (4) と variant (10xx) bit を立て、RFC dash を省いても UUID と分かるように。
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return "v-" + hex.EncodeToString(buf[:])
}

// Load は永続 session state を返す。失敗 (欠落 / parse / version 不一致 / 検証失敗) は DefaultData に
// fallback。v5 は v6 に migrate、それ以前は fallback。
func Load() StateData {
	stateMu.Lock()
	defer stateMu.Unlock()
	return loadLocked()
}

func loadLocked() StateData {
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

	// strict v6 unmarshal が viewers 欠落で失敗する前に v5 migration へ振り分けられるよう version を覗く。
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

// validateState は soft fix (範囲 clamp / 名前 sanitize) を適用し、回復不能なほど壊れていれば error を返す (caller が defaults に fallback)。
func validateState(s *StateData) error {
	// Window の sanity。
	if s.Window.Width < 200 {
		s.Window.Width = 1024
	}
	if s.Window.Height < 200 {
		s.Window.Height = 768
	}

	// Viewers: 1..maxViewers / 一意 ID / sanitize 名 / 有効 layout を強制。
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

	// activeViewerId を解決。
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
	switch s.List.Sort {
	case SortManual, SortNameAsc, SortNameDesc, SortMtimeAsc, SortMtimeDesc:
		// ok
	default:
		// 旧 state.json (field 欠落 = 空文字) / 不正値は従来挙動の manual へ。
		s.List.Sort = SortManual
	}
	return nil
}

// sanitizeViewerName は trim + 制御文字除去 + maxNameLen 切り詰め。空なら index (0-based) を 1-based に
// して "ビューア N" に fallback。
func sanitizeViewerName(raw string, index int) string {
	trimmed := strings.TrimSpace(raw)
	// 制御文字 (改行 / tab 等) を除去 — viewer 名は 1 行 UI。
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
		// rune 境界で切る。
		runes := []rune(cleaned)
		cleaned = string(runes[:maxNameLen])
	}
	return cleaned
}

// validateLayoutTree は layout tree を walk し ratio / activeIndex / zoom を soft fix、構造的問題
// (kind 欠落 / id 重複 / child 欠落) は拒否する。
func validateLayoutTree(l *LayoutState) error {
	if l.Root.Kind == "" {
		return errors.New("layout root has no kind")
	}
	seen := make(map[string]struct{})
	if err := walkLayoutNode(&l.Root, seen); err != nil {
		return err
	}
	// activeId 解決: tree 内の leaf を指す必要がある; でなければ DFS 先頭 leaf を既定にする。
	leafIDs := []string{}
	collectLeafIDs(&l.Root, &leafIDs)
	if len(leafIDs) == 0 {
		// 起きない想定 — 少なくとも root は leaf か leaf を含むはず。corrupt 扱い。
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
		// soft fix: ratio を clamp。
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
		// 明らかに不正な zoom を reset; frontend は zoom<=0 を「初期 fit が必要」と扱う。
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
	if r != r { // NaN チェック
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

// Save は state を state.json に atomic に書く。stateMu で Load / SaveWindow と直列化する。
func Save(s StateData) error {
	stateMu.Lock()
	defer stateMu.Unlock()
	return saveLocked(s)
}

func saveLocked(s StateData) error {
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

// SaveWindow は window geometry だけを永続化し他 field を保持する。load+save を stateMu 下で行うため
// 並行 frontend Save と取りこぼし無く interleave する。Windows では Go の Win32 capture が window field の
// 唯一の writer (#129, spec-window-placement.md §8)。
func SaveWindow(w WindowState) error {
	stateMu.Lock()
	defer stateMu.Unlock()
	s := loadLocked()
	s.Window = w
	return saveLocked(s)
}
