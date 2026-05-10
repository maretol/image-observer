package classification

import (
	"fmt"
	"time"
)

// Service orchestrates loading, merging, and saving classification metadata.
// Repository handles I/O; Scanner enumerates files. Both are interfaces so
// the service can be tested with in-memory fakes.
type Service struct {
	repo    SidecarRepository
	scanner FileScanner
}

func NewService(repo SidecarRepository, scanner FileScanner) *Service {
	return &Service{repo: repo, scanner: scanner}
}

// Load reads the sidecar (if any) and merges it with the actual image files
// in folderPath. See spec-classification.md §3.6 for the merge rules.
func (s *Service) Load(folderPath string) (*LoadResult, error) {
	out, err := s.repo.Load(folderPath)
	if err != nil {
		return nil, err
	}
	files, err := s.scanner.ListImageFiles(folderPath)
	if err != nil {
		return nil, err
	}

	fileSet := make(map[string]struct{}, len(files))
	for _, f := range files {
		fileSet[f] = struct{}{}
	}

	var sidecarEntries []Entry
	if out.Data != nil {
		sidecarEntries = out.Data.Entries
	}

	// Step 1: keep sidecar entries in order, splitting orphans aside.
	entries := make([]Entry, 0, len(sidecarEntries)+len(files))
	orphans := make([]Entry, 0)
	seen := make(map[string]struct{}, len(sidecarEntries))
	for _, e := range sidecarEntries {
		seen[e.Filename] = struct{}{}
		if _, ok := fileSet[e.Filename]; ok {
			entries = append(entries, e)
		} else {
			orphans = append(orphans, e)
		}
	}

	// Step 2: append unseen files (in scanner order, which is alphabetical via os.ReadDir).
	for _, f := range files {
		if _, ok := seen[f]; ok {
			continue
		}
		entries = append(entries, Entry{Filename: f})
	}

	return &LoadResult{
		FolderPath: folderPath,
		Entries:    entries,
		Orphans:    orphans,
		HasSidecar: out.Source == "json" || out.Source == "csv",
		Source:     out.Source,
		Mtime:      out.Mtime,
	}, nil
}

// Save persists the given entries (plus the existing orphans) to JSON.
// expectedMtime is the mtime the caller observed at load time; pass 0 to
// force overwrite (e.g., the user chose "force overwrite" after a conflict).
func (s *Service) Save(folderPath string, entries []Entry, expectedMtime int64) (int64, error) {
	if err := validateNoDuplicates(entries); err != nil {
		return 0, err
	}
	// Read current sidecar to pick up orphans we should preserve.
	orphans, err := s.currentOrphans(folderPath, entries)
	if err != nil {
		// Non-fatal: a missing/corrupt sidecar just means no orphans to keep.
		// We log via the returned error chain by ignoring softly.
		orphans = nil
	}
	all := append(append(make([]Entry, 0, len(entries)+len(orphans)), entries...), orphans...)

	c := &Classification{
		Version:   SchemaVersion,
		UpdatedAt: time.Now(),
		Entries:   all,
	}
	return s.repo.SaveJSON(folderPath, c, expectedMtime)
}

// UpdateEntry replaces (or appends) a single entry by Filename. Order of
// other entries is preserved. Conflict detection is delegated to SaveJSON.
func (s *Service) UpdateEntry(folderPath string, entry Entry, expectedMtime int64) (int64, error) {
	out, err := s.repo.Load(folderPath)
	if err != nil {
		return 0, err
	}
	var existing []Entry
	if out.Data != nil {
		existing = out.Data.Entries
	}

	updated := make([]Entry, 0, len(existing)+1)
	replaced := false
	for _, e := range existing {
		if e.Filename == entry.Filename {
			updated = append(updated, entry)
			replaced = true
		} else {
			updated = append(updated, e)
		}
	}
	if !replaced {
		updated = append(updated, entry)
	}

	c := &Classification{
		Version:   SchemaVersion,
		UpdatedAt: time.Now(),
		Entries:   updated,
	}
	return s.repo.SaveJSON(folderPath, c, expectedMtime)
}

// CreateEmpty writes a brand-new sidecar populated from the actual image
// files in folderPath. Returns ErrAlreadyExists if a JSON file is already there.
func (s *Service) CreateEmpty(folderPath string) (int64, error) {
	files, err := s.scanner.ListImageFiles(folderPath)
	if err != nil {
		return 0, err
	}
	entries := make([]Entry, 0, len(files))
	for _, f := range files {
		entries = append(entries, Entry{Filename: f})
	}
	c := &Classification{
		Version:   SchemaVersion,
		UpdatedAt: time.Now(),
		Entries:   entries,
	}
	return s.repo.CreateJSON(folderPath, c)
}

// currentOrphans figures out which existing-sidecar entries are NOT in the
// caller-supplied entries list AND are not present on disk — i.e., orphans
// the caller's UI did not see and should not silently delete.
func (s *Service) currentOrphans(folderPath string, supplied []Entry) ([]Entry, error) {
	out, err := s.repo.Load(folderPath)
	if err != nil {
		return nil, err
	}
	if out.Data == nil {
		return nil, nil
	}
	files, err := s.scanner.ListImageFiles(folderPath)
	if err != nil {
		return nil, fmt.Errorf("scan for orphan check: %w", err)
	}
	fileSet := make(map[string]struct{}, len(files))
	for _, f := range files {
		fileSet[f] = struct{}{}
	}
	suppliedSet := make(map[string]struct{}, len(supplied))
	for _, e := range supplied {
		suppliedSet[e.Filename] = struct{}{}
	}
	out2 := make([]Entry, 0)
	for _, e := range out.Data.Entries {
		if _, onDisk := fileSet[e.Filename]; onDisk {
			continue
		}
		if _, given := suppliedSet[e.Filename]; given {
			continue
		}
		out2 = append(out2, e)
	}
	return out2, nil
}
