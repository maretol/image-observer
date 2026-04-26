package thumb

import (
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"strings"

	"golang.org/x/image/webp"
)

// decodeImage opens path and returns the first frame as image.Image.
// Animation formats (GIF, WebP) collapse to the first frame per spec §3.4.
func decodeImage(path, ext string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return jpeg.Decode(f)
	case ".png":
		return png.Decode(f)
	case ".gif":
		g, err := gif.DecodeAll(f)
		if err != nil {
			return nil, err
		}
		if len(g.Image) == 0 {
			return nil, fmt.Errorf("gif has no frames: %s", path)
		}
		return g.Image[0], nil
	case ".webp":
		return webp.Decode(f)
	default:
		return nil, fmt.Errorf("unsupported image extension: %s", ext)
	}
}
