package watcher

// changedAccumulator は debounce flush 間の event を集める。
//
// anyChange は「counter を増やさない interesting event (新規 subdir 等)」と「event 皆無」を区別し、
// empty() が no-op emit を抑止できるように。
//
// discoveredImagePaths / removedPaths は per-window dedup set。dir-Create の walk が見つけた画像への
// 後続 inotify Create、および 1 削除で inotify が出す複数 event (IN_DELETE + IN_DELETE_SELF / IN_IGNORED)
// の二重計上を防ぐ。map は reset() で消える。
type changedAccumulator struct {
	addedFiles           int
	removedFiles         int
	renamedFiles         int
	contentChanged       bool
	sidecarChanged       bool
	anyChange            bool
	discoveredImagePaths map[string]struct{}
	removedPaths         map[string]struct{}
}

func (c *changedAccumulator) empty() bool {
	return !c.anyChange &&
		c.addedFiles == 0 &&
		c.removedFiles == 0 &&
		c.renamedFiles == 0 &&
		!c.contentChanged &&
		!c.sidecarChanged
}

func (c *changedAccumulator) reset() { *c = changedAccumulator{} }

func (c *changedAccumulator) snapshot(folder string) ChangedPayload {
	return ChangedPayload{
		Folder:         folder,
		AddedFiles:     c.addedFiles,
		RemovedFiles:   c.removedFiles,
		RenamedFiles:   c.renamedFiles,
		ContentChanged: c.contentChanged,
		SidecarChanged: c.sidecarChanged,
	}
}
