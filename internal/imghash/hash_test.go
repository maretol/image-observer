package imghash

import (
	"image"
	"image/color"
	"testing"
)

// grayImage は w×h のグレースケール画像を value(x, y) から作る。
func grayImage(w, h int, value func(x, y int) uint8) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			v := value(x, y)
			img.SetRGBA(x, y, color.RGBA{R: v, G: v, B: v, A: 255})
		}
	}
	return img
}

// pattern は対角グラデーション + 中央の明るい矩形。「写真っぽい」勾配を持つ決定的な素材。
func pattern(w, h int, invert bool) *image.RGBA {
	return grayImage(w, h, func(x, y int) uint8 {
		v := (x*255/(w-1) + y*255/(h-1)) / 2
		if x > w/3 && x < 2*w/3 && y > h/3 && y < 2*h/3 {
			v = (v + 255) / 2
		}
		if invert {
			v = 255 - v
		}
		return uint8(v)
	})
}

// bit 規約 (左 < 右 = 1、y0 行 MSB) の golden pin。変えるときは dhashRevision を bump する。
func TestDHashBitConvention(t *testing.T) {
	increasing := grayImage(90, 80, func(x, _ int) uint8 { return uint8(x * 255 / 89) })
	if got := DHash(increasing); got != ^uint64(0) {
		t.Errorf("increasing gradient = %016x, want all ones", got)
	}
	decreasing := grayImage(90, 80, func(x, _ int) uint8 { return uint8(255 - x*255/89) })
	if got := DHash(decreasing); got != 0 {
		t.Errorf("decreasing gradient = %016x, want zero", got)
	}
	uniform := grayImage(90, 80, func(_, _ int) uint8 { return 128 })
	if got := DHash(uniform); got != 0 {
		t.Errorf("uniform = %016x, want zero (等輝度は「左 < 右」不成立)", got)
	}
}

func TestDHashResizeInvariance(t *testing.T) {
	a := DHash(pattern(64, 64, false))
	b := DHash(pattern(128, 128, false))
	if d := Distance(a, b); d > 5 {
		t.Errorf("resized pattern distance = %d, want <= 5 (既定しきい値で検出できること)", d)
	}
}

func TestDHashDistinguishesDifferentImages(t *testing.T) {
	a := DHash(pattern(64, 64, false))
	c := DHash(pattern(64, 64, true))
	if d := Distance(a, c); d <= 16 {
		t.Errorf("inverted pattern distance = %d, want > 16 (しきい値上限でも誤検出しないこと)", d)
	}
}

func TestDistance(t *testing.T) {
	if d := Distance(0, 0); d != 0 {
		t.Errorf("Distance(0,0) = %d", d)
	}
	if d := Distance(0, ^uint64(0)); d != 64 {
		t.Errorf("Distance(0,^0) = %d", d)
	}
	if d := Distance(0b1010, 0b0010); d != 1 {
		t.Errorf("Distance 1bit = %d", d)
	}
}

func TestHashHexRoundtrip(t *testing.T) {
	for _, h := range []uint64{0, 1, 0xdeadbeefcafe1234, ^uint64(0)} {
		s := hashHex(h)
		if len(s) != 16 {
			t.Errorf("hashHex(%x) = %q, want 16 chars", h, s)
		}
		got, ok := parseHashHex(s)
		if !ok || got != h {
			t.Errorf("roundtrip %x -> %q -> %x (ok=%v)", h, s, got, ok)
		}
	}
	for _, bad := range []string{"", "zz", "not-a-hash-16chr", "0123456789abcdef0"} {
		if _, ok := parseHashHex(bad); ok {
			t.Errorf("parseHashHex(%q) should fail", bad)
		}
	}
}
