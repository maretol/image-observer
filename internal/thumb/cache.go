package thumb

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// cacheRootOverride はテストが cache 書き込みを user cache dir 外へ redirect するため。
var cacheRootOverride string

func cacheRoot() (string, error) {
	if cacheRootOverride != "" {
		return cacheRootOverride, nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "image-observer", "cache", "thumbnails"), nil
}

func cacheKey(path string, mtime int64, size int64) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%d", path, mtime, size)
	return hex.EncodeToString(h.Sum(nil))[:32]
}

func cacheFilePath(root string, cfg Config, key string, outputExt string) string {
	dir := filepath.Join(root, cfg.Mode, strconv.Itoa(cfg.GenerateSize), key[:2])
	return filepath.Join(dir, key[2:]+outputExt)
}

// outputExtFor は入力拡張子を cache ファイルの拡張子に対応させる。WebP は encoder が無く PNG に fallback (spec §3.6)。
func outputExtFor(inputExt string) string {
	ext := strings.ToLower(inputExt)
	switch ext {
	case ".jpg", ".jpeg":
		return ".jpg"
	case ".png":
		return ".png"
	case ".gif":
		return ".gif"
	case ".webp":
		return ".png"
	default:
		return ".png"
	}
}

func mimeFor(outputExt string) string {
	switch outputExt {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	default:
		return "application/octet-stream"
	}
}
