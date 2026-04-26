package imgread

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestRead_JPEG_BytesUnchanged(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.jpg")
	writeJPEG(t, src, 100, 200)

	expected, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	res, err := Read(src)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !bytes.Equal(res.Data, expected) {
		t.Errorf("data should match disk bytes (got %d bytes, want %d)", len(res.Data), len(expected))
	}
	if res.MimeType != "image/jpeg" {
		t.Errorf("mime: got %q, want image/jpeg", res.MimeType)
	}
	if res.Width != 100 || res.Height != 200 {
		t.Errorf("dims: got %dx%d, want 100x200", res.Width, res.Height)
	}
}

func TestRead_PNG_BytesUnchanged(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.png")
	writePNG(t, src, 80, 60)

	expected, _ := os.ReadFile(src)
	res, err := Read(src)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !bytes.Equal(res.Data, expected) {
		t.Errorf("data should match disk bytes")
	}
	if res.MimeType != "image/png" {
		t.Errorf("mime: got %q, want image/png", res.MimeType)
	}
	if res.Width != 80 || res.Height != 60 {
		t.Errorf("dims: got %dx%d, want 80x60", res.Width, res.Height)
	}
}

func TestRead_GIF_BytesUnchanged(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.gif")
	writeGIF(t, src, 50, 40)

	expected, _ := os.ReadFile(src)
	res, err := Read(src)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !bytes.Equal(res.Data, expected) {
		t.Errorf("data should match disk bytes")
	}
	if res.MimeType != "image/gif" {
		t.Errorf("mime: got %q, want image/gif", res.MimeType)
	}
	if res.Width != 50 || res.Height != 40 {
		t.Errorf("dims: got %dx%d, want 50x40", res.Width, res.Height)
	}
}

func TestRead_NotImage(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.txt")
	os.WriteFile(src, []byte("hello"), 0o644)
	if _, err := Read(src); err == nil {
		t.Error("expected error for non-image extension")
	}
}

func TestRead_NotExist(t *testing.T) {
	if _, err := Read(filepath.Join(t.TempDir(), "nope.jpg")); err == nil {
		t.Error("expected error for non-existent path")
	}
}

func TestRead_Directory(t *testing.T) {
	dir := t.TempDir()
	subdir := filepath.Join(dir, "sub.jpg") // extension makes IsImage true
	os.Mkdir(subdir, 0o755)
	if _, err := Read(subdir); err == nil {
		t.Error("expected error for directory input")
	}
}

func TestReadInfo_PNG(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.png")
	writePNG(t, src, 123, 456)
	info, err := ReadInfo(src)
	if err != nil {
		t.Fatalf("ReadInfo: %v", err)
	}
	if info.Width != 123 || info.Height != 456 {
		t.Errorf("dims: got %dx%d, want 123x456", info.Width, info.Height)
	}
	if info.MimeType != "image/png" {
		t.Errorf("mime: got %q, want image/png", info.MimeType)
	}
}

func TestReadInfo_NotImage(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.txt")
	os.WriteFile(src, []byte("hi"), 0o644)
	if _, err := ReadInfo(src); err == nil {
		t.Error("expected error for non-image extension")
	}
}

func TestReadInfo_NotExist(t *testing.T) {
	if _, err := ReadInfo(filepath.Join(t.TempDir(), "nope.jpg")); err == nil {
		t.Error("expected error for non-existent path")
	}
}

func TestReadInfo_BrokenHeader(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "broken.png")
	os.WriteFile(src, []byte("not a real png"), 0o644)
	if _, err := ReadInfo(src); err == nil {
		t.Error("expected error for broken header")
	}
}

func TestMimeForInput(t *testing.T) {
	cases := map[string]string{
		".jpg":  "image/jpeg",
		".JPEG": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".webp": "image/webp",
		".bmp":  "application/octet-stream",
	}
	for ext, want := range cases {
		if got := mimeForInput(ext); got != want {
			t.Errorf("mimeForInput(%q) = %q, want %q", ext, got, want)
		}
	}
}

// --- helpers (duplicated from internal/thumb/thumb_test.go intentionally) ---

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
