package thumb

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"image-observer/internal/settings"
)

// TestThumbDefaultsMatchSettings guards against the defensive defaults in
// internal/thumb (used when callers pass 0/empty) drifting away from the
// user-facing defaults exposed by internal/settings. The values are
// duplicated rather than imported because making thumb depend on settings
// would invert today's "settings depends on nothing" posture; a single
// equality assertion is cheaper than that refactor.
func TestThumbDefaultsMatchSettings(t *testing.T) {
	d := settings.DefaultSettings()
	if d.ThumbnailSize != defaultDisplaySize {
		t.Errorf("settings.DefaultSettings().ThumbnailSize (%d) and internal/thumb.defaultDisplaySize (%d) drifted",
			d.ThumbnailSize, defaultDisplaySize)
	}
	if d.ThumbnailMode != defaultMode {
		t.Errorf("settings.DefaultSettings().ThumbnailMode (%q) and internal/thumb.defaultMode (%q) drifted",
			d.ThumbnailMode, defaultMode)
	}
}

func TestCacheKey_Determinism(t *testing.T) {
	a := cacheKey("/x/y.png", 100, 1024)
	b := cacheKey("/x/y.png", 100, 1024)
	if a != b {
		t.Errorf("same inputs should produce same key: %s vs %s", a, b)
	}
	if len(a) != 32 {
		t.Errorf("expected 32-char key, got %d (%q)", len(a), a)
	}
}

func TestCacheKey_SensitiveToInputs(t *testing.T) {
	base := cacheKey("/x/y.png", 100, 1024)
	cases := map[string]string{
		"different path":  cacheKey("/x/z.png", 100, 1024),
		"different mtime": cacheKey("/x/y.png", 101, 1024),
		"different size":  cacheKey("/x/y.png", 100, 1025),
	}
	for name, k := range cases {
		if k == base {
			t.Errorf("%s should produce different key", name)
		}
	}
}

func TestCacheFilePath_Sharding(t *testing.T) {
	cfg := Config{Mode: "letterbox", GenerateSize: 512}
	key := "abcdef0123456789abcdef0123456789"
	got := cacheFilePath("/root", cfg, key, ".jpg")
	want := filepath.Join("/root", "letterbox", "512", "ab", "cdef0123456789abcdef0123456789.jpg")
	if got != want {
		t.Errorf("cacheFilePath:\n  got  %s\n  want %s", got, want)
	}
}

func TestOutputExtFor_WebPFallsBackToPNG(t *testing.T) {
	cases := map[string]string{
		".jpg":  ".jpg",
		".jpeg": ".jpg",
		".png":  ".png",
		".gif":  ".gif",
		".webp": ".png",
		".WEBP": ".png",
	}
	for in, want := range cases {
		if got := outputExtFor(in); got != want {
			t.Errorf("outputExtFor(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGetThumbnail_RoundTripJPEG(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	cacheRootOverride = filepath.Join(dir, "cache", "thumbnails")
	defer func() { cacheRootOverride = "" }()

	src := filepath.Join(dir, "a.jpg")
	writeJPEG(t, src, 200, 100)

	res, err := Get(src, 64, "letterbox")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if res.MimeType != "image/jpeg" {
		t.Errorf("MimeType: got %q, want image/jpeg", res.MimeType)
	}
	img, err := jpeg.Decode(bytes.NewReader(res.Data))
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if img.Bounds().Dx() != 64*generateScaleFactor || img.Bounds().Dy() != 64*generateScaleFactor {
		t.Errorf("size: got %dx%d, want %dx%d",
			img.Bounds().Dx(), img.Bounds().Dy(),
			64*generateScaleFactor, 64*generateScaleFactor)
	}
}

func TestGetThumbnail_RoundTripPNG(t *testing.T) {
	dir := t.TempDir()
	cacheRootOverride = filepath.Join(dir, "cache")
	defer func() { cacheRootOverride = "" }()

	src := filepath.Join(dir, "a.png")
	writePNG(t, src, 100, 200)

	res, err := Get(src, 64, "crop")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if res.MimeType != "image/png" {
		t.Errorf("MimeType: got %q, want image/png", res.MimeType)
	}
	img, err := png.Decode(bytes.NewReader(res.Data))
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if img.Bounds().Dx() != 64*generateScaleFactor || img.Bounds().Dy() != 64*generateScaleFactor {
		t.Errorf("size: got %dx%d, want %dx%d (crop should fill)",
			img.Bounds().Dx(), img.Bounds().Dy(),
			64*generateScaleFactor, 64*generateScaleFactor)
	}
}

func TestGetThumbnail_RoundTripGIF(t *testing.T) {
	dir := t.TempDir()
	cacheRootOverride = filepath.Join(dir, "cache")
	defer func() { cacheRootOverride = "" }()

	src := filepath.Join(dir, "a.gif")
	writeGIF(t, src, 80, 80)

	res, err := Get(src, 32, "letterbox")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if res.MimeType != "image/gif" {
		t.Errorf("MimeType: got %q, want image/gif", res.MimeType)
	}
	if _, err := gif.Decode(bytes.NewReader(res.Data)); err != nil {
		t.Errorf("decode result: %v", err)
	}
}

func TestGetThumbnail_CacheHitDoesNotReDecode(t *testing.T) {
	dir := t.TempDir()
	cacheRootOverride = filepath.Join(dir, "cache")
	defer func() { cacheRootOverride = "" }()

	src := filepath.Join(dir, "a.jpg")
	writeJPEG(t, src, 50, 50)

	res1, err := Get(src, 32, "letterbox")
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	// Replace source with bytes that would fail to decode if read.
	if err := os.WriteFile(src, []byte("not a jpeg, but mtime is preserved"), 0o644); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	// Restore mtime + size so the cache key stays stable.
	mt := time.Unix(1700000000, 0)
	if err := os.Chtimes(src, mt, mt); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	// Re-do the first call's key by also setting it before that call.
	// Easier: regenerate with a new src to make the test deterministic.
	dir2 := t.TempDir()
	cacheRootOverride = filepath.Join(dir2, "cache")
	src2 := filepath.Join(dir2, "a.jpg")
	writeJPEG(t, src2, 50, 50)
	if err := os.Chtimes(src2, mt, mt); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	first, err := Get(src2, 32, "letterbox")
	if err != nil {
		t.Fatalf("first(src2): %v", err)
	}
	// Corrupt source after first call but keep mtime/size.
	info, _ := os.Stat(src2)
	corrupt := bytes.Repeat([]byte("x"), int(info.Size()))
	if err := os.WriteFile(src2, corrupt, 0o644); err != nil {
		t.Fatalf("corrupt: %v", err)
	}
	if err := os.Chtimes(src2, mt, mt); err != nil {
		t.Fatalf("chtimes2: %v", err)
	}

	second, err := Get(src2, 32, "letterbox")
	if err != nil {
		t.Fatalf("second(src2): cache should be served, got %v", err)
	}
	if !bytes.Equal(first.Data, second.Data) {
		t.Errorf("cache hit should return identical bytes")
	}
	_ = res1 // first call from corrupted-then-replaced flow not asserted
}

func TestGetThumbnail_MtimeChangeInvalidatesCache(t *testing.T) {
	dir := t.TempDir()
	cacheRootOverride = filepath.Join(dir, "cache")
	defer func() { cacheRootOverride = "" }()

	src := filepath.Join(dir, "a.jpg")
	writeJPEG(t, src, 50, 50)
	t1 := time.Unix(1700000000, 0)
	os.Chtimes(src, t1, t1)
	_, err := Get(src, 32, "letterbox")
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	// Bump mtime → key changes → new cache file.
	t2 := time.Unix(1700000999, 0)
	os.Chtimes(src, t2, t2)

	cacheDirGlob := filepath.Join(cacheRootOverride, "letterbox", "64", "*", "*.jpg")
	beforeCount := globCount(t, cacheDirGlob)
	_, err = Get(src, 32, "letterbox")
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	afterCount := globCount(t, cacheDirGlob)
	if afterCount <= beforeCount {
		t.Errorf("expected new cache file after mtime change: before=%d after=%d", beforeCount, afterCount)
	}
}

func TestGetThumbnail_NotImage(t *testing.T) {
	dir := t.TempDir()
	cacheRootOverride = filepath.Join(dir, "cache")
	defer func() { cacheRootOverride = "" }()

	src := filepath.Join(dir, "a.txt")
	os.WriteFile(src, []byte("hello"), 0o644)
	_, err := Get(src, 32, "letterbox")
	if err == nil {
		t.Error("expected error for non-image input")
	}
}

func TestThumbPool_DeduplicatesConcurrentJobs(t *testing.T) {
	pool := newPool(4)
	var calls atomic.Int32

	fn := func() ([]byte, error) {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		return []byte("ok"), nil
	}

	const n = 10
	var wg sync.WaitGroup
	results := make([][]byte, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = pool.Generate("same-key", fn)
		}(i)
	}
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Errorf("expected fn to be called exactly once, got %d", got)
	}
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Errorf("call %d: err = %v", i, errs[i])
		}
		if string(results[i]) != "ok" {
			t.Errorf("call %d: result = %q", i, results[i])
		}
	}
}

func TestThumbPool_DifferentKeysEachRun(t *testing.T) {
	pool := newPool(4)
	var calls atomic.Int32
	fn := func() ([]byte, error) {
		calls.Add(1)
		return []byte("x"), nil
	}
	pool.Generate("a", fn)
	pool.Generate("b", fn)
	pool.Generate("a", fn) // a was deleted after first run, so this triggers another call
	if calls.Load() != 3 {
		t.Errorf("expected 3 calls (a, b, a-again), got %d", calls.Load())
	}
}

// --- helpers ---

func writeJPEG(t *testing.T, path string, w, h int) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	if err := jpeg.Encode(f, img, nil); err != nil {
		t.Fatalf("jpeg encode: %v", err)
	}
}

func writePNG(t *testing.T, path string, w, h int) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{255, uint8(x), uint8(y), 255})
		}
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatalf("png encode: %v", err)
	}
}

func writeGIF(t *testing.T, path string, w, h int) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{
		color.RGBA{0, 0, 0, 255},
		color.RGBA{255, 255, 255, 255},
	})
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if (x+y)%2 == 0 {
				img.SetColorIndex(x, y, 1)
			}
		}
	}
	if err := gif.Encode(f, img, nil); err != nil {
		t.Fatalf("gif encode: %v", err)
	}
}

func globCount(t *testing.T, pattern string) int {
	t.Helper()
	matches, err := filepath.Glob(pattern)
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	return len(matches)
}

func TestEncodeImage_RejectsUnknownExt(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	_, err := encodeImage(img, ".bmp")
	if err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Errorf("expected 'unsupported' error, got %v", err)
	}
}
