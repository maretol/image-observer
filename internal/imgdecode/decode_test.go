package imgdecode

import (
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func writePNG(t *testing.T, dir, name string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDecodePNG(t *testing.T) {
	path := writePNG(t, t.TempDir(), "a.png", 4, 3)
	img, err := Decode(path, ".png")
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if b := img.Bounds(); b.Dx() != 4 || b.Dy() != 3 {
		t.Errorf("bounds = %v, want 4x3", b)
	}
}

func TestDecodeGIFFirstFrame(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.gif")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	pal := color.Palette{color.Black, color.White}
	frame1 := image.NewPaletted(image.Rect(0, 0, 2, 2), pal)
	frame2 := image.NewPaletted(image.Rect(0, 0, 2, 2), pal)
	err = gif.EncodeAll(f, &gif.GIF{
		Image: []*image.Paletted{frame1, frame2},
		Delay: []int{0, 0},
	})
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	img, err := Decode(path, ".gif")
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if b := img.Bounds(); b.Dx() != 2 || b.Dy() != 2 {
		t.Errorf("bounds = %v, want 2x2", b)
	}
}

func TestDecodeUnsupportedExt(t *testing.T) {
	path := writePNG(t, t.TempDir(), "a.png", 1, 1)
	if _, err := Decode(path, ".avif"); err == nil {
		t.Error("Decode(.avif) should error (Go にデコーダなし、WebView 委譲)")
	}
	if _, err := Decode(path, ".txt"); err == nil {
		t.Error("Decode(.txt) should error")
	}
}
