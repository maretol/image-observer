// Package watcher は 1 フォルダを再帰監視し、分類 ("list") タブを更新すべき file system 変更を検出する
// (spec-folder-watch.md)。
//
// gofsnotify/fsnotify をラップし以下を足す:
//   - OS 非依存の再帰監視 (subdir を自前で列挙し各々 Add — Linux inotify に再帰モードは無い)
//   - 200ms debounce + burst coalescing → quiet window ごとに emit() 1 回
//   - フィルタ (spec §7.2): 画像 Create/Remove/Rename / sidecar / dir Create (子孫を再帰 Add) /
//     dir・非画像 Remove/Rename (subtree 消失で anyChange) で emit。画像 Write は emit しないが debounce
//     timer は延ばす (大画像の Create→Write… が落ち着くまで待つ)。Chmod のみ / hidden は無視。
//
// watcher は分類 entry を再読込しない。変化を signal するだけで frontend が LoadClassification する。
package watcher

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofsnotify/fsnotify"

	"image-observer/internal/logging"
)

// DefaultDebounce は coalesce した event を emit する前の quiet-window 長。カメラの一括コピー
// burst (~100 files/sec) を吸収しつつ UI feedback を素早く保つ値 (spec §7.3)。
const DefaultDebounce = 200 * time.Millisecond

// ClassificationChangedEvent は debounce 済み変更を frontend へ push する Wails event 名。frontend の
// CLASSIFICATION_CHANGED_EVENT に複製され、両側の literal 等価テストで片側 rename を CI 落ちにする (D-1)。
const ClassificationChangedEvent = "classification:changed"

// ChangedPayload は emit() が frontend へ渡す snapshot。path 単位の詳細は省く — frontend が folder を
// re-Load して authoritative な entries を得る。
type ChangedPayload struct {
	Folder         string `json:"folder"`
	AddedFiles     int    `json:"addedFiles"`
	RemovedFiles   int    `json:"removedFiles"`
	RenamedFiles   int    `json:"renamedFiles"`
	SidecarChanged bool   `json:"sidecarChanged"`
}

// EmitFunc は Manager が各 debounce flush 後に呼ぶ callback。本番は runtime.EventsEmit、テストは channel。
type EmitFunc func(ChangedPayload)

// Manager は最大 1 つの active watch を持つ。Start/Stop は複数 goroutine から安全で、Start は別 root で
// 繰り返し呼べる (前の watch を先に tear down)。
type Manager struct {
	emit     EmitFunc
	debounce time.Duration

	mu    sync.Mutex
	state *watchState // non-nil iff a watch is active
}

type watchState struct {
	watcher *fsnotify.Watcher
	root    string
	stop    chan struct{}
	done    chan struct{}

	// watchedDirs は Add 成功した dir を追い、Remove/Rename が dir か file かを確実に判別するため
	// (w.Remove の返り値は timing 依存 — inotify の IN_IGNORED 非同期処理で watch が先に消える)。書くのは
	// loop goroutine (Create 分岐) と Start だけで並行アクセスなし。
	watchedDirs map[string]struct{}

	// stopRequested は stopLocked が watcher close の *前* に true にする。loop は Events-channel-closed 時に
	// これで明示 Stop (pending discard) と想定外 backend 失敗 (log + flush) を区別する。atomic (別 goroutine 読み)。
	stopRequested atomic.Bool
}

// NewManager は既定 debounce window で Manager を作る。
func NewManager(emit EmitFunc) *Manager {
	return NewManagerWithDebounce(emit, DefaultDebounce)
}

// NewManagerWithDebounce はカスタム flush window が要るテスト / 呼び出し側用。本番は NewManager。
func NewManagerWithDebounce(emit EmitFunc, d time.Duration) *Manager {
	return &Manager{emit: emit, debounce: d}
}

// Start は root の監視を始める。同 root + live loop なら no-op。別 root か loop exit 済み (zombie) なら
// stale state を先に tear down する。root の Add 失敗は error (caller は manual reload に degrade, spec §5.5)。
// hidden subdir は skip、可視子孫の Add 失敗は log して続行 (部分 watch > ゼロ)。
func (m *Manager) Start(root string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 同 root + live goroutine: no-op。既存 watch は検証済みなので dir/symlink チェックを skip し、一時的な
	// Lstat 失敗で動作中 watch を tear down しない。done channel 判定で loop 側を lock-free に保つ。
	if m.state != nil && m.state.root == root && !goroutineExited(m.state) {
		return nil
	}

	// 別 root へ移った (or zombie)。新 root 検証の *前* に旧 watch を tear down する — でないと新 root の
	// 検証失敗時に旧 watcher が走り続け「現 folder のみ」不変条件を破る。
	if m.state != nil {
		_ = m.stopLocked()
	}

	// 非 dir root を拒否。inotify は単一ファイルも watch できるので、無いと file path で Start が成功し
	// 何も event を出さず健全に見えて何もしない。Lstat で symlink-to-dir も拒否 — WalkDir は symlink root の
	// descent を skip しネスト watch が未設定になるし、scanner (同じ Lstat 制約) が surface できない event を出す。
	info, err := os.Lstat(root)
	if err != nil {
		return fmt.Errorf("watcher: lstat root %q: %w", root, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("watcher: root must not be a symlink, got %q", root)
	}
	if !info.IsDir() {
		return fmt.Errorf("watcher: root must be a directory, got %q (mode %s)",
			root, info.Mode().Type())
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("watcher: NewWatcher: %w", err)
	}

	// watchedDirs は初期 walk で addSubtree が埋め、loop の Create 分岐が拡張する。
	watchedDirs := make(map[string]struct{})

	// root は成功必須: 無いと top-level 変更 (root 直下の画像 add/remove) が見えない。子孫は best-effort。
	// 初期 walk は collect なし版 — Start 時は発見画像への inotify Create が queue されず dedup 対象が無い。
	if !addSubtree(w, root, watchedDirs) {
		_ = w.Close()
		return fmt.Errorf("watcher: cannot watch root %q", root)
	}

	st := &watchState{
		watcher:     w,
		root:        root,
		stop:        make(chan struct{}),
		done:        make(chan struct{}),
		watchedDirs: watchedDirs,
	}
	m.state = st
	go m.loop(st)
	logging.Info("watcher", "started", "folder", root)
	return nil
}

// goroutineExited は st の loop が既に return したか報告する。Start が zombie state (Stop 無しに loop 終了) を
// 検出し機能しない watch へ no-op しないため。
func goroutineExited(st *watchState) bool {
	select {
	case <-st.done:
		return true
	default:
		return false
	}
}

// Stop は active な watch を tear down する。冪等。
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stopLocked()
}

func (m *Manager) stopLocked() error {
	if m.state == nil {
		return nil
	}
	st := m.state
	// 順序が重要:
	//   1) stopRequested を立て、loop が明示 Stop と backend 失敗を区別できるように。
	//   2) close(st.stop) で idle な loop の select を起こす (fsnotify read で block 中はこれだけでは効かない)。
	//   3) st.watcher.Close() で Events/Errors を閉じ loop の select を !ok 分岐で unblock。
	// 既に閉じた st.stop の close を skip するのは zombie 経路対応 (Start が dead goroutine を掃除する場合)。
	st.stopRequested.Store(true)
	select {
	case <-st.stop:
		// 既に閉じている (zombie cleanup) — st.watcher.Close は fsnotify リソース解放のため冪等に走る。
	default:
		close(st.stop)
	}
	err := st.watcher.Close()
	<-st.done
	logging.Info("watcher", "stopped", "folder", st.root)
	m.state = nil
	return err
}

// Current は最後に建てた watcher state の root、無ければ "" を返す。非空でも loop が live とは限らない
// (root 消失 / backend close で zombie になりうる)。テスト / debug 用で、本番は JS 側 folderRef が意図
// folder を独立追跡する。
func (m *Manager) Current() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil {
		return ""
	}
	return m.state.root
}

// loop は 1 watch の間、自前 goroutine で走る。raw fsnotify event を quiet window ごとに 1 つの
// ChangedPayload に coalesce し、flush ごとに emit() をちょうど 1 回呼ぶ。
func (m *Manager) loop(st *watchState) {
	defer close(st.done)

	// errCh を local 化し fsnotify が Errors を閉じたとき nil にできるように — でないと閉じた channel が
	// 常時 ready で continue が tight CPU loop になる。
	errCh := st.watcher.Errors

	var (
		timer   *time.Timer
		timerCh <-chan time.Time
		pending changedAccumulator
	)

	flush := func() {
		if pending.empty() {
			return
		}
		payload := pending.snapshot(st.root)
		pending.reset()
		m.emit(payload)
		logging.Debug("watcher", "flush",
			"folder", st.root,
			"added", payload.AddedFiles,
			"removed", payload.RemovedFiles,
			"renamed", payload.RenamedFiles,
			"sidecar", payload.SidecarChanged)
	}
	resetTimer := func() {
		if timer != nil {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(m.debounce)
		} else {
			timer = time.NewTimer(m.debounce)
		}
		timerCh = timer.C
	}

	for {
		select {
		case ev, ok := <-st.watcher.Events:
			if !ok {
				if timer != nil {
					timer.Stop()
				}
				// stopLocked は Close の前に stopRequested を立てる。区別:
				//   - 明示 Stop → pending discard (trailing flush は不要な event を emit する)
				//   - 想定外 backend close (fsnotify 死 / max_watches overflow) → log + flush で部分結果を渡す (spec §10.2)
				if !st.stopRequested.Load() {
					logging.Warn("watcher",
						"events channel closed unexpectedly",
						"folder", st.root)
					flush()
				}
				return
			}
			logging.Debug("watcher", "event",
				"op", ev.Op.String(), "path", ev.Name)
			if classifyAndAccumulate(&pending, ev, st) {
				resetTimer()
			}
			// root 消失: watched root 自身の Remove/Rename は inotify watch を IN_IGNORED で dangling にし、
			// goroutine が dead fd を永遠に待ち Start も同 root で短絡して次の openFolder が no-op になる。
			// pending を flush (不在を surface) し exit 前に fsnotify を tear down する — 開いたままだと fd と
			// reader goroutine が leak する。stopLocked は stopRequested を見るので並行 Stop でも冪等。
			if (ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename)) && ev.Name == st.root {
				if timer != nil {
					timer.Stop()
				}
				// Stop 並行: 明示 Stop 済みなら "discard pending" 契約を守る (trailing の warn + flush は
				// 監視 off 済み folder には noisy)。timer / Events !ok / st.stop 分岐と同じ扱い。
				if st.stopRequested.Load() {
					return
				}
				logging.Warn("watcher", "watch root vanished",
					"folder", st.root, "op", ev.Op.String())
				pending.anyChange = true
				flush()
				// stopRequested を立て、上の !ok 分岐が close を意図的と扱い log + flush の重複を skip するように。
				// goroutine 終了は下の return、Close は fsnotify 内部の goroutine / fd 解放だけ。
				st.stopRequested.Store(true)
				_ = st.watcher.Close()
				return
			}
		case err, ok := <-errCh:
			if !ok {
				// fsnotify が Errors を閉じた。return しない (Events はまだ live かも); spin を避けこの case を無効化。
				errCh = nil
				continue
			}
			logging.Warn("watcher", "channel error", "err", err.Error())
			// benign warning と lost-event (IN_Q_OVERFLOW 等) を確実に区別できないので、安全側で anyChange を
			// 立て re-Load させる — でないと queue overflow で listing が silent に stale になる。
			pending.anyChange = true
			resetTimer()
		case <-timerCh:
			timerCh = nil
			// Stop と timer が同 tick で両方 ready のとき Go はランダム選択するので、stopLocked 後でもこの分岐が
			// 勝って "明示 Stop は pending discard" 契約を破りうる。stopRequested で防ぐ。
			if st.stopRequested.Load() {
				return
			}
			flush()
		case <-st.stop:
			if timer != nil {
				timer.Stop()
			}
			// 上の Events !ok 分岐と同じ理由 — 明示 Stop は pending を捨てる。watcher.Close が Events を
			// drain する前に stop signal が select に勝つとここに来る。
			return
		}
	}
}
