package classification

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// SidecarRepository abstracts CSV/JSON I/O so Service can be tested with
// in-memory implementations. The default implementation is fileRepo below.
type SidecarRepository interface {
	// Load reads either _classification.json (preferred) or _classification.csv
	// from folderPath. Returns Source="none" with nil Data when neither exists.
	// Mtime is the UnixMilli of _classification.json (0 if absent or CSV-only).
	// We use milliseconds, not nanoseconds, because UnixNano (~1.78e18 in 2026)
	// exceeds JavaScript Number.MAX_SAFE_INTEGER (~9e15) and would lose precision
	// when round-tripped through Wails IPC, breaking conflict detection.
	Load(folderPath string) (LoadOutput, error)

	// SaveJSON writes _classification.json atomically with a .bak rotation.
	// If expectedMtime > 0 the on-disk mtime is checked first and ErrConflict
	// is returned on mismatch. expectedMtime == 0 forces overwrite.
	// Returns the new mtime on success.
	SaveJSON(folderPath string, c *Classification, expectedMtime int64) (int64, error)

	// CreateJSON writes a brand-new _classification.json. Returns
	// ErrAlreadyExists if a JSON file is already there.
	CreateJSON(folderPath string, c *Classification) (int64, error)
}

// LoadOutput is the raw repository result before merging with on-disk files.
type LoadOutput struct {
	Data   *Classification
	Source string // "json" | "csv" | "none"
	Mtime  int64
}

// NewFileRepository returns the default repository backed by the local filesystem.
func NewFileRepository() SidecarRepository {
	return fileRepo{}
}

type fileRepo struct{}

func (fileRepo) Load(folderPath string) (LoadOutput, error) {
	jsonPath := filepath.Join(folderPath, SidecarJSON)
	if info, err := os.Stat(jsonPath); err == nil && !info.IsDir() {
		c, err := readJSON(jsonPath)
		if err != nil {
			return LoadOutput{}, err
		}
		return LoadOutput{Data: c, Source: "json", Mtime: info.ModTime().UnixMilli()}, nil
	} else if err != nil && !os.IsNotExist(err) {
		return LoadOutput{}, fmt.Errorf("stat json: %w", err)
	}

	csvPath := filepath.Join(folderPath, SidecarCSV)
	if info, err := os.Stat(csvPath); err == nil && !info.IsDir() {
		c, err := readCSV(csvPath)
		if err != nil {
			return LoadOutput{}, err
		}
		return LoadOutput{Data: c, Source: "csv", Mtime: 0}, nil
	} else if err != nil && !os.IsNotExist(err) {
		return LoadOutput{}, fmt.Errorf("stat csv: %w", err)
	}

	return LoadOutput{Data: nil, Source: "none", Mtime: 0}, nil
}

func (fileRepo) SaveJSON(folderPath string, c *Classification, expectedMtime int64) (int64, error) {
	jsonPath := filepath.Join(folderPath, SidecarJSON)
	bakPath := filepath.Join(folderPath, BackupJSON)
	tmpPath := filepath.Join(folderPath, TempJSON)

	// Conflict check: if expectedMtime is set, compare against current mtime.
	if expectedMtime > 0 {
		info, err := os.Stat(jsonPath)
		switch {
		case err == nil:
			// A directory now occupies the sidecar path (e.g. the user
			// or an external tool replaced the file with a same-named
			// dir between Load and Save). Mtime may even match by
			// coincidence, so the equality check below isn't enough.
			// The subsequent backup / WriteFile / Rename would fail
			// with an opaque IO error far from the actual cause;
			// surface it as ErrConflict so the frontend's standard
			// conflict dialog gives the user a choice, same as the
			// file-gone case below (PR #75 25th, thread B).
			if info.IsDir() {
				return 0, ErrConflict
			}
			if info.ModTime().UnixMilli() != expectedMtime {
				return 0, ErrConflict
			}
		case os.IsNotExist(err):
			// The file went away entirely between Load and Save (the
			// user was editing, an external delete removed the sidecar).
			// expectedMtime was non-zero, meaning the caller observed
			// the file at Load — re-creating it silently here would
			// silently overwrite whatever caused the delete (e.g. an
			// AI tool resetting state). Surface as ErrConflict so the
			// frontend's standard conflict dialog gives the user a
			// choice (PR #75 16th, thread E).
			return 0, ErrConflict
		default:
			return 0, fmt.Errorf("stat for conflict check: %w", err)
		}
	}

	// Backup existing JSON (best-effort; missing is fine for first save).
	if _, err := os.Stat(jsonPath); err == nil {
		if err := copyFile(jsonPath, bakPath); err != nil {
			return 0, fmt.Errorf("backup: %w", err)
		}
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return 0, fmt.Errorf("marshal: %w", err)
	}
	data = append(data, '\n')

	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return 0, fmt.Errorf("write tmp: %w", err)
	}
	if err := os.Rename(tmpPath, jsonPath); err != nil {
		_ = os.Remove(tmpPath)
		return 0, fmt.Errorf("rename: %w", err)
	}

	info, err := os.Stat(jsonPath)
	if err != nil {
		return 0, fmt.Errorf("stat after save: %w", err)
	}
	return info.ModTime().UnixMilli(), nil
}

func (r fileRepo) CreateJSON(folderPath string, c *Classification) (int64, error) {
	jsonPath := filepath.Join(folderPath, SidecarJSON)
	if _, err := os.Stat(jsonPath); err == nil {
		return 0, ErrAlreadyExists
	} else if !os.IsNotExist(err) {
		return 0, fmt.Errorf("stat: %w", err)
	}
	return r.SaveJSON(folderPath, c, 0)
}

func readJSON(path string) (*Classification, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	raw = stripBOM(raw)
	var c Classification
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}
	if err := validateNoDuplicates(c.Entries); err != nil {
		return nil, err
	}
	return &c, nil
}

func readCSV(path string) (*Classification, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	raw = stripBOM(raw)
	r := csv.NewReader(bytes.NewReader(raw))
	r.FieldsPerRecord = -1

	header, err := r.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return &Classification{Version: SchemaVersion, Entries: []Entry{}}, nil
		}
		return nil, fmt.Errorf("read header: %w", err)
	}
	idx := buildCSVIndex(header)
	if idx.filename < 0 {
		return nil, fmt.Errorf("csv: missing 'filename' column")
	}

	entries := make([]Entry, 0)
	for {
		row, err := r.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("read row: %w", err)
		}
		entries = append(entries, Entry{
			Filename:   pick(row, idx.filename),
			Folder:     pick(row, idx.folder),
			Confidence: Confidence(pick(row, idx.confidence)),
			Note:       pick(row, idx.note),
		})
	}
	if err := validateNoDuplicates(entries); err != nil {
		return nil, err
	}
	return &Classification{
		Version: SchemaVersion,
		Entries: entries,
	}, nil
}

type csvIndex struct {
	filename, folder, confidence, note int
}

func buildCSVIndex(header []string) csvIndex {
	idx := csvIndex{filename: -1, folder: -1, confidence: -1, note: -1}
	for i, h := range header {
		switch strings.TrimSpace(strings.ToLower(h)) {
		case "filename":
			idx.filename = i
		case "folder", "proposed_folder":
			idx.folder = i
		case "confidence":
			idx.confidence = i
		case "note":
			idx.note = i
		}
	}
	return idx
}

func pick(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return row[i]
}

func validateNoDuplicates(entries []Entry) error {
	seen := make(map[string]struct{}, len(entries))
	for _, e := range entries {
		if _, dup := seen[e.Filename]; dup {
			return fmt.Errorf("%w: %q", ErrDuplicate, e.Filename)
		}
		seen[e.Filename] = struct{}{}
	}
	return nil
}

func stripBOM(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return b[3:]
	}
	return b
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
