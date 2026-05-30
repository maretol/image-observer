package imgread

import (
	"errors"
	"fmt"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/webp"

	"image-observer/internal/imgfile"
)

type Result struct {
	Data     []byte `json:"data"`
	MimeType string `json:"mimeType"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

type Info struct {
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	MimeType string `json:"mimeType"`
}

// ReadInfo returns image dimensions and mime type without loading pixel data.
// Used for pre-flight checks (e.g., size threshold) before opening a tab.
func ReadInfo(path string) (Info, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Info{}, err
	}
	if !imgfile.IsImage(abs) {
		return Info{}, fmt.Errorf("not an image: %s", abs)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Info{}, err
	}
	if info.IsDir() {
		return Info{}, errors.New("path is a directory")
	}
	inputExt := strings.ToLower(filepath.Ext(abs))
	w, h, err := decodeImageDimensions(abs, inputExt)
	if err != nil {
		return Info{}, fmt.Errorf("dimensions: %w", err)
	}
	return Info{Width: w, Height: h, MimeType: mimeForInput(inputExt)}, nil
}

// Read returns the original image bytes plus its dimensions.
// See spec-tab-imageview-3a.md §3.2 for behavior.
func Read(path string) (Result, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Result{}, err
	}
	if !imgfile.IsImage(abs) {
		return Result{}, fmt.Errorf("not an image: %s", abs)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Result{}, err
	}
	if info.IsDir() {
		return Result{}, errors.New("path is a directory")
	}

	inputExt := strings.ToLower(filepath.Ext(abs))

	data, err := os.ReadFile(abs)
	if err != nil {
		return Result{}, err
	}
	w, h, err := decodeImageDimensions(abs, inputExt)
	if err != nil {
		return Result{}, fmt.Errorf("dimensions: %w", err)
	}
	return Result{
		Data:     data,
		MimeType: mimeForInput(inputExt),
		Width:    w,
		Height:   h,
	}, nil
}

func mimeForInput(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	}
	return "application/octet-stream"
}

func decodeImageDimensions(path, ext string) (int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	switch ext {
	case ".jpg", ".jpeg":
		cfg, err := jpeg.DecodeConfig(f)
		if err != nil {
			return 0, 0, err
		}
		return cfg.Width, cfg.Height, nil
	case ".png":
		cfg, err := png.DecodeConfig(f)
		if err != nil {
			return 0, 0, err
		}
		return cfg.Width, cfg.Height, nil
	case ".gif":
		cfg, err := gif.DecodeConfig(f)
		if err != nil {
			return 0, 0, err
		}
		return cfg.Width, cfg.Height, nil
	case ".webp":
		cfg, err := webp.DecodeConfig(f)
		if err != nil {
			return 0, 0, err
		}
		return cfg.Width, cfg.Height, nil
	case ".avif":
		// Go に in-tree avif デコーダが無く、cgo 回避方針 (context.md) のため
		// デコーダ依存も追加しない (spec-avif-support §7 D1=A)。寸法は 0 を返し、
		// フロントが <img>.naturalWidth/Height で補完する (§4.3 A1)。error に
		// すると Read 全体が落ち、WebView が表示できる avif まで表示不能になる。
		return 0, 0, nil
	}
	return 0, 0, fmt.Errorf("unsupported extension: %s", ext)
}
