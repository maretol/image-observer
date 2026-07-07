package imghash

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"

	"image-observer/internal/logging"
)

const indexVersion = 1

// indexEntry は 1 画像分のキャッシュ行。mtime (Unix 秒) / size 一致でハッシュ再利用、不一致で
// 再計算 (サムネキャッシュ = todo.md D 節と同じ無効化方針, spec §7.3)。
type indexEntry struct {
	Mtime int64  `json:"mtime"`
	Size  int64  `json:"size"`
	Hash  string `json:"hash,omitempty"`
	// Failed は decode 失敗の負キャッシュ。mtime/size 不変の間は再試行しない (spec §7.3)。
	Failed bool `json:"failed,omitempty"`
}

type indexFile struct {
	Version int                   `json:"version"`
	Algo    string                `json:"algo"`
	Files   map[string]indexEntry `json:"files"`
}

// cacheRootOverride はテストが user cache dir 外へ redirect するため (thumb と同流儀)。
var cacheRootOverride string

// cacheRoot は <UserCacheDir>/image-observer/cache/duphash を返す。ベースの
// image-observer/cache 配下という流儀は thumb の thumbnails キャッシュと同じ (todo.md D 節)。
func cacheRoot() (string, error) {
	if cacheRootOverride != "" {
		return cacheRootOverride, nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "image-observer", "cache", "duphash"), nil
}

// indexPath はフォルダ絶対 path から algo 別の index ファイル path を導く。
// sha256(フォルダ絶対 path) 先頭 32 hex を <2>/<30>.json でシャーディング (spec §7.3)。
func indexPath(root, algo, folderAbs string) string {
	sum := sha256.Sum256([]byte(folderAbs))
	key := hex.EncodeToString(sum[:])[:32]
	return filepath.Join(root, algo, key[:2], key[2:]+".json")
}

// loadIndex は index を読む。欠落 / 壊れ / version・revision 不一致は空 index に fallback し
// 全再計算させる (spec §9。キャッシュなので失うものは計算時間だけ)。
func loadIndex(path, revision string) map[string]indexEntry {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			logging.Warn("imghash", "index read failed (recomputing)",
				"path", path, "err", err.Error())
		}
		return map[string]indexEntry{}
	}
	var f indexFile
	if err := json.Unmarshal(data, &f); err != nil {
		logging.Warn("imghash", "index parse failed (recomputing)",
			"path", path, "err", err.Error())
		return map[string]indexEntry{}
	}
	if f.Version != indexVersion || f.Algo != revision || f.Files == nil {
		return map[string]indexEntry{}
	}
	return f.Files
}

// saveIndex は tmp + rename の atomic write で index を書く。失敗は warn のみで判定は続行
// (次回また計算するだけ, spec §9)。
func saveIndex(path, revision string, files map[string]indexEntry) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logging.Warn("imghash", "index dir create failed", "path", path, "err", err.Error())
		return
	}
	data, err := json.MarshalIndent(indexFile{
		Version: indexVersion,
		Algo:    revision,
		Files:   files,
	}, "", "  ")
	if err != nil {
		logging.Warn("imghash", "index marshal failed", "path", path, "err", err.Error())
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		logging.Warn("imghash", "index write failed", "path", tmp, "err", err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		logging.Warn("imghash", "index rename failed", "path", path, "err", err.Error())
	}
}
