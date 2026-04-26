package thumb

import (
	"image"

	"golang.org/x/image/draw"
)

// resize produces a target×target RGBA according to cfg.Mode.
// - "letterbox": preserve aspect, fit within the box, transparent padding
// - "crop":      preserve aspect, fill the box, center-crop
//
// Output is always cfg.GenerateSize × cfg.GenerateSize.
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
		// Scale source so its shorter side maps to target, then center-crop.
		// Drawing into rect (offX, offY, offX+scaledW, offY+scaledH) where the
		// box is target×target effectively crops the overflow.
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
		// Scale source so its longer side maps to target; pad with transparent.
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
