package imghash

import (
	"fmt"
	"image"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"image-observer/internal/imgdecode"
	"image-observer/internal/imgfile"
	"image-observer/internal/logging"
)

// DuplicatePair は距離がしきい値以内で dismiss されていない 1 ペア。FileA/FileB は
// classification entry と同じ POSIX 相対 path ("child1/foo.png")。FileA < FileB (辞書順) に正規化。
type DuplicatePair struct {
	FileA    string `json:"fileA"`
	FileB    string `json:"fileB"`
	Distance int    `json:"distance"`
}

// DuplicateReport は 1 フォルダ分の検出結果 (spec §4.1)。
type DuplicateReport struct {
	FolderPath string `json:"folderPath"`
	// Pairs は (FileA, FileB) 辞書順で決定的に並ぶ。
	Pairs []DuplicatePair `json:"pairs"`
	// Skipped は判定対象外 (AVIF / 非対応拡張子 / stat・decode 失敗)。バッジは出さない。
	Skipped []string `json:"skipped"`
}

// Service は Check / Dismiss の入口。folder 単位 mutex で index の read-modify-write を
// 直列化する (spec §6.1)。
type Service struct {
	mu        sync.Mutex
	folderMus map[string]*sync.Mutex
	// workers はハッシュ計算 (decode がボトルネック) の並行上限。サムネの pool とは独立し
	// 相互にブロックしない (spec §13 D8)。
	workers int
	// decode はテストが呼び出し回数を数えるための DI 点 (spec §10.1)。
	decode func(path, ext string) (image.Image, error)
}

func NewService() *Service {
	return &Service{
		folderMus: map[string]*sync.Mutex{},
		workers:   defaultWorkerCount(),
		decode:    imgdecode.Decode,
	}
}

// defaultWorkerCount は NumCPU/2 (最低 1)。thumb の auto と同じ式だが専用設定は設けない (D8)。
func defaultWorkerCount() int {
	return max(runtime.NumCPU()/2, 1)
}

func (s *Service) folderMu(folder string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.folderMus[folder]
	if !ok {
		m = &sync.Mutex{}
		s.folderMus[folder] = m
	}
	return m
}

// Check は filenames (POSIX 相対、一覧の表示 entry と同じ集合 = D3) からダブり候補ペアを返す
// (spec §6.1)。threshold はハミング距離の上限で caller (app.go) が settings から解決する。
// mode ゲートも caller の責任 (off ならここまで来ない)。
func (s *Service) Check(folderPath string, filenames []string, threshold int) (DuplicateReport, error) {
	folder, err := validateFolder(folderPath)
	if err != nil {
		return DuplicateReport{}, err
	}
	report := DuplicateReport{
		FolderPath: folderPath,
		Pairs:      []DuplicatePair{},
		Skipped:    []string{},
	}

	mu := s.folderMu(folder)
	mu.Lock()
	defer mu.Unlock()

	// cache root 不可 (UserCacheDir 失敗) でも判定は続行 — キャッシュ無しで全計算するだけ (spec §9)。
	var idxPath string
	cached := map[string]indexEntry{}
	if root, err := cacheRoot(); err != nil {
		logging.Warn("imghash", "cache root unavailable (recomputing all)", "err", err.Error())
	} else {
		idxPath = indexPath(root, AlgoDHash, folder)
		cached = loadIndex(idxPath, dhashRevision)
	}

	type target struct {
		name, abs, ext string
		mtime, size    int64
	}
	next := make(map[string]indexEntry, len(filenames))
	hashes := make(map[string]uint64, len(filenames))
	var toCompute []target

	for _, name := range filenames {
		abs, err := resolveUnder(folder, name)
		if err != nil {
			// path traversal / 不正入力は改竄 IPC でしか現れない → skip でなく error (DeleteImage と同方針)。
			return DuplicateReport{}, err
		}
		ext := strings.ToLower(filepath.Ext(name))
		// AVIF は Go でデコードできず判定対象外 (spec §3 / #118)。
		if !imgfile.IsImage(name) || ext == ".avif" {
			report.Skipped = append(report.Skipped, name)
			continue
		}
		info, err := os.Stat(abs)
		if err != nil || info.IsDir() {
			report.Skipped = append(report.Skipped, name)
			continue
		}
		if e, ok := cached[name]; ok && e.Mtime == info.ModTime().Unix() && e.Size == info.Size() {
			if h, ok := parseHashHex(e.Hash); ok {
				hashes[name] = h
				next[name] = e
				continue
			}
		}
		toCompute = append(toCompute, target{
			name: name, abs: abs, ext: ext,
			mtime: info.ModTime().Unix(), size: info.Size(),
		})
	}

	// 並行ハッシュ計算。結果は index 書きで decode 順によらず決定的に集約する。
	type hashResult struct {
		h   uint64
		err error
	}
	results := make([]hashResult, len(toCompute))
	sem := make(chan struct{}, s.workers)
	var wg sync.WaitGroup
	for i := range toCompute {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			img, err := s.decode(toCompute[i].abs, toCompute[i].ext)
			if err != nil {
				results[i] = hashResult{err: err}
				return
			}
			results[i] = hashResult{h: DHash(img)}
		}(i)
	}
	wg.Wait()
	for i, t := range toCompute {
		if results[i].err != nil {
			// デコード失敗は skip でエラーにしない (spec §9)。
			logging.Warn("imghash", "hash failed (skipping)",
				"file", t.name, "err", results[i].err.Error())
			report.Skipped = append(report.Skipped, t.name)
			continue
		}
		hashes[t.name] = results[i].h
		next[t.name] = indexEntry{Mtime: t.mtime, Size: t.size, Hash: hashHex(results[i].h)}
	}
	// next は今回の filenames から再構築するので、消えた filename の行は自然に落ちる (spec §7.3)。
	if idxPath != "" {
		saveIndex(idxPath, dhashRevision, next)
	}

	dismissed := loadDismissed(folder, AlgoDHash)

	names := make([]string, 0, len(hashes))
	for n := range hashes {
		names = append(names, n)
	}
	sort.Strings(names)
	for i := range names {
		for j := i + 1; j < len(names); j++ {
			d := Distance(hashes[names[i]], hashes[names[j]])
			if d > threshold {
				continue
			}
			if _, ok := dismissed[dismissKey(hashHex(hashes[names[i]]), hashHex(hashes[names[j]]))]; ok {
				continue
			}
			report.Pairs = append(report.Pairs, DuplicatePair{
				FileA: names[i], FileB: names[j], Distance: d,
			})
		}
	}
	sort.Strings(report.Skipped)
	return report, nil
}

// Dismiss は fileA/fileB の現在ハッシュペアを _duplicates.json に追記する (spec §6.2)。冪等。
// Phase 1 は dhash エントリのみ (Phase 2 で全実装 algo の同時記録に拡張, spec §7.2)。
func (s *Service) Dismiss(folderPath, fileA, fileB string) error {
	folder, err := validateFolder(folderPath)
	if err != nil {
		return err
	}
	if fileA == fileB {
		return fmt.Errorf("imghash: dismiss pair must be two distinct files")
	}

	mu := s.folderMu(folder)
	mu.Lock()
	defer mu.Unlock()

	var idxPath string
	cached := map[string]indexEntry{}
	if root, err := cacheRoot(); err != nil {
		logging.Warn("imghash", "cache root unavailable (computing without cache)", "err", err.Error())
	} else {
		idxPath = indexPath(root, AlgoDHash, folder)
		cached = loadIndex(idxPath, dhashRevision)
	}

	var hexes [2]string
	updated := false
	for i, name := range []string{fileA, fileB} {
		abs, err := resolveUnder(folder, name)
		if err != nil {
			return err
		}
		ext := strings.ToLower(filepath.Ext(name))
		if !imgfile.IsImage(name) || ext == ".avif" {
			return fmt.Errorf("imghash: cannot hash unsupported format: %q", name)
		}
		info, err := os.Stat(abs)
		if err != nil {
			return fmt.Errorf("imghash: stat %q: %w", name, err)
		}
		if e, ok := cached[name]; ok && e.Mtime == info.ModTime().Unix() && e.Size == info.Size() {
			if _, ok := parseHashHex(e.Hash); ok {
				hexes[i] = e.Hash
				continue
			}
		}
		img, err := s.decode(abs, ext)
		if err != nil {
			return fmt.Errorf("imghash: decode %q: %w", name, err)
		}
		h := DHash(img)
		hexes[i] = hashHex(h)
		cached[name] = indexEntry{Mtime: info.ModTime().Unix(), Size: info.Size(), Hash: hexes[i]}
		updated = true
	}
	// 追計算した分は index にも反映 (次の Check の再計算を省く)。cached には過去の filename 行が
	// 残りうるが、Check が filenames から next を再構築する際に落とすので問題ない。
	if updated && idxPath != "" {
		saveIndex(idxPath, dhashRevision, cached)
	}
	return addDismissed(folder, AlgoDHash, hexes[0], hexes[1])
}

// validateFolder / resolveUnder は app.go DeleteImage と同じ検証方針 (絶対 folder + 相対
// filename + traversal 拒否)。改竄 IPC 以外では失敗しない。
func validateFolder(folderPath string) (string, error) {
	cleaned := strings.TrimSpace(folderPath)
	if cleaned == "" {
		return "", fmt.Errorf("imghash: folderPath must not be empty")
	}
	if !filepath.IsAbs(cleaned) {
		return "", fmt.Errorf("imghash: folderPath must be absolute: %q", cleaned)
	}
	return cleaned, nil
}

func resolveUnder(folder, filename string) (string, error) {
	cleaned := strings.TrimSpace(filename)
	if cleaned == "" {
		return "", fmt.Errorf("imghash: filename must not be empty")
	}
	nameOS := filepath.FromSlash(cleaned)
	if filepath.IsAbs(nameOS) {
		return "", fmt.Errorf("imghash: filename must be relative: %q", filename)
	}
	abs := filepath.Join(folder, nameOS)
	rel, err := filepath.Rel(folder, abs)
	if err != nil {
		return "", fmt.Errorf("imghash: filename resolves outside folder: %q (%w)", filename, err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("imghash: filename must not escape folder: %q", filename)
	}
	return abs, nil
}
