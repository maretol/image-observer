// Package imgfile は internal package 共有の画像ファイル判定を提供する。判定を 1 箇所にまとめ、
// consumer ごとに対応拡張子が drift するのを防ぐ。
package imgfile

import (
	"path/filepath"
	"strings"
)

var imageExts = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".gif":  true,
	".webp": true,
	".avif": true,
}

// IsImage は name が対応画像拡張子か判定する (case-insensitive)。
func IsImage(name string) bool {
	return imageExts[strings.ToLower(filepath.Ext(name))]
}
