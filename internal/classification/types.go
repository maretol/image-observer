// Package classification implements the sidecar-based image classification
// metadata layer used by the "list" tab. The canonical store is JSON
// (_classification.json); CSV is read once for migration and never written.
// See docs/spec-classification.md.
package classification

import (
	"errors"
	"time"
)

const SchemaVersion = 1

const (
	SidecarJSON = "_classification.json"
	SidecarCSV  = "_classification.csv"
	BackupJSON  = "_classification.json.bak"
	TempJSON    = "_classification.json.tmp"
)

// Confidence is the level of certainty assigned to a classification.
// Empty string means "not set".
type Confidence string

const (
	ConfHigh Confidence = "high"
	ConfMid  Confidence = "mid"
	ConfLow  Confidence = "low"
	ConfNone Confidence = ""
)

// Entry is one row of classification metadata for a single image file.
type Entry struct {
	Filename   string     `json:"filename"`
	Folder     string     `json:"folder"`
	Confidence Confidence `json:"confidence"`
	Note       string     `json:"note"`
}

// Classification is the on-disk shape of _classification.json.
type Classification struct {
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
	Entries   []Entry   `json:"entries"`
}

// LoadResult is the merged view returned to the frontend: sidecar entries
// reconciled against the actual files on disk.
//
// - Entries: visible in the grid. Files present on disk but absent from the
//   sidecar are appended with empty Folder/Confidence/Note.
// - Orphans: in the sidecar but no file on disk. Hidden from the grid but
//   preserved when saving so the user does not lose intentional records.
// - Mtime: UnixMilli of _classification.json at load time. Used by the
//   frontend to pass back to Save/UpdateEntry for conflict detection.
//   Zero when no JSON file exists.
//   (Milliseconds — not nanoseconds — to fit JS Number safe-integer range.)
type LoadResult struct {
	FolderPath string  `json:"folderPath"`
	Entries    []Entry `json:"entries"`
	Orphans    []Entry `json:"orphans"`
	HasSidecar bool    `json:"hasSidecar"`
	Source     string  `json:"source"` // "json" | "csv" | "none"
	Mtime      int64   `json:"mtime"`
}

// SaveOutput is returned from Save/UpdateEntry/CreateEmpty so the frontend can
// update its tracked mtime after a successful write.
type SaveOutput struct {
	Mtime int64 `json:"mtime"`
}

// ErrConflict signals that the on-disk JSON was modified externally between
// the caller's last Load and the Save attempt.
var ErrConflict = errors.New("classification: external modification detected")

// ErrAlreadyExists signals that CreateEmpty would overwrite an existing sidecar.
var ErrAlreadyExists = errors.New("classification: sidecar already exists")

// ErrDuplicate signals duplicate filename entries in the sidecar.
var ErrDuplicate = errors.New("classification: duplicate filename in entries")

// ChildSidecarSummary describes one child-folder sidecar that is a candidate
// for the initial parent-merge flow (Phase 4 v1.2).
//
// Subfolder is the relative POSIX path from the parent (e.g. "child1" or
// "child1/sub"). Source is "json" or "csv". EntryCount is the total number of
// rows in the child sidecar. NonEmptyCount is the count of rows that carry
// real data (Folder, Confidence, or Note set) — the prompt is only shown when
// NonEmptyCount > 0 across all candidates so users are not bothered by
// blank-template sidecars.
type ChildSidecarSummary struct {
	Subfolder     string `json:"subfolder"`
	Source        string `json:"source"`
	EntryCount    int    `json:"entryCount"`
	NonEmptyCount int    `json:"nonEmptyCount"`
}

// MergePreview is the result of scanning a parent folder for child sidecars.
// HasNonTrivial == true means at least one ChildSidecarSummary contributes
// data worth merging; the frontend uses this to decide whether to show the
// merge prompt. When false, the caller should proceed to the normal
// "create empty sidecar?" flow.
type MergePreview struct {
	FolderPath     string                `json:"folderPath"`
	Children       []ChildSidecarSummary `json:"children"`
	HasNonTrivial  bool                  `json:"hasNonTrivial"`
	TotalEntries   int                   `json:"totalEntries"`
	TotalNonEmpty  int                   `json:"totalNonEmpty"`
}
