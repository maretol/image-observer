package imghash

import (
	"encoding/json"
	"os"
	"path/filepath"

	"image-observer/internal/logging"
)

// DuplicatesJSON / TempDuplicatesJSON はフォルダ直下の dismiss sidecar (spec §7.2)。
// watcher はこの 2 つに反応しない — dismiss 書き込み (tmp + rename) の自 echo で
// 再 Load ループになるため (watcher/classify.go)。
const (
	DuplicatesJSON     = "_duplicates.json"
	TempDuplicatesJSON = "_duplicates.json.tmp"
)

const dismissVersion = 1

// dismissEntry は「ダブりではない」と判定された 1 ハッシュペア。A <= B に正規化した無順序ペア。
// ファイル名でなくハッシュ値をキーにするのは rename / 同一画像の再追加でも dismiss が生きるように
// するため (spec §7.2)。
type dismissEntry struct {
	Algo string `json:"algo"`
	A    string `json:"a"`
	B    string `json:"b"`
}

type dismissFile struct {
	Version   int            `json:"version"`
	Dismissed []dismissEntry `json:"dismissed"`
}

// dismissKey は dismiss 集合の lookup キー (a <= b 正規化済みペア)。
func dismissKey(a, b string) string {
	a, b = normalizePairHex(a, b)
	return a + "\x00" + b
}

func normalizePairHex(a, b string) (string, string) {
	if b < a {
		return b, a
	}
	return a, b
}

// loadDismissed は folder の dismiss 済みハッシュペア集合を algo で絞って返す。
// 欠落 / 壊れ JSON は「dismiss ゼロ」扱い + warn (spec §9 の寛容方針)。
func loadDismissed(folder, algo string) map[string]struct{} {
	out := map[string]struct{}{}
	path := filepath.Join(folder, DuplicatesJSON)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			logging.Warn("imghash", "dismiss file read failed (treating as empty)",
				"path", path, "err", err.Error())
		}
		return out
	}
	var f dismissFile
	if err := json.Unmarshal(data, &f); err != nil {
		logging.Warn("imghash", "dismiss file parse failed (treating as empty)",
			"path", path, "err", err.Error())
		return out
	}
	for _, e := range f.Dismissed {
		if e.Algo != algo {
			continue
		}
		out[dismissKey(e.A, e.B)] = struct{}{}
	}
	return out
}

// addDismissed は 1 ペアを _duplicates.json に追記する。冪等 (登録済みなら no-op で成功)。
// tmp + rename の atomic write (spec §7.2。mtime 楽観ロックは持たない = last-write-wins)。
func addDismissed(folder, algo, hexA, hexB string) error {
	path := filepath.Join(folder, DuplicatesJSON)
	var f dismissFile
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &f); err != nil || f.Version != dismissVersion {
			// 壊れ / 未知 version は解釈不能。読める dismiss が無いので作り直す (load 側の
			// 「dismiss ゼロ扱い」と整合)。上書き前に warn を残す。
			logging.Warn("imghash", "dismiss file unreadable (rewriting)",
				"path", path, "err", errString(err))
			f = dismissFile{}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	a, b := normalizePairHex(hexA, hexB)
	for _, e := range f.Dismissed {
		if e.Algo == algo && e.A == a && e.B == b {
			return nil
		}
	}
	f.Version = dismissVersion
	f.Dismissed = append(f.Dismissed, dismissEntry{Algo: algo, A: a, B: b})
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(folder, TempDuplicatesJSON)
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func errString(err error) string {
	if err == nil {
		return "version mismatch"
	}
	return err.Error()
}
