package thumb

import (
	"image"

	"golang.org/x/image/draw"
)

// resize は cfg.Mode に従い target×target RGBA を作る。
// - "letterbox": アスペクト保持で box 内に fit、透明 padding
// - "crop":      アスペクト保持で box を fill、center-crop
// 出力は常に cfg.GenerateSize × cfg.GenerateSize。
func resize(src image.Image, cfg Config) image.Image {
	target := cfg.GenerateSize
	bounds := src.Bounds()
	sw, sh := bounds.Dx(), bounds.Dy()
	if sw <= 0 || sh <= 0 {
		return image.NewRGBA(image.Rect(0, 0, target, target))
	}

	dst := image.NewRGBA(image.Rect(0, 0, target, target))

	switch cfg.Mode {
	case "crop":
		// 短辺を target に合わせ center-crop。box を rect に描くことで overflow が crop される。
		scale := float64(target) / float64(minInt(sw, sh))
		scaledW := int(float64(sw) * scale)
		scaledH := int(float64(sh) * scale)
		offX := (target - scaledW) / 2
		offY := (target - scaledH) / 2
		draw.BiLinear.Scale(
			dst,
			image.Rect(offX, offY, offX+scaledW, offY+scaledH),
			src, bounds, draw.Src, nil,
		)
	default: // "letterbox"
		// 長辺が target に合うよう scale し透明で pad。
		scale := float64(target) / float64(maxInt(sw, sh))
		dstW := int(float64(sw) * scale)
		dstH := int(float64(sh) * scale)
		offX := (target - dstW) / 2
		offY := (target - dstH) / 2
		draw.BiLinear.Scale(
			dst,
			image.Rect(offX, offY, offX+dstW, offY+dstH),
			src, bounds, draw.Src, nil,
		)
	}
	return dst
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
