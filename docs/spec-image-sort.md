# 画像の並び替え機能 実装仕様書 (#144)

一覧 (分類) タブの画像の表示順を、ユーザーが**ソート基準の選択** (ファイル名 / 更新日時 ×
昇降順) と**手動並び替え** (Card の DnD) の両方で変更できるようにする。issue #144 の
「たぶん今は外部のメタデータ JSON ファイルの配列順」という推測はコード上正しく
(`_classification.json` の entries 配列順が表示順の正本)、本仕様はこの配列順を
「手動順」として公式化した上で、その上に表示専用のソートモードを重ねる 2 層構成を採る。
実装は **Phase 1 (ソートモード) / Phase 2 (手動 DnD 並び替え)** に分割する (§12)。

> **ステータス**: ユーザー合意済み (2026-07-18、D5 は並べ替えモード制に変更の上で合意)。
> Phase 1 (ソートモード) を feat/144-image-sort で実装。Phase 2 (並べ替えモード + DnD) は
> 別ブランチで着手時に §8 を改訂してから。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-07-18 | 初版ドラフト | issue #144 + triage 合意 (スコープ = ソート基準選択 + 手動並び替えの両方) を受けて起案。2 層モデル (sidecar 配列順 = 手動順の正本 + 表示派生ソート) + ListTabState additive 永続化 + H-8 同期モデル表。 |
| 2026-07-18 | レビュー反映 (1) | ユーザー指示で D5 を「常時 DnD」から**明示的な並べ替えモード**に変更。モード中はプレビュー / 選択 / コンテキストメニュー / ビューアタブへの移動 (トップタブ切替 + 関連キーバインド) を無効化し並べ替え専念 (§5.2)。§8 に reorderMode の event source 行を追加。 |
| 2026-07-18 | Phase 1 実装反映 | ソート適用点を filter 後段 (ClassificationView 内、順序保存の述語なので §3 の sort→filter と同値) に確定。sortMode state の所有は useClassification (persistableState 経由で session save に乗るため)。§14 Phase 1 の実ファイルを実装に合わせ更新 (App.tsx / useSessionLoad は変更不要だった)。 |
| 2026-07-18 | code-review 反映 | (1) FileTimes の収集を Load の二重 stat から **scanner の walk 中収集** に変更 (`FileScanner.ListImageFiles` が names+times を返す、§6.1)。(2) watcher の no-op gate に **fileTimes 等価判定を追加** (`fileTimesEquivalent`) — 同名上書きで mtime ソートが stale になる穴を塞ぐ (§8.1 の watcher 行を訂正: 「既存 gate に任せる」は gate 自体が fileTimes を知らず不成立だった)。 |

---

## 1. ゴール (DoD)

- 一覧タブのヘッダーから並び順を選択できる:
  **手動 (既定) / ファイル名 昇順・降順 / 更新日時 昇順・降順** (D1)。
- 選択した並び順は `state.json` に永続化され、再起動後も維持される (D3)。
- 並び順は「グループ内の Card の順序」に適用される。ディレクトリグループ自体の順序
  (直下先頭 → キー昇順) は変えない (D1)。
- 並び順の変更に、既存の順序依存機能が全て追従する:
  Shift+click 範囲選択 / 矢印キー gridNav / SampleModal の prev・next。
  (これらは `displayedOrder` 派生なので、ソートを entries 配列に適用すれば自動で追従する)
- (Phase 2) 並び順が「手動」のとき、**並べ替えモード** に入ると Card を DnD で
  グループ内並び替えでき、結果が `_classification.json` の entries 配列順として
  永続化される (D2)。再読み込み / 再起動後も並びが維持される。
- (Phase 2) 並べ替えモード中は**並べ替え以外の操作ができない** (D5):
  プレビュー (SampleModal) / 選択 / コンテキストメニュー / ビューアへの送りが無効になり、
  トップタブ切替 (ビューアタブへの移動 / 設定) も関連キーバインドごと禁止される。
- (Phase 2) 並び替えの保存は既存の mtime 楽観ロックに乗り、外部変更と衝突したら
  既存の CONFLICT フローに合流する (D8)。
- 通常時 (並べ替えモード外) は DnD が一切発動しない。並べ替えモードに入るボタンは
  ソートモード「手動」かつフィルタ非適用のときのみ有効 (D5)。
- `go test ./...` / `go vet` / `tsc --noEmit` / vitest 全通過。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **手動順** | `_classification.json` の entries 配列順。現状の表示順の実体であり、本仕様で「ユーザーが所有する並び」として公式化する。 |
| **ソートモード** | 一覧タブの表示順の決め方。`manual` (手動順のまま) / `nameAsc` / `nameDesc` / `mtimeAsc` / `mtimeDesc` の 5 値 (D1)。 |
| **表示派生ソート** | `manual` 以外のモード。entries 配列は書き換えず、表示時に純関数で並べ替える。sidecar / disk への書き込みは発生しない。 |
| **並べ替えモード** | 手動並び替え専用の明示的モード (Phase 2)。ヘッダーのトグルで入り、モード中は DnD 並べ替え**のみ**が行える (プレビュー / 選択 / タブ切替等は無効、D5)。永続化しない一時 state。 |
| **手動並び替え** | 並べ替えモード中の Card DnD。entries 配列を並べ替えて既存 `SaveClassification` で永続化する (Phase 2)。 |
| **FileTimes** | `LoadResult` に additive 追加する filename → mtime (Unix 秒) のマップ。`mtimeAsc/Desc` の入力。sidecar には書かない (D4)。 |

---

## 3. アーキテクチャ概観

```
_classification.json entries 配列順  ← 手動順の正本 (現状の実体を公式化)
        │  LoadClassification (LoadResult に FileTimes を additive 追加)
        ▼
loadResult.entries (不変のまま)
        │
        ▼
filterEntries ── sortEntries(filtered, sortMode, fileTimes) ── 純関数 (sort.ts)
        │                    ▲          (filter は順序保存の述語なので sort→filter と同値。
        │             sortMode: useClassification が所有、ListTabState additive 永続化)
        ▼
groupByDirectory → filteredGroups → displayedOrder
        │  (既存の派生チェーン。ソートは 1 箇所差すだけ)
        ▼
範囲選択 / gridNav / SampleModal prev·next が自動追従

(Phase 2) manual モード + 並べ替えモード中のみ:
Card DnD drop → entries 配列を並べ替え → setLoadResult (楽観 local commit)
        → SaveClassification(folder, newEntries, expectedMtime)
        → 成功: mtime 更新 / CONFLICT: 既存 conflict フロー (reload)
```

ポイント:

- **並び順の正本を増やさない**。手動順は今も sidecar 配列順が持っている事実をそのまま使い、
  新しい永続データ (順序ファイル / index フィールド) を導入しない (D2)。
- ソートは **表示派生チェーンの最上流 1 箇所** (`loadResult.entries` → filter の間) に差す。
  下流 (`displayedOrder` 等) は全て派生なので変更不要。
- `mtime` ソートの入力はロード時に Go が stat して返す (D4)。sidecar に書かないので
  schema / conflict 機構に影響しない。

---

## 4. データモデル

| 項目 | 変更 |
|------|------|
| state schema | **v6 のまま additive 追加** (`ListTabState.sort`、§7.1。#116 の無バンプ additive と同じ整理) |
| settings schema | **変更なし** (並び順はフォルダ閲覧状態なので settings でなく state 側、D3) |
| classification sidecar | **スキーマ変更なし**。Phase 2 で entries の**配列順のみ**が並び替え保存で変わる (形式は不変) |
| `LoadResult` | `FileTimes map[string]int64` を additive 追加 (§6.1) |
| 新規 IPC | **なし** (Phase 2 の並び替え保存も既存 `SaveClassification` を流用) |
| 新規 Go パッケージ | なし (`internal/classification` 内の変更のみ) |

---

## 5. 画面 / 操作

### 5.1 並び順セレクト (Phase 1)

- `ClassificationHeader` のフィルタ行に `<select>` を追加。選択肢:
  - `手動` (既定) / `ファイル名 ↑` / `ファイル名 ↓` / `更新日時 ↑` / `更新日時 ↓`
- `<select>` には `aria-label` = 「並び順」を付与 (H-1)。`:focus-visible` は周辺の
  フィルタ UI と同水準のスタイルを App.css に定義 (H-4 で実在 grep)。
- 文言は周辺 (`ClassificationHeader`) がハードコード ja のため同様にハードコード
  (#83 の `t()` 移行は feature view 一括のタイミングで追従)。
- ソートモード変更は表示専用の再並べ替えで、IPC / 書き込みは発生しない。

### 5.2 並べ替えモード + Card DnD (Phase 2)

通常時は DnD を一切発動させず、**明示的な並べ替えモード**に入ったときだけ
並べ替えを行う (D5。誤 drag による意図しない順序変更 + 保存を構造的に防ぐ)。

#### モードの出入り

- `ClassificationHeader` に「並べ替え」トグルボタンを追加 (Phase 2)。
  **有効条件**: ソートモード `manual` かつ **フィルタ非適用** (tags / untaggedOnly /
  confidence / query が全て初期値)。それ以外は disabled + `title` で理由を表示。
- モード中はボタンが「完了」表示 (`aria-pressed` でトグル状態を表現、H-1)。
  「完了」クリックまたは **Esc** で解除。
- モードは永続化しない一時 state (再起動でモード外から開始)。フォルダ切替 /
  一覧タブ unmount で自動解除 (§8)。

#### モード中の操作制限 (並べ替えに専念させる)

- **Card**: クリックでプレビュー (SampleModal) を**開かない** / checkbox・範囲選択無効
  (checkbox 非表示) / CardContextMenu 無効 / ビューアへの送り (ダブルクリック等) 無効。
  Card は「drag ハンドル」としてのみ機能する。
- **トップタブ**: ビューアタブへの切替 / タブ追加 / 設定ボタンを disabled にし、
  関連キーバインド (`Ctrl+Tab` / `Ctrl+Shift+1..9` / `Ctrl+W` 等) も gate する
  (useGlobalKeybindings に reorderMode gate を追加)。並べ替え途中の文脈を失わせない。
- **一覧ヘッダー**: フィルタ UI / 検索 / 並び順セレクト / フォルダ変更ボタンを disabled
  (モード中に有効条件が崩れる操作を入口から塞ぐ)。
- グループの折りたたみ開閉は**許可** (大量画像で目的グループへ辿り着くのに必要)。
- watcher は動き続ける (外部変更の反映は §8 の gate で処理)。

#### DnD 操作

- **Card 全体を pointerdown → 閾値 (5px) 移動で drag 開始** (viewer タブ DnD と同じ
  自前 pointer events 方式。モード中は click に割り当てられた動作が無いため競合しない)。
- ドロップ先は **同一ディレクトリグループ内のみ** (D5)。グループ跨ぎはファイル移動を
  意味してしまうため無効 (カーソルで不可を示す)。
- 挿入位置インジケータ (Card 間の縦バー) を表示。新規 CSS クラスは App.css に定義 (H-4)。
- drop 確定で entries 配列内の該当 entry を移動 → local 反映 → **drop ごとに即時保存** (§8。
  「完了」時の一括保存にしないのは、途中クラッシュ / 強制終了で並びが丸ごと失われるのを
  避けるため + 既存 autosave の思想と揃えるため)。
- マルチタッチ / 二重 pointerdown は先勝ちで無視、`pointercancel` / unmount cleanup で
  drag state を解放 (H-2)。
- キーボードでの並び替え (Ctrl+矢印等) は v1 では設けない (§11、a11y 改善として将来課題)。

### 5.3 トースト / エラー表示

- 表示派生ソート: エラー経路なし。
- (Phase 2) 並び替え保存の失敗: CONFLICT は既存の conflict ダイアログ / reload フローに
  合流。その他エラーは既存 save 失敗と同じ error トースト + ログ。

---

## 6. IPC

### 6.1 `LoadClassification` の返り値拡張 (additive)

```go
// internal/classification — LoadResult に追加
type LoadResult struct {
    // ... 既存フィールド不変 ...
    // FileTimes は Entries の各 filename の mtime (Unix 秒)。mtimeAsc/Desc ソートの入力。
    // stat 失敗 / orphan は行を持たない (frontend は 0 扱いで末尾に寄せる)。
    FileTimes map[string]int64 `json:"fileTimes"`
}
```

- mtime は **scanner の walk 中に収集**する: `FileScanner.ListImageFiles` を
  `([]string, map[string]int64, error)` に拡張し、`WalkDir` コールバックの
  `fs.DirEntry.Info()` (Windows ではディレクトリ列挙データ由来で追加 syscall なし) から
  拾う。Load は passthrough するだけ (code-review 反映: 当初案の Load 側 2 周目 stat は
  watcher flush ごとに N stat を余分に払うため廃止)。
- `Info()` 失敗 (コピー中ロック等) の path は map に行を持たず、エラーにしない。
- watcher 反映 (再 Load) でも自然に最新化される。
- 新規 IPC は増やさない。Phase 2 の保存も既存
  `SaveClassification(folderPath, entries, expectedMtime)` をそのまま使う
  (配列順を変えて渡すだけ。orphans 温存 / mtime 楽観ロック / atomic write は既存実装が担保)。

---

## 7. 永続化 / マイグレーション

### 7.1 state.json (`ListTabState` additive、v6 のまま)

```go
type ListTabState struct {
    FolderPath      string          `json:"folderPath"`
    Filter          ListFilterState `json:"filter"`
    CollapsedGroups []string        `json:"collapsedGroups"`
    // Sort は一覧タブのソートモード。"manual" | "nameAsc" | "nameDesc" | "mtimeAsc" | "mtimeDesc"。
    // 空 / 不正値は "manual" に fallback (additive 追加のため旧 state.json には存在しない)。
    Sort string `json:"sort"`
}
```

- **schema bump しない** (#116 UntaggedOnly と同じ判断)。旧バイナリが新 state.json を
  読んでも未知フィールドは無視され (前方互換)、新バイナリが旧 state.json を読むと
  空文字 → `manual` fallback (後方互換)。
- `validateState` に不正値 → `"manual"` の正規化を追加。
- モード文字列は AGENTS.md D-1 に従い、frontend 側に共通定数モジュール
  (`features/classification/sortMode.ts`) を新設して Go 側と同値テストで pin する。

### 7.2 `_classification.json` (Phase 2、形式不変)

- 並び替え保存は entries **配列順のみ** 変更。スキーマ / フィールドは一切不変で、
  旧バージョンのアプリ / 手動編集との互換に影響しない。
- orphans は既存 `Save` が末尾に温存する (現状仕様のまま)。
- **新規検出ファイルの位置**: 現状どおり「sidecar 掲載分の後ろにファイル名昇順で追記」
  (D6)。手動順に対して新規分が末尾に来るのは自然な挙動として維持。

### 7.3 マイグレーション

- state / settings / sidecar とも schema 変更なし → マイグレーション不要。

---

## 8. 同期モデル (AGENTS.md H-8 / CLAUDE.md 着手前ルール)

新規 state:

- `sortMode` (useClassification が所有し persistableState 経由で session save に乗せる。
  `ListTabState.Sort` の hydrate / save ミラー) — **同期 UI state** で async source は
  session hydrate のみ。
- (Phase 2) `reorderMode` (並べ替えモード on/off。App レベルまで lift する — TopTabsBar /
  useGlobalKeybindings の gate に必要) — 同期 UI state だが、folder 切替 / unmount で
  解除する経路を持つ。永続化しない。
- (Phase 2) `dragState` (drag 中の filename / 挿入先 index。新規子フック
  `useCardReorder` が所有) — **entries 依存 state** なので folder 切替 / reload で
  リセットが要る。
- (Phase 2) 並び替え保存の in-flight — 既存 `loadResult.mtime` チェーンに乗る。

### 8.1 event source 5 列表 (着手前マトリクス)

| event source | trigger | capture したい値 | stale 化リスク | gate 方針 |
|---|---|---|---|---|
| session hydrate | 起動時の GetState | 保存済み sortMode | なし (起動時 1 回、フォルダ Load より先行) | validateState 済みの値をそのまま初期値に。不正値は Go 側で manual 化済み |
| sortMode 変更 | select の onChange | 新モード | なし (同期 state) | setState のみ。表示は memo 派生で追従。並べ替えモード中は select 自体が disabled (§5.2) なので drag との交差なし |
| (P2) 並べ替えモード on | ヘッダーのトグル | — | 押下時点で有効条件 (manual + フィルタ非適用) が崩れている | onClick で有効条件を再評価してから on (disabled 表示と実 gate の二重防御)。SampleModal 等が開いている間はヘッダーが覆われ押せない |
| (P2) 並べ替えモード off | 「完了」/ Esc / folder 切替 / unmount | — | drag 途中 / 保存 await 中の解除 | dragState を即リセット (pointer capture release 含む)。in-flight 保存は完走させる (folder gate が commit を守る)。Esc は drag 中なら「drag 中止」を優先し、モードは維持 (2 段 Esc) |
| (P2) drag 開始 | Card pointerdown + 閾値移動 | 対象 filename / 開始時 entries の identity (gen) | drag 中の watcher reload / folder 切替で entries が差し替わる | reorderMode 中のみ発動。開始時に `loadResult` の参照 (または既存 requestGen) を capture。drop 時に不一致なら **並び替えを中止** (toast なし。表示が変わった時点でユーザーの意図した挿入位置は無効) |
| (P2) drop 確定 → 保存 | pointerup | folder / 並び替え後 entries / `loadResult.mtime` | folder 切替 / モード解除 / in-flight edit save | folder・gen・reorderMode を **drop 時に再確認** → local commit (setLoadResult) → `SaveClassification`。モード中はフィルタ / sortMode / モーダル操作が封じられているため交差軸はこの 3 つ + autosave 残 in-flight (§8.2) に絞られる |
| (P2) 保存完了 | IPC resolve | SaveOutput.mtime | await 中の folder 切替 / 別 save の完了 | `folderRef.current === captured` check 後に追跡 mtime 更新 (既存 saveEdit と同じ流儀)。古い gen なら破棄 |
| (P2) 保存失敗 (CONFLICT) | IPC reject | — | local commit 済み並びが disk と乖離 | 既存 conflict フロー (reload) に合流 = disk 正を再 Load して local 並びを捨てる。既存の編集 CONFLICT と同一挙動 |
| (P2) 保存失敗 (その他) | IPC reject | — | 同上 | error トースト + 再 Load で並びを戻す (silent に乖離を残さない) |
| watcher 反映 | `classification:changed` → 再 Load | 新 entries + FileTimes | drag 中 / 保存 await 中に着弾 / **no-op gate が fileTimes を捨てる** | drag 中: dragState を **リセット** (gen 不一致で drop 中止と同義)。保存 await 中: 既存 watcher 側の gen gate に任せ、reorder 側は mtime chain の CONFLICT で収束。no-op gate は entries + sidecar mtime に加え **fileTimes 等価 (`fileTimesEquivalent`、fresh 側 entries の filename に限定比較) も要求** — 同名上書き (mtime だけ変化) を silent commit に落とし、mtime ソートを stale にしない (code-review 反映) |
| フォルダ切替 / Load 失敗 | openFolder / loadInternal catch | — | 旧フォルダの dragState / reorderMode 残留 | `resetEntriesDependentState` に dragState リセット + reorderMode 解除を追加 (PR #75 Round 14 の流儀)。sortMode は **リセットしない** (タブ全体の表示設定であり folder 非依存、D3) |
| unmount | ClassificationView unmount | — | pointer capture リーク / reorderMode 残留 (タブ切替 gate が掛かったまま) | cleanup で releasePointerCapture + dragState 破棄 + reorderMode 解除 (H-2 / H-3。モード中はタブ切替を封じているため通常 unmount しないが、防御として置く) |

### 8.2 並び替え保存と編集 autosave の直列化

並び替え保存 (`SaveClassification` 全量) と編集 autosave (`UpdateClassificationEntry`
単体) は同じ mtime チェーンを bump し合う。同時 in-flight になると後着が CONFLICT する:

- SampleModal と並べ替えモードは同時に存在しない (モーダル表示中はヘッダーが覆われ
  モードに入れず、モード中はプレビューが開かない、§5.2) → 交差窓は「モーダルを閉じた
  直後の queue 済み autosave が in-flight のうちにモードへ入り drop する」場合のみ。
- **gate**: drop 時に autosave queue の in-flight を確認できる形にする
  (orchestrator 経由で in-flight フラグを参照)。in-flight 中の drop は**保存せず中止**
  (楽観 local commit もしない。稀ケースなので queue 追従より単純さを優先)。
- 逆方向 (並び替え保存 in-flight 中の編集開始) は、編集 save が完了時 mtime を
  最新で読む既存設計 (`onSaveRef.current` 経由) のため追加対処不要。

### 8.3 詳細マトリクス (Phase 2)

| 経路 | gen check | folder check | reorderMode check | filter check | mtime chain | inflight check |
|------|:--:|:--:|:--:|:--:|:--:|:--:|
| モード on | – | – | (有効条件を onClick で再評価) | ✓ (非適用のみ) | – | – |
| モード off | – | – | (dragState リセット) | – | – | – (in-flight 保存は完走) |
| drag 開始 | capture | – (開始時の folder を capture) | ✓ (モード中のみ) | – (モード中は変更不能) | – | – |
| drop 確定 | ✓ (開始時 gen と一致) | ✓ | ✓ (再確認) | – (同上) | capture (loadResult.mtime) | ✓ (autosave in-flight で中止) |
| 保存完了 | ✓ | ✓ | – | – | 更新 | – |
| 保存失敗 | ✓ | ✓ | – | – | – (reload が再設定) | – |
| watcher 反映 | (dragState リセット) | 既存 gate | – (モード維持) | – | 既存 gate | – |
| folder 切替 | (dragState リセット) | – | (モード解除) | – | – | – |

- dirty / touched 軸: 並び替えはフォーム編集を持たないため該当なし (検討済み)。
- loading token: 並び替え保存に spinner は出さない (該当軸なし)。

---

## 9. エラーハンドリング

| ケース | 挙動 |
|--------|------|
| `FileTimes` に無い filename (walk 中の `Info()` 失敗 / race で消失) | mtime 0 扱いで mtime ソート時は末尾グループ (同着はファイル名昇順 tiebreak)。エラーにしない |
| 旧 state.json (Sort フィールド無し) / 不正値 | `manual` に fallback (validateState + frontend 双方で防御) |
| (P2) 並び替え保存 CONFLICT | 既存 conflict フロー (reload)。local 並びは disk 正で上書き |
| (P2) 並び替え保存 その他失敗 | error トースト + 再 Load で並びを戻す |
| (P2) drag 中の entries 差し替え | drop 中止 (silent)。§8.1 |

---

## 10. テスト

### 10.1 Go

- scanner: walk 中の mtime 収集 (実 tempdir + Chtimes、非画像は行なし)。
- `LoadResult.FileTimes`: scanner times の passthrough / sidecar-only (orphan) は行なし /
  `Info()` 失敗相当 (times に行が無い path) は行なし (fake scanner)。
- `validateState`: Sort 空文字 → manual / 不正値 → manual / 有効 5 値は素通し。
- (P2) `Save` の配列順保持は既存テストで担保済み (順序を変えて渡した entries が
  そのままの順で書かれることを明示 pin するテストを 1 本追加)。

### 10.2 vitest

- `sort.ts` 純関数 (`sortEntries`): manual = identity / nameAsc・Desc (大文字小文字 /
  数字混在) / mtimeAsc・Desc + mtime 欠落 (0 扱い末尾 + name tiebreak) / 安定ソート
  (同値で元順維持)。
- `sortMode.ts` D-1 同値テスト: 5 値の文字列が Go 側定数と一致。
- `fileTimesEquivalent`: 一致 / 上書き検出 / entries 外の行 (in-flight delete 残り) を無視 /
  両側欠落は等価・片側欠落は差分 / undefined・null 耐性。
- グループ内順序: `sortEntries` → `groupByDirectory` の合成でグループ内が
  ソート順・グループ列は従来順のまま、を pin。
- (P2) 並び替え計算純関数 (`reorderEntries(entries, filename, insertBefore)`):
  同一グループ内移動 / 先頭・末尾 / グループ跨ぎ拒否 / 非破壊。
- (P2) `useCardReorder` を renderHook + IPC mock で: gen gate (drag 中 reload で drop
  中止) / folder gate / reorderMode gate (モード外 drag 不発 / モード off で dragState
  リセット + in-flight 保存は完走) / autosave in-flight gate / CONFLICT 時に
  reload が呼ばれる (#110 B の流儀)。
- (P2) モード有効条件の純関数 (`canEnterReorderMode(sortMode, filter)`):
  manual + フィルタ非適用のみ true / 各フィルタ軸 1 つでも有効なら false。
- (P2) `useGlobalKeybindings` の reorderMode gate: モード中に Ctrl+Tab /
  Ctrl+Shift+1..9 / Ctrl+W がタブ操作を起こさないことを既存テストの流儀で pin。

### 10.3 手動 (wails dev)

- 並び順セレクトの 5 モードで表示が切り替わり、範囲選択 / 矢印キー移動 /
  SampleModal prev·next が表示順に追従する。
- 再起動でソートモードが復元される。旧 state.json (手で Sort を消す) でも起動できる。
- watch auto + mtime ソート中にフォルダ内の画像を同名上書き → 並びが自動追従する
  (toast なしの silent 更新。code-review 反映の fileTimes gate 確認)。
- (P2) 手動モードで並べ替えモードに入り Card を DnD → 再読み込み / 再起動で並びが
  維持される。`_classification.json` の配列順が変わっていることを目視確認。
- (P2) モード外では DnD が一切発動しない。名前順モード / フィルタ適用中は
  「並べ替え」ボタンが disabled で押せない。
- (P2) モード中: Card クリックでプレビューが開かない / checkbox が出ない /
  右クリックメニューが出ない / ビューアタブ・設定へ移動できない (クリック +
  Ctrl+Tab / Ctrl+Shift+1..9 とも) / フィルタ・検索・並び順セレクトが disabled。
- (P2) 「完了」/ Esc でモード解除後、通常操作 (プレビュー / 選択 / タブ切替) が全て復活する。
- (P2) drag 中の Esc は drag だけ中止しモードは維持、もう一度 Esc でモード解除。
- (P2) drag 中に watcher でファイル追加 → drop が中止され、以降の DnD は正常。
- (P2) 外部で sidecar を書き換えた直後の drop → CONFLICT → reload で disk 正に収束。

---

## 11. Out of scope

- **グループ (ディレクトリ) 自体の並び替え**: 直下先頭 + キー昇順のまま。
- **グループ跨ぎ DnD** (= ファイル移動): 別機能。
- **ビューアタブ内の画像順**: 本仕様は一覧タブのみ (ビューアのタブ順 DnD は実装済みの別機能)。
- **キーボードによる手動並び替え** (Ctrl+矢印等): a11y 改善として将来課題。
- **ソート基準の追加** (サイズ / 撮影日時 EXIF / タグ / 信頼度): EXIF は todo.md E9 の
  非対応方針もあり v1 は 5 モードに絞る。必要になったら additive に足せる設計。
- **フィルタ適用中の並べ替えモード**: 隠れ entry を跨ぐ移動が意図しない大移動になるため
  入口 (トグルボタン) から無効 (D5)。
- **並べ替えモードの永続化**: 一時 state。再起動 / フォルダ切替でモード外に戻る。
- i18n (#16 / #83 で別途)。

---

## 12. Phase 分割

### Phase 1 (最初の PR、ソートモード)

1. Go: `LoadResult.FileTimes` + `ListTabState.Sort` + validateState
2. frontend: `sort.ts` / `sortMode.ts` 純関数 + ClassificationHeader のセレクト +
   派生チェーンへの組み込み + session hydrate/save 配線
3. テスト (§10.1 / §10.2 の P1 分)

Phase 1 は同期 state のみで async リスクが小さい。ただし §8.1 の hydrate 行は Phase 1 に含む。

### Phase 2 (別ブランチ / 別 PR、並べ替えモード + 手動 DnD)

- 並べ替えモード (トグル + 操作制限: Card / トップタブ / キーバインド / ヘッダー UI の
  gate、§5.2) + `useCardReorder` (drag state + gate + 保存、§8) + `reorderEntries` 純関数 +
  挿入インジケータ CSS + autosave in-flight 参照の orchestrator 配線
- 着手時に本 spec の §8 を実装細部で改訂 (改訂履歴に追記) してから実装

---

## 13. 決定事項 (レビューで合意を取る論点)

| § | 論点 | 推奨案 |
|---|------|--------|
| D1 | ソートモードの選択肢 | `manual` (既定) / `nameAsc` / `nameDesc` / `mtimeAsc` / `mtimeDesc` の 5 値。グループ内順序のみに適用し、グループ列の順序は不変。 |
| D2 | 手動順の正本 | **`_classification.json` の entries 配列順** (現状の実体を公式化)。順序専用の永続データは導入しない。並び替え保存は既存 `SaveClassification` の流用で新規 IPC なし。 |
| D3 | ソートモードの永続化先 | `state.json` の `ListTabState.Sort` (additive、v6 据え置き、#116 と同じ整理)。フォルダ閲覧状態なので settings ではなく state。folder 切替でリセットしない (タブ全体の表示設定)。 |
| D4 | mtime の供給 | `LoadResult.FileTimes` (Load 時に Go が stat)。sidecar に書かない (schema / conflict 機構への影響ゼロ)。 |
| D5 | 並べ替えの入口 | **明示的な並べ替えモード** (ユーザーレビューで確定)。通常時 DnD は無効で、ヘッダーのトグル (有効条件: `manual` かつフィルタ非適用) で入る。モード中は並べ替えのみ可能 — プレビュー / 選択 / コンテキストメニュー / ビューアへの送り / トップタブ切替 (キーバインド含む) / フィルタ・検索・並び順変更を全て無効化。ドロップは同一グループ内のみ。「完了」/ Esc で解除。 |
| D6 | 新規検出ファイルの位置 (manual) | 現状維持 = 末尾にファイル名昇順で追記。 |
| D7 | Phase 分割 | Phase 1 = ソートモード / Phase 2 = 手動 DnD。async リスクが Phase 2 に集中するため分離。 |
| D8 | 並び替え保存の競合 | 既存 mtime 楽観ロック + CONFLICT フローに合流。autosave in-flight 中の drop は保存せず中止 (稀ケースは単純さ優先)。 |

レビュー確認事項:

- D1: 既定を `manual` (= 現状挙動維持) とすることの確認。「ファイル名昇順を既定にしたい」
  なら既存フォルダの見え方が変わる点に注意。
- D1: 選択肢 5 値で足りるか (サイズ順等が要るなら additive に足せるが v1 は絞る)。
- D5: **合意済み** (2026-07-18 ユーザーレビュー) — 通常時は無効、並べ替えモード中のみ
  DnD 可。モード中はプレビュー等を開かず並べ替えに専念、ビューアタブへの移動も禁止。
  細部 (Esc の 2 段解除 / グループ折りたたみは許可 / drop ごと即時保存) は推奨案、
  Phase 2 着手時に気になる点があれば改訂。
- D7: Phase 1 だけ先にリリースする分割で良いか (手動並び替えは Phase 2 まで来ない)。

---

## 14. 実装スコープ予測

| ファイル | 変更内容 | Phase |
|---------|---------|:--:|
| `internal/classification/types.go` / `service.go` | `LoadResult.FileTimes` (scanner times の passthrough) | 1 |
| `internal/classification/scanner.go` | `ListImageFiles` を names+times 返却に拡張 (walk 中に mtime 収集) | 1 |
| `frontend/src/features/classification/entriesEquivalent.ts` | `fileTimesEquivalent` 追加 (watcher no-op gate 用、vitest 対象) | 1 |
| `frontend/src/features/classification/useClassificationWatcher.ts` | no-op gate に fileTimes 等価判定を追加 (2 箇所) | 1 |
| `internal/state/state.go` | `ListTabState.Sort` + validateState 正規化 | 1 |
| `frontend/src/features/classification/sort.ts` (新規) | `sortEntries` 純関数 (vitest 対象) | 1 |
| `frontend/src/features/classification/sortMode.ts` (新規) | D-1 共通定数 (5 値 + 既定) + `normalizeSortMode` | 1 |
| `frontend/src/features/classification/ClassificationHeader.tsx` | 並び順セレクト | 1 |
| `frontend/src/features/classification/ClassificationView.tsx` | filter 済み entries への sort 適用 (派生チェーン組み込み) | 1 |
| `frontend/src/features/classification/useClassification.ts` | sortMode state (initialList hydrate + persistableState) | 1 |
| `frontend/src/features/session/useSessionSave.ts` | `ListPersist.sort` の save 通し (hydrate は既存 initialList 経路で追加変更なし) | 1 |
| `frontend/src/App.css` | セレクト + 同行 reload の focus スタイル | 1 |
| `frontend/src/features/classification/reorderEntries.ts` (新規) | 並び替え計算純関数 | 2 |
| `frontend/src/features/classification/reorderMode.ts` (新規) | `canEnterReorderMode` 純関数 (vitest 対象) | 2 |
| `frontend/src/features/classification/useCardReorder.ts` (新規) | drag state + gate + 保存 (§8) | 2 |
| `frontend/src/features/classification/ClassificationHeader.tsx` | 「並べ替え」トグル + モード中の UI disabled | 2 |
| `frontend/src/features/classification/Card.tsx` / `DirectoryGroup.tsx` | DnD ハンドラ + 挿入インジケータ + モード中の操作無効化 | 2 |
| `frontend/src/features/classification/ClassificationView.tsx` | reorderMode state + Esc ハンドリング + プレビュー / メニュー gate | 2 |
| `frontend/src/features/classification/useClassification.ts` | `resetEntriesDependentState` に dragState リセット + reorderMode 解除 + autosave in-flight 参照 | 2 |
| `frontend/src/App.tsx` / `TopTabsBar.tsx` | reorderMode の lift + タブ切替 / 設定ボタンの disabled | 2 |
| `frontend/src/useGlobalKeybindings.ts` | reorderMode 中のタブ操作キーバインド gate | 2 |
| `frontend/src/App.css` | 挿入インジケータ / drag 中 / モード中スタイル | 2 |

- `.claude/context.md` / `docs/todo.md`: 機能一覧 / H 節に追従 1 行ずつ。

---

## 15. 参考 (実装着手時に必ず読む)

- [AGENTS.md](../AGENTS.md): H-8 (本 spec §8 が着手前マトリクス) / H-1 (セレクトの a11y) /
  H-2 (DnD の pointer 防御) / H-4 (新規 CSS クラス実在) / D-1 (モード文字列の Go/TS pin)
- [docs/spec-untagged-filter.md](spec-untagged-filter.md): state v6 無バンプ additive の先行判断 (#116)
- [docs/spec-edit-autosave.md](spec-edit-autosave.md) / [spec-edit-autosave-testing.md](spec-edit-autosave-testing.md):
  mtime チェーン / autosave queue の直列化 (§8.2 の前提)
- [docs/spec-folder-watch.md](spec-folder-watch.md): watcher 反映と gen/folder gate の先行実装
- [docs/spec-viewer-tab-reorder.md](spec-viewer-tab-reorder.md): 自前 pointer DnD の先行流儀 (Phase 2)
- 関連 issue: [#144](https://github.com/maretol/image-observer/issues/144)
