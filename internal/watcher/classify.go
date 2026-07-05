package watcher

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/gofsnotify/fsnotify"

	"image-observer/internal/classification"
	"image-observer/internal/imgfile"
)

// classifyAndAccumulate は raw fsnotify event 1 つを検査し acc を更新する。timer を reset すべきとき
// (frontend が気にする変化があるとき) true を返す。st は新規 subdir の増分 Add と dir/file 判別のため
// watcher / watchedDirs を参照/更新する (w.Remove の返り値は timing 依存)。spec §7.2。
func classifyAndAccumulate(acc *changedAccumulator, ev fsnotify.Event, st *watchState) bool {
	w := st.watcher
	base := filepath.Base(ev.Name)

	// hidden フィルタは子孫だけ。root 自体は常に監視 — skip すると `.foo` を選んだとき root の Remove/Rename が
	// 落ち root-vanish 分岐が発火せず dead fd に loop が張り付く。
	if ev.Name != st.root && isHiddenName(base) {
		return false
	}

	// Sidecar JSON: chmod 以外の event で flag を立てる — ただし `_classification.json` という名の *dir* は
	// 除く。同名 dir を sidecar 扱いすると addSubtree / removeSubtreeFromWatch を skip し watch が leak する。
	// Remove/Rename は watchedDirs 参照 (path 消済み)、Create は Lstat。dir なら下の dir 分岐へ落とす。
	if base == classification.SidecarJSON {
		pathIsDir := false
		if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
			_, pathIsDir = st.watchedDirs[ev.Name]
		} else if ev.Op.Has(fsnotify.Create) {
			if info, err := os.Lstat(ev.Name); err == nil &&
				info.Mode()&os.ModeSymlink == 0 && info.IsDir() {
				pathIsDir = true
			}
		}
		if !pathIsDir {
			if ev.Op.Has(fsnotify.Create) || ev.Op.Has(fsnotify.Write) ||
				ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
				acc.sidecarChanged = true
				acc.anyChange = true
				return true
			}
			return false
		}
		// pathIsDir == true: 下の dir 分岐へ落とす。
	}

	if ev.Op == fsnotify.Chmod {
		return false
	}

	// 新規 dir: symlink 検出のため Lstat。symlink に addSubtree すると scanner が辿らない tree を watch に
	// 取り込み「現 folder のみ」不変条件を壊す。確定 dir は再帰 walk する:
	//   1) 各ネスト subdir に自前 watch (inotify は再帰なし、既存 tree の `mv` で子孫を取りこぼす)、
	//   2) 既存画像 (`mv` / `cp -r` 由来) を added に数え payload を正確にする。
	if ev.Op.Has(fsnotify.Create) {
		// Lstat エラーは path が既に消えた可能性が高い (rapid create-then-remove)。下の file 分岐へ落とす。
		if info, err := os.Lstat(ev.Name); err == nil {
			isSymlink := info.Mode()&os.ModeSymlink != 0
			if isSymlink && !imgfile.IsImage(base) {
				// 非画像 (dir 等) への symlink。target は辿らない。anyChange を立て変化を見せる。
				acc.anyChange = true
				return true
			}
			// 画像拡張子の symlink は下の image Create 分岐へ落とす — scanner が symlink 有無によらず含めるので
			// payload を re-Load と一致させる。
			if !isSymlink && info.IsDir() {
				// 実ディレクトリ: 増分 add。root 失敗は非致命 (親 dir の watch がこの event をくれた;
				// 新 subdir のネスト活動を失うだけ)。anyChange は true で frontend が re-Load。
				_, discovered := addSubtreeCollect(w, ev.Name, st.watchedDirs)
				if len(discovered) > 0 {
					if acc.discoveredImagePaths == nil {
						acc.discoveredImagePaths = make(map[string]struct{}, len(discovered))
					}
					// per-window set で dedup: 同 window の先行 dir-Create が親を walk 済みかもしれない
					// (fsnotify が親子両方の Create を出し親 walk が先着したとき)。
					newImages := 0
					for _, p := range discovered {
						if _, dup := acc.discoveredImagePaths[p]; dup {
							continue
						}
						acc.discoveredImagePaths[p] = struct{}{}
						newImages++
					}
					acc.addedFiles += newImages
				}
				acc.anyChange = true
				return true
			}
		}
	}

	// 以降 counter は画像だけ気にする。非画像・非 sidecar の Remove/Rename はほぼ dir 消失かユーザーの
	// 再編成で on-disk set が変わるので、counter は増やさず (subtree 内容が判別不能) anyChange を立てる。
	// 非画像の Write / Chmod のみは無視。
	if !imgfile.IsImage(base) {
		if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
			// acc.removedPaths で dedup し、IN_IGNORED / IN_DELETE_SELF の後続が anyChange を再発火しないように。
			if acc.removedPaths == nil {
				acc.removedPaths = make(map[string]struct{})
			}
			if _, dup := acc.removedPaths[ev.Name]; dup {
				return true
			}
			acc.removedPaths[ev.Name] = struct{}{}
			// path とその子孫を unwatch。inotify は inode 追跡なので rename 後も子孫 inode が元 path の
			// event を出し続ける。unwatch 子孫を removedPaths に tombstone し後続を上の dedup で吸収する。
			removeSubtreeFromWatch(st, ev.Name, acc.removedPaths)
			acc.anyChange = true
			return true
		}
		return false
	}

	triggered := false
	if ev.Op.Has(fsnotify.Create) {
		// 直近 dir-Create の WalkDir が既に数えていたら二重加算せず dedup entry を消費 (one-shot、後の
		// 本物 Create はちゃんと数える)。
		if _, dup := acc.discoveredImagePaths[ev.Name]; dup {
			delete(acc.discoveredImagePaths, ev.Name)
		} else {
			acc.addedFiles++
		}
		triggered = true
	}
	if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
		// per-window dedup: 1 回の削除で inotify は親の IN_DELETE と path 自身の IN_DELETE_SELF + IN_IGNORED を出す。
		if acc.removedPaths == nil {
			acc.removedPaths = make(map[string]struct{})
		}
		if _, dup := acc.removedPaths[ev.Name]; dup {
			return true
		}
		acc.removedPaths[ev.Name] = struct{}{}
		// dir/file 判別は watchedDirs で (w.Remove の返り値は IN_IGNORED 非同期処理で timing 依存)。
		// watchedDirs にあれば我々が Add した dir (`photos.jpg/` 等) で、scanner は dir を無視するので
		// removedFiles++ は過剰報告 → anyChange 扱い。実画像は watchedDirs に無く通常加算。
		if _, wasDir := st.watchedDirs[ev.Name]; wasDir {
			// subtree 全体を unwatch (画像拡張子 dir のネスト watch が rename で tree 外へ移る)。unwatch
			// 子孫を removedPaths に tombstone し後続を上の dedup で吸収する。
			removeSubtreeFromWatch(st, ev.Name, acc.removedPaths)
			acc.anyChange = true
		} else {
			acc.removedFiles++
			if ev.Op.Has(fsnotify.Rename) {
				acc.renamedFiles++
			}
		}
		triggered = true
	}
	// 既存画像への Write は entries set を変えず counter は増やさないが timer は reset する (true)。
	// 大画像のコピー (Create → Write → …) が落ち着くまで quiet window を保つため — でないと Create 後
	// 200ms で早期 flush し LoadClassification が書き込み中の size-0 画像を surface する。spec §7.2 / §13.14。
	if ev.Op.Has(fsnotify.Write) {
		triggered = true
	}
	return triggered
}

// isHiddenName は classification/scanner.go のルールをミラーし watch と scan の対象を揃える。dotfile /
// dotdir のみ (Windows の hidden 属性は見ない)。
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}
