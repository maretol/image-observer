package classification

import (
	"errors"
	"sync"
	"testing"
)

// fakeRepo is an in-memory SidecarRepository for service tests.
type fakeRepo struct {
	mu        sync.Mutex
	data      *Classification
	mtime     int64
	source    string
	loadErr   error
	saveErr   error
	createErr error
	saves     []*Classification
}

func (f *fakeRepo) Load(folderPath string) (LoadOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.loadErr != nil {
		return LoadOutput{}, f.loadErr
	}
	if f.data == nil {
		return LoadOutput{Source: "none"}, nil
	}
	src := f.source
	if src == "" {
		src = "json"
	}
	cp := *f.data
	cp.Entries = append([]Entry(nil), f.data.Entries...)
	return LoadOutput{Data: &cp, Source: src, Mtime: f.mtime}, nil
}

func (f *fakeRepo) SaveJSON(folderPath string, c *Classification, expectedMtime int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.saveErr != nil {
		return 0, f.saveErr
	}
	if expectedMtime > 0 && expectedMtime != f.mtime {
		return 0, ErrConflict
	}
	cp := *c
	cp.Entries = append([]Entry(nil), c.Entries...)
	f.data = &cp
	f.mtime++
	if f.mtime == 0 {
		f.mtime = 1
	}
	f.source = "json"
	f.saves = append(f.saves, &cp)
	return f.mtime, nil
}

func (f *fakeRepo) CreateJSON(folderPath string, c *Classification) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return 0, f.createErr
	}
	if f.data != nil {
		return 0, ErrAlreadyExists
	}
	f.mu.Unlock()
	mtime, err := f.SaveJSON(folderPath, c, 0)
	f.mu.Lock()
	return mtime, err
}

type fakeScanner struct {
	files []string
	// times は ListImageFiles の第 2 戻り値 (nil なら空 map)。実 walk での収集は
	// scanner_test.go 側で検証し、service 側は passthrough だけを見る。
	times map[string]int64
	err   error
}

func (s fakeScanner) ListImageFiles(folderPath string) ([]string, map[string]int64, error) {
	if s.err != nil {
		return nil, nil, s.err
	}
	times := make(map[string]int64, len(s.times))
	for k, v := range s.times {
		times[k] = v
	}
	return append([]string(nil), s.files...), times, nil
}

func TestService_Load_MergeAddsUnclassifiedAtEnd(t *testing.T) {
	repo := &fakeRepo{
		mtime:  100,
		source: "json",
		data: &Classification{
			Version: SchemaVersion,
			Entries: []Entry{
				{Filename: "a.jpg", Folder: "iroha"},
				{Filename: "b.png"},
			},
		},
	}
	scn := fakeScanner{files: []string{"a.jpg", "b.png", "c.gif", "d.webp"}}
	svc := NewService(repo, scn)
	res, err := svc.Load("/folder")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !res.HasSidecar || res.Source != "json" || res.Mtime != 100 {
		t.Errorf("metadata wrong: %+v", res)
	}
	gotNames := make([]string, len(res.Entries))
	for i, e := range res.Entries {
		gotNames[i] = e.Filename
	}
	want := []string{"a.jpg", "b.png", "c.gif", "d.webp"}
	if !equalSlice(gotNames, want) {
		t.Errorf("entry order = %v, want %v (sidecar order then new files)", gotNames, want)
	}
	if len(res.Orphans) != 0 {
		t.Errorf("expected no orphans, got %v", res.Orphans)
	}
}

func TestService_Load_OrphansSplitOut(t *testing.T) {
	repo := &fakeRepo{
		data: &Classification{
			Entries: []Entry{
				{Filename: "exists.jpg", Folder: "x"},
				{Filename: "gone.png", Folder: "y"},
			},
		},
	}
	scn := fakeScanner{files: []string{"exists.jpg"}}
	svc := NewService(repo, scn)
	res, err := svc.Load("/folder")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(res.Entries) != 1 || res.Entries[0].Filename != "exists.jpg" {
		t.Errorf("entries = %+v, want only exists.jpg", res.Entries)
	}
	if len(res.Orphans) != 1 || res.Orphans[0].Filename != "gone.png" {
		t.Errorf("orphans = %+v, want only gone.png", res.Orphans)
	}
}

func TestService_Load_NoSidecar(t *testing.T) {
	repo := &fakeRepo{}
	scn := fakeScanner{files: []string{"a.jpg", "b.png"}}
	svc := NewService(repo, scn)
	res, err := svc.Load("/folder")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if res.HasSidecar || res.Source != "none" {
		t.Errorf("expected HasSidecar=false Source=none, got %+v", res)
	}
	if len(res.Entries) != 2 {
		t.Errorf("entries=%d, want 2 (all unclassified)", len(res.Entries))
	}
	for _, e := range res.Entries {
		if e.Folder != "" || e.Confidence != "" || e.Note != "" {
			t.Errorf("synthetic entry must be empty, got %+v", e)
		}
	}
}

func TestService_UpdateEntry_ReplaceAndAppend(t *testing.T) {
	repo := &fakeRepo{
		mtime: 50,
		data: &Classification{
			Entries: []Entry{
				{Filename: "a.jpg", Folder: "old"},
				{Filename: "b.png"},
			},
		},
	}
	scn := fakeScanner{files: []string{"a.jpg", "b.png"}}
	svc := NewService(repo, scn)

	// Replace existing.
	if _, err := svc.UpdateEntry("/folder", Entry{Filename: "a.jpg", Folder: "new"}, 50); err != nil {
		t.Fatalf("UpdateEntry replace: %v", err)
	}
	if got := repo.data.Entries[0].Folder; got != "new" {
		t.Errorf("first entry Folder = %q, want new", got)
	}

	// Append (filename not in sidecar).
	if _, err := svc.UpdateEntry("/folder", Entry{Filename: "c.gif", Folder: "z"}, repo.mtime); err != nil {
		t.Fatalf("UpdateEntry append: %v", err)
	}
	last := repo.data.Entries[len(repo.data.Entries)-1]
	if last.Filename != "c.gif" || last.Folder != "z" {
		t.Errorf("appended entry = %+v", last)
	}
}

func TestService_UpdateEntry_ConflictPropagates(t *testing.T) {
	repo := &fakeRepo{
		mtime: 100,
		data: &Classification{
			Entries: []Entry{{Filename: "a.jpg"}},
		},
	}
	scn := fakeScanner{files: []string{"a.jpg"}}
	svc := NewService(repo, scn)
	_, err := svc.UpdateEntry("/folder", Entry{Filename: "a.jpg", Folder: "x"}, 99 /* stale */)
	if !errors.Is(err, ErrConflict) {
		t.Errorf("want ErrConflict, got %v", err)
	}
}

func TestService_Save_PreservesOrphans(t *testing.T) {
	repo := &fakeRepo{
		mtime: 10,
		data: &Classification{
			Entries: []Entry{
				{Filename: "a.jpg"},
				{Filename: "ghost.png", Folder: "old"},
			},
		},
	}
	scn := fakeScanner{files: []string{"a.jpg"}} // ghost.png is missing → orphan
	svc := NewService(repo, scn)

	// Caller saves only a.jpg (visible entries). The orphan must survive on disk.
	if _, err := svc.Save("/folder", []Entry{{Filename: "a.jpg", Folder: "now"}}, 10); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got := repo.data.Entries
	names := make([]string, len(got))
	for i, e := range got {
		names[i] = e.Filename
	}
	if !equalSlice(names, []string{"a.jpg", "ghost.png"}) {
		t.Errorf("orphan dropped: %v", names)
	}
}

func TestService_CreateEmpty(t *testing.T) {
	repo := &fakeRepo{}
	scn := fakeScanner{files: []string{"a.jpg", "b.png"}}
	svc := NewService(repo, scn)
	if _, err := svc.CreateEmpty("/folder"); err != nil {
		t.Fatalf("CreateEmpty: %v", err)
	}
	if len(repo.data.Entries) != 2 {
		t.Errorf("entries=%d, want 2", len(repo.data.Entries))
	}
	for _, e := range repo.data.Entries {
		if e.Folder != "" || e.Confidence != "" || e.Note != "" {
			t.Errorf("entry must be empty: %+v", e)
		}
	}

	// Second CreateEmpty must fail.
	if _, err := svc.CreateEmpty("/folder"); !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("second CreateEmpty: want ErrAlreadyExists, got %v", err)
	}
}

// #144: FileTimes は scanner が walk 中に収集した map の passthrough。orphan (sidecar のみで
// scanner が列挙しないファイル) は行を持たない。実 walk での mtime 収集は scanner_test.go 側で検証。
func TestService_Load_FileTimes(t *testing.T) {
	repo := &fakeRepo{
		mtime:  100,
		source: "json",
		data: &Classification{
			Version: SchemaVersion,
			Entries: []Entry{{Filename: "ghost.png"}}, // orphan (disk に無い)
		},
	}
	scn := fakeScanner{
		files: []string{"a.jpg", "child/b.png", "locked.gif"},
		// locked.gif は Info() 失敗を模して行なし。
		times: map[string]int64{"a.jpg": 1000, "child/b.png": 2000},
	}
	svc := NewService(repo, scn)
	res, err := svc.Load("/folder")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got, want := res.FileTimes["a.jpg"], int64(1000); got != want {
		t.Errorf("FileTimes[a.jpg] = %d, want %d", got, want)
	}
	if got, want := res.FileTimes["child/b.png"], int64(2000); got != want {
		t.Errorf("FileTimes[child/b.png] = %d, want %d", got, want)
	}
	if _, ok := res.FileTimes["ghost.png"]; ok {
		t.Errorf("orphan ghost.png must not have a FileTimes row")
	}
	if _, ok := res.FileTimes["locked.gif"]; ok {
		t.Errorf("Info()-failed locked.gif must not have a FileTimes row")
	}
	if len(res.FileTimes) != 2 {
		t.Errorf("FileTimes size = %d, want 2 (%v)", len(res.FileTimes), res.FileTimes)
	}
}
