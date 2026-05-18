# フォルダー監視機能 実装仕様書 (#19)

一覧 (分類) タブの現在開いているフォルダーを OS のファイルシステム通知 API
(`gofsnotify/fsnotify`) で監視し、外部からの画像追加 / 削除 / リネーム /
サイドカー編集を **自動で UI に反映** する。

> **ステータス**: Phase 1 実装完了 (PR #75)。Phase 2 着手時に本書 §15 を起点に拡張する。

---

## 0. 改訂履歴

| 更新日 | PR / ラウンド | 主な変更 |
|--------|-------------|---------|
| 2026-05-17 | PR #75 初版 | Phase 1 仕様策定。fsnotify 採用、200ms debounce、silent auto-merge |
| 2026-05-17 | PR #75 Round 1 | TS 型を手書き mirror 方針に確定、debounce flush 改定、dir Create 再帰 walk 追記 |
| 2026-05-17 | PR #75 Round 6 | テスト方針を `NewManagerWithDebounce(EmitFunc)` DI API に同期 |
| 2026-05-17 | PR #75 Round 7 | symlink follow 禁止 (os.Lstat)、Errors チャンネル recovery、Start 成功時 stale check |
| 2026-05-17 | PR #75 Round 8 | addSubtree / addSubtreeCollect 2 経路分割、await 後 watchMode 再確認 |
| 2026-05-17 | PR #75 Round 9 | gofsnotify fork の Add(p, All) シグネチャ修正、root vanish 検知、inFlightDeletesRef 追加 |
| 2026-05-17 | PR #75 Round 10 | 全 mutation 成功後 gen bump、Start/Stop intent reconcile (fixed-point 収束) |
| 2026-05-17 | PR #75 Round 11 | silentRecheck を snapshot-only に修正、pendingResultRef に capturedGen 追加 |
| 2026-05-17 | PR #75 Round 12 | 各 await 後 folderRef check、render-time ref sync、silentRecheck を defer |
| 2026-05-17 | PR #75 Round 13 | resetEntriesDependentState ヘルパ追加 (Load 失敗 3 catch 経路一括 clear) |
| 2026-05-17 | PR #75 Round 14 | openFolder でも resetEntriesDependentState、全 mutation に folder check 追加 |
| 2026-05-17 | PR #75 Round 15 | root を hidden filter から除外、removeSubtreeFromWatch で subtree 一括解除 |
| 2026-05-17 | PR #75 Round 16 | SaveJSON に ErrConflict 実装 (sidecar 不在 + expectedMtime > 0)、setError(null) 追加 |
| 2026-05-17 | PR #75 Round 17–18 | CI go test スコープ修正 (./... + ci-placeholder)、context.md / todo.md 整合 |
| 2026-05-17 | PR #75 Round 19 | EmitFunc DI 設計を全記述に統一、TestStartFolderWatch_PathValidation 追加 |
| 2026-05-17 | PR #75 Round 20 | Manager.Start に os.Stat dir check 追加、renamedFiles counter 説明修正 |
| 2026-05-17 | PR #75 Round 21 | inFlightDeletesRef を Map<folder,Set<filename>> 化、os.Lstat 移行、dir 名 sidecar バグ修正 |
| 2026-05-17 | PR #75 Round 22 | Start 切替時の旧 watch teardown を新 root 検証より前に実施 |
| 2026-05-17 | PR #75 Round 24 | removeSubtreeFromWatch に tombstone 引数追加 (image-ext dir の誤計上防止) |
| 2026-05-18 | PR #75 Round 25 | self-echo 検出を asymmetric strip に修正、SaveJSON IsDir() 分岐追加 |
| 2026-05-18 | PR #75 Round 26 | debounce timer 分岐に stopRequested check 追加 (Stop との race 修正) |
| 2026-05-18 | PR #75 Round 27 | docs only: 改訂履歴の時系列並び順修正 |

> 詳細な非同期 IPC 経路の race 検証設計 (gen check / folder check / mode check / pending gen check 等) は **AGENTS.md §H-8** を参照。

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
- `wails build` 通過、`go test ./...` 全通過 (CI と同範囲。CI 側は `mkdir -p frontend/dist && touch frontend/dist/.ci-placeholder` で main の go:embed を満たしている)、`tsc --noEmit` クリア、vitest 全通過。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **watcher** | OS のファイルシステム通知 API を抽象化した Go 側コンポーネント。`internal/watcher` パッケージ新設。 |
| **watch** | 1 つのフォルダーに対する監視登録。再帰監視のため root + 全サブフォルダに 1 つずつ張る。 |
| **changed イベント** | watcher が debounce / coalesce 後にフロントへ emit する集約イベント。`{ folder, addedFiles, removedFiles, renamedFiles, sidecarChanged }` を含む。 |
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
│ │ internal/watcher (wails runtime に依存しない)       │ │
│ │  Manager                                            │ │
│ │    ├ Start(folder) / Stop()                         │ │
│ │    ├ WalkDir で全サブフォルダに watch 追加          │ │
│ │    ├ Create(dir) → 新規 watch 追加 (incremental)    │ │
│ │    ├ debounce 200ms → coalesce                      │ │
│ │    └ emit(ChangedPayload) — EmitFunc DI で受領      │ │
│ │      (本番は app.go が runtime.EventsEmit に結線)   │ │
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
    WatchMode string `json:"watchMode"` // "auto" | "off", default "auto"
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
// frontend/src/features/classification/watcherPolicy.ts に hand-mirror
EventsOn("classification:changed", (payload: ChangedPayload) => { ... })

type ChangedPayload = {
  folder: string;        // 絶対パス。現在 watch 中のフォルダ
  addedFiles: number;    // 追加された画像ファイル数 (200ms バースト内の合計)
  removedFiles: number;  // 削除された画像ファイル数
  renamedFiles: number;  // Rename の source 側イベントごとに +1 する informational counter (dest 側の Create は addedFiles に別計上、1 リネームで renamedFiles が 2 になることはない)
  sidecarChanged: boolean; // _classification.json が write/create された
}
```

**TS 型は手書き mirror**: Wails の `generate module` は exported binding
の戻り値・引数に出現する Go 構造体のみ TS namespace を生成するため、
`EventsEmit` 経由の payload 型 (`watcher.ChangedPayload`) は自動生成
されない。フロント側 [watcherPolicy.ts](../frontend/src/features/classification/watcherPolicy.ts)
で同形の型を hand-mirror し、Go 側 struct (`internal/watcher.ChangedPayload`)
と双方の docstring で cross-reference する。リネーム時は双方を同時更新。

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
| カウンタなし変化 (`addedFiles == removedFiles == renamedFiles == 0 && !sidecarChanged`) | `"フォルダの変更を検出しました"` (counter-less generic 文言) |

最後の行は `anyChange == true` だけが立つケース (ディレクトリ削除 / Errors チャンネル
err 受領 / hidden filter で個別 counter は増えなかったが debounce を回す必要があった
等) のフォールバック。`watcherPolicy.ts::formatChangeSummary` が同じ判定で generic
文言を返すので、Go 側が将来この経路の payload を増やしても表示は安全に成立する。

severity = `info`。`useToastFn` を流用。連続バーストは Go 側の 200ms debounce で 1 件に
集約されるため通知がかさむことは少ない。同種トースト同士の表示上の重複抑制は
現状 `ToastProvider` が message/severity 完全一致のときだけタイマーを延長する挙動に
任せる (差分カウンタ `(+N -M)` が異なれば別トーストとして並ぶ)。**バナー (案 B) は
採用しない**。理由は §13.7 を参照。

### 5.3 編集中 / 確認中の抑止

以下のいずれかの状態では auto-merge を **遅延**:

- `editing.open === true` (編集ポップオーバー表示中)
- `conflict !== null` (競合ダイアログ表示中)
- `mergePrompt.open === true` (子→親マージ確認中)

遅延中はイベントを内部フラグ (`pendingResultRef`) に `{ fresh, folder, capturedGen }`
の 3 フィールドで保持し、上記いずれかが閉じた瞬間に **再度 `decideAutoMerge` を評価して**
commit する。再評価は重要で、deferred 中に編集対象が削除されているケースがあれば、
replay 時に `commit-editing-removed` 経路で popover を閉じる必要がある。

replay (`performReplay`) 起動時の破棄条件 (どれかに該当すれば pending を捨てる):

- `folder !== folderRef.current` — 編集中にフォルダを切り替えた → 旧 folder の
  `LoadResult` を現フォルダに commit しない
- `watchModeRef.current === WATCH_MODE_OFF` — 編集中に監視を off にした → 保留分も破棄
- `capturedGen !== requestGenRef.current` — park 後に他経路 (手動 reload / mutation /
  別 watcher payload) が gen を bump した → 他経路の commit が既に走っているため
  pending は古い。`sidecar mtime` 比較だけだと entries だけ変化のケースで巻き戻し可能
  (PR #75 11th)。

**例外**: 編集ポップオーバーの対象 filename が再 Load 後の entries に **存在
しない** 場合は即座に:

1. ポップオーバーを `closeEdit()` で閉じる
2. warn トースト `"<filename> は外部で削除されました"`
3. 通常の auto-merge を実行 (commit + selected filter)

理由: 削除済みファイルに対する編集を user が続けて確定 → 保存先 entry が消えた
sidecar に書き戻されると操作が無駄になるため、即座に通知する方が UX として親切。

**逆に「対象 filename が存在する」場合は defer する**。spec 当初版では
「commit」と書いていたが、commit すると `loadResult.mtime` が外部の最新値に
更新されてしまい、ユーザの旧 draft が次回 save 時に mtime 競合検出をすり抜けて
外部変更を silently 上書きする重大バグになる (PR #75 レビュー対応)。実装は
[watcherPolicy.ts](../frontend/src/features/classification/watcherPolicy.ts)
の `decideAutoMerge`。

### 5.4 sidecar 変化の反映 / 自己 echo の抑制

`sidecarChanged === true` のとき、現在の `loadResult.mtime` と再 Load 後の
`mtime` が一致しない場合のみ entries を置換 (no-op 自己ループ防止)。
`Service.Load` が既に「sidecar + 実ファイル merge」をやってくれるので、フロント
側は単に再呼び出しするだけ。

**自己 echo の抑制 (PR #75 レビュー対応)**: アプリ自身が呼んだ
sidecar / 画像書き換え系バインディング (`SaveClassification` /
`UpdateClassificationEntry` / `CreateEmptyClassification` /
`MergeChildSidecars` / `DeleteImage`) も watcher に拾われて
`classification:changed` を発火する。フロント側ハンドラは fresh の
entries 内容 (filename / folder / confidence / note を順序込み深比較) が
現在の `loadResult.entries` と等価かどうかで自己 echo を判定する:

- entries 等価 + mtime 等価 → **完全 no-op** (toast も commit も無し)
- entries 等価 + mtime のみ違う → **静かに commit** (toast 無し、次回 save の
  expectedMtime を新鮮に保つため loadResult.mtime だけ更新)
- entries が違う → 通常フロー (toast + `decideAutoMerge`)

これにより通常の編集 / 削除操作で誤通知が出ない。entries 比較は
`Service.Load` の戻り順序 (sidecar 順 → アルファベット順) が決定的なので
順序込み比較で安全。

`DeleteImage` 経由の self-echo は entries 比較だけでは sidecar save の完了タイミングに
依存して取り逃すため、別途 `inFlightDeletesRef: Map<folder, Set<filename>>` で
folder スコープで削除中 filename を保持する。`deleteOne` の冒頭で `(folder, filename)` を
add → finally で必ず delete。watcher handler / `silentRecheckAfterStart` の
entriesEquivalent 判定では `payload.folder` (handler) または引数 `folder` (recheck) で
Map 引きしてから **cur (= 削除前の stale な現在表示) 側だけ** in-flight filename を
strip して fresh と比較する。fresh 側は strip しない: 削除 IPC のラウンドトリップ中に
**外部で同名ファイルが再作成された**ケースでは fresh.entries にその再作成エントリが
通常通り現れるため、これを strip すると差分を取り逃して再作成を silently 隠すことに
なる。cur 側だけ strip すれば、純粋な self-echo (cur が削除前 / fresh は削除後で
filename 不在) では length が揃って equivalent = no toast、再作成ケースでは
cur stripped vs fresh の length 差で diff が surface して通常の auto-merge トーストが
出る (PR #75 25th thread D で symmetric strip → asymmetric に変更)。
**Map の key を folder にしている**のは、フォルダ切替後に旧 folder で進行中だった
delete の filename が新 folder の cur 側 strip に混入して同名ファイルを誤って隠す
race を避けるため (PR #75 21st thread A)。

**競合**: ユーザがちょうど編集 → 保存しようとしたタイミングで sidecar が更新
されると、既存の mtime 競合検出 (`SaveJSON` の `ErrConflict`) に乗る。§5.3 の
defer により編集中は `loadResult.mtime` を据え置くため、save 時の expectedMtime
が古いまま渡り、Go 側が外部変更を検出して conflict ダイアログが出る。

### 5.5 degraded mode / 起動待機

watcher の起動に失敗した場合 (例: 監視対象数が OS 上限を超えた、権限なし):

- 起動時 warn トースト `"自動監視を開始できませんでした (再読み込みボタンで手動更新してください)"`
- `EventsEmit` は呼ばれず、フロントは従来通り手動 reload のみで動作
- ログに詳細 (`logger.warn("watcher", "start failed", { folder, err })`)
- `StopFolderWatch` / 別フォルダへの切替は通常通り動く (二度 Start を試行する経路は
  毎回 reset すれば OK)

**起動直後の待機 (PR #75 レビュー対応)**: フロント側の `useClassification` は
`settings.data?.watchMode` が `undefined` (= `useSettings` が settings.json を
読み込み中) の間は `StartFolderWatch` も `StopFolderWatch` も呼ばない。
さもなくば、永続設定で `watchMode = "off"` を選んでいるユーザでも起動直後の
数百 ms の間 auto で動いてしまい、settings ロード完了時の Stop と Go 側
goroutine の順序次第で誤った状態が残る。`watchMode` が確定 (`"auto"` か
`"off"`) するまで Start を待機させる方が安全。

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
`StartFolderWatch(root)` を同 root で連続呼び出しした場合は、live goroutine が走って
いる限り Go 側で no-op (`Manager.Start` の same-root short-circuit)。これにより
フロントが Start 完了後の stale 判定で `dispatchWatchIntentRef.current()` を再 dispatch しても、
Go 側で重複 walk は走らない (PR #75 7th)。`useClassification` には `tryStart` のような
個別ヘルパは持たず、Start/Stop は §6.3 の単一導管 `dispatchWatchIntentRef` に集約する。

**フロント側 stale 検出**: Wails IPC は call ごとに別 goroutine で dispatch される
ため、JS 側で連続発行した `Start("A")` → `Start("B")` が Go 側 `m.mu` の取得順で
逆転する可能性がある。`useClassification` は各 `Start` の **success / error の
両方** で `folderRef.current` と `watchModeRef.current` を再評価し、stale なら
現在 intent (Stop / 別 folder の Start) を再 dispatch する。Start same-root は
Go 側 no-op、Stop は idempotent なので二重 IPC は副作用なし。

### 6.2 EventsEmit

`runtime.EventsEmit(a.ctx, watcher.ClassificationChangedEvent, ChangedPayload{...})`
を呼ぶのは **`app.go` だけ** (`NewApp` で `watcher.NewManager` に渡す `EmitFunc`
コールバック内で結線)。**event 名はリテラル `"classification:changed"` ではなく
`watcher.ClassificationChangedEvent` 定数経由で参照する** — `internal/watcher`
側と `useClassification.ts` 側が同値テスト (`TestClassificationChangedEventName`
+ `watcherPolicy.test.ts` の `expect(CLASSIFICATION_CHANGED_EVENT).toBe(...)`)
で D-1 ドリフト検知しており、ここでリテラルを混ぜると将来 app.go 側にも
直書きを戻す誤解を招く。`internal/watcher` 自身は `wails/v2/pkg/runtime` を
import しない設計で、`Manager.emit(payload)` (DI で受け取った関数) を呼ぶだけ。
こうすることでテストは `EmitFunc` を直接差し替えてキャプチャでき (§11)、
将来 IPC 機構が変わっても影響範囲を app.go に閉じ込められる (§7.3 / §12)。
`ChangedPayload` 構造体は `internal/watcher` でエクスポートしているが、
Wails の `generate module` は **EventsEmit の payload 型を TS namespace 化しない**
(bindings シグネチャに現れないため)。フロント側は §4.2 のとおり
[watcherPolicy.ts](../frontend/src/features/classification/watcherPolicy.ts)
で同形の型を hand-mirror する。リネーム時は Go / TS の両方を同時更新。

### 6.3 ライフサイクル責務

`useClassification` 内の **`StartFolderWatch` / `StopFolderWatch` 呼び出しは
すべて単一の `dispatchWatchIntentRef` 経由**で行う (= folder-watch effect が
`folderPath` / `watchMode` の変化を見て dispatch する単一導管)。`openFolder` /
auto-load effect / 設定 UI から直接 Start / Stop を呼ぶ経路は意図的に持たない —
JS から並列で Start("A") → Start("B") を発行すると Wails の per-call goroutine
dispatch によって Go 側 `m.mu` 取得順が逆転し得るため、最後の IPC が "勝者" に
なる race を避ける目的 (`postLoadFlow` の race と並んで PR #75 7th / 10th の
主要設計点)。各経路の責務:

- フォルダを開く / 切り替える ← `openFolder` は **folderPath / folderRef を
  更新するのみ**。`useEffect([folderPath, watchMode])` が `dispatchWatchIntentRef`
  を経由して Start / Stop を発行する
- アプリ起動時に session 復元で folder が読まれた ← auto-load effect も同様、
  folderPath を反映するだけで Start / Stop は folder-watch effect が処理
- WatchMode が `"off"` ← `dispatchWatchIntentRef` が `StopFolderWatch` を呼ぶ
  (Go 側は「呼ばれたら起動する」スタンスで設定値は知らない)
- WatchMode を `"auto"` ↔ `"off"` で切替 ← 同じ effect が依存変更で再 fire し、
  intent に応じて Start / Stop を発行
- Start / Stop IPC の完了 (success / error) ← `dispatchWatchIntentRef` の
  then / catch 内で現 intent を再評価し、ズレていれば再 dispatch する
  fixed-point reconcile (Start same-root = no-op / Stop = idempotent を前提)
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
    // Root が「実在するディレクトリ」であることを Lstat で確認する。
    // fsnotify.Watcher.Add は通常ファイルも成功し得るため、ここで弾かないと
    // Start が success を返した後、画像追加 / 削除 event が一切流れない
    // (= 健康に見えて沈黙する) 状態になる。symlink-to-dir も拒否する —
    // 後続の filepath.WalkDir(root, ...) は内部で root を Lstat するので
    // symlink を辿らず子孫の Add が走らない (classification.scanner も
    // 同じ Lstat-at-root 制約なので一貫させる)。詳細は §5.1 / PR #75
    // review 20th / 21st。
    info, err := os.Lstat(root)
    if err != nil { return fmt.Errorf("watcher: lstat root: %w", err) }
    if info.Mode()&os.ModeSymlink != 0 {
        return fmt.Errorf("watcher: root must not be a symlink: %q", root)
    }
    if !info.IsDir() {
        return fmt.Errorf("watcher: root must be a directory: %q", root)
    }

    w, err := fsnotify.NewWatcher()
    if err != nil { return err }
    // Root は明示的に最初に Add し、失敗したら Start 全体を fail させる
    // (root が監視できなければ何もできない)。子孫の Add 失敗は warn して
    // 続行する best-effort 戦略 (§7.5 で詳述、partial coverage beats none)。
    // w.Add の第 2 引数 op マスクは gofsnotify/fsnotify v0.0.6 が要求する
    // シグネチャ (原 fsnotify は単引数だが採用 fork はオペレーションマスクを
    // 取る) — fsnotify.All で全 op を購読する。
    if err := w.Add(root, fsnotify.All); err != nil {
        _ = w.Close()
        return fmt.Errorf("watcher: cannot watch root: %w", err)
    }
    // 全サブフォルダを WalkDir で列挙 (classification.scanner と同じ
    // isHiddenName 規則で隠しディレクトリを除外)。各 dir Add 失敗は warn 出力
    // のみで継続し WalkDir 自体は止めない。
    _ = filepath.WalkDir(root, func(p string, d fs.DirEntry, _ error) error {
        if p == root || !d.IsDir() { return nil }
        if isHiddenName(d.Name()) { return fs.SkipDir }
        if err := w.Add(p, fsnotify.All); err != nil {
            logging.Warn("watcher", "add dir failed", "dir", p, "err", err.Error())
        }
        return nil
    })
    m.watcher = w
    go m.loop()
    return nil
}
```

ディレクトリの Create イベントを受けたら **配下を `filepath.WalkDir` で再帰的に
walk + 各サブフォルダを `w.Add`** する。これにより:

- `mkdir empty` のような単純なケース → top-level に対する 1 Add のみ
- `mv existing-tree watched-root/` のような原子的 inode 移動 → Linux inotify は
  top-level の Create イベントしか発火しないため、配下のサブフォルダを当方で
  enumerate して Add しないと孫以降の変更を取りこぼす
- 同じ walk で発見した既存画像ファイルは `addedFiles` に集計 (バルク mv の
  サマリを payload に正しく反映するため)

Remove / Rename では **`removeSubtreeFromWatch(st, ev.Name, acc.removedPaths)`
で `ev.Name` および配下の watch path を一括解除** する (#75 15th)。単一の
`w.Remove` だけでは descendant の inode-tracked watch が残り、rename out で
moved 先 subtree の変更が現 root の event として流れ続けて「現在フォルダのみ
監視」前提を破る。Linux inotify は dir 削除時に `IN_IGNORED` で watch を自動
解除するが、明示 `w.Remove` は冪等性確保用 (エラーは黙殺、auto-evict 済みも
許容)。解除した descendant path は同時に `acc.removedPaths` にも登録 (tombstone)
し、subtree Remove の直後に descendant 単独の `IN_DELETE_SELF` が同 debounce
window 内に届いたとき、`watchedDirs` から既に消えた image-extension dir
(`photos.jpg/`) が image branch に fall-through して `removedFiles++` に誤計上
される race を予防する (#75 23rd, thread A)。

### 7.2 イベント分類

| 対象 | event | アクション |
|------|-------|------------|
| 画像ファイル (`imgfile.IsImage`) | Create | `addedFiles++` |
| 画像ファイル | Remove / Rename (source) | `removedFiles++` |
| 画像ファイル | Rename (dest) | `addedFiles++` |
| 画像ファイル | Write | **counter は bump せず、debounce timer のみ延長** (`triggered=true, anyChange=false`)。大きい画像のコピー (Create → Write → Write → …) で Create だけ拾って 200ms 後に flush すると、フロントが未完成 / 0-byte ファイルを開いてサムネエラーを出す race を避けるため、Write 中は quiet window を伸ばし続ける。Write 単独 (既存画像の上書き) では pending が空のままなので flush は no-op になり、Phase 1 のスコープ通り「既存画像の content edit はサムネ更新されない」挙動も維持される (`useGridThumbnail` の path-key cache 制約は §13.14)。 |
| サイドカー (`_classification.json`) | Create / Write / Rename (dest) | `sidecarChanged = true` |
| サイドカー | Remove / Rename (source) | `sidecarChanged = true` (entries から sidecar 元エントリが消える可能性、Load し直して反映) |
| ディレクトリ | Create | `os.Lstat` で symlink を弾いてから配下を `filepath.WalkDir` で再帰 enumerate → 各サブフォルダを `w.Add` + 既存画像ファイル数を `addedFiles` に集計 (`anyChange = true`)。watch 追加に成功した dir path は `watchState.watchedDirs` に登録 (Remove/Rename の dir-vs-file 検出用、#75 14th)。walk で見つけた画像 path は `acc.discoveredImagePaths` 共有 dedup set にも登録し、**parent walk と child Create event 両方で同じ画像を見つけた race / 並行 inotify Create vs walk の race の double-count を防ぐ** (新しい path のみ addedFiles に加算; PR #75 12th)。 |
| 画像拡張子のディレクトリ (`photos.jpg/`) | Remove / Rename | `watchState.watchedDirs` に存在すれば dir 削除と判定し `anyChange` のみに倒す (`removedFiles++` しない)。`acc.removedPaths` で IN_DELETE + IN_DELETE_SELF + IN_IGNORED の多重発火を per-window dedup (#75 14th)。 |
| ディレクトリ / 非画像ファイル symlink | Create | `anyChange = true` のみ立て、target tree への watch 拡大を防止 (分類スキャナも symlink を辿らない設計と整合、「現在フォルダのみ監視」の前提を保つ)。 |
| 画像拡張子の symlink | Create | image-Create branch に fall through (`addedFiles++`)。分類スキャナは Lstat ベースで extension のみ判定するため symlink でも entries に含めるので、payload の `addedFiles` カウントを再 Load 結果と一致させる必要がある (PR #75 8th)。 |
| ディレクトリ | Remove / Rename | `removeSubtreeFromWatch(st, ev.Name)` で `ev.Name` 配下の watchedDirs + w.Remove を一括解除 + `anyChange = true`。Linux inotify は rename で watch を inode に残すため、descendant も含めて解除しないと移動先のサブツリー変更が現在 root の `classification:changed` に流れ込む (#75 15th)。base に画像拡張子も sidecar 名も付かない Remove / Rename は dir or 非画像ファイル相当として扱い、re-Load トリガとして十分 |
| 非画像 / 非 sidecar ファイル | Remove / Rename | `anyChange = true` (dir 削除と区別不能のため安全側に倒す。`*.txt` 削除等で空 flush することはあるが、再 Load は冪等で安価) |
| 非画像 / 非 sidecar ファイル | Create / Write / Chmod | 無視 |
| 隠しファイル / 隠しディレクトリ (`.`始まり) | 全 event | 無視 (**ただし monitor root 自身は除外** — `isHiddenName(base)` ガードは `ev.Name != st.root` の子孫だけに適用する。root のフォルダ名が `.foo` のとき root vanish event まで捨てると loop が dead fd で hang するため、root の Remove/Rename は通常経路で拾って `st.watcher.Close() + return` させる; #75 15th) |
| `_classification.csv` / `.bak` 等の sidecar 派生ファイル | 全 event | 無視 (sidecar JSON のみ追跡) |

**Rename の扱い**: fsnotify は OS により `Rename` 1 個 + 同名 `Create` 1 個を出す
場合と、`Remove` + `Create` を出す場合がある。本仕様では rename を「remove + create
の組」として扱い、独自の matching は行わない (= `renamedFiles` カウントは
informational のみ、内部ロジックは add / remove ペアで一貫)。

### 7.3 Debounce / Coalesce

```go
// 擬似コード (現行 DI 形)
const debounceWindow = 200 * time.Millisecond

// Manager は wails runtime を import せず、emit を DI で受け取る。
// 本番では app.go が `func(p) { runtime.EventsEmit(a.ctx,
// watcher.ClassificationChangedEvent, p) }` を渡す。
type Manager struct {
    emit     EmitFunc
    debounce time.Duration
    // ...
}

func (m *Manager) loop(st *watchState) {
    var (
        timer   *time.Timer
        pending changedAccumulator
    )
    flush := func() {
        if pending.empty() { return }
        payload := pending.snapshot(st.root)
        pending.reset()
        m.emit(payload) // ← wails runtime 依存はここに居ない
    }
    for {
        select {
        case ev := <-st.watcher.Events:
            pending.accumulate(ev)
            if timer != nil { timer.Stop() }
            timer = time.AfterFunc(m.debounce, flush)
        case err := <-st.watcher.Errors:
            logging.Warn("watcher", "channel error", "err", err.Error())
            // queue overflow 等の取りこぼし通知に備えて anyChange を
            // 立て debounce 再起動する (フロントに一般的な再 Load を促す)。
            pending.anyChange = true
            timer = time.AfterFunc(m.debounce, flush)
        case <-st.stop:
            if timer != nil { timer.Stop() }
            // 明示的 Stop は pending を discard する。Stop 直後に flush
            // すると、watchMode = "off" 切替やアプリ終了直後に
            // "classification:changed" がフロントへ届き、ユーザー意図と
            // 反してしまう (PR #75 レビュー対応)。
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
// internal/watcher/watcher.go
type EmitFunc func(ChangedPayload)

type Manager struct {
    emit     EmitFunc
    debounce time.Duration

    mu    sync.Mutex
    state *watchState // non-nil iff a watch is active
}

func NewManager(emit EmitFunc) *Manager
func NewManagerWithDebounce(emit EmitFunc, d time.Duration) *Manager  // テスト用
func (m *Manager) Start(root string) error
func (m *Manager) Stop() error
func (m *Manager) Current() string                // テスト / debug 用
```

**emit DI**: Wails runtime に依存する `EventsEmit` 呼び出しは `app.go` 側で
`EmitFunc` として注入する (`a.watch = watcher.NewManager(func(p) {
runtime.EventsEmit(a.ctx, watcher.ClassificationChangedEvent, p) })`)。これにより
`internal/watcher` 自体は wails runtime を import せず、テストでは emit を
チャネルキャプチャに差し替えられる。

**watchState 分離**: 監視中の状態 (`watcher` / `root` / `stop` ch / `done` ch
/ `stopRequested atomic.Bool`) は `watchState` 構造体に切り出し、`Manager.state`
で nil 切替する。これにより goroutine 自死後の zombie state を `Start` で検知
してリビルドできる。

`Start` は再入可能。同 root + goroutine 生存中は no-op、それ以外は旧 watcher
を Close → 新規 Watcher を構築。Stop は idempotent。`OnShutdown` で 1 度 Stop
を呼べば clean up 完了。

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

`Manager.loop` が Events `nil, false` を受けたら **`stopRequested` が false の
ときに限り** `logging.Warn("watcher", "events channel closed unexpectedly",
"folder", root)` を残し、pending を 1 度 flush してから終了する。フロントには
「現在の watch が死んだ」イベントを emit しない (= 静かに degraded 化)。
**フォルダ切替 / 手動 reload のどちらでも** `dispatchWatchIntent` が再 dispatch
され、`Manager.Start` の `goroutineExited` 判定で zombie state を tear down →
新規 watcher を構築する経路で復旧する (§6.3 / 11th-12th 対応)。

明示的 Stop で同じ分岐に来た場合 (`stopRequested == true`) はログも flush も
せずに即 return する — Stop の意図は「いま積んでいる変更は捨てる」だから
(§7.3)。

ここで「死亡通知イベントを emit してフロントから再 Start させる」案も検討したが:

- watch 死亡は Linux で max_user_watches 不足など環境要因が大半 → ループしても
  治らないことが多い
- フロント側の再 Start ロジックが複雑になる
- Phase 1 では **「フォルダ切替 or 手動 reload で復活」** で十分 (両者とも
  `dispatchWatchIntent` 経由で `Manager.Start` を呼び、`goroutineExited` 判定で
  zombie を tear down → 新規 watcher 構築する。§10.2 と §6.3 を参照)

### 10.2b watcher が `Errors` チャンネルで err を返した

`logging.Warn` でログに残しつつ、`pending.anyChange = true` を立て debounce timer を
リセットする。inotify queue overflow など「イベントを取りこぼした」通知でもフロントが
気付かず一覧が古いまま残るのを避けるための保険 (PR #75 review 7th)。次回 flush で
一般的な再 Load が走り、取りこぼした変更も含めて整合する。

### 10.3 `LoadClassification` (auto-merge 時) が失敗

通常の reload と同じパスを通る → 既存の `setError` + error トースト。
ユーザー操作 (再読み込みボタン) と区別しない。

### 10.4 ログ

```
logger.info("watcher", "started", { folder })                   // Start 成功時
logger.warn("watcher", "start failed", { folder, err })         // Start 失敗時
logger.warn("watcher", "add dir failed", { dir, err })          // 個別 Add 失敗時
logger.debug("watcher", "event", { op, path })                  // raw event (DEBUG リング)
logger.debug("watcher", "flush", { folder, added, removed, renamed, sidecar })   // 集約 flush 時 (ChangedPayload と同じ 4 フィールドを必ず含める)
```

raw event は高頻度なので `logger.debug` (ring buffer に蓄積、flush 時のみ Go 側に
転送される既存仕組み) を使う。

## 11. テスト

### 11.1 Go

`internal/watcher/watcher_test.go`:

下表は Phase 1 で **回帰検知が必須** とした主要挙動。実テスト関数名は
`go test -run` でグレップする (件数スナップショットを避ける、AGENTS.md A-1)。

| 区分 | ケース概要 |
|------|------------|
| Start / Stop 契約 | 欠落 root で fail、**file 渡し root で fail (#75 20th, thread F)**、同一 root 再 Start は no-op、folder 切替で旧 watch を tear down、root vanish 後の Start 再構築 |
| 画像 Create / バースト | 単一 Create で `addedFiles == 1`、バースト Create で `addedFiles == N` の 1 event に集約 |
| 画像 Remove / Rename | Remove で `removedFiles++`、Rename source/dest で informational `renamedFiles` を bump + dest 側は `addedFiles` 別計上 (§4.2) |
| sidecar 変化 | `_classification.json` の Write / Create / Remove で `sidecarChanged: true` |
| 拡張 / dir 挙動 | サブフォルダ Create で watch 拡張 + 配下ファイル Create が拾える、subtree rename-out で descendant watch が一括解除される (#75 15th) |
| symlink / 名前 race | dir symlink は target を follow しない、画像拡張子 symlink は `addedFiles` に計上、画像拡張子の dir (`photos.jpg/`) Remove は `anyChange` のみで `removedFiles++` しない (#75 14th) |
| filter / 無視 | 非画像 Create を無視、隠しディレクトリ配下 Create を無視 (ただし root が `.foo` の場合の root vanish は通常経路で処理) |
| 自己 echo / dedup | dir Create と child image Create の double-count 防止 (`discoveredImagePaths` 共有 dedup)、Remove/Rename 多重発火 (IN_DELETE + IN_DELETE_SELF + IN_IGNORED) の per-window dedup |

`runtime.EventsEmit` は context を取るが、テストでは `internal/watcher` を直接
呼び出し、`NewManagerWithDebounce(emit EmitFunc, d)` のコンストラクタ DI で
`EmitFunc func(ChangedPayload)` を差し替えてキャプチャする (Manager 自体は
`runtime.EventsEmit` を import しない設計)。本番は `app.go` 側で
`func(p watcher.ChangedPayload) { runtime.EventsEmit(a.ctx, watcher.ClassificationChangedEvent, p) }`
を `NewManager` に渡す。

実 fsnotify を起動する integration test は CI (Linux runner) で動かす。Windows 専用
コードパスは手動確認に依存 (#47 Trash と同じ)。

### 11.2 フロント

vitest は **`watcherPolicy.test.ts` の純関数のみ** を対象とする (Phase 1 スコープ):

| ケース | 期待 |
|--------|------|
| `formatChangeSummary` のメッセージ分岐 (files-only / sidecar-only / both / 空 payload で generic) | OK |
| `decideAutoMerge` の分岐 (mergePrompt → defer / conflict → defer / editing-open + target intact → defer / editing-open + target gone → commit-editing-removed / それ以外 → commit) | OK |
| AGENTS.md D-1 drift detector: `CLASSIFICATION_CHANGED_EVENT === "classification:changed"` (Go 側の対のテストとセット) | OK |

**`useClassification` フック自体の event subscription / auto-merge 統合挙動は
vitest 非対象** — happy-dom / jsdom + `@testing-library/react` を導入していない
ため。同種の理由で既存の他フック (`useViewerSet` / `useDirectoryGroups` 等) も純関数
レイヤだけ単体テストしている。hook 統合テストは将来 jsdom 導入と合わせて別 issue
で検討する。手動確認は §11.3 でカバー。

実 IPC は将来 hook テストを書く時点で mock を用意する (`vi.mock(
"../../../wailsjs/go/main/App", ...)` 既存パターン + `EventsOn` / `EventsEmit`
の runtime mock)。

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

- エクスポート: `Manager`、`NewManager(emit EmitFunc) *Manager`、
  `NewManagerWithDebounce(emit EmitFunc, d time.Duration) *Manager` (テスト用)、
  `Start(root) error`、`Stop() error`、`Current() string`、`ChangedPayload` 型、
  `EmitFunc` 型、`DefaultDebounce` 定数、`ClassificationChangedEvent` 定数
- 依存: `gofsnotify/fsnotify`、`internal/classification` (`SidecarJSON` 文字列定数のみ)、
  `internal/imgfile` (画像判定)、`internal/logging`
- 被依存: `app.go` (バインディング呼び出し + emit を `runtime.EventsEmit` に結線) と
  `main.go` (`OnShutdown` で `app.shutdown` → `Manager.Stop` を呼ぶ最終クリーンアップ
  のみ)。`Start` は **フロント側 `useClassification` の folder-watch effect** が
  `StartFolderWatch` バインディングで発火する経路で、`main.go` からは呼ばない。

`runtime.EventsEmit` は `app.go` 側で `Manager` に `EmitFunc` として注入する形を
採り、`internal/watcher` は wails runtime を直接 import しない (テストで emit を
チャネルキャプチャに差し替えやすくするため + パッケージ依存方向をシンプルに
保つため)。

`classification` パッケージとは **挙動レベルでは疎結合** にする (classification は
watcher を知らない、watcher は classification の Service 等を呼ばない)。ただし
sidecar ファイル名 (`_classification.json`) を 1 箇所で持たせるため `watcher` は
`classification.SidecarJSON` 文字列定数のみ import する (定数同期コストが
最も安い)。`app.go` 側で Start/Stop バインディング + emit 配線を行う。

## 13. 決定事項 (= 本書での recommend、レビューで合意を取る)

| § | 論点 | 本書の決定 | 代替案 / 検討理由 |
|---|------|----------|---------------------|
| 13.1 | ライブラリ | **`github.com/gofsnotify/fsnotify`** (issue #19 コメント指定) | 原 `fsnotify/fsnotify` はメンテ停滞、`gofsnotify` は同 API の active fork。差し替え可能性は将来検討 |
| 13.2 | 監視スコープ | **一覧タブの現在 folder のみ**。サブフォルダは再帰的に監視 | ビューアタブで開いている個別画像の監視は Phase 2 (#19 文言「一覧を更新」とも整合) |
| 13.3 | 再帰戦略 | **OS によらず WalkDir で全サブフォルダ列挙 + 個別 watch**。新規 dir Create で incremental 追加 | Windows のみ `recursive: true` 採用は OS 差を持ち込むため不採用 |
| 13.4 | Debounce | **200ms 固定** | カメラ一括コピー対応 + UI 体感のバランス。将来 settings 化検討 |
| 13.5 | 反映方式 | **silent auto-merge**。フィルタ / 選択 / 折りたたみは保持 | バナー「外部変更を検出 [再読み込み]」は §13.7 で不採用 |
| 13.6 | 通知 UI | **小さな info トースト 1 個** (`+N -M` 形式)。連続バーストは Go 側 200ms debounce で 1 件に集約され、フロント `ToastProvider` は message/severity 完全一致時のみタイマー延長 (差分カウンタ違いは別トーストとして並ぶ) | OS ネイティブ通知は Wails v2 の対応状況が OS 依存で v1 のみのため除外。詳細は §5.2 |
| 13.7 | バナー UI | **採用しない** | 一覧画面の縦領域を消費する / ユーザ操作必須は issue 文言「自動で更新」に反する。「外部編集時の見落としリスク」より「自動で reflect される快適さ」を優先 |
| 13.8 | 編集中の挙動 | **編集 / conflict / merge ダイアログ表示中は反映を遅延**。ただし編集対象が削除された場合だけ即時 close + warn | バックグラウンドで強制反映 → 編集中ポップオーバーの draft が消えるリスク |
| 13.9 | sidecar 自動取り込み | **`sidecarChanged === true` で reload して entries を置換**。`loadResult.mtime` も更新 | ユーザの未保存編集中は §13.8 で抑止される。手動 reload と同経路を通る |
| 13.10 | 設定 | **`settings.WatchMode = "auto" | "off"` 追加** (default `auto`)。schema bump なし | 監視対象の細かい設定 (subdir 除外、debounce 値、再帰深さ等) は Phase 2 |
| 13.11 | Watch 失敗時 | **degraded mode** (warn トースト + 手動 reload のみで動作)。再 Start は **フォルダ切替時 / 手動 reload 時** に `dispatchWatchIntent` 経由で発火 (`useClassification.reload` / Round 11 で追加) | 自動再試行は環境要因の場合無限ループしがちなので Phase 2 |
| 13.12 | Rename 扱い | **remove + create のペアとして処理**。matching は行わず informational カウントのみ | OS 差で rename event の出方が変わるため robust に |
| 13.13 | ビューアタブとの連携 | **Phase 1 では実装しない**。ビューアで開いている画像が外部削除されても自動 close はしない (ImageView 側の missing-file エラー表示で吸収) | #47 Phase 2 と束ねる判断もアリ。Phase 2 で `useViewerSet.closeTabsForPath` を流用 |
| 13.14 | サムネキャッシュ | **触らない**。Go 側 disk cache は mtime/size keyed なので新規 / リネーム / 拡張子変更は自動的に別キー。**ただし既存ファイルの内容上書きはフロント `useGridThumbnail` の path-keyed メモリ cache に阻まれて表示が更新されない** — これは Phase 1 既知ギャップで、Phase 2 で「フロント cache 無効化ハック」と「キャッシュ GC」を一括検討 | 既存画像 Write の追従とキャッシュ GC は別 issue |

## 14. Out of scope

完全に範囲外 (Phase 2 でも対応しない、または別 issue 化が必要なもの):

- 監視中のフォルダの「閉じる」UI (現状そもそも一覧側に close 概念なし)
- 複数フォルダの同時監視 (init.md スコープ外と整合)
- 旧サムネキャッシュの orphan GC
- watcher 経由の「ビューアタブで開いている画像本体の変更検出」(別画像エディタで保存
  し直したら viewer の表示を refresh する等)

## 15. Phase 分割

### Phase 1 (本 spec のスコープ)

- `internal/watcher` パッケージ + `Manager` (Start / Stop / `EmitFunc` DI で
  ChangedPayload を発火、wails runtime には依存しない)
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
