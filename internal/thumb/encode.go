package thumb

import (
	"bytes"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
)

// encodeImage は img を outputExt (".jpg" / ".png" / ".gif") で encode する。WebP source は PNG で書く (caller が ".png" を選ぶ, spec §3.6)。
func encodeImage(img image.Image, outputExt string) ([]byte, error) {
	var buf bytes.Buffer
	switch outputExt {
	case ".jpg", ".jpeg":
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
			return nil, err
		}
	case ".png":
		if err := png.Encode(&buf, img); err != nil {
			return nil, err
		}
	case ".gif":
		if err := gif.Encode(&buf, img, nil); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported output extension: %s", outputExt)
	}
	return buf.Bytes(), nil
}
