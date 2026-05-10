package classification

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// PreviewChildSidecars walks the parent's immediate child directories looking
// for sidecar files (_classification.json or _classification.csv) and returns
// a summary the frontend can show in the merge-prompt dialog.
//
// Behavior:
//   - The parent folder's own sidecar (if any) does NOT appear in the result;
//     callers are expected to gate this entire flow on parent having no sidecar.
//   - Hidden directories (".prefix") are skipped.
//   - Recursion is one level deep — only direct children are considered.
//     Sidecars deeper than one level are ignored (rare in practice and
//     supporting them would complicate the merge prefix logic).
//   - When both JSON and CSV exist in the same child, JSON wins (matches the
//     repository's load preference).
//   - Per-child read errors are skipped silently so a single broken sidecar
//     does not block the prompt for legitimate ones.
func (s *Service) PreviewChildSidecars(folderPath string) (*MergePreview, error) {
	entries, err := os.ReadDir(folderPath)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}
	preview := &MergePreview{FolderPath: folderPath, Children: []ChildSidecarSummary{}}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if isHiddenName(name) {
			continue
		}
		childPath := filepath.Join(folderPath, name)
		out, err := s.repo.Load(childPath)
		if err != nil {
			continue // best-effort: a corrupt child sidecar should not block others
		}
		if out.Source == "none" || out.Data == nil {
			continue
		}
		nonEmpty := countNonEmpty(out.Data.Entries)
		preview.Children = append(preview.Children, ChildSidecarSummary{
			Subfolder:     filepath.ToSlash(name),
			Source:        out.Source,
			EntryCount:    len(out.Data.Entries),
			NonEmptyCount: nonEmpty,
		})
		preview.TotalEntries += len(out.Data.Entries)
		preview.TotalNonEmpty += nonEmpty
	}
	sort.Slice(preview.Children, func(i, j int) bool {
		return preview.Children[i].Subfolder < preview.Children[j].Subfolder
	})
	preview.HasNonTrivial = preview.TotalNonEmpty > 0
	return preview, nil
}

// MergeChildSidecars reads every child sidecar found by PreviewChildSidecars
// and writes a parent _classification.json that contains all entries with
// their filenames prefixed by the child folder name (e.g. "hoge.png" becomes
// "child1/hoge.png").
//
// Idempotency: this is a one-shot migration. Calling it when the parent
// already has a sidecar returns ErrAlreadyExists and writes nothing — the
// frontend is expected to gate the call on parent having no sidecar.
//
// Child sidecars themselves are left in place (delete/move out of scope per
// user direction; users may continue to consume them with other tools).
func (s *Service) MergeChildSidecars(folderPath string) (int64, error) {
	// Only run when the parent has no existing sidecar — the same precondition
	// as PreviewChildSidecars; without this guard we could accidentally
	// overwrite a parent the user has already started maintaining.
	parentOut, err := s.repo.Load(folderPath)
	if err != nil {
		return 0, err
	}
	if parentOut.Source != "none" {
		return 0, ErrAlreadyExists
	}

	entries, err := os.ReadDir(folderPath)
	if err != nil {
		return 0, fmt.Errorf("read dir: %w", err)
	}

	merged := make([]Entry, 0)
	seen := make(map[string]struct{})

	// Stable ordering: sort child names so the resulting sidecar is
	// deterministic across platforms with different ReadDir order.
	type childRec struct {
		name string
		path string
	}
	children := make([]childRec, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if isHiddenName(e.Name()) {
			continue
		}
		children = append(children, childRec{name: e.Name(), path: filepath.Join(folderPath, e.Name())})
	}
	sort.Slice(children, func(i, j int) bool { return children[i].name < children[j].name })

	for _, child := range children {
		out, err := s.repo.Load(child.path)
		if err != nil || out.Source == "none" || out.Data == nil {
			continue
		}
		prefix := filepath.ToSlash(child.name) + "/"
		for _, e := range out.Data.Entries {
			fname := prefix + e.Filename
			if _, dup := seen[fname]; dup {
				continue // shouldn't happen with prefixed paths, but be safe
			}
			seen[fname] = struct{}{}
			merged = append(merged, Entry{
				Filename:   fname,
				Folder:     e.Folder,
				Confidence: e.Confidence,
				Note:       e.Note,
			})
		}
	}

	// Append any direct-child files of the parent that aren't already covered
	// by the merged set. Without this step, brand-new images directly under
	// parent would not appear in the sidecar until the user re-saved.
	files, err := s.scanner.ListImageFiles(folderPath)
	if err != nil {
		return 0, fmt.Errorf("post-merge scan: %w", err)
	}
	for _, f := range files {
		if _, dup := seen[f]; dup {
			continue
		}
		// Skip files that live under a child whose sidecar we already merged —
		// those entries already exist (possibly as orphans from a child
		// sidecar's perspective, but that's fine).
		if strings.Contains(f, "/") && hasMergedPrefix(seen, f) {
			continue
		}
		merged = append(merged, Entry{Filename: f})
		seen[f] = struct{}{}
	}

	c := &Classification{
		Version:   SchemaVersion,
		UpdatedAt: time.Now(),
		Entries:   merged,
	}
	return s.repo.CreateJSON(folderPath, c)
}

// hasMergedPrefix returns true if any key in seen has the same first path
// segment as f. Used during post-merge filling so we don't double-add files
// from a child whose sidecar contributed orphans (entries pointing to no real
// file) — those already exist in `seen` and will be picked up directly.
func hasMergedPrefix(seen map[string]struct{}, f string) bool {
	slash := strings.IndexByte(f, '/')
	if slash < 0 {
		return false
	}
	prefix := f[:slash+1]
	for k := range seen {
		if strings.HasPrefix(k, prefix) {
			return true
		}
	}
	return false
}

func countNonEmpty(entries []Entry) int {
	n := 0
	for _, e := range entries {
		if e.Folder != "" || e.Confidence != "" || e.Note != "" {
			n++
		}
	}
	return n
}

