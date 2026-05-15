package state

import (
	"encoding/json"
)

// v5StateData mirrors the v5 on-disk schema. Defined privately here (not as a
// renamed alias of the live StateData) so the v6 type can drop the single
// `Layout` field cleanly without dragging legacy shapes into the rest of the
// codebase. Only the fields v5 actually wrote are present.
//
// v5 schema source: state.go @ commit before #11 (tag-able as `state v5`).
type v5StateData struct {
	Version int          `json:"version"`
	Window  WindowState  `json:"window"`
	Layout  LayoutState  `json:"layout"`
	TopTab  string       `json:"topTab"`
	List    ListTabState `json:"list"`
}

// migrateV5 wraps the v5 single-layout payload into one viewer so users keep
// their existing splits / tabs / zoom intact when upgrading. Validation is
// run by the caller (Load) afterward — this function does no normalization
// of its own.
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
