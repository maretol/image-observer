// Package classification は "list" タブが使う sidecar ベースの画像分類メタデータ層。正の store は
// JSON (_classification.json)。CSV は移行のため一度読むだけで書かない (docs/spec-classification.md)。
package classification

import (
	"errors"
	"time"
)

const SchemaVersion = 1

const (
	SidecarJSON = "_classification.json"
	SidecarCSV  = "_classification.csv"
	BackupJSON  = "_classification.json.bak"
	TempJSON    = "_classification.json.tmp"
)

// Confidence は分類の確信度。空文字は「未設定」。
type Confidence string

const (
	ConfHigh Confidence = "high"
	ConfMid  Confidence = "mid"
	ConfLow  Confidence = "low"
	ConfNone Confidence = ""
)

// Entry は 1 画像ファイル分の分類メタデータ 1 行。
type Entry struct {
	Filename   string     `json:"filename"`
	Folder     string     `json:"folder"`
	Confidence Confidence `json:"confidence"`
	Note       string     `json:"note"`
}

// Classification は _classification.json の on-disk 形。
type Classification struct {
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
	Entries   []Entry   `json:"entries"`
}

// LoadResult は frontend へ返す merged view: sidecar entry を disk 上の実ファイルと突き合わせる。
//
//   - Entries: grid に表示。disk にあり sidecar に無いファイルは Folder/Confidence/Note 空で追加。
//   - Orphans: sidecar にあり disk に無い。grid では隠すが save 時に保持し、意図的な記録を失わせない。
//   - Mtime: load 時の _classification.json の UnixMilli。frontend が Save/UpdateEntry に戻し conflict
//     検出に使う。JSON 無しなら 0。ミリ秒 (ナノ秒でない) なのは JS Number の safe-integer に収めるため。
type LoadResult struct {
	FolderPath string  `json:"folderPath"`
	Entries    []Entry `json:"entries"`
	Orphans    []Entry `json:"orphans"`
	HasSidecar bool    `json:"hasSidecar"`
	Source     string  `json:"source"` // "json" | "csv" | "none"
	Mtime      int64   `json:"mtime"`
	// FileTimes は Entries の各 filename の mtime (Unix 秒)。mtime ソート (#144) の入力。
	// stat 失敗 / orphan は行を持たない (frontend は 0 扱いで末尾に寄せる)。sidecar には書かない。
	FileTimes map[string]int64 `json:"fileTimes"`
}

// SaveOutput は Save/UpdateEntry/CreateEmpty が返す。frontend が書き込み成功後に追跡 mtime を更新する用。
type SaveOutput struct {
	Mtime int64 `json:"mtime"`
}

// ErrConflict は caller の直近 Load から Save までに on-disk JSON が外部変更されたことを示す。
var ErrConflict = errors.New("classification: external modification detected")

// ErrAlreadyExists は CreateEmpty が既存 sidecar を上書きしてしまうことを示す。
var ErrAlreadyExists = errors.New("classification: sidecar already exists")

// ErrDuplicate は sidecar 内の filename 重複を示す。
var ErrDuplicate = errors.New("classification: duplicate filename in entries")

// ChildSidecarSummary は親 merge フロー (Phase 4 v1.2) の候補となる 1 子フォルダ sidecar。
// Subfolder は親からの相対 POSIX path ("child1" / "child1/sub")。NonEmptyCount は実データ
// (Folder/Confidence/Note のいずれか) を持つ行数 — 全候補で NonEmptyCount > 0 のときだけ prompt を
// 出し、空テンプレ sidecar で user を煩わせない。
type ChildSidecarSummary struct {
	Subfolder     string `json:"subfolder"`
	Source        string `json:"source"`
	EntryCount    int    `json:"entryCount"`
	NonEmptyCount int    `json:"nonEmptyCount"`
}

// MergePreview は親フォルダの子 sidecar 走査結果。HasNonTrivial == true は merge に値するデータを
// 持つ子が 1 つ以上あること (frontend が merge prompt を出すか判断)。false なら通常の
// "create empty sidecar?" フローへ。
type MergePreview struct {
	FolderPath    string                `json:"folderPath"`
	Children      []ChildSidecarSummary `json:"children"`
	HasNonTrivial bool                  `json:"hasNonTrivial"`
	TotalEntries  int                   `json:"totalEntries"`
	TotalNonEmpty int                   `json:"totalNonEmpty"`
}
