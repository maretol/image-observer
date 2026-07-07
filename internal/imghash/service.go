package imghash

import (
	"context"
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
	// folderChecks は folder ごとの in-flight Check。同一 folder への新しい Check が旧 Check を
	// supersede cancel する (spec §6.1。フロントは gen gate で旧結果を捨てるため完走は無駄)。
	folderChecks map[string]*inflightCheck
	// workers はハッシュ計算 (decode がボトルネック) の並行上限。サムネの pool とは独立し
	// 相互にブロックしない (spec §13 D8)。
	workers int
	// decode はテストが呼び出し回数を数えるための DI 点 (spec §10.1)。
	decode func(path, ext string) (image.Image, error)
}

type inflightCheck struct {
	cancel context.CancelFunc
}

func NewService() *Service {
	return &Service{
		folderMus:    map[string]*sync.Mutex{},
		folderChecks: map[string]*inflightCheck{},
		workers:      defaultWorkerCount(),
		decode:       imgdecode.Decode,
	}
}

// maxAutoWorkers は auto (NumCPU/2) worker 数の上限。thumb の maxAutoWorkers /
// settings.MaxThumbnailWorkerCount と同値に保つ (D8。TestDefaultWorkerCapMatchesSettings が守る)。
const maxAutoWorkers = 64

// defaultWorkerCount は NumCPU/2 (最低 1、上限 maxAutoWorkers)。thumb の auto と同じ式で
// 専用設定は設けない (D8)。
func defaultWorkerCount() int {
	return min(max(runtime.NumCPU()/2, 1), maxAutoWorkers)
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
// mode ゲートも caller の責任 (off ならここまで来ない)。同一 folder への新しい Check は
// 旧 in-flight を ctx で supersede cancel する — cancel された側は計算済み分を index に
// salvage してエラーで返る (フロントは gen gate で silent に破棄, spec §6.1)。
func (s *Service) Check(ctx context.Context, folderPath string, filenames []string, threshold int) (DuplicateReport, error) {
	folder, err := validateFolder(folderPath)
	if err != nil {
		return DuplicateReport{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	me := &inflightCheck{cancel: cancel}
	s.mu.Lock()
	if prev := s.folderChecks[folder]; prev != nil {
		prev.cancel()
	}
	s.folderChecks[folder] = me
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		// 自分が最新の登録のときだけ消す (後続 Check が既に上書きしていたら触らない)。
		if s.folderChecks[folder] == me {
			delete(s.folderChecks, folder)
		}
		s.mu.Unlock()
	}()

	report := DuplicateReport{
		FolderPath: folderPath,
		Pairs:      []DuplicatePair{},
		Skipped:    []string{},
	}

	mu := s.folderMu(folder)
	mu.Lock()
	defer mu.Unlock()
	// mutex 待ちの間に supersede されていたら stat / decode を始める前に抜ける。
	if err := ctx.Err(); err != nil {
		return DuplicateReport{}, fmt.Errorf("imghash: check superseded: %w", err)
	}

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
			// stat 失敗は一時的 (コピー中ロック等) かもしれないので、既存キャッシュ行を
			// 温存する — 全置換で有効な行を巻き込んで落とさない (spec §7.3)。
			if err != nil {
				if e, ok := cached[name]; ok {
					next[name] = e
				}
			}
			report.Skipped = append(report.Skipped, name)
			continue
		}
		if e, ok := cached[name]; ok && e.Mtime == info.ModTime().Unix() && e.Size == info.Size() {
			if e.Failed {
				// 負キャッシュ: 前回 decode 失敗かつファイル不変 → 再試行しない (spec §7.3)。
				report.Skipped = append(report.Skipped, name)
				next[name] = e
				continue
			}
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

	// 並行ハッシュ計算。固定 s.workers 本の worker が channel から仕事を引く (goroutine 数を
	// 未計算件数に比例させない, D8)。結果は index 書きで decode 順によらず決定的に集約する。
	type hashResult struct {
		h    uint64
		err  error
		done bool
	}
	results := make([]hashResult, len(toCompute))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < min(s.workers, len(toCompute)); w++ {
		wg.Go(func() {
			for i := range jobs {
				// supersede / shutdown 後は decode せず捨てる (done=false のまま)。
				if ctx.Err() != nil {
					continue
				}
				img, err := s.decode(toCompute[i].abs, toCompute[i].ext)
				if err != nil {
					results[i] = hashResult{err: err, done: true}
					continue
				}
				results[i] = hashResult{h: DHash(img), done: true}
			}
		})
	}
feed:
	for i := range toCompute {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()

	// changed = index を書き直す価値のある差分があった (全件キャッシュヒットの Check で
	// 毎回 JSON を書き直す write amplification を避ける, spec §7.3)。
	changed := false
	for i, t := range toCompute {
		r := results[i]
		if !r.done {
			// cancel で未処理。既存キャッシュ行があれば温存 (spec §7.3)。
			if e, ok := cached[t.name]; ok {
				next[t.name] = e
			}
			continue
		}
		if r.err != nil {
			// デコード失敗は skip でエラーにしない (spec §9)。負キャッシュを残し、ファイルが
			// 変わるまで再試行しない (spec §7.3)。
			logging.Warn("imghash", "hash failed (skipping)",
				"file", t.name, "err", r.err.Error())
			report.Skipped = append(report.Skipped, t.name)
			next[t.name] = indexEntry{Mtime: t.mtime, Size: t.size, Failed: true}
			changed = true
			continue
		}
		hashes[t.name] = r.h
		next[t.name] = indexEntry{Mtime: t.mtime, Size: t.size, Hash: hashHex(r.h)}
		changed = true
	}
	// next は今回の filenames から再構築するので、消えた filename の行は自然に落ちる (spec §7.3)。
	if idxPath != "" && (changed || len(next) != len(cached)) {
		saveIndex(idxPath, dhashRevision, next)
	}
	// cancel されたら計算済み分の salvage (上の saveIndex) だけ済ませてエラーで返る。
	// フロントは gen gate で silent に破棄する (spec §6.1)。
	if err := ctx.Err(); err != nil {
		return DuplicateReport{}, fmt.Errorf("imghash: check superseded: %w", err)
	}

	dismissed := loadDismissed(folder, AlgoDHash)

	names := make([]string, 0, len(hashes))
	for n := range hashes {
		names = append(names, n)
	}
	sort.Strings(names)
	// O(n²) の内側ループは添字アクセスだけにする — map lookup / Sprintf を毎反復行うと
	// popcount の数十倍のコストが支配して spec §3 の性能前提が崩れる。
	hs := make([]uint64, len(names))
	hexes := make([]string, len(names))
	for i, n := range names {
		hs[i] = hashes[n]
		hexes[i] = hashHex(hs[i])
	}
	for i := range names {
		hi := hs[i]
		for j := i + 1; j < len(names); j++ {
			d := Distance(hi, hs[j])
			if d > threshold {
				continue
			}
			if _, ok := dismissed[dismissKey(hexes[i], hexes[j])]; ok {
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
