package state

import (
	"encoding/json"
)

// v5StateData は v5 の on-disk schema をミラー。private に定義し v6 型が単一 Layout field を綺麗に
// 落とせるように (legacy 形を codebase 全体に引きずらない)。
type v5StateData struct {
	Version int          `json:"version"`
	Window  WindowState  `json:"window"`
	Layout  LayoutState  `json:"layout"`
	TopTab  string       `json:"topTab"`
	List    ListTabState `json:"list"`
}

// migrateV5 は v5 の単一 layout を 1 viewer に包む (既存 split / tab / zoom を保つ)。検証は caller (Load)
// が行い、ここでは正規化しない。
func migrateV5(raw []byte) (StateData, error) {
	var v5 v5StateData
	if err := json.Unmarshal(raw, &v5); err != nil {
		return StateData{}, err
	}
	viewer := ViewerState{
		ID:     newViewerID(),
		Name:   defaultViewerName,
		Layout: v5.Layout,
	}
	return StateData{
		Version:        StateSchemaVersion,
		Window:         v5.Window,
		Viewers:        []ViewerState{viewer},
		ActiveViewerID: viewer.ID,
		TopTab:         v5.TopTab,
		List:           v5.List,
	}, nil
}
