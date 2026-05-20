package watcher

// changedAccumulator collects events between debounce flushes.
//
// anyChange distinguishes "we got an interesting event that doesn't bump a
// counter" (e.g. a new subdirectory was created) from "no events at all",
// so empty() can suppress no-op emits.
//
// discoveredImagePaths is a per-window dedup set: when a directory-Create
// event runs addSubtreeCollect, every image file the walk turns up is both
// counted into addedFiles AND parked here. A subsequent inotify Create for
// one of those paths (race between the walk and concurrent writers
// dropping files into the just-created dir) is then consumed instead of
// double-counted.
//
// removedPaths is a per-window dedup set for Remove/Rename. Inotify fires
// multiple events for a removed/renamed entry (parent's IN_DELETE plus the
// path's own IN_DELETE_SELF / IN_IGNORED); without dedup the second event
// over-counts. The map is wiped by reset().
type changedAccumulator struct {
	addedFiles           int
	removedFiles         int
	renamedFiles         int
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
		!c.sidecarChanged
}

func (c *changedAccumulator) reset() { *c = changedAccumulator{} }

func (c *changedAccumulator) snapshot(folder string) ChangedPayload {
	return ChangedPayload{
		Folder:         folder,
		AddedFiles:     c.addedFiles,
		RemovedFiles:   c.removedFiles,
		RenamedFiles:   c.renamedFiles,
		SidecarChanged: c.sidecarChanged,
	}
}
