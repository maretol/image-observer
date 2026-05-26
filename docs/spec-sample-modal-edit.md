# 画像サンプルモーダルとタグ・ノート編集の統合 実装仕様書 (#93)

一覧タブのカード操作で開く 2 つのモーダル — **SampleModal** (大プレビュー + viewer-picker + prev/next) と **EditPopover** (tags / confidence / note 編集) — を 1 モーダルに統合し、プレビューを見ながら編集できるようにする。

> **ステータス**: §10 ユーザー合意済み (2026-05-26)、Phase 1 実装着手。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-05-26 | 初版 | Phase 1 を「SampleModal を統合モーダルに拡張、EditPopover の独立呼び出しは廃止」に絞る。§10 で 6 つの設計判断点を提示。 |
| 2026-05-26 | ユーザー合意 | §10-A〜F すべて推奨案 (A 案) で確定。実装着手可に更新。 |
| 2026-05-26 | PR #102 レビュー対応 | §10-E の削除済み `EditPopover.tsx` へのリンクを除去 (git 履歴で参照可能の旨だけ残す)。 |
| 2026-05-26 | PR #102 レビュー対応 (続) | §9 の typo (`promp` → `prompt`) を修正。 |

---

## 1. ゴール (DoD)

- 一覧タブのカード操作 (サムネクリック / 編集ボタン / 右クリックメニュー「編集」) で開くモーダルを **1 つに統合** する。
- 1 モーダル内で以下が同時に行える:
  - 大プレビュー画像の閲覧 (現行 SampleModal の機能を温存)
  - tags / confidence / note の編集 (現行 EditPopover の機能を温存)
  - viewer-picker から任意ビューアで開く (現行 SampleModal の機能を温存)
  - prev/next による同一ディレクトリ内ナビゲーション (現行 SampleModal #94 の機能を温存)
- 編集の保存は **明示保存** (保存ボタン or Cmd/Ctrl+Enter)。autosave はしない。
- 保存後に conflict / mergePrompt が出る既存経路 (§4 / [docs/spec-folder-watch.md]) は影響なく動く。
- カード上の編集アイコンボタン (EditIcon) と右クリックメニュー「編集」は **統合モーダルを「編集ペインに focus を当てた状態で」開く** ように変更する (廃止はしない、動線は維持)。
- 既存 `EditPopover` コンポーネントは **削除** し、編集 UI は統合モーダル内の子コンポーネントに置き換える (`SampleEditPane.tsx` 新設想定)。
- `tsc --noEmit` クリア、`go test ./...` 通過、`vitest` 全通過、`wails dev` で手動動作確認。

## 2. 用語

| 用語 | 意味 |
|------|------|
| **統合モーダル** | 本仕様で新設する、画像プレビュー + 編集ペインを併せ持つ単一モーダル。ファイル名は `SampleModal.tsx` を継続使用 (中身を拡張)。 |
| **プレビューペイン** | 統合モーダル内の画像表示エリア。現行 SampleModal の `sample-modal-body` 相当。 |
| **編集ペイン** | 統合モーダル内の tags / confidence / note 編集 UI。現行 EditPopover の中身に相当。 |
| **未保存変更** | 編集ペインのフォーム値が、最後に開いた / 保存した状態から差分を持っている状態。 |
| **prev/next 移動** | プレビュー対象を同一ディレクトリ内の隣接ファイルに切り替える操作 (#94)。 |

## 3. アーキテクチャ概観

```
[Card クリック / 編集アイコン / 右クリック「編集」]
       │
       ▼
   統合モーダルを開く
   - クリック起点 = "preview"   → 編集ペイン focus せず、プレビューを主役に
   - 編集アイコン起点 = "edit"  → 編集ペインのタグ入力に autoFocus
       │
       ▼
   [プレビューペイン] [編集ペイン]
       │                │
       │                ├─ 保存ボタン / Cmd+Enter → saveEdit (既存)
       │                │           │
       │                │           ▼
       │                │      conflict / mergePrompt (既存 dialog 経路)
       │                │
       │                └─ キャンセル / Esc → 未保存破棄 (確認なし)
       │
       ├─ prev/next ボタン / ←→ キー → 未保存があれば §5.4 に従う
       │
       └─ viewer-picker → onOpenInViewer (既存)
```

state ownership:
- `previewFilename` は引き続き `ClassificationView` が持つ。
- 編集中フォーム値 (tags / confidence / note) は **統合モーダル内 (SampleEditPane) の local state**。`useClassification.editing` は引き続き残すが、用途は「conflict 検知用の baseline 保持 + saveEdit の呼び出し点」のみに縮退。

## 4. データモデル

state schema / IPC 変更は **なし**。

- 既存 `useClassification.editing` (`{ open, filename }`) は内部的に維持されるが、UI 開閉トリガとしての役割は `previewFilename` に統合される (= 統合モーダルが開いていれば editing は常に同じ filename を指す)。
- 既存 `useClassification.saveEdit(entry)` の signature 変更なし。
- 既存 `useClassification.openEdit / closeEdit` は廃止 or 内部 helper に縮退。

新規型:
- `OpenSource = "preview" | "edit"` (統合モーダルを開いた起点。初期 focus 振り分け用)

## 5. UI / 操作

### 5.1 統合モーダルのレイアウト

横並び 2 ペイン構成 (推奨案、§10-A で確定):

```
┌────────────────────────────────────────────────────────────┐
│  filename.png                                          [×] │  ← header
├──────────────────────────────────────┬─────────────────────┤
│                                      │ タグ                │
│                                      │ [tag1] [tag2] [+]   │
│         大プレビュー画像              │                     │
│         (letterbox / 1024px cache)   │ confidence          │
│                                      │ ○ none ● high ○ ... │
│                                      │                     │
│  [<]                          [>]    │ note                │
│                                      │ ┌─────────────────┐ │
│                                      │ │                 │ │
│                                      │ └─────────────────┘ │
│                                      │                     │
│                                      │ [キャンセル] [保存] │
├──────────────────────────────────────┴─────────────────────┤
│  ビューア「{name}」で開く  / viewer-picker                  │
└────────────────────────────────────────────────────────────┘
```

- モーダル全体の最大幅を現行より広げる (現行は CSS 側で `max-width` 設定済み。新値の具体ピクセルは実装時に画面サイズ感で詰める)。
- プレビューペインは現行 `sample-modal-body` の構造を継承 (img + nav buttons + loading/error 表示)。
- 編集ペインは新規コンポーネント `SampleEditPane.tsx` (現行 `EditPopover` の内側を抽出 / 流用)。
- ビューアフッタ (viewer-picker) は **モーダル下端の横長エリア** に維持。プレビューと編集の両方にとって「画像を別ビューアで開く」は共通アクションなので、ペインに含めず footer 共通とする。

### 5.2 開く動線

| トリガ | 開く起点 | 初期 focus |
|--------|---------|-----------|
| Card サムネ クリック (selectionMode=off) | `"preview"` | プレビューペイン (具体的入力には合わせない、Tab で編集ペインに入れる) |
| Card の編集アイコン クリック | `"edit"` | 編集ペインのタグ入力 (autoFocus) |
| Card 右クリック → 「編集」 (もし現存) | `"edit"` | 同上 |
| キーボード Space/Enter on Card | `"preview"` | プレビューペイン |

クリック起点を `ClassificationView` から統合モーダルに渡し、初期 focus を振り分ける。

### 5.3 保存 / キャンセル / 閉じる

- **保存**: 「保存」ボタン or Cmd/Ctrl+Enter で `saveEdit(entry)` を呼ぶ。成功時はモーダルを **開いたまま**、フォーム値を「保存済み baseline」に更新 (= 未保存変更フラグを下ろす)。conflict / mergePrompt は既存経路。
- **キャンセル**: 「キャンセル」ボタンで未保存変更を破棄。モーダルは **開いたまま**、フォーム値を最後の baseline に戻す。
- **閉じる**: × ボタン / Esc / バックドロップクリックでモーダルを閉じる。未保存変更があっても **確認なしで破棄** (現行 EditPopover の Esc 挙動と一致)。
  - 例外を入れたければ別 issue で。本 spec では Phase 1 は確認なし固定。

### 5.4 prev/next 移動と未保存変更

未保存変更がある状態で prev/next を押した場合の挙動 — **推奨案: prev/next を disabled にし、ツールチップで理由を出す**:

```
[<](disabled, title="未保存の変更があります。保存またはキャンセルしてください")
```

ナビゲーションを抑止する側に倒す理由: 編集途中の値が暗黙に破棄されると、ユーザーの作業損失リスクが大きい。明示的に保存 / キャンセルを促した方が安全。

代替案は §10-D に併記。

### 5.5 アクセシビリティ

- 統合モーダル全体の `aria-label`: `{filename} のプレビューと編集` (filename が null なら `画像プレビューと編集`)
- 編集ペイン全体に `role="group"` + `aria-label="編集"`
- 編集ペインの入力は既存 EditPopover と同じ (label 関連付け済み)
- ModalShell の focus trap で Tab / Shift+Tab がペイン跨ぎでも循環することを動作確認

## 6. 状態管理 / フック

### 6.1 ClassificationView 側の変更

```ts
// 既存
const [previewFilename, setPreviewFilename] = useState<string | null>(null);

// 追加: モーダルを開く起点
const [previewOpenSource, setPreviewOpenSource] = useState<"preview" | "edit">("preview");

const openPreview = (filename: string) => {
  setPreviewFilename(filename);
  setPreviewOpenSource("preview");
};
const openEditModal = (filename: string) => {
  setPreviewFilename(filename);
  setPreviewOpenSource("edit");
};
```

`useClassification.openEdit` を呼んでいた箇所はすべて `openEditModal` に置換 (Card 編集ボタン / 右クリック「編集」)。
`useClassification.editing` の `{ open, filename }` は内部的に previewFilename と一致するように同期させる (saveEdit の baseline 取得のため)。

### 6.2 統合モーダル (SampleModal) 側

現行 SampleModal の props に追加:

```ts
type SampleModalProps = {
  // 既存
  open, imagePath, filename, onClose,
  viewers, activeViewerId, onOpenInViewer,
  onPrev, onNext,

  // 追加
  openSource: "preview" | "edit";
  entry: classification.Entry | null;   // 編集対象 (filename と整合)
  knownTags: string[];                  // 編集ペインの補完用
  onSave: (next: classification.Entry) => void;
};
```

内部で `SampleEditPane` を子コンポーネントとして配置。SampleEditPane は現行 EditPopover の中身 (タグ / confidence / note 入力 + ボタン) を **dialog 外殻なし** で再構成したもの。

### 6.3 prev/next 抑止ロジック

```ts
const dirty = /* SampleEditPane が持つ未保存変更フラグを上位に持ち上げる */;
const onPrevPreviewEffective = dirty ? null : onPrevPreview;
const onNextPreviewEffective = dirty ? null : onNextPreview;
```

dirty の上昇方法 (callback ref / state lift) は実装時に決める。

## 7. 永続化 / マイグレーション

- 永続化対象なし。state.json / settings.json 変更なし。
- マイグレーション不要。

## 8. テスト

- **新規ユニットテスト**:
  - `SampleEditPane.test.tsx`: 編集ペインのフォーム挙動 (tags / confidence / note の入力 / 保存 callback) — 現行 EditPopover にテストがあれば移植、なければ新規。
  - 「未保存変更がある場合に prev/next が無効になる」を統合モーダル単位でテスト (React Testing Library)。
- **既存テスト**:
  - `sampleModalNav.test.ts`: pickSibling のロジック自体は不変。
  - `useClassification` 系のテストで openEdit/closeEdit の signature が変わる場合は追従。
- **手動確認 (wails dev)**:
  - Card サムネクリック → モーダル開、編集ペイン見えるが focus はプレビュー側
  - Card 編集アイコンクリック → モーダル開、タグ入力に focus
  - 保存 → モーダル open のまま、再編集できる
  - キャンセル → フォームが baseline に戻る
  - Esc / × / バックドロップ → 未保存があっても閉じる
  - prev/next → 未保存なし時に動く、未保存ありで disabled
  - viewer-picker → 既存通り
  - conflict 経路 (外部編集 → 保存) でダイアログが出る

## 9. Out of scope (Phase 1)

- 編集ペインの折り畳み / リサイズ
- autosave
- prev/next 移動時の「保存して移動」インライン選択肢 (§10-D の代替案)
- 編集ペインの dirty 状態をモーダル閉じ確認で prompt する挙動
- モバイル / 縦長レイアウトの 2 ペイン縦並びレイアウト
- 編集ペインのキーボードショートカット拡張 (現行の Cmd/Ctrl+Enter 以外)

## 10. 決定事項 (要合意)

ユーザー合意後に各項目を確定する。**推奨案**を A 案として記載するが、redirect 可能。

### 10-A. レイアウト

- **A 案 (推奨)**: 横並び 2 ペイン (左:プレビュー / 右:編集)。理由: 1080p 想定で縦より横が余裕。プレビュー画像は letterbox 表示なので横幅をある程度確保しても無駄が出にくい。
- B 案: 縦並び 2 ペイン (上:プレビュー / 下:編集)。横長画像メインの場合に画像を大きく見せられる。
- C 案: タブ切替 (1 度に 1 ペインだけ表示)。「1 画面化」の意図と乖離するため非推奨。

### 10-B. Card 編集ボタン (EditIcon) / 右クリック「編集」を残すか

- **A 案 (推奨)**: **残す**。同じ統合モーダルを開くが、起点で初期 focus を変える (editor focus vs preview focus)。動線を温存することで既存ユーザーの記憶を尊重。
- B 案: 廃止。Card クリックだけに動線を一本化。UI が減ってシンプルになるが、操作の予測性が変わる。

### 10-C. 保存タイミング

- **A 案 (推奨)**: 明示保存 (現行維持)。autosave しない。
- B 案: blur / Esc 時 autosave。誤入力での意図せぬ上書きリスク + conflict 検知の頻発が懸念。

### 10-D. prev/next 移動時の未保存変更の扱い

- **A 案 (推奨)**: prev/next を disable + tooltip で理由を出す。
- B 案: inline confirm を出す (保存して移動 / 破棄して移動 / キャンセル)。摩擦が高い。
- C 案: 暗黙に破棄して移動。作業損失リスク高、非推奨。

### 10-E. EditPopover コンポーネントの扱い

- **A 案 (推奨)**: 削除し、中身を `SampleEditPane.tsx` として作り直す (dialog 外殻を取り除いた形)。`EditPopover.tsx` は git 履歴に残るので将来参照可能。
- B 案: EditPopover を残して、SampleModal の中に `<EditPopover open={true} entry={...} />` をネスト。dialog 内 dialog の二重構造が混乱を招くため非推奨。

### 10-F. モーダル幅の目安

- **A 案 (推奨)**: プレビュー側を最大 ~720px (現行に近い)、編集ペインを ~360px、合計 ~1080px を目安。CSS 側で `max-width` を画面幅に応じて clamp。
- B 案: 画面幅の 80% を維持。実機の見え方確認後に確定。

## 11. Phase 分割

### Phase 1 (本 spec)

- 統合モーダル UI 実装 (§5)
- SampleEditPane の新設、EditPopover の削除 (§10-E A 案合意前提)
- ClassificationView の動線変更 (§6.1)
- 未保存中の prev/next 抑止 (§5.4 A 案合意前提)
- 既存テスト追従 + 新規テスト追加 (§8)

### Phase 2 (別 issue)

- ペイン折り畳み / リサイズ
- prev/next 移動時の inline confirm option (§10-D B 案、ユーザーから要望があれば)
- モーダル幅をユーザー設定に
- autosave モード (§10-C B 案)

## 12. 関連

- [docs/todo.md](todo.md) §H (UX / ショートカット) に 1 行追記済み
- [docs/spec-multi-viewer.md](spec-multi-viewer.md) §5.6 (一覧 → ビューア結線): viewer-picker フッタは継承
- [docs/spec-card-context-menu.md](spec-card-context-menu.md): Card 右クリックメニューに「編集」項目があれば本仕様の編集起点に統合される
- 関連 issue: #94 (SampleModal prev/next, 直近マージ済み) — 本 spec は #94 の prev/next を温存する形で拡張
