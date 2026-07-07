package thumb

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"image-observer/internal/imgdecode"
	"image-observer/internal/imgfile"
)

type Config struct {
	DisplaySize  int    `json:"displaySize"`
	GenerateSize int    `json:"generateSize"`
	Mode         string `json:"mode"`
}

type Result struct {
	Data     []byte `json:"data"`
	MimeType string `json:"mimeType"`
}

// Get は画像 path のサムネイルを返す (spec-thumbnail.md §3.3)。
func Get(path string, size int, mode string) (Result, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Result{}, err
	}
	if !imgfile.IsImage(abs) {
		return Result{}, fmt.Errorf("not an image: %s", abs)
	}

	if mode != "letterbox" && mode != "crop" {
		mode = defaultMode
	}
	if size <= 0 {
		size = defaultDisplaySize
	}
	cfg := Config{
		DisplaySize:  size,
		GenerateSize: size * generateScaleFactor,
		Mode:         mode,
	}

	info, err := os.Stat(abs)
	if err != nil {
		return Result{}, err
	}
	if info.IsDir() {
		return Result{}, errors.New("path is a directory")
	}

	inputExt := strings.ToLower(filepath.Ext(abs))

	// AVIF: Go に in-tree デコーダが無く downscale できない (spec-avif-support §7 D1=A)。元バイト列を
	// そのまま返し WebView に縮小表示を委ねる (§4.4 / D3)。実体を返すので disk cache もしない。
	if inputExt == ".avif" {
		data, err := os.ReadFile(abs)
		if err != nil {
			return Result{}, err
		}
		return Result{Data: data, MimeType: "image/avif"}, nil
	}

	outputExt := outputExtFor(inputExt)

	root, err := cacheRoot()
	if err != nil {
		return Result{}, err
	}
	key := cacheKey(abs, info.ModTime().Unix(), info.Size())
	cachePath := cacheFilePath(root, cfg, key, outputExt)

	if data, err := os.ReadFile(cachePath); err == nil {
		return Result{Data: data, MimeType: mimeFor(outputExt)}, nil
	}

	data, err := defaultPool.Generate(cachePath, func() ([]byte, error) {
		return generateThumbnail(abs, inputExt, outputExt, cfg)
	})
	if err != nil {
		return Result{}, err
	}

	if err := writeCache(cachePath, data); err != nil {
		log.Printf("thumb: cache write failed for %q: %v", cachePath, err)
	}

	return Result{Data: data, MimeType: mimeFor(outputExt)}, nil
}

func generateThumbnail(path, inputExt, outputExt string, cfg Config) ([]byte, error) {
	src, err := imgdecode.Decode(path, inputExt)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	dst := resize(src, cfg)
	return encodeImage(dst, outputExt)
}

func writeCache(cachePath string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(cachePath, data, 0o644)
}
