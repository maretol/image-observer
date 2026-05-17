# フォルダー監視機能 実装仕様書 (#19)

一覧 (分類) タブの現在開いているフォルダーを OS のファイルシステム通知 API
(`gofsnotify/fsnotify`) で監視し、外部からの画像追加 / 削除 / リネーム /
サイドカー編集を **自動で UI に反映** する。

> **ステータス**: ドラフト。§13 の決定事項をユーザー合意後に着手。

---

## 0. 改訂履歴

- 2026-05-17 初版ドラフト。Phase 1 = 一覧タブの現在フォルダのみ監視、画像
  Create/Remove/Rename → silent auto-merge、サイドカー Write → 自動 reload、
  200ms debounce、`gofsnotify/fsnotify` 採用 (issue #19 コメント指定)。

---

## 1. ゴール (DoD)

- 一覧タブでフォルダーを開いた状態のまま、**外部 (Explorer / 別アプリ / AI バッチ
  生成スクリプト等) で画像を追加・削除・リネーム** すると、再読み込みボタンを
  押さなくても一覧に反映される。
- 同様に外部で `_classification.json` を書き換えた場合も自動で反映される
  (例: AI 分類ツールがバッチで sidecar を書き直すユースケース)。
- 監視は **現在開いているフォルダのみ**。フォルダ切替で旧 watch を解除して
  新 watch を張り直す。アプリ終了時に clean up。
- 大量バースト (カメラからの一括コピー、AI バッチ書き出し等) は内部で
  coalesce し、フロントへの emit は **最後のイベントから 200ms 静止後に 1 回**。
- 既存の編集 / 競合検出 / merge prompt フローと衝突しない (= 編集中ポップオーバー
  が開いている / conflict / merge prompt 表示中は反映を遅延)。
- 監視 ON / OFF を settings.json で切替可能 (default `auto`)。
- `wails build` 通過、`go test ./...` 全通過、`tsc --noEmit` クリア、vitest 全通過。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **watcher** | OS のファイルシステム通知 API を抽象化した Go 側コンポーネント。`internal/watcher` パッケージ新設。 |
| **watch** | 1 つのフォルダーに対する監視登録。再帰監視のため root + 全サブフォルダに 1 つずつ張る。 |
| **changed イベント** | watcher が debounce / coalesce 後にフロントへ emit する集約イベント。`{ folder, addedFiles, removedFiles, sidecarChanged }` を含む。 |
| **silent auto-merge** | フロント側で `LoadClassification` を再実行し、結果を差分マージして UI に反映する操作。ユーザー操作の中断・確認ダイアログは出さない。 |
| **degraded mode** | watcher の起動に失敗した状態。reload ボタン経由の手動更新のみで動作する。 |

---

## 3. アーキテクチャ概観

```
┌─────────────────────────────────────────────────────────┐
│ Frontend (React)                                        │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ClassificationView                                  │ │
│ │  └ useClassification                                │ │
│ │     ├ LoadClassification (既存)                     │ │
│ │     ├ EventsOn("classification:changed") ← 新規     │ │
│ │     └ silent auto-merge / 編集中なら deferred       │ │
│ └─────────────────────────────────────────────────────┘ │
│              │ Wails IPC + EventsEmit / EventsOn        │
└──────────────┼──────────────────────────────────────────┘
               │
┌──────────────┴──────────────────────────────────────────┐
│ Backend (Go)                                            │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ app.go                                              │ │
│ │  StartFolderWatch(folder) / StopFolderWatch()       │ │
│ └────────────┬────────────────────────────────────────┘ │
│              │                                          │
│ ┌────────────┴────────────────────────────────────────┐ │
│ │ internal/watcher                                    │ │
│ │  Manager                                            │ │
│ │    ├ Start(folder) / Stop()                         │ │
│ │    ├ WalkDir で全サブフォルダに watch 追加          │ │
│ │    ├ Create(dir) → 新規 watch 追加 (incremental)    │ │
│ │    ├ debounce 200ms → coalesce → emit               │ │
│ │    └ runtime.EventsEmit("classification:changed")   │ │
│ └────────────┬────────────────────────────────────────┘ │
│              │                                          │
│ ┌────────────┴────────────────────────────────────────┐ │
│ │ gofsnotify/fsnotify                                 │ │
│ │   inotify (Linux dev) / ReadDirectoryChangesW (Win) │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

ファイルシステム通知の OS 差異は `gofsnotify/fsnotify` に隔離。Go 側のロジックは
**「raw event → debounce + coalesce + フィルタ → 1 個の集約イベントを emit」**
に専念し、フロントは「changed イベントを受けたら現在 folder を Load し直して
差分マージ」だけ担当する。

## 4. データモデル

state schema 変更は **無し**。watcher 状態は volatile (永続化しない)。

### 4.1 settings.json 追加 (additive)

```go
// internal/settings/settings.go
type SettingsData struct {
    // ... 既存
    WatchMode string `json:"watchMode,omitempty"` // "auto" | "off", default "auto"
}
```

| 値 | 動作 |
|----|------|
| `"auto"` (既定) | フォルダを開いたタイミングで自動的に watch を開始 |
| `"off"` | watch を開始しない (degraded mode で動作、手動 reload のみ) |

per-field fallback で旧 settings.json から無痛 upgrade。schema bump 不要 (v1 のまま
additive。`MaxImagePixelsMP` 追加時 #14 と同じパターン)。

### 4.2 Wails イベント payload

```ts
// frontend/wailsjs/runtime
EventsOn("classification:changed", (payload: ChangedPayload) => { ... })

type ChangedPayload = {
  folder: string;        // 絶対パス。現在 watch 中のフォルダ
  addedFiles: number;    // 追加された画像ファイル数 (200ms バースト内の合計)
  removedFiles: number;  // 削除された画像ファイル数
  renamedFiles: number;  // リネームされた画像ファイル数 (= remove + create カウント)
  sidecarChanged: boolean; // _classification.json が write/create された
}
```

詳細なパス一覧は **載せない**。フロントは payload を summary として扱い、
反映自体は `LoadClassification` を再実行して差分を出す方式。理由:

- watcher が報告するパスは OS / fsnotify バージョン差で表記揺れがある (絶対 / 相対、
  シンボリックリンク解決の差等) ため、IPC 経由で「権威ある entries 一覧」として
  扱うには信頼性が低い。
- 200ms バースト内で何度も書き換わる可能性があり、最終状態は disk が真。

## 5. 画面 / 操作

### 5.1 自動反映のユーザー体験

- フォルダを一覧タブで開く → 自動的に watch 開始 (ユーザー操作不要)
- 外部で画像を追加 → 200ms 後に一覧に追加 (フィルタ / 選択 / 折りたたみ状態は保持)
- 外部で画像を削除 → 200ms 後に entries から消える + 選択中 / 編集中であれば抑止 (§5.3)
- 外部で sidecar 編集 → 200ms 後に entries が新しい sidecar の内容に置換 (§5.4)

### 5.2 トースト通知

silent auto-merge のたびに **小さな info トースト** を 1 個出す:

| 状況 | 文言 |
|------|------|
| 画像のみ変化 (sidecar 無変化) | `"フォルダの変更を検出しました (+N -M)"` |
| sidecar 変化のみ | `"分類データが外部で更新されました"` |
| 両方変化 | `"フォルダと分類データの変更を検出しました (+N -M)"` |

severity = `info`。`useToastFn` を流用。同種トーストが既に出ている場合は上書き
(連続バーストで通知ががさ付かないように)。**バナー (案 B) は採用しない**。
理由は §13.7 を参照。

### 5.3 編集中 / 確認中の抑止

以下のいずれかの状態では auto-merge を **遅延**:

- `editing.open === true` (編集ポップオーバー表示中)
- `conflict !== null` (競合ダイアログ表示中)
- `mergePrompt.open === true` (子→親マージ確認中)

遅延中はイベントを内部フラグ (`pendingChanged: ChangedPayload | null`) に保持し、
上記いずれかが閉じた瞬間にまとめて 1 回適用する。**例外**: 編集ポップオーバーの
対象 filename が `removedFiles` に含まれる場合は即座に:

1. ポップオーバーを `closeEdit()` で閉じる
2. warn トースト `"<filename> は外部で削除されました"`
3. 通常の auto-merge を実行

理由: 削除済みファイルに対する編集を user が続けて確定 → 保存先 entry が消えた
sidecar に書き戻されると操作が無駄になるため、即座に通知する方が UX として親切。

### 5.4 sidecar 変化の反映

`sidecarChanged === true` のとき、現在の `loadResult.mtime` と再 Load 後の
`mtime` が一致しない場合のみ entries を置換 (no-op 自己ループ防止)。`Service.Load`
が既に「sidecar + 実ファイル merge」をやってくれるので、フロント側は単に再呼び出し
するだけ。

**競合**: ユーザがちょうど編集 → 保存しようとしたタイミングで sidecar が更新
されると、既存の mtime 競合検出 (`SaveJSON` の `ErrConflict`) に乗る。auto-merge
で `loadResult.mtime` を更新した後は次回保存時にも新しい mtime が使われるため、
編集中状態 (= 抑止中、§5.3) を抜けるまで `loadResult.mtime` は据え置く。

### 5.5 degraded mode

watcher の起動に失敗した場合 (例: 監視対象数が OS 上限を超えた、権限なし):

- 起動時 warn トースト `"自動監視を開始できませんでした (再読み込みボタンで手動更新してください)"`
- `EventsEmit` は呼ばれず、フロントは従来通り手動 reload のみで動作
- ログに詳細 (`logger.warn("watcher", "start failed", { folder, err })`)
- `StopFolderWatch` / 別フォルダへの切替は通常通り動く (二度 Start を試行する経路は
  毎回 reset すれば OK)

## 6. IPC (Go バインディング)

### 6.1 新規 API

```go
// app.go
func (a *App) StartFolderWatch(folderPath string) error
func (a *App) StopFolderWatch() error
```

| 引数 | 意味 |
|------|------|
| `folderPath` | 絶対パス。一覧タブが開いている folder。 |

戻り値:
- `nil`: watcher 起動 / 停止成功
- `error`: failed → フロント側で degraded mode へ。エラー文字列はそのままログ。

`StartFolderWatch` を別フォルダで再呼び出しすると、内部で旧 watch を `Stop` → 新規
`Start` の順で再構築する。`StopFolderWatch` は idempotent (未起動でも no-op)。

### 6.2 EventsEmit

Go 側で `runtime.EventsEmit(a.ctx, "classification:changed", ChangedPayload{...})`
を呼ぶ。`ChangedPayload` の構造体は `internal/watcher` でエクスポート (Wails が
TS バインディングを自動生成)。

### 6.3 ライフサイクル責務

- フォルダを開く / 切り替える ← フロント `useClassification.openFolder` が
  `StartFolderWatch` を呼ぶ
- アプリ起動時に session 復元で folder が読まれた ← `useClassification` の
  auto-load effect が同様に `StartFolderWatch` を呼ぶ
- WatchMode が `"off"` ← フロント側で `StartFolderWatch` を呼ばない (Go 側は
  「呼ばれたら起動する」スタンスで設定値は知らない)
- WatchMode を `"auto"` ↔ `"off"` で切替 ← フロントが `Stop` / `Start` を相応に呼ぶ
- アプリ終了 ← `main.go` の `OnShutdown` で `internal/watcher` 側に Stop を委譲
  (フロント経由ではなく直接)

## 7. 監視戦略 (Go 側詳細)

### 7.1 再帰監視

`gofsnotify/fsnotify` は OS によって挙動が違う:

- **Linux (inotify)**: 再帰非対応。サブフォルダ 1 つにつき 1 watch を張る必要あり。
- **Windows (ReadDirectoryChangesW)**: `recursive: true` をサポート (gofsnotify 拡張)。
  ただし v1 では **OS 差を消すため Linux と同じ「サブフォルダ列挙 + 個別 watch」**
  の戦略を採る (シンプル + テスト容易性 + 「特定サブフォルダだけ無視」を将来追加
  しやすい)。
- **macOS (FSEvents)**: 開発・配布対象外なので v1 ではテストしない。動けばラッキー。

起動シーケンス:

```go
// internal/watcher/manager.go (擬似コード)
func (m *Manager) Start(root string) error {
    w, err := fsnotify.NewWatcher()
    if err != nil { return err }
    // 全サブフォルダを WalkDir で列挙 (classification.scanner と同じ
    // isHiddenName 規則で隠しディレクトリを除外)
    err = filepath.WalkDir(root, func(p string, d fs.DirEntry, _ error) error {
        if !d.IsDir() { return nil }
        if isHiddenName(d.Name()) && p != root { return fs.SkipDir }
        return w.Add(p)
    })
    if err != nil { /* cleanup + return */ }
    m.watcher = w
    go m.loop()
    return nil
}
```

ディレクトリの Create イベントを受けたら `w.Add` で incremental 追加。
Remove で `w.Remove` (内部で no-op になる可能性あり、エラーは黙殺)。

### 7.2 イベント分類

| 対象 | event | アクション |
|------|-------|------------|
| 画像ファイル (`imgfile.IsImage`) | Create | `addedFiles++` |
| 画像ファイル | Remove / Rename (source) | `removedFiles++` |
| 画像ファイル | Rename (dest) | `addedFiles++` |
| 画像ファイル | Write | **無視** (entries に変化なし。サムネは mtime/size keyed なので自然に再生成) |
| サイドカー (`_classification.json`) | Create / Write / Rename (dest) | `sidecarChanged = true` |
| サイドカー | Remove / Rename (source) | `sidecarChanged = true` (entries から sidecar 元エントリが消える可能性、Load し直して反映) |
| ディレクトリ | Create | `w.Add(p)` で watch 追加 + `addedFiles` は子の Create イベントで個別カウント |
| ディレクトリ | Remove | `w.Remove(p)` (失敗黙殺)。子の Remove イベントは fsnotify が個別に出す |
| 隠しファイル / 隠しディレクトリ (`.`始まり) | 全 event | 無視 |
| `_classification.csv` / `.bak` 等の sidecar 派生ファイル | 全 event | 無視 (sidecar JSON のみ追跡) |

**Rename の扱い**: fsnotify は OS により `Rename` 1 個 + 同名 `Create` 1 個を出す
場合と、`Remove` + `Create` を出す場合がある。本仕様では rename を「remove + create
の組」として扱い、独自の matching は行わない (= `renamedFiles` カウントは
informational のみ、内部ロジックは add / remove ペアで一貫)。

### 7.3 Debounce / Coalesce

```go
// 擬似コード
const debounceWindow = 200 * time.Millisecond

func (m *Manager) loop() {
    var (
        timer   *time.Timer
        pending changedAccumulator
    )
    flush := func() {
        if pending.empty() { return }
        runtime.EventsEmit(m.ctx, "classification:changed", pending.snapshot())
        pending.reset()
    }
    for {
        select {
        case ev := <-m.watcher.Events:
            pending.accumulate(ev)
            if timer != nil { timer.Stop() }
            timer = time.AfterFunc(debounceWindow, flush)
        case err := <-m.watcher.Errors:
            logging.Warn("watcher", "channel error", "err", err.Error())
        case <-m.stop:
            if timer != nil { timer.Stop() }
            flush() // 終了直前に残イベントを吐く (Stop 後の Start 即実行に備える)
            return
        }
    }
}
```

`debounceWindow = 200ms` は固定 (将来 settings 化検討)。理由:

- カメラからの一括コピー (~100 files/sec) を 1 イベントにまとめるには 100ms 以上必要
- AI バッチ書き出し (数秒〜数十秒) は中途半端なところで auto-merge が走るのも
  許容範囲。最終 flush で entries が落ち着く
- 500ms 以上は「変更したのに反映遅い」体感が出やすい
- 一覧 reload 自体は数 ms〜数十 ms オーダーなので、200ms 周期で叩いても CPU 負荷
  にはならない

### 7.4 Manager の責務境界

```go
// internal/watcher/manager.go
type Manager struct {
    ctx     context.Context     // wails runtime context, EventsEmit のため
    watcher *fsnotify.Watcher
    root    string
    stop    chan struct{}
    mu      sync.Mutex          // Start/Stop の排他
}

func NewManager(ctx context.Context) *Manager
func (m *Manager) Start(root string) error
func (m *Manager) Stop() error
func (m *Manager) Current() string                // テスト / debug 用
```

`Start` は再入可能。新規 root が指定されたら旧 watcher を Close → 新規 Watcher を
構築。Stop は再 Start を妨げない。`OnShutdown` で 1 度 Stop を呼べば clean up 完了。

### 7.5 リソース上限

Linux inotify はデフォルトで user あたり 8192 watch まで (`/proc/sys/fs/inotify/max_user_watches`)。
配布対象は Windows 主体だが、開発時に当たる可能性あり。

- `w.Add` 失敗 (`too many open files` 等) はログに warn を残して **walk を続行**
  (子フォルダの一部だけ監視できないが、残りは動く)。
- root の `w.Add` 自体が失敗したら `Start` 全体を error 返却 → degraded mode へ。

## 8. 永続化

state schema 変更なし。settings.json に `WatchMode` を additive 追加 (§4.1)。

## 9. マイグレーション

state schema / settings schema bump なし。新フィールドは per-field fallback で
旧 settings.json から無痛 upgrade。

## 10. エラーハンドリング

### 10.1 watcher 起動失敗

`StartFolderWatch` が error → フロントで warn トースト + degraded mode (§5.5)。
エラー詳細はログ。

### 10.2 watcher channel が予期せず close

`Manager.loop` が `nil, false` を受けたら `logging.Error("watcher", "channel closed unexpectedly")`
を残して終了。フロントには「現在の watch が死んだ」イベントを emit しない (= 静かに
degraded 化)。次回フォルダ切替で新規 watcher が張られる。

ここで「死亡通知イベントを emit してフロントから再 Start させる」案も検討したが:

- watch 死亡は Linux で max_user_watches 不足など環境要因が大半 → ループしても
  治らないことが多い
- フロント側の再 Start ロジックが複雑になる
- Phase 1 では「次回フォルダを開き直したら復活」で十分

### 10.3 `LoadClassification` (auto-merge 時) が失敗

通常の reload と同じパスを通る → 既存の `setError` + error トースト。
ユーザー操作 (再読み込みボタン) と区別しない。

### 10.4 ログ

```
logger.info("watcher", "started", { folder, watchCount })       // Start 成功時
logger.warn("watcher", "start failed", { folder, err })         // Start 失敗時
logger.warn("watcher", "add dir failed", { dir, err })          // 個別 Add 失敗時
logger.debug("watcher", "event", { op, path })                  // raw event (DEBUG リング)
logger.debug("watcher", "flush", { added, removed, sidecar })   // 集約 flush 時
```

raw event は高頻度なので `logger.debug` (ring buffer に蓄積、flush 時のみ Go 側に
転送される既存仕組み) を使う。

## 11. テスト

### 11.1 Go

`internal/watcher/manager_test.go`:

| ケース | 期待 |
|--------|------|
| `Start(tmpDir)` 後に画像ファイル Create → 200ms 待ち → `addedFiles == 1` の event が emit される | OK |
| 200ms 内に 5 個 Create → 1 個の event に `addedFiles == 5` で集約 | OK |
| 画像ではない `.txt` Create → event 出ない | OK |
| 隠しディレクトリ `.git` 配下の Create → event 出ない | OK |
| サブフォルダ Create → そのフォルダに watch が追加され、配下のファイル Create も拾える | OK |
| `_classification.json` Write → `sidecarChanged: true` の event | OK |
| `Stop()` 後の Create はもう event を出さない | OK |
| `Start(folderA)` → `Start(folderB)` で旧 watch が掃除される (folderA の Create は無視) | OK |

`runtime.EventsEmit` は context を取るが、テストでは `internal/watcher` を直接
呼び出し、`emit` を関数フィールドに差し替えてキャプチャするアプローチ
(`Manager.emitFn func(string, ...interface{})` を露出して内部はそれを介して emit)。

実 fsnotify を起動する integration test は CI (Linux runner) で動かす。Windows 専用
コードパスは手動確認に依存 (#47 Trash と同じ)。

### 11.2 フロント

vitest:

| ケース | 期待 |
|--------|------|
| `EventsOn("classification:changed")` のハンドラが現在 folder と一致する payload で `LoadClassification` を呼ぶ | OK |
| 違う folder の payload (古い watcher の残響) は無視される | OK |
| 編集ポップオーバー open 中 + 対象 filename が removedFiles に含まれる → ポップオーバー閉じる + warn toast | OK |
| 編集ポップオーバー open 中 + 対象 filename が含まれない → auto-merge は deferred | OK |
| `mergePrompt.open === true` のとき auto-merge は deferred | OK |
| auto-merge 後に entries が新 sidecar の内容に更新される | OK |

実 IPC は mock (`vi.mock("../../../wailsjs/go/main/App", ...)` 既存パターン)。
`EventsOn` / `EventsEmit` も同様に runtime mock を用意。

### 11.3 手動 (Windows / Linux)

- 一覧でフォルダ A を開いた状態で Explorer から画像をコピー → 一覧に追加される
- 同じ画像を Explorer で削除 → 一覧から消える
- 画像をリネーム → 旧名が消えて新名で追加される
- AI ツールで `_classification.json` を書き換える → 一覧の tag / confidence / note が
  更新される
- 編集ポップオーバーを開いている画像を外部から削除 → ポップオーバー閉じる + warn
- 別フォルダに切り替え → 旧 watch のイベントが反映されない
- 設定で `WatchMode = "off"` → 自動更新が停止、reload ボタンのみで更新できる
- 大量バースト (画像 100 枚を一気にコピー) → 1 個のトーストにまとまる

## 12. パッケージ境界

新規 `internal/watcher` パッケージ:

- エクスポート: `Manager`、`NewManager(ctx) *Manager`、`Start(root) error`、
  `Stop() error`、`Current() string`、`ChangedPayload` 型
- 依存: `gofsnotify/fsnotify`、`internal/imgfile` (画像判定)、`internal/logging`、
  `github.com/wailsapp/wails/v2/pkg/runtime` (EventsEmit)
- 被依存: `app.go` (バインディング呼び出し) と `main.go` (起動 / 終了)

`classification` パッケージとは **疎結合** にする (classification は watcher を知らない、
watcher は classification を知らない)。`app.go` で結線。

## 13. 決定事項 (= 本書での recommend、レビューで合意を取る)

| § | 論点 | 本書の決定 | 代替案 / 検討理由 |
|---|------|----------|---------------------|
| 13.1 | ライブラリ | **`github.com/gofsnotify/fsnotify`** (issue #19 コメント指定) | 原 `fsnotify/fsnotify` はメンテ停滞、`gofsnotify` は同 API の active fork。差し替え可能性は将来検討 |
| 13.2 | 監視スコープ | **一覧タブの現在 folder のみ**。サブフォルダは再帰的に監視 | ビューアタブで開いている個別画像の監視は Phase 2 (#19 文言「一覧を更新」とも整合) |
| 13.3 | 再帰戦略 | **OS によらず WalkDir で全サブフォルダ列挙 + 個別 watch**。新規 dir Create で incremental 追加 | Windows のみ `recursive: true` 採用は OS 差を持ち込むため不採用 |
| 13.4 | Debounce | **200ms 固定** | カメラ一括コピー対応 + UI 体感のバランス。将来 settings 化検討 |
| 13.5 | 反映方式 | **silent auto-merge**。フィルタ / 選択 / 折りたたみは保持 | バナー「外部変更を検出 [再読み込み]」は §13.7 で不採用 |
| 13.6 | 通知 UI | **小さな info トースト 1 個** (`+N -M` 形式)。連続バーストでは上書き | OS ネイティブ通知は Wails v2 の対応状況が OS 依存で v1 のみのため除外 |
| 13.7 | バナー UI | **採用しない** | 一覧画面の縦領域を消費する / ユーザ操作必須は issue 文言「自動で更新」に反する。「外部編集時の見落としリスク」より「自動で reflect される快適さ」を優先 |
| 13.8 | 編集中の挙動 | **編集 / conflict / merge ダイアログ表示中は反映を遅延**。ただし編集対象が削除された場合だけ即時 close + warn | バックグラウンドで強制反映 → 編集中ポップオーバーの draft が消えるリスク |
| 13.9 | sidecar 自動取り込み | **`sidecarChanged === true` で reload して entries を置換**。`loadResult.mtime` も更新 | ユーザの未保存編集中は §13.8 で抑止される。手動 reload と同経路を通る |
| 13.10 | 設定 | **`settings.WatchMode = "auto" | "off"` 追加** (default `auto`)。schema bump なし | 監視対象の細かい設定 (subdir 除外、deboounce 値、再帰深さ等) は Phase 2 |
| 13.11 | Watch 失敗時 | **degraded mode** (warn トースト + 手動 reload のみで動作)。再 Start は次回フォルダ切替時 | 自動再試行は環境要因の場合無限ループしがちなので Phase 2 |
| 13.12 | Rename 扱い | **remove + create のペアとして処理**。matching は行わず informational カウントのみ | OS 差で rename event の出方が変わるため robust に |
| 13.13 | ビューアタブとの連携 | **Phase 1 では実装しない**。ビューアで開いている画像が外部削除されても自動 close はしない (ImageView 側の missing-file エラー表示で吸収) | #47 Phase 2 と束ねる判断もアリ。Phase 2 で `useViewerSet.closeTabsForPath` を流用 |
| 13.14 | サムネキャッシュ | **触らない**。mtime / size keyed で自動的に新キーが生成される | キャッシュ GC は別 issue |

## 14. Out of scope

完全に範囲外 (Phase 2 でも対応しない、または別 issue 化が必要なもの):

- 監視中のフォルダの「閉じる」UI (現状そもそも一覧側に close 概念なし)
- 複数フォルダの同時監視 (init.md スコープ外と整合)
- 旧サムネキャッシュの orphan GC
- watcher 経由の「ビューアタブで開いている画像本体の変更検出」(別画像エディタで保存
  し直したら viewer の表示を refresh する等)

## 15. Phase 分割

### Phase 1 (本 spec のスコープ)

- `internal/watcher` パッケージ + `Manager` (Start / Stop / EventsEmit)
- `app.go::StartFolderWatch` / `StopFolderWatch` バインディング
- フロント `useClassification` の `EventsOn` 結線 + silent auto-merge
- 200ms debounce + バースト coalesce
- `settings.WatchMode` (auto / off)
- 編集中の deferred 反映 + 削除時の即時 close
- info トースト通知 (`+N -M`)
- ChangedPayload の `addedFiles / removedFiles / renamedFiles / sidecarChanged`

### Phase 2 (将来 issue 化)

- ビューアタブで開いている画像が外部削除されたら自動 close (`useViewerSet.closeTabsForPath` 流用)
- ビューアで開いている画像本体が外部書き換えされたら refresh
- 監視対象の細かい設定 (subdir 除外 / 再帰深さ / debounce 値)
- バナー UI (案 B) を opt-in 化
- watcher 障害時の自動再試行
- 監視中 watch 数のステータス表示 (デバッグ目的)

---

## 16. 参考 (実装着手時に必ず読む)

- [AGENTS.md](../AGENTS.md):
  - A-2 / A-3: 識別子リネーム時のコメント / context.md 同期
  - B-1: ミュータブル参照を export しない (`ChangedPayload` の構造体は immutable に)
  - C-1 / C-2: `EventsOn` ハンドラ内で `setState` を立て続けに呼ぶときの stale closure
  - D-1: `debounceWindow` を Go と TS で重複定義しない (片方を export、もう片方は import)
  - H-2: `EventsOn` のクリーンアップ (`EventsOff` を unmount で必ず呼ぶ。さもなくば
    フォルダ切替や hot reload で listener が積み上がり double-merge する)
  - H-7: 同種の long-lived listener (Toast / zoomCommandBus 等) と同じ unmount パターンか確認
- [docs/spec-classification.md](spec-classification.md): 一覧タブの設計、sidecar 競合検出
- [docs/spec-image-delete.md](spec-image-delete.md): ビューアタブ自動 close (Phase 2 で再利用)
- 関連 issue: [#19](https://github.com/maretol/image-observer/issues/19)
