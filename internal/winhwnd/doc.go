// Package winhwnd はこの process の main top-level window の HWND を自力取得する
// Windows 専用ヘルパ (#129 で winplacement に実装したものを #149 で共有化)。
// Wails v2 が native handle を公開しないため、EnumWindows + 自プロセス PID マッチで探す。
//
// 実体は hwnd_windows.go (//go:build windows) のみ。この doc.go は build-tag なしで
// 置き、非 Windows の `go build ./...` / `go test ./...` が「build constraints exclude
// all Go files」で落ちないようにする (呼び出し側は全て windows-tagged ファイルなので
// 非 Windows ビルドに空 package が残るだけで実害はない)。
package winhwnd
