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
// - Mtime: UnixNano of _classification.json at load time. Used by the
//   frontend to pass back to Save/UpdateEntry for conflict detection.
//   Zero when no JSON file exists.
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
