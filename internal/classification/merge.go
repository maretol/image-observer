package classification

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// PreviewChildSidecars は親の直下子 dir を walk し sidecar (_classification.json/.csv) を探し、
// merge-prompt dialog 用の summary を返す。
//
// 挙動:
//   - 親自身の sidecar は結果に出さない (呼び出し側が「親に sidecar 無し」で gate する前提)。
//   - hidden dir (".prefix") は skip。
//   - 再帰は 1 段だけ (直下子のみ。深い sidecar は無視 — 稀 + merge prefix 論理が複雑になる)。
//   - 同じ子に JSON と CSV があれば JSON 優先 (repository の load 優先に合わせる)。
//   - 子ごとの read エラーは silent skip (1 つ壊れた sidecar が正常な子の prompt を止めない)。
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
			continue // best-effort: 壊れた子 sidecar が他を止めない
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

// MergeChildSidecars は PreviewChildSidecars が見つけた各子 sidecar を読み、filename を子フォルダ名で
// prefix した全 entry を持つ親 _classification.json を書く ("hoge.png" → "child1/hoge.png")。
//
// 冪等性: 一度きりの移行。親に既に sidecar があれば ErrAlreadyExists で何も書かない (frontend が
// 「親に sidecar 無し」で gate する前提)。子 sidecar 自体は残す (削除/移動はスコープ外)。
func (s *Service) MergeChildSidecars(folderPath string) (int64, error) {
	// 親に既存 sidecar が無いときだけ実行 (PreviewChildSidecars と同じ前提)。guard が無いと、user が
	// 既にメンテし始めた親を誤って上書きしうる。
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

	// 安定順序: 子名を sort し、ReadDir 順が異なる platform でも結果 sidecar が決定的になるように。
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
				continue // prefix 付き path では起きない想定だが安全策
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

	// merged に未収録の親直下ファイルを追加。この step が無いと、親直下の新規画像が再 save まで
	// sidecar に現れない。
	files, _, err := s.scanner.ListImageFiles(folderPath)
	if err != nil {
		return 0, fmt.Errorf("post-merge scan: %w", err)
	}
	for _, f := range files {
		if _, dup := seen[f]; dup {
			continue
		}
		// 既に merge した子 sidecar 配下のファイルは skip (その entry は既に存在 — 子 sidecar 視点で
		// orphan かもしれないがそれでよい)。
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

// hasMergedPrefix は seen のいずれかの key が f と最初の path segment を共有すれば true。post-merge
// 充填で、orphan (実ファイル無しの entry) を出した子由来のファイルを二重追加しないため — それらは
// 既に seen にあり直接拾われる。
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
