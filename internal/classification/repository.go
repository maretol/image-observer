package classification

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// SidecarRepository は CSV/JSON I/O を抽象化し Service を in-memory 実装でテストできるようにする。
// 既定実装は下の fileRepo。
type SidecarRepository interface {
	// Load は _classification.json (優先) か .csv を読む。どちらも無ければ Source="none" + nil Data。
	// Mtime は UnixMilli (CSV / 無しは 0)。ナノ秒でなくミリ秒なのは UnixNano が JS の
	// Number.MAX_SAFE_INTEGER を超え IPC で精度を失い conflict 検出が壊れるため。
	Load(folderPath string) (LoadOutput, error)

	// SaveJSON は _classification.json を .bak rotation 付きで atomic に書く。expectedMtime > 0 なら
	// 先に on-disk mtime を確認し不一致で ErrConflict。0 は強制上書き。成功時は新 mtime を返す。
	SaveJSON(folderPath string, c *Classification, expectedMtime int64) (int64, error)

	// CreateJSON は新規 _classification.json を書く。既にあれば ErrAlreadyExists。
	CreateJSON(folderPath string, c *Classification) (int64, error)
}

// LoadOutput は on-disk ファイルとマージする前の raw な repository 結果。
type LoadOutput struct {
	Data   *Classification
	Source string // "json" | "csv" | "none"
	Mtime  int64
}

// NewFileRepository は local filesystem を使う既定 repository を返す。
func NewFileRepository() SidecarRepository {
	return fileRepo{}
}

type fileRepo struct{}

func (fileRepo) Load(folderPath string) (LoadOutput, error) {
	jsonPath := filepath.Join(folderPath, SidecarJSON)
	if info, err := os.Stat(jsonPath); err == nil && !info.IsDir() {
		c, err := readJSON(jsonPath)
		if err != nil {
			return LoadOutput{}, err
		}
		return LoadOutput{Data: c, Source: "json", Mtime: info.ModTime().UnixMilli()}, nil
	} else if err != nil && !os.IsNotExist(err) {
		return LoadOutput{}, fmt.Errorf("stat json: %w", err)
	}

	csvPath := filepath.Join(folderPath, SidecarCSV)
	if info, err := os.Stat(csvPath); err == nil && !info.IsDir() {
		c, err := readCSV(csvPath)
		if err != nil {
			return LoadOutput{}, err
		}
		return LoadOutput{Data: c, Source: "csv", Mtime: 0}, nil
	} else if err != nil && !os.IsNotExist(err) {
		return LoadOutput{}, fmt.Errorf("stat csv: %w", err)
	}

	return LoadOutput{Data: nil, Source: "none", Mtime: 0}, nil
}

func (fileRepo) SaveJSON(folderPath string, c *Classification, expectedMtime int64) (int64, error) {
	jsonPath := filepath.Join(folderPath, SidecarJSON)
	bakPath := filepath.Join(folderPath, BackupJSON)
	tmpPath := filepath.Join(folderPath, TempJSON)

	// conflict check: expectedMtime があれば現在の mtime と比較。
	if expectedMtime > 0 {
		info, err := os.Stat(jsonPath)
		switch {
		case err == nil:
			// sidecar path を dir が占めている (Load↔Save 間に同名 dir へ差し替え)。後続の IO は原因から
			// 遠いエラーで失敗するので、file-gone 同様 ErrConflict として surface し標準 dialog で選ばせる。
			if info.IsDir() {
				return 0, ErrConflict
			}
			if info.ModTime().UnixMilli() != expectedMtime {
				return 0, ErrConflict
			}
		case os.IsNotExist(err):
			// Load↔Save 間にファイルが消えた (外部 delete)。silent 再作成は delete の原因を上書きするので、
			// ErrConflict として surface し標準 dialog で選ばせる。
			return 0, ErrConflict
		default:
			return 0, fmt.Errorf("stat for conflict check: %w", err)
		}
	}

	// 既存 JSON を backup (best-effort; 初回 save で無いのは OK)。
	if _, err := os.Stat(jsonPath); err == nil {
		if err := copyFile(jsonPath, bakPath); err != nil {
			return 0, fmt.Errorf("backup: %w", err)
		}
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return 0, fmt.Errorf("marshal: %w", err)
	}
	data = append(data, '\n')

	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return 0, fmt.Errorf("write tmp: %w", err)
	}
	if err := os.Rename(tmpPath, jsonPath); err != nil {
		_ = os.Remove(tmpPath)
		return 0, fmt.Errorf("rename: %w", err)
	}

	info, err := os.Stat(jsonPath)
	if err != nil {
		return 0, fmt.Errorf("stat after save: %w", err)
	}
	return info.ModTime().UnixMilli(), nil
}

func (r fileRepo) CreateJSON(folderPath string, c *Classification) (int64, error) {
	jsonPath := filepath.Join(folderPath, SidecarJSON)
	if _, err := os.Stat(jsonPath); err == nil {
		return 0, ErrAlreadyExists
	} else if !os.IsNotExist(err) {
		return 0, fmt.Errorf("stat: %w", err)
	}
	return r.SaveJSON(folderPath, c, 0)
}

func readJSON(path string) (*Classification, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	raw = stripBOM(raw)
	var c Classification
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}
	if err := validateNoDuplicates(c.Entries); err != nil {
		return nil, err
	}
	return &c, nil
}

func readCSV(path string) (*Classification, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	raw = stripBOM(raw)
	r := csv.NewReader(bytes.NewReader(raw))
	r.FieldsPerRecord = -1

	header, err := r.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return &Classification{Version: SchemaVersion, Entries: []Entry{}}, nil
		}
		return nil, fmt.Errorf("read header: %w", err)
	}
	idx := buildCSVIndex(header)
	if idx.filename < 0 {
		return nil, fmt.Errorf("csv: missing 'filename' column")
	}

	entries := make([]Entry, 0)
	for {
		row, err := r.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("read row: %w", err)
		}
		entries = append(entries, Entry{
			Filename:   pick(row, idx.filename),
			Folder:     pick(row, idx.folder),
			Confidence: Confidence(pick(row, idx.confidence)),
			Note:       pick(row, idx.note),
		})
	}
	if err := validateNoDuplicates(entries); err != nil {
		return nil, err
	}
	return &Classification{
		Version: SchemaVersion,
		Entries: entries,
	}, nil
}

type csvIndex struct {
	filename, folder, confidence, note int
}

func buildCSVIndex(header []string) csvIndex {
	idx := csvIndex{filename: -1, folder: -1, confidence: -1, note: -1}
	for i, h := range header {
		switch strings.TrimSpace(strings.ToLower(h)) {
		case "filename":
			idx.filename = i
		case "folder", "proposed_folder":
			idx.folder = i
		case "confidence":
			idx.confidence = i
		case "note":
			idx.note = i
		}
	}
	return idx
}

func pick(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return row[i]
}

func validateNoDuplicates(entries []Entry) error {
	seen := make(map[string]struct{}, len(entries))
	for _, e := range entries {
		if _, dup := seen[e.Filename]; dup {
			return fmt.Errorf("%w: %q", ErrDuplicate, e.Filename)
		}
		seen[e.Filename] = struct{}{}
	}
	return nil
}

func stripBOM(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return b[3:]
	}
	return b
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
