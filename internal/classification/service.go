package classification

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Service は分類メタデータの load / merge / save をまとめる。Repository (I/O) と Scanner (列挙) は
// interface で in-memory fake でテストできる。
type Service struct {
	repo    SidecarRepository
	scanner FileScanner
}

func NewService(repo SidecarRepository, scanner FileScanner) *Service {
	return &Service{repo: repo, scanner: scanner}
}

// Load は sidecar を読み folderPath の実画像ファイルとマージする (merge ルール: spec-classification.md §3.6)。
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

	// Step 1: sidecar entry を順序保持し、orphan を分離。
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

	// Step 2: 未見ファイルを追加 (scanner 順 = os.ReadDir の alphabetical)。
	for _, f := range files {
		if _, ok := seen[f]; ok {
			continue
		}
		entries = append(entries, Entry{Filename: f})
	}

	// Step 3: mtime ソート (#144) 用の FileTimes。stat 失敗 (コピー中ロック / race で消失) は
	// 行を持たず、エラーにしない。
	fileTimes := make(map[string]int64, len(files))
	for _, f := range files {
		info, err := os.Stat(filepath.Join(folderPath, filepath.FromSlash(f)))
		if err != nil {
			continue
		}
		fileTimes[f] = info.ModTime().Unix()
	}

	return &LoadResult{
		FolderPath: folderPath,
		Entries:    entries,
		Orphans:    orphans,
		HasSidecar: out.Source == "json" || out.Source == "csv",
		Source:     out.Source,
		Mtime:      out.Mtime,
		FileTimes:  fileTimes,
	}, nil
}

// Save は entries (+ 既存 orphans) を JSON へ永続化する。expectedMtime は caller が load 時に見た
// mtime。強制上書きは 0 を渡す (conflict 後にユーザーが「強制上書き」を選んだ等)。
func (s *Service) Save(folderPath string, entries []Entry, expectedMtime int64) (int64, error) {
	if err := validateNoDuplicates(entries); err != nil {
		return 0, err
	}
	// 保持すべき orphan を拾うため現在の sidecar を読む。
	orphans, err := s.currentOrphans(folderPath, entries)
	if err != nil {
		// 非致命: sidecar 欠落/破損は保持 orphan なしを意味するだけ。
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

// UpdateEntry は Filename で 1 entry を置換 (無ければ追加)。他 entry の順序は保持。conflict 検出は SaveJSON に委譲。
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

// CreateEmpty は folderPath の実画像から新規 sidecar を書く。JSON が既にあれば ErrAlreadyExists。
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

// currentOrphans は既存 sidecar entry のうち、caller の entries に無く disk にも無いもの
// (= caller の UI が見ておらず silent に消すべきでない orphan) を割り出す。
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
