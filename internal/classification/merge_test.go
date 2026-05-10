package classification

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writeJSONSidecar(t *testing.T, dir string, entries []Entry) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	c := &Classification{Version: SchemaVersion, Entries: entries}
	if _, err := NewFileRepository().SaveJSON(dir, c, 0); err != nil {
		t.Fatalf("write sidecar in %s: %v", dir, err)
	}
}

func newTestService() *Service {
	return NewService(NewFileRepository(), NewFileScanner())
}

func TestPreviewChildSidecars_NoChildren(t *testing.T) {
	svc := newTestService()
	dir := t.TempDir()
	preview, err := svc.PreviewChildSidecars(dir)
	if err != nil {
		t.Fatalf("PreviewChildSidecars: %v", err)
	}
	if preview.HasNonTrivial || len(preview.Children) != 0 {
		t.Errorf("preview should be empty, got %+v", preview)
	}
}

func TestPreviewChildSidecars_NonTrivialDetected(t *testing.T) {
	svc := newTestService()
	parent := t.TempDir()
	writeJSONSidecar(t, filepath.Join(parent, "child1"), []Entry{
		{Filename: "a.jpg", Folder: "iroha", Confidence: ConfHigh, Note: "n1"},
		{Filename: "b.png"}, // empty
	})
	writeJSONSidecar(t, filepath.Join(parent, "child2"), []Entry{
		{Filename: "x.gif"}, // all empty → no contribution
	})

	preview, err := svc.PreviewChildSidecars(parent)
	if err != nil {
		t.Fatalf("PreviewChildSidecars: %v", err)
	}
	if !preview.HasNonTrivial {
		t.Errorf("expected HasNonTrivial=true, got %+v", preview)
	}
	if len(preview.Children) != 2 {
		t.Fatalf("Children=%d, want 2", len(preview.Children))
	}
	if preview.Children[0].Subfolder != "child1" || preview.Children[1].Subfolder != "child2" {
		t.Errorf("Subfolder ordering = [%s, %s], want [child1, child2]",
			preview.Children[0].Subfolder, preview.Children[1].Subfolder)
	}
	if preview.Children[0].NonEmptyCount != 1 {
		t.Errorf("child1 NonEmptyCount = %d, want 1", preview.Children[0].NonEmptyCount)
	}
	if preview.Children[1].NonEmptyCount != 0 {
		t.Errorf("child2 NonEmptyCount = %d, want 0", preview.Children[1].NonEmptyCount)
	}
}

func TestPreviewChildSidecars_AllTrivialReturnsFalse(t *testing.T) {
	svc := newTestService()
	parent := t.TempDir()
	writeJSONSidecar(t, filepath.Join(parent, "child1"), []Entry{
		{Filename: "a.jpg"}, // empty
		{Filename: "b.png"},
	})

	preview, err := svc.PreviewChildSidecars(parent)
	if err != nil {
		t.Fatalf("PreviewChildSidecars: %v", err)
	}
	if preview.HasNonTrivial {
		t.Errorf("expected HasNonTrivial=false when all entries are blank, got %+v", preview)
	}
	// We still report the children so the frontend can decide what to display.
	if len(preview.Children) != 1 {
		t.Errorf("Children=%d, want 1", len(preview.Children))
	}
}

func TestPreviewChildSidecars_HiddenDirsSkipped(t *testing.T) {
	svc := newTestService()
	parent := t.TempDir()
	writeJSONSidecar(t, filepath.Join(parent, ".hidden"), []Entry{
		{Filename: "a.jpg", Folder: "iroha"},
	})

	preview, err := svc.PreviewChildSidecars(parent)
	if err != nil {
		t.Fatalf("PreviewChildSidecars: %v", err)
	}
	if len(preview.Children) != 0 {
		t.Errorf("hidden child should be skipped, got %+v", preview.Children)
	}
}

func TestMergeChildSidecars_PrefixesAndPreserves(t *testing.T) {
	svc := newTestService()
	parent := t.TempDir()
	// Create real image files so the post-merge fill picks them up.
	writeFile(t, filepath.Join(parent, "child1", "a.jpg"))
	writeFile(t, filepath.Join(parent, "child1", "b.png"))
	writeFile(t, filepath.Join(parent, "child2", "x.gif"))
	writeFile(t, filepath.Join(parent, "direct.webp"))
	writeJSONSidecar(t, filepath.Join(parent, "child1"), []Entry{
		{Filename: "a.jpg", Folder: "iroha", Confidence: ConfHigh, Note: "n"},
		{Filename: "b.png", Folder: "kaguya"},
	})
	writeJSONSidecar(t, filepath.Join(parent, "child2"), []Entry{
		{Filename: "x.gif", Folder: "shugo (a + b)"},
	})

	if _, err := svc.MergeChildSidecars(parent); err != nil {
		t.Fatalf("MergeChildSidecars: %v", err)
	}

	out, err := NewFileRepository().Load(parent)
	if err != nil {
		t.Fatalf("Load parent: %v", err)
	}
	if out.Source != "json" {
		t.Fatalf("Source = %q, want json", out.Source)
	}
	got := make(map[string]Entry, len(out.Data.Entries))
	for _, e := range out.Data.Entries {
		got[e.Filename] = e
	}
	for _, want := range []struct {
		filename string
		folder   string
	}{
		{"child1/a.jpg", "iroha"},
		{"child1/b.png", "kaguya"},
		{"child2/x.gif", "shugo (a + b)"},
		{"direct.webp", ""}, // direct file appended as empty
	} {
		e, ok := got[want.filename]
		if !ok {
			t.Errorf("missing entry %q", want.filename)
			continue
		}
		if e.Folder != want.folder {
			t.Errorf("entry %q Folder = %q, want %q", want.filename, e.Folder, want.folder)
		}
	}
}

func TestMergeChildSidecars_RefusesWhenParentExists(t *testing.T) {
	svc := newTestService()
	parent := t.TempDir()
	writeJSONSidecar(t, parent, []Entry{{Filename: "x.jpg"}})
	writeJSONSidecar(t, filepath.Join(parent, "child1"), []Entry{
		{Filename: "a.jpg", Folder: "iroha"},
	})
	_, err := svc.MergeChildSidecars(parent)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("want ErrAlreadyExists, got %v", err)
	}
}

func TestMergeChildSidecars_LeavesChildSidecarsInPlace(t *testing.T) {
	svc := newTestService()
	parent := t.TempDir()
	writeFile(t, filepath.Join(parent, "child1", "a.jpg"))
	childSidecar := filepath.Join(parent, "child1", SidecarJSON)
	writeJSONSidecar(t, filepath.Join(parent, "child1"), []Entry{
		{Filename: "a.jpg", Folder: "iroha"},
	})

	before, err := os.ReadFile(childSidecar)
	if err != nil {
		t.Fatalf("read child sidecar before: %v", err)
	}
	if _, err := svc.MergeChildSidecars(parent); err != nil {
		t.Fatalf("MergeChildSidecars: %v", err)
	}
	after, err := os.ReadFile(childSidecar)
	if err != nil {
		t.Fatalf("read child sidecar after: %v", err)
	}
	if string(before) != string(after) {
		t.Errorf("child sidecar must remain untouched after merge")
	}
}
