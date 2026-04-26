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

	"image-observer/internal/tree"
)

type Result struct {
	Data     []byte `json:"data"`
	MimeType string `json:"mimeType"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

// Read returns the original image bytes plus its dimensions.
// See spec-tab-imageview-3a.md §3.2 for behavior.
func Read(path string) (Result, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Result{}, err
	}
	if !tree.IsImage(abs) {
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
	}
	return 0, 0, fmt.Errorf("unsupported extension: %s", ext)
}
