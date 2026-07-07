// Package imgdecode は画像ファイルを image.Image にデコードする共有層。thumb (サムネ生成) と
// imghash (ダブり判定のハッシュ計算, #136) が同じデコード経路を使う (spec-duplicate-detection.md §3)。
// AVIF は Go に in-tree デコーダが無く対象外 (spec-avif-support.md、WebView に委譲)。
package imgdecode

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

// Decode は path を開き最初のフレームを image.Image で返す。アニメ形式 (GIF, WebP) は最初のフレームに潰す (spec-thumbnail.md §3.4)。
func Decode(path, ext string) (image.Image, error) {
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
