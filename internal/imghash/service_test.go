package imghash

import (
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"image-observer/internal/settings"
)

func writePNGFile(t *testing.T, path string, img image.Image) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

// newTestService は cache root をテスト dir へ redirect し、decode 回数を数える Service を返す。
func newTestService(t *testing.T) (*Service, *int32) {
	t.Helper()
	prev := cacheRootOverride
	cacheRootOverride = t.TempDir()
	t.Cleanup(func() { cacheRootOverride = prev })

	s := NewService()
	var count int32
	orig := s.decode
	s.decode = func(path, ext string) (image.Image, error) {
		atomic.AddInt32(&count, 1)
		return orig(path, ext)
	}
	return s, &count
}

func pairKeySet(pairs []DuplicatePair) map[string]int {
	out := map[string]int{}
	for _, p := range pairs {
		out[p.FileA+"|"+p.FileB] = p.Distance
	}
	return out
}

func TestCheckFindsResizedDuplicate(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	writePNGFile(t, filepath.Join(folder, "c.png"), pattern(64, 64, true))

	rep, err := s.Check(context.Background(), folder, []string{"c.png", "b.png", "a.png"}, 5)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	pairs := pairKeySet(rep.Pairs)
	if _, ok := pairs["a.png|b.png"]; !ok {
		t.Errorf("resized duplicate not detected: %v", rep.Pairs)
	}
	if len(rep.Pairs) != 1 {
		t.Errorf("unexpected extra pairs: %v", rep.Pairs)
	}
	if len(rep.Skipped) != 0 {
		t.Errorf("unexpected skipped: %v", rep.Skipped)
	}
}

func TestCheckPairOrderIsDeterministic(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	src := pattern(64, 64, false)
	for _, n := range []string{"z.png", "a.png", "m.png"} {
		writePNGFile(t, filepath.Join(folder, n), src)
	}
	rep, err := s.Check(context.Background(), folder, []string{"z.png", "a.png", "m.png"}, 0)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	want := []DuplicatePair{
		{FileA: "a.png", FileB: "m.png", Distance: 0},
		{FileA: "a.png", FileB: "z.png", Distance: 0},
		{FileA: "m.png", FileB: "z.png", Distance: 0},
	}
	if len(rep.Pairs) != len(want) {
		t.Fatalf("pairs = %v, want %v", rep.Pairs, want)
	}
	for i := range want {
		if rep.Pairs[i] != want[i] {
			t.Errorf("pairs[%d] = %v, want %v", i, rep.Pairs[i], want[i])
		}
	}
}

func TestCheckUsesCacheAndInvalidatesOnMtime(t *testing.T) {
	s, count := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	files := []string{"a.png", "b.png"}

	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(count); got != 2 {
		t.Fatalf("first check decodes = %d, want 2", got)
	}

	atomic.StoreInt32(count, 0)
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(count); got != 0 {
		t.Errorf("cached check decodes = %d, want 0", got)
	}

	// mtime 変更で該当ファイルだけ再計算 (spec §7.3)。
	newTime := time.Now().Add(5 * time.Second)
	if err := os.Chtimes(filepath.Join(folder, "a.png"), newTime, newTime); err != nil {
		t.Fatal(err)
	}
	atomic.StoreInt32(count, 0)
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(count); got != 1 {
		t.Errorf("post-mtime check decodes = %d, want 1", got)
	}
}

func TestCheckCorruptIndexRecomputes(t *testing.T) {
	s, count := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	if _, err := s.Check(context.Background(), folder, []string{"a.png"}, 5); err != nil {
		t.Fatal(err)
	}
	root, err := cacheRoot()
	if err != nil {
		t.Fatal(err)
	}
	idx := indexPath(root, AlgoDHash, folder)
	if err := os.WriteFile(idx, []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	atomic.StoreInt32(count, 0)
	if _, err := s.Check(context.Background(), folder, []string{"a.png"}, 5); err != nil {
		t.Fatalf("Check with corrupt index: %v", err)
	}
	if got := atomic.LoadInt32(count); got != 1 {
		t.Errorf("corrupt-index check decodes = %d, want 1 (全再計算)", got)
	}
}

func TestCheckSkipsUnhashable(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	if err := os.WriteFile(filepath.Join(folder, "anim.avif"), []byte("avif-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "broken.png"), []byte("not-a-png"), 0o644); err != nil {
		t.Fatal(err)
	}
	rep, err := s.Check(context.Background(), folder,
		[]string{"a.png", "anim.avif", "broken.png", "missing.png", "note.txt"}, 5)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	want := []string{"anim.avif", "broken.png", "missing.png", "note.txt"}
	if len(rep.Skipped) != len(want) {
		t.Fatalf("skipped = %v, want %v", rep.Skipped, want)
	}
	for i := range want {
		if rep.Skipped[i] != want[i] {
			t.Errorf("skipped[%d] = %q, want %q (sorted)", i, rep.Skipped[i], want[i])
		}
	}
	if len(rep.Pairs) != 0 {
		t.Errorf("pairs = %v, want empty", rep.Pairs)
	}
}

func TestCheckThresholdBoundary(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	// バイト同一コピー = 距離 0。
	src, err := os.ReadFile(filepath.Join(folder, "a.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "copy.png"), src, 0o644); err != nil {
		t.Fatal(err)
	}
	writePNGFile(t, filepath.Join(folder, "c.png"), pattern(64, 64, true))

	rep, err := s.Check(context.Background(), folder, []string{"a.png", "copy.png", "c.png"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	pairs := pairKeySet(rep.Pairs)
	if d, ok := pairs["a.png|copy.png"]; !ok || d != 0 {
		t.Errorf("exact copy pair missing or distance != 0: %v", rep.Pairs)
	}
	if len(rep.Pairs) != 1 {
		t.Errorf("threshold 0 should only match exact-ish copies: %v", rep.Pairs)
	}
}

func TestCheckSubdirEntries(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "child", "b.png"), pattern(128, 128, false))
	rep, err := s.Check(context.Background(), folder, []string{"a.png", "child/b.png"}, 5)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := pairKeySet(rep.Pairs)["a.png|child/b.png"]; !ok {
		t.Errorf("subdir pair not detected: %v", rep.Pairs)
	}
}

func TestCheckRejectsBadInput(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	if _, err := s.Check(context.Background(), "relative/path", []string{"a.png"}, 5); err == nil {
		t.Error("relative folder should error")
	}
	if _, err := s.Check(context.Background(), folder, []string{"../evil.png"}, 5); err == nil {
		t.Error("traversal filename should error")
	}
	if _, err := s.Check(context.Background(), folder, []string{"/abs.png"}, 5); err == nil {
		t.Error("absolute filename should error")
	}
	if _, err := s.Check(context.Background(), "  ", []string{"a.png"}, 5); err == nil {
		t.Error("empty folder should error")
	}
}

func TestDismissExcludesPairAndSurvivesRename(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	files := []string{"a.png", "b.png"}

	rep, err := s.Check(context.Background(), folder, files, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Pairs) != 1 {
		t.Fatalf("precondition: want 1 pair, got %v", rep.Pairs)
	}

	if err := s.Dismiss(folder, "a.png", "b.png"); err != nil {
		t.Fatalf("Dismiss: %v", err)
	}
	// 冪等。
	if err := s.Dismiss(folder, "a.png", "b.png"); err != nil {
		t.Fatalf("Dismiss (again): %v", err)
	}

	rep, err = s.Check(context.Background(), folder, files, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Pairs) != 0 {
		t.Errorf("dismissed pair still reported: %v", rep.Pairs)
	}

	// rename しても dismiss が生きる (ハッシュ値キー, spec §7.2)。
	if err := os.Rename(filepath.Join(folder, "b.png"), filepath.Join(folder, "z.png")); err != nil {
		t.Fatal(err)
	}
	rep, err = s.Check(context.Background(), folder, []string{"a.png", "z.png"}, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Pairs) != 0 {
		t.Errorf("dismiss should survive rename: %v", rep.Pairs)
	}
}

func TestDismissFileFormat(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	if err := s.Dismiss(folder, "b.png", "a.png"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(folder, DuplicatesJSON))
	if err != nil {
		t.Fatalf("dismiss sidecar missing: %v", err)
	}
	var f dismissFile
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if f.Version != dismissVersion || len(f.Dismissed) != 1 {
		t.Fatalf("unexpected dismiss file: %+v", f)
	}
	e := f.Dismissed[0]
	if e.Algo != AlgoDHash {
		t.Errorf("algo = %q, want %q", e.Algo, AlgoDHash)
	}
	if e.A > e.B {
		t.Errorf("pair not normalized: a=%q b=%q", e.A, e.B)
	}
	if _, ok := parseHashHex(e.A); !ok {
		t.Errorf("a is not a hash hex: %q", e.A)
	}
}

func TestDismissCorruptFileRewrites(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	if err := os.WriteFile(filepath.Join(folder, DuplicatesJSON), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.Dismiss(folder, "a.png", "b.png"); err != nil {
		t.Fatalf("Dismiss over corrupt file: %v", err)
	}
	rep, err := s.Check(context.Background(), folder, []string{"a.png", "b.png"}, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Pairs) != 0 {
		t.Errorf("dismiss after rewrite should hold: %v", rep.Pairs)
	}
}

func TestCheckNegativeCachesDecodeFailure(t *testing.T) {
	s, count := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	if err := os.WriteFile(filepath.Join(folder, "broken.png"), []byte("not-a-png"), 0o644); err != nil {
		t.Fatal(err)
	}
	files := []string{"a.png", "broken.png"}

	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(count); got != 2 {
		t.Fatalf("first check decode attempts = %d, want 2", got)
	}

	// 負キャッシュ: ファイル不変なら decode 失敗を再試行しない (spec §7.3)。
	atomic.StoreInt32(count, 0)
	rep, err := s.Check(context.Background(), folder, files, 5)
	if err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(count); got != 0 {
		t.Errorf("cached check decode attempts = %d, want 0 (負キャッシュ)", got)
	}
	if len(rep.Skipped) != 1 || rep.Skipped[0] != "broken.png" {
		t.Errorf("skipped = %v, want [broken.png]", rep.Skipped)
	}

	// mtime 変更で再試行される。
	newTime := time.Now().Add(5 * time.Second)
	if err := os.Chtimes(filepath.Join(folder, "broken.png"), newTime, newTime); err != nil {
		t.Fatal(err)
	}
	atomic.StoreInt32(count, 0)
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(count); got != 1 {
		t.Errorf("post-mtime check decode attempts = %d, want 1 (再試行)", got)
	}
}

func TestCheckRetainsCacheRowOnStatFailure(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	files := []string{"a.png", "b.png"}
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}

	// stat 失敗 (ここでは消失で再現) しても filenames に居る限り行は温存される (spec §7.3)。
	if err := os.Remove(filepath.Join(folder, "b.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	root, err := cacheRoot()
	if err != nil {
		t.Fatal(err)
	}
	idx := indexPath(root, AlgoDHash, folder)
	cached := loadIndex(idx, dhashRevision)
	if _, ok := cached["b.png"]; !ok {
		t.Errorf("stat 失敗行が index から落ちた: %v", cached)
	}

	// filenames から消えたら (フロントの集合が更新されたら) 行も落ちる。
	if _, err := s.Check(context.Background(), folder, []string{"a.png"}, 5); err != nil {
		t.Fatal(err)
	}
	cached = loadIndex(idx, dhashRevision)
	if _, ok := cached["b.png"]; ok {
		t.Errorf("消えた filename の行が残っている: %v", cached)
	}
}

func TestCheckSkipsIndexWriteWhenUnchanged(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	files := []string{"a.png", "b.png"}
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	root, err := cacheRoot()
	if err != nil {
		t.Fatal(err)
	}
	idx := indexPath(root, AlgoDHash, folder)
	sentinel := time.Now().Add(-time.Hour)
	if err := os.Chtimes(idx, sentinel, sentinel); err != nil {
		t.Fatal(err)
	}

	// 全件キャッシュヒットなら index を書き直さない (spec §7.3 write amplification 防止)。
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(idx)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(sentinel) {
		t.Error("変更なしの Check が index を書き直した")
	}

	// 差分があれば書き直す。
	newTime := time.Now().Add(5 * time.Second)
	if err := os.Chtimes(filepath.Join(folder, "a.png"), newTime, newTime); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Check(context.Background(), folder, files, 5); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(idx)
	if err != nil {
		t.Fatal(err)
	}
	if info.ModTime().Equal(sentinel) {
		t.Error("再計算後も index が書き直されていない")
	}
}

func TestCheckSupersededByNewerCheck(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	writePNGFile(t, filepath.Join(folder, "b.png"), pattern(128, 128, false))
	files := []string{"a.png", "b.png"}

	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	orig := s.decode
	s.decode = func(path, ext string) (image.Image, error) {
		once.Do(func() {
			close(started)
			<-release // 旧 Check を decode 中に留め、その間に新 Check を発行させる
		})
		return orig(path, ext)
	}

	var firstErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, firstErr = s.Check(context.Background(), folder, files, 5)
	}()
	<-started

	// 同一 folder への新しい Check が旧 in-flight を supersede cancel する (spec §6.1)。
	secondDone := make(chan struct{})
	var rep DuplicateReport
	var secondErr error
	go func() {
		defer close(secondDone)
		rep, secondErr = s.Check(context.Background(), folder, files, 5)
	}()
	close(release)
	<-done
	<-secondDone

	if !errors.Is(firstErr, context.Canceled) {
		t.Errorf("superseded check error = %v, want context.Canceled", firstErr)
	}
	if secondErr != nil {
		t.Fatalf("second check: %v", secondErr)
	}
	if len(rep.Pairs) != 1 {
		t.Errorf("second check pairs = %v, want 1", rep.Pairs)
	}
}

// TestDefaultWorkerCapMatchesSettings は auto worker 上限が thumb 側 (settings の明示上限と同値) から
// 乖離していないことを守る (D8「thumb と同じ auto 式」のドリフト検知)。
func TestDefaultWorkerCapMatchesSettings(t *testing.T) {
	if maxAutoWorkers != settings.MaxThumbnailWorkerCount {
		t.Errorf("imghash.maxAutoWorkers (%d) != settings.MaxThumbnailWorkerCount (%d)",
			maxAutoWorkers, settings.MaxThumbnailWorkerCount)
	}
	if got := defaultWorkerCount(); got > maxAutoWorkers || got < 1 {
		t.Errorf("defaultWorkerCount() = %d, want 1..%d", got, maxAutoWorkers)
	}
}

func TestDismissErrors(t *testing.T) {
	s, _ := newTestService(t)
	folder := t.TempDir()
	writePNGFile(t, filepath.Join(folder, "a.png"), pattern(64, 64, false))
	if err := s.Dismiss(folder, "a.png", "a.png"); err == nil {
		t.Error("same-file dismiss should error")
	}
	if err := s.Dismiss(folder, "a.png", "missing.png"); err == nil {
		t.Error("missing file dismiss should error")
	}
	if err := s.Dismiss(folder, "a.png", "../evil.png"); err == nil {
		t.Error("traversal dismiss should error")
	}
}
