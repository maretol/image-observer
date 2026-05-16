# 複数ビューア対応 実装仕様書 (#11)

ビューアタブを単一の固定タブから「**ユーザーが追加 / 削除 / リネームできる複数ビューア**」へ拡張する。各ビューアは独立した BSP レイアウト ([docs/spec-viewer-flexlayout.md](spec-viewer-flexlayout.md)) を持つ。VS Code の「ウィンドウ → 新しいウィンドウ」やブラウザの複数タブグループに近い UX を目指す。

> **ステータス**: ドラフト。§13 の決定事項をユーザー合意後に着手。

---

## 0. 改訂履歴

- 2026-05-15 初版ドラフト。

---

## 1. ゴール (DoD)

- トップレベルタブが「**一覧 + ビューア × N (1 ≤ N ≤ MAX_VIEWERS)**」の構成になる。
- ビューアタブ末尾の `+` ボタンで新しいビューアを追加できる。
- 各ビューアタブは:
  - クリックで切替
  - ダブルクリック (または右クリックメニュー) でリネーム inline edit
  - hover で出る `×` ボタンで削除 (タブ内に画像があれば確認ダイアログ)
- 各ビューアは独立した `Layout` を持つ。BSP 分割 / DnD / タブ操作は **そのビューア内に閉じる** (v1 ではビューア間 DnD なし)。
- 一覧タブからのビューア結線を刷新 (§5.6 詳細):
  - **単一画像**: Card クリックで SampleModal が開き、モーダル内のビューア選択メニューから対象ビューアを選んで開く (現行の「Card クリック = 即ビューア開」は廃止)。
  - **バルク (複数選択)**: 「タブで開く」「分割で開く」ボタンに**ビューア選択ドロップダウン**を併設し、対象ビューアを選んで開く。
  - 既定選択は常に**直近にアクティブだったビューア**。
- ビューア間 DnD は実装しない (§12 スコープ外) が、タブ右クリックメニューに **「ビューア "X" へ移動」** を追加する (§5.7, §4.6)。
- セッション復元: ビューア配列 + 各ビューアの Layout + アクティブビューア ID + アクティブパネル ID + 全タブの zoom/pan が、再起動後も復元される。
- state schema を **v5 → v6** に上げる。v5 → v6 は **ロスレス昇格** マイグレーションを実装する (ユーザーの既存レイアウトを破壊しない)。
- グローバルキーバインド `Ctrl+Shift+1` (一覧) は維持。`Ctrl+Shift+2..9` を **N 番目のビューア** に拡張する (旧 `Ctrl+Shift+2`「ビューアタブに切替」は「1 番目のビューアに切替」と同義になり後方互換)。
- 設定ダイアログのキーバインド表に新規エントリを追記する。
- `wails build` が通り、`wails dev` で操作確認できる。Phase 3 〜 5 / Phase 4 (一覧) / Phase H (設定) の機能 (画像表示 / ズーム / DnD / 一覧 / セッション復元 / 設定) に劣化なし。


## 2. 用語

| 用語 | 意味 |
|------|------|
| **Viewer** | 1 個のビューアタブに対応する論理エンティティ。`{id, name, layout}` を持つ。 |
| **active viewer** | ユーザーが直近に表示していたビューア。`activeViewerID` で参照。トップタブが `"list"` の間も保持される。 |
| **viewer set** | アプリが抱えるビューアの配列全体 (`Viewer[]`) + active viewer ID。 |
| **Layout** / **LayoutNode** / **panel** / **active panel** | spec-viewer-flexlayout.md §2 の定義をそのまま継承。Layout はビューアごとに 1 個。 |
| **MAX_VIEWERS** | ビューア最大数。本仕様では **8** (§3.5)。 |
| **MAX_PANELS** | 1 ビューア当たりのパネル最大数。spec-viewer-flexlayout.md と同じ **16** で据え置き。 |

## 3. データモデル

### 3.1 主要型 (フロント)

```ts
// frontend/src/features/viewer-grid/viewers.ts (新規 — 純関数 + 型のみ)

import type { Layout, LayoutState } from "./layout";

export type Viewer = {
  id: string;     // 安定 ID (crypto.randomUUID)。React key、persistence、active 参照に使う
  name: string;   // 表示名。ユーザー編集可。空文字 / トリム後 0 文字は不可
  layout: Layout; // BSP レイアウト (spec-viewer-flexlayout.md の定義をそのまま流用)
};

export type ViewerSet = {
  viewers: Viewer[];        // 1 個以上 (§3.4 不変条件)
  activeViewerId: string;   // viewers[*].id のいずれかを指す
};

// Persistence shape (Wails-generated state.ViewerState とミラー)
export type ViewerStatePersist = {
  id: string;
  name: string;
  layout: LayoutState;
};
```

### 3.2 主要型 (Go / state schema v6)

```go
// internal/state/state.go

const StateSchemaVersion = 6

type StateData struct {
    Version        int            `json:"version"`
    Window         WindowState    `json:"window"`
    Viewers        []ViewerState  `json:"viewers"`         // 1 個以上
    ActiveViewerID string         `json:"activeViewerId"`  // viewers[*].id のいずれか
    TopTab         string         `json:"topTab"`          // "list" | "viewer"
    List           ListTabState   `json:"list"`
}

type ViewerState struct {
    ID     string      `json:"id"`
    Name   string      `json:"name"`
    Layout LayoutState `json:"layout"`
}
```

旧 `StateData.Layout LayoutState` (単数) は **削除**。`ListTabState` / `WindowState` / `LayoutState` / `LayoutNodeState` / `TabState` は変更なし。

### 3.3 ID の生成

- ビューア ID: `crypto.randomUUID()` (フロント)。Go 側はそのまま受け取って unmarshal するだけ。
- 既存の Layout / LayoutNode の ID 採番ルールはそのまま (`newNodeId()`)。**ビューア ID と node ID は同名前空間で衝突を避ける必要はない** (それぞれ別 map で参照する)。

### 3.4 不変条件 (invariants)

ViewerSet の整合性を常に満たす。`useViewerSet` の各 mutation の最後に validateViewerSet でチェックし、不正なら no-op + warn ログ。

- `viewers.length >= 1` (ゼロ個禁止)。最後の 1 個は削除不可。
- `viewers.length <= MAX_VIEWERS` (= 8)。新規追加時に上限なら toast で拒否。
- `viewers[*].id` はすべて UNIQUE。
- `viewers[*].name` は trim 後 1 文字以上、`MAX_NAME_LEN` (= 32) 文字以下。
- `activeViewerId` は必ず `viewers[*].id` のいずれかを指す。指している ID が消えたら、配列上で**消えた位置と同じインデックス** → **その前のインデックス** → **先頭** の優先順位でフォールバック (Phase 5 `pickNewActiveId` と同じ思想、対象が leaf → viewer に変わるだけ)。
- 各 `viewers[*].layout` 内部の不変条件は spec-viewer-flexlayout.md §3.4 をそのまま継承。

### 3.5 定数

```ts
// frontend/src/features/viewer-grid/viewers.ts
export const MAX_VIEWERS = 8;
export const MAX_NAME_LEN = 32;
export const DEFAULT_NAME_PREFIX = "ビューア "; // 末尾スペース込み
```

```go
// internal/state/state.go
const (
    maxViewers     = 8
    maxNameLen     = 32
    defaultNamePat = "ビューア %d" // Sprintf 用
)
```

### 3.6 既定名のサジェスト

`suggestViewerName(existingNames []string) string`:
1. 既存 `ビューア (\d+)$` パターンの数字を集合化。
2. 1 から始めて集合に含まれない最小の正整数 N を選ぶ。
3. `"ビューア N"` を返す。

ユーザーが付けたカスタム名はパターンに合致しないので無視される。「ビューア 2」を消して新規追加 → 「ビューア 2」が再採番される。

## 4. 操作とアルゴリズム

### 4.1 ビューア追加 `addViewer(set) → ViewerSet`

- `set.viewers.length >= MAX_VIEWERS` なら no-op + toast `"ビューア数の上限 (8) に達しました"` + warn ログ。
- 新規 `Viewer { id: uuid, name: suggestViewerName(...), layout: initialLayout() }` を末尾に append。
- `activeViewerId` を新規ビューアに切替 (= 追加直後にそのビューアにフォーカスする)。

### 4.2 ビューア削除 `closeViewer(set, id, opts?: { skipConfirm?: boolean }) → ViewerSet`

- `set.viewers.length === 1` なら no-op + warn ログ (UI 側でボタンを `disabled` にすれば実質呼ばれない)。
- 対象ビューアの内部に画像タブが 1 個でもあれば、UI 側 (`App.tsx`) で確認ダイアログ:
  ```
  ビューア "{name}" を閉じますか?
  N 個のタブが破棄されます。
  [閉じる] [キャンセル]
  ```
  - `useConfirm` を流用。
- 対象が active viewer の場合、`activeViewerId` を:
  1. 削除後の同じインデックス (= 「次のビューア」) のビューア
  2. それがなければ前のインデックス
  3. それもなければ先頭 (= 最後の 1 個保護で実質起こらない)
- `set.viewers` から該当 ID を除いた新配列を返す。

### 4.3 ビューアリネーム `renameViewer(set, id, newName) → ViewerSet`

- `newName.trim()` を取り、長さ 0 なら no-op (UI 側で input を元の名前に戻す + toast `"名前を空にできません"`)。
- 長さが `MAX_NAME_LEN` を超えたら先頭 32 文字に truncate (UI 側で maxLength で防ぐが API でも防御)。
- 同名ビューアが既に存在しても許容 (内部 ID で識別するため)。
- 該当ビューアの `name` を更新した新配列を返す。`activeViewerId` は変えない。

### 4.4 アクティブビューア切替 `setActiveViewer(set, id) → ViewerSet`

- `id` が `viewers[*].id` に存在しなければ no-op。
- `set.activeViewerId === id` なら no-op (参照同一)。
- それ以外は `activeViewerId` を更新。

### 4.5 ビューア内 Layout 操作

既存の `useViewerGrid` が抱えていた layout mutation 群 (open / close / split / move / reorder / setActivePanel / setActiveTab / updateTabState / setSplitRatio / openManyInActive / openManyAsSplit / preflight) は **`useViewerSet` に移管** される。

- 各 mutation は内部で `set.viewers[active].layout` に対して既存 `layout.ts` の純関数を適用し、active viewer のみを置換した新 `viewers` 配列を返す。
- 純関数 ([layout/](../frontend/src/features/viewer-grid/layout/) — Phase 5 当時は `layout.ts` 単一ファイル、#68 で機能別モジュールに分割) 自体は変更不要 (既に Layout 単体を入出力する設計)。
- `MAX_PANELS = 16` の上限は **ビューア当たり** で適用 (現状の挙動と一致)。

### 4.6 ビューア間タブ移動 `moveTabAcrossViewers(set, srcViewerId, srcLeafId, srcIdx, dstViewerId) → ViewerSet`

タブ右クリックメニュー「別ビューアへ移動」(§5.7) から呼ばれる、ビューア間でタブを 1 個だけ移すパス。

- src / dst のビューア両方が `viewers[*].id` に存在しなければ no-op。
- `srcViewerId === dstViewerId` のときは no-op (ビューア内移動は既存 `moveTabIntoLeaf` 経路で扱う)。
- src ビューアの該当 leaf からタブを取り出す (`zoom / pan / panX / panY / initialized / imageWidth / imageHeight` を含めて保持)。`recomputeActiveAfterClose` で src の `activeIndex` を更新、空 leaf になったら `collapseEmptyLeaf`。
- dst ビューアの**現行 active leaf** に対して `appendOrFocusInActive` 相当を適用 (重複 path はフォーカスのみ、なければ末尾追加)。
- `set.activeViewerId` は **変更しない** (ユーザーは src で作業を続けたい想定。VS Code "Move Editor to Other Group" と同等)。
- 完了後、UI 側でトースト `'ビューア "{dstName}" に移動しました'` を出す (フィードバックなしだとタブが消えただけに見える)。
- MAX_PANELS チェックは不要 (タブを leaf に追加するだけで panel は増えない)。
- vitest 観点: src 側の collapse / dst 側の dedupe / active 不変 / src===dst no-op / 不在 ID no-op。

### 4.7 v5 → v6 マイグレーション (Go side)

state.json の `version` を見て:

| version | 動作 |
|---------|------|
| 6 | そのまま `Unmarshal` → validate |
| 5 | **ロスレス昇格**: 旧 `Layout` 単数を 1 個のビューアに包む |
| それ以外 | DefaultData fallback (従来通り) |

具体的な v5 → v6 ロジック:

```go
// internal/state/state.go (擬似コード)

func migrateV5(raw []byte) (StateData, error) {
    var v5 v5StateData
    if err := json.Unmarshal(raw, &v5); err != nil {
        return DefaultData(), err
    }
    viewer := ViewerState{
        ID:     newViewerID(),         // crypto/rand から生成 (UUID-like)
        Name:   "ビューア 1",
        Layout: v5.Layout,
    }
    return StateData{
        Version:        StateSchemaVersion,
        Window:         v5.Window,
        Viewers:        []ViewerState{viewer},
        ActiveViewerID: viewer.ID,
        TopTab:         normalizeTopTab(v5.TopTab),
        List:           v5.List,
    }, nil
}
```

- `v5StateData` は `internal/state/migration_v5.go` に**当該マイグレーション専用の private 構造体**として定義する (本体型を旧形に戻すと将来コードに leak するため隔離)。
- マイグレーション後は通常の v6 validate 経路を通す (空配列 → 1 個 default、name validation 等)。
- マイグレーション失敗 (json parse error 等) は従来通り DefaultData fallback。

### 4.8 v6 validateState

```
validateState(s):
  validateWindow(s.Window)            # 既存と同じ
  if len(s.Viewers) == 0:
    s.Viewers = [defaultViewer()]     # 起動可能な状態を保証
  if len(s.Viewers) > maxViewers:
    s.Viewers = s.Viewers[:maxViewers]
  for each v in s.Viewers:
    if v.ID == "":  return error      # corrupt
    v.Name = sanitizeName(v.Name)     # trim, fallback to "ビューア N"
    validateLayoutTree(&v.Layout)     # 既存ロジック
  if duplicate viewer IDs:  return error  # corrupt
  if s.ActiveViewerID not in viewer IDs:
    s.ActiveViewerID = s.Viewers[0].ID
  if s.TopTab not in {"list", "viewer"}:
    s.TopTab = "list"
  validateList(&s.List)               # 既存と同じ
```

レイアウトツリー単体の不正 (`validateLayoutTree` が error を返す) は従来通り全体 fallback だが、**ビューア単位での fallback は v1 ではしない** (1 つでも壊れていたら全体を default に戻す。複雑度を上げないため)。

## 5. UI

### 5.1 トップタブの構造

```
┌─────────────────────────────────────────────────────────────────┐
│ [一覧] [ビューア 1] [ビューア 2] [ビューア 3] [+]            [⚙]│
└─────────────────────────────────────────────────────────────────┘
```

- 左から:
  - `[一覧]`: 既存。クリックで `setTopTab("list")`。
  - `[ビューア N]` × N: 各ビューアタブ。クリックで `setTopTab("viewer") + setActiveViewer(id)` を一括適用。アクティブビューアは既存と同じ active 配色。
  - `[+]`: 新規ビューア追加ボタン。`MAX_VIEWERS` に達したら `disabled` + tooltip `"ビューア数の上限 (8)"`.
  - 右端: 設定アイコン (既存)。
- ビューアタブ群の領域は **`overflow-x: auto` + ホイール横スクロール** で、最大数 8 でも狭いウィンドウなら横にスクロール。
- 設定アイコンは `position: relative` の親 + `flex-shrink: 0` で常に右端固定。
- 一覧 / 設定アイコン は `flex-shrink: 0` で常に表示、ビューアタブ群だけがスクロール領域。

### 5.2 ビューアタブの中身

```
┌────────────────┐
│ ビューア 2  ×  │
└────────────────┘
```

- 名前: `text-overflow: ellipsis` + `max-width: 200px` 程度。リネーム inline edit 中だけ `<input>` に差し替え。
- `×` ボタン: 通常は非表示。タブ全体に hover で表示。`viewers.length === 1` なら非表示 (削除不可)。
  - クリックで `closeViewer(id)`。
  - タブ要素の右上に絶対配置 (タブ name のレイアウトを動かさない)。
  - aria-label: `"ビューア "{name}" を閉じる"`.

### 5.3 リネーム inline edit

- トリガ: タブ name 部分のダブルクリック (Card の動線とぶつからないよう、ビューアタブ専用ハンドラ)。
- 動作: タブ name を `<input type="text" maxLength={32}>` に差し替え。マウント時に `select()` で全選択。
- 確定:
  - `Enter`: `renameViewer(id, value)` 実行 + edit mode 解除。
  - `Esc`: 元の name で edit mode 解除 (変更を破棄)。
  - `blur`: Enter と同じ扱い (確定)。
- 入力中はそのタブの onClick / onPointerDown は受け付けない (`<input>` 自体が pointer events を消費する)。
- グローバルキーバインドは `isEditableTarget` ([keybindings.ts:31](../frontend/src/shared/utils/keybindings.ts#L31)) で自動的に抑制される (input 要素のため)。
- バリデーション失敗 (空文字) 時はトースト + edit mode は維持 (ユーザーがやり直せる)。

### 5.4 削除確認ダイアログ

`useConfirm` ([ConfirmDialog.tsx](../frontend/src/shared/components/ConfirmDialog.tsx)) を流用。

- 中身に画像タブが 1 個以上:
  ```
  ビューア "ビューア 2" を閉じますか?
  3 個のタブが破棄されます。
  [閉じる] [キャンセル]
  ```
- 中身が空 (root leaf に tabs なし) なら**確認なし**で即削除。
- ダイアログ表示中もグローバルキーバインドは抑制される (ConfirmDialog 内 ModalShell が focus trap)。

### 5.5 設定ダイアログのキーバインド表

[SettingsDialog.tsx:698 KEYBINDINGS](../frontend/src/features/settings/SettingsDialog.tsx#L698) に追加:

```ts
{ keys: "Ctrl+Shift+2 〜 9", action: "N 番目 (1〜8) のビューアタブに切替", scope: "全体" },
{ keys: "ダブルクリック (タブ名)", action: "ビューア名を編集", scope: "全体" },
```

既存 `Ctrl+Shift+2` 行 (「ビューアタブに切替」) は **削除**して上記に統合。

`Ctrl+Shift+W` (ビューア閉じる) は **v1 では追加しない** (× ボタンで十分。誤爆リスク回避。要望が出たら別 issue)。

### 5.6 一覧 → ビューア結線 (新動線)

複数ビューア化に合わせて、一覧 → ビューア結線を「**毎回ビューアを選んで開く**」モデルに刷新する。「Card クリック = 即ビューア開」という現行動線は廃止する。

#### 5.6.1 単一画像 (Card クリック)

- Card サムネ通常クリックの動線を **`onClickThumb` (即ビューア開) → `onClickPreview` (SampleModal を開く)** に差し替え。`Card.tsx` の `activate()` / `onClick` 内の分岐から `onClickThumb()` を `onClickPreview()` に置換。
- 既存の独立した「プレビュー」ボタン (`PreviewIcon`) は動線が冗長になるため**削除する** (アクションパスを 1 本に絞る)。
- [SampleModal.tsx](../frontend/src/features/classification/SampleModal.tsx) フッターの `「ビューアで開く」` ボタン (1 個) を **ビューア選択メニュー** に置換:
  - props 追加: `viewers: { id: string; name: string }[]` / `activeViewerId: string` / `onOpenInViewer: (dstViewerId: string) => void`
  - `viewers.length === 1` のとき: ボタン 1 個 `「ビューア "{name}" で開く」` (現行 UX 互換)。
  - `viewers.length >= 2` のとき: ビューアごとにボタンを横並び (`role="group"`)。active viewer をハイライト + 既定キーボードフォーカス。例:
    ```
    [✓ ビューア 1] [ビューア 2] [ビューア 3]
    ```
  - クリックで `onOpenInViewer(dstId)` → 親 (`App.tsx`) で `viewer.openInActiveOf(dstId, path)` を呼び (= `setActiveViewer(dstId)` してから `openInActive`)、モーダルを閉じ、`setTopTab("viewer")`。
- 8 個まで横並びで概ね収まる。狭幅は CSS `flex-wrap` で折り返し。

#### 5.6.2 バルク (複数選択)

- `ClassificationView` 内の BulkActionsBar (複数選択時のみ表示される領域) の既存 2 ボタンを「**ビューア選択ドロップダウン + アクションボタン**」の構成に変更:

  ```
  [N 件選択中]  [ビューア ▾]  [タブで開く]  [パネル分割で開く (≤8 枚)]  [選択解除]
  ```

  - ドロップダウン (`<select>`) の選択肢は `viewers[*]` (active viewer がデフォルト選択)。
  - アクションボタンクリックで `viewer.openManyInActiveOf(dstViewerId, paths)` / `openManyAsSplitOf(dstViewerId, paths)` を呼ぶ。これらは `useViewerSet` 上で「dst を一時的に active 化 → 既存 `openManyInActive` / `openManyAsSplit` を呼ぶ → active viewer を更新」する thin wrapper。
  - ドロップダウン状態は ClassificationView ローカル `useState`。フォルダ変更や選択解除では持ち越し可 (細かい体感判断、初期実装は持ち越しで OK)。

#### 5.6.3 動線変更の影響と緩和

- 「Card クリック = 即ビューア開」に慣れたユーザーには **1 クリック増える**。代わりに「どのビューアに開くか」を毎回明示できる。
- 動線は **モーダル固定で一本化** (フォールバックトグルは作らない)。要望が再燃したら別 issue で扱う。
- SampleModal は ModalShell に乗っており Esc / focus trap / portal-to-body は既存のまま。

### 5.7 タブ右クリックメニュー: 別ビューアへ移動 (サブメニュー)

[TabContextMenu.tsx](../frontend/src/features/viewer-grid/TabContextMenu.tsx) の項目を拡張する。ビューア間 DnD (§12 スコープ外) の代替手段。**サブメニュー方式**を採用 (親メニューにビューア名を並べてしまうと縦に長くなり、本来主要な「閉じる / 分割」項目を埋もれさせるため)。

#### 5.7.1 メニュー構造

親メニュー:

| 項目 | 種別 |
|------|------|
| 閉じる | 既存 |
| (区切り) | 既存 |
| 右に分割 | 既存 |
| 下に分割 | 既存 |
| (区切り) | 新規 |
| **ビューアへ移動 ▶** | 新規 (`role="menuitem"` + `aria-haspopup="menu"` + `aria-expanded`) |

サブメニュー (「ビューアへ移動」展開時):

```
┌──────────────┐                ┌──────────────────────────┐
│ 閉じる        │                │ ビューア "ビューア 2"     │
├──────────────┤                │ ビューア "ビューア 3"     │
│ 右に分割      │                │ ビューア "デザインレビュー"│
│ 下に分割      │                └──────────────────────────┘
├──────────────┤
│ ビューアへ移動 ▶│  ← hover で右に展開
└──────────────┘
```

- `viewers.filter(v => v.id !== currentViewerId)` を `'ビューア "{name}"'` として列挙。
- `viewers.length === 1` のときは「ビューアへ移動 ▶」項目と直前の区切りを**非表示**。
- 各サブ menuitem 幅: `max-width: 280px` + `text-overflow: ellipsis` + `title` で全文ツールチップ。`aria-label` にも全文を入れる。

#### 5.7.2 開閉トリガとフォーカス

- マウス: 親項目に hover で **150ms 遅延後**にサブメニューが開く (誤発火回避)。サブメニューから外れて 150ms 経過で閉じる。クリックでも開く (キーボード操作と統一)。
- キーボード:
  - `→` / `Enter`: 親項目フォーカス時にサブメニューを開いて先頭項目にフォーカス。
  - `←` / `Esc` (サブ内): サブメニューを閉じて親項目にフォーカスを戻す。
  - `↑` / `↓`: サブメニュー内で項目移動 (ラップアラウンド、既存 TabContextMenu と同パターン)。
  - `Home` / `End`: サブメニュー先頭 / 末尾。
  - `Esc` (親に戻った後さらに): 親メニュー全体を閉じる (既存パス)。
- マウスダウンでメニュー外をクリック: 親もサブも閉じる (既存 `onClose` パスを再利用)。

#### 5.7.3 配置と画面端処理

- サブメニューは親メニューの**右辺に隣接** (`left: parentRight - 4px`、4px は被せて連続感)。`top` は親項目の top と揃える。
- 画面右端にぶつかるとき (= `parentRight + subWidth > window.innerWidth`): 親メニューの**左辺に flip** (`right: parentLeft + 4px`)。
- 画面下端にぶつかるとき: 親項目 top を起点に上方向にシフト。
- `position: fixed` + `window.innerWidth/Height` クランプ。UI scale (`zoom: var(--ui-scale)`) は親メニューと同じく**適用しない** (raw 座標で位置決めするため、`.tab-context-menu` と同じ理由で除外)。

#### 5.7.4 実装メモ

- `TabContextMenu` に props 追加: `viewers: { id: string; name: string }[]` / `currentViewerId: string` / `onMoveToViewer: (dstId: string) => void`。
- ローカル state: `submenuOpen: boolean` + `submenuOpenTimer: number | null` (ホバー遅延用)。
- サブメニュー DOM はサブコンポーネント `MoveToViewerSubmenu` として切り出す。`role="menu"` + 各項目 `role="menuitem"`。
- 既存の `itemsRef` (vertical arrow nav) はサブメニュー側にも独立に持たせる。
- クリックで `onMoveToViewer(dstId)` → 親 (`ViewerGrid` → `App.tsx`) で `useViewerSet.moveTabAcrossViewers(...)` 実行 → 完了トースト `'ビューア "{dstName}" に移動しました'` → メニュー全体クローズ。
- `setActiveViewer` は呼ばない (§4.6 の通り src で作業継続)。

## 6. キーバインド

`App.tsx` グローバル keydown ([App.tsx:190-271](../frontend/src/App.tsx#L190)) を以下に変更:

| 既存 | 新規 |
|------|------|
| `Ctrl+Shift+1` → list | 据え置き (`setTopTab("list")`)。 |
| `Ctrl+Shift+2` → viewer | **削除**して下記に統合。 |
|  | `Ctrl+Shift+2..9` → `setTopTab("viewer") + setActiveViewer(viewers[N-2].id)` (N=2 で 1 番目)。`viewers[N-2]` が存在しないキー (例: ビューア 3 個しかないのに `Ctrl+Shift+5`) は **no-op**。 |
| `Ctrl+W` (viewer scope) | 据え置き (active panel の active tab を閉じる)。 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` (viewer scope) | 据え置き (panel 内タブ巡回。**ビューア間巡回ではない**点を spec で明示)。 |
| `Ctrl+0` / `Ctrl+1` / `Ctrl++` / `Ctrl+-` (viewer scope) | 据え置き (`zoomCommandBus`)。アクティブビューアのアクティブパネル内 ImageView が listener を持つ。 |

### 6.1 `e.code === "DigitN"` での判定

既存 `Ctrl+Shift+1/2` は `e.code === "Digit1"` / `"Digit2"` で判定済み ([App.tsx:204-215](../frontend/src/App.tsx#L204))。同パターンで `"Digit3"` 〜 `"Digit9"` を追加。9 は `viewers.length >= 8` のみマッチする。

### 6.2 `zoomCommandBus` の listener takeover 検証

ビューア切替時に **inactive 化したビューアの ImageView が listener を保持し続けないこと** を確認する。

- 現状: `ImageView` は `isActivePanel` prop が true の時だけ `zoomCommandBus.setListener(...)` を呼び、false になったら null をセット。
- ビューア切替 = 別 viewer の同じ active panel が新しい active になる。inactive 側の panel は `topTab === "viewer"` でも非表示になるため `isActivePanel = false` 相当の振る舞いになるべき。
- 実装:
  - 案 1: トップタブ非表示のビューアは `ViewerGrid` を unmount する (= panel が消える → effect cleanup で listener が剥がれる)。**simplest**、推奨。
  - 案 2: 非表示ビューアも mount したまま `display: none` で隠す (タブ切替が高速だが、メモリと listener 管理が複雑)。
- v1 は案 1 を採用 (= 各ビューアの ViewerGrid は active 時のみマウント)。これにより既存の `isActivePanel` 機構をそのまま使える。
  - 副作用: ビューア切替で画像が再マウント → 再 decode のラグ。Phase 3a 以降の `tab.initialized` / `zoom`/`panX`/`panY` は **タブ state に保存されている**ので「絵が再表示される」だけで、状態は失われない。
  - サムネキャッシュ ([useGridThumbnail.ts](../frontend/src/features/classification/useGridThumbnail.ts)) と画像バイト (Wails IPC で取得) は再 decode が走るが、Go 側ファイル read はディスクキャッシュ層 (Phase 2) で速い。

## 7. 永続化

### 7.1 state.json schema v6

- `useSessionSave` ([useSessionSave.ts](../frontend/src/features/session/useSessionSave.ts)) の `SessionInput` を変更:

  ```ts
  export type SessionInput = {
    window: { width: number; height: number; x: number; y: number };
    viewers: { id: string; name: string; layout: Layout }[];
    activeViewerId: string;
    topTab: "list" | "viewer";
    list: ListPersist;
  };
  ```

- `STATE_SCHEMA_VERSION = 6` に bump。
- `serializeLayout` を全ビューアに対して回す。
- 既存の 500ms debounce + JSON.stringify diff 機構はそのまま動作 (配列内オブジェクトの identity 変化は JSON 文字列レベルで弾かれる)。

### 7.2 session 復元 (`useSessionLoad` + `App.tsx`)

- `useSessionLoad` 自体は `state.StateData` を素通しで返す ([useSessionLoad.ts](../frontend/src/features/session/useSessionLoad.ts)) → 変更不要。
- `App.tsx` で `initialState.viewers` から `Viewer[]` を復元 (`layoutFromPersisted` を各ビューアに対して呼ぶ)。
- `initialState.activeViewerId` を `useViewerSet` に注入 (`opts.initialActiveViewerId`)。
- 起動時 `viewers` が空 / null (= 旧 schema fallback 後の defaults) なら 1 個のデフォルトビューアで初期化。

### 7.3 v5 → v6 マイグレーションの境界条件

| ケース | 期待動作 |
|--------|---------|
| state.json 不在 | DefaultData (v6) を返す → ビューア 1 個 |
| state.json 存在 / version=6 / 構造健全 | そのまま load |
| state.json 存在 / version=5 / Layout 健全 | v5 → v6 ロスレス昇格 (1 個のビューア化) |
| state.json 存在 / version=5 / Layout 不正 | DefaultData (v6) fallback |
| state.json 存在 / version=4 以下 | DefaultData (v6) fallback (従来通り) |
| state.json 存在 / version=6 / viewers 空配列 | validateState で 1 個 default を生成 |
| state.json 存在 / version=6 / activeViewerId が viewers にない | validateState で先頭ビューアにフォールバック |
| state.json 存在 / version=6 / 重複 viewer ID | 全体 fallback (corrupt 扱い) |

## 8. テスト

### 8.1 Go テスト (internal/state)

`internal/state/state_test.go` に追加:

- `TestLoadState_V5MigratesLosslessly`: v5 形式 (Layout 単数) を書き込んで Load → v6 で 1 個のビューアに包まれて返ること、ID が空でなく、name が "ビューア 1"、Layout 内容が一致。
- `TestLoadState_V5InvalidLayoutFallsBack`: v5 で Layout が壊れていたら DefaultData fallback。
- `TestLoadState_V6RoundTrip`: v6 形式の Save/Load round-trip。
- `TestLoadState_V6EmptyViewers`: viewers 空配列 → validateState で 1 個生成。
- `TestLoadState_V6ActiveViewerIdMismatch`: activeViewerId が存在しないビューアを指す → 先頭ビューアにフォールバック。
- `TestLoadState_V6DuplicateViewerID`: 重複 ID → DefaultData fallback。
- `TestLoadState_V6NameTrimAndFallback`: 空 / 空白のみの name → "ビューア N" にフォールバック。
- `TestLoadState_V6ExceedsMaxViewers`: 9 個書き込み → 8 個に切詰め。
- `TestSuggestViewerName_*`: gap 採番ロジック (1 から最小未使用)、カスタム名混在ケース。

### 8.2 vitest (frontend)

`frontend/src/features/viewer-grid/viewers.test.ts` (新規):

- 純関数テスト: `addViewer` / `closeViewer` / `renameViewer` / `setActiveViewer` / `suggestViewerName` / `moveTabAcrossViewers`。
- active viewer 解決のフォールバック (削除時に同じインデックス → 前 → 先頭)。
- MAX_VIEWERS 上限 (新規追加が拒否される)。
- 最後の 1 個削除拒否。
- 名前バリデーション (空 / トリム / 32 文字超過)。
- `moveTabAcrossViewers` 観点: src/dst 両ビューア存在 / 不在 ID no-op / 同一ビューア no-op / src 末尾タブ移動で leaf collapse / dst 重複 path の dedupe / `activeViewerId` 不変 / `panX`/`panY`/`zoom`/`initialized` 保持。

`frontend/src/features/viewer-grid/layout.test.ts` (既存 55 ケース) は **無改修** (Layout 単体型は不変)。

### 8.3 マニュアルテスト (`wails dev`)

- 一覧 → 画像クリック → アクティブビューアの active panel に開かれる。
- ビューア追加 → 名前 "ビューア 2" → 切替で空ビューア表示。
- ビューア 1 で画像開く → 切替 → 戻ると state 維持。
- リネーム inline → Esc で破棄、Enter で確定、空文字で reject。
- ビューア削除 (タブあり) → 確認ダイアログ。
- ビューア削除 (タブなし) → 確認なし。
- MAX_VIEWERS = 8 まで追加できる、9 個目は + ボタン disabled。
- `Ctrl+Shift+1〜9` で切替できる、存在しないビューア番号は no-op。
- アプリ再起動で全状態が復元される。
- 旧 v5 state.json があるユーザーが起動 → ビューア 1 個に packing されて lose せず復元される。

## 9. ロギング

`logger.info("viewer-set", ...)` カテゴリで以下を仕込む:

| イベント | level | data |
|----------|-------|------|
| `add` | info | `{ id, total }` |
| `add refused` (max reached) | warn | `{ max }` |
| `close` | info | `{ id, hadTabs: bool, total }` |
| `close refused` (last viewer) | warn | `{ id }` |
| `rename` | info | `{ id, oldName, newName }` |
| `rename refused` (empty/invalid) | warn | `{ id, attempted }` |
| `setActive` | debug | `{ from, to }` |
| `migration v5→v6` | info | `{ viewerId, panelCount }` (Go 側 log) |

## 10. エラー処理

- Wails IPC (`SaveState` / `GetState`) 失敗時は既存の `logger.warn` 経路 (useSessionSave.ts:56) で吸収。ユーザー通知は v1 では出さない (現状と同じ)。
- フロント mutation の no-op (validation 失敗) はトーストで notify。
- Go 側 `validateState` の致命エラーは DefaultData fallback ([state.go:159](../internal/state/state.go#L159))。

## 11. 実装順序

依存関係を考えると以下の順:

1. **Go 側 state v6** + マイグレーション + テスト (PR 単位の最小ブロック)。Wails 自動生成の TS 型 (`state.StateData`) を再生成。
2. **`features/viewer-grid/viewers.ts`** (純関数 + 型 + `moveTabAcrossViewers`) + vitest。
3. **`useViewerSet` フック** ([useViewerGrid.ts](../frontend/src/features/viewer-grid/useViewerGrid.ts) を上に被せる形)。既存 `useViewerGrid` は内部実装に降格。判断: **置き換え** — `useViewerGrid` ファイル名を維持しつつ中身を `useViewerSet` 化、active viewer の各操作を delegate メソッドとして公開。`openInActiveOf(dstId, path)` / `openManyInActiveOf(dstId, paths)` / `openManyAsSplitOf(dstId, paths)` / `moveTabToViewer(srcLeafId, srcIdx, dstId)` の thin wrapper も同時に生やす。
4. **`useSessionSave` v6 化** + buildStateData 更新。
5. **App.tsx 改修**: viewers 配列レンダ、トップタブ + リネーム / × ボタン UI、グローバルキーバインド `Digit3..9` 追加、onOpenInViewer 系のターゲット解決を `*Of(dstId, ...)` 経由に。
6. **SampleModal 改修** (§5.6.1): `viewers` / `activeViewerId` / `onOpenInViewer(dstId)` props 追加、フッターをビューア選択ボタン群に置換。
7. **Card 動線変更** (§5.6.1): `Card.tsx` の `activate()` / `onClick` で `onClickThumb` → `onClickPreview` に置換、PreviewIcon ボタン削除、`onClickThumb` prop を削除。`ClassificationView` 側の prop 配線と DirectoryGroup の通り道も同時更新。
8. **ClassificationView バルク領域改修** (§5.6.2): BulkActionsBar に `<select>` + 既存 2 ボタンの並び。`onOpenManyInTabs` / `onOpenManyAsSplit` を `(dstId, filenames)` シグネチャに変更。
9. **TabContextMenu 拡張** (§5.7): `viewers` / `currentViewerId` / `onMoveToViewer(dstId)` props 追加、「ビューアへ移動 ▶」サブメニュー (`MoveToViewerSubmenu` を子コンポーネントに切出し)。マウス hover 150ms 遅延、キーボード `→/←/↑/↓/Home/End/Esc` 対応、画面端 flip 配置。`viewers.length === 1` で項目ごと非表示。
10. **CSS** (`.top-tabs` overflow + `.top-tab` リネーム / × ボタン + SampleModal フッターの button group + BulkActionsBar の `<select>` + TabContextMenu サブメニューの `position: fixed` + `max-width / ellipsis`)。
11. **設定ダイアログ KEYBINDINGS** 更新 (§5.5)。
12. **マニュアル `wails dev` 受け入れテスト** (§8.3)。
13. **ドキュメント**: `.claude/context.md` の Phase 名 + state schema 注記、`docs/todo.md` の E 系項目、`spec-viewer-flexlayout.md` 冒頭に redirect。

各ステップで `go test ./...` / `npm run test` / `tsc --noEmit` / `wails build` が通ることを確認。

## 12. スコープ外 (v1 で作らない、要望出たら別 issue)

- **ビューア間 DnD** (タブを別ビューアに移す)。代替手段としてタブ右クリックメニュー (§5.7) を提供する。
- **ビューアごとのフォルダ紐付け / セッション** (`workspace` 概念)。今は画像タブの集合という意味論を維持。
- **`Ctrl+Shift+W`** (アクティブビューアを閉じるショートカット)。誤爆リスク回避。
- **ビューア複製** (現在のビューアを名前違いで複製)。需要不明。
- **ビューア並び替え** (タブ DnD で順序変更)。優先度低。
- **ビューア順序の永続化以外の用途** (= ビューア選択モーダル等)。
- **9 個以上のビューア**。MAX_VIEWERS = 8 (`Ctrl+Shift+2..9` の数字キーに合わせて固定)。
- **マイグレーション v4 以下** (DefaultData fallback のまま)。

## 13. 確定すべき決定事項 (実装着手前)

§1 で「こうする」と書いた内容は、次の判断のうえに成り立っている。**ユーザー合意で確定**してから実装に入る。

| # | 項目 | 推奨 | 代替案 |
|---|------|------|--------|
| 1 | v5→v6 マイグレーション | **ロスレス昇格** (1 ビューアに packing) | DefaultData fallback (損失あり、コード薄い) |
| 2 | `topTab` モデル | `"list" \| "viewer"` のまま + `activeViewerID` 別フィールド | `topTab: "list" \| "viewer:<id>"` のような string union |
| 3 | ビューア追加 UI | top-tab 末尾の `+` ボタン | コンテキストメニュー / メニューバー |
| 4 | リネーム UI | タブダブルクリックで inline edit | コンテキストメニュー → モーダル |
| 5 | ビューア削除 UI | タブ hover で `×` | コンテキストメニュー / 設定ダイアログ |
| 6 | 削除確認 | タブが残っていれば確認ダイアログ、空なら無確認 | 常に確認 / 常に即削除 |
| 7 | 既定名 | "ビューア N" 自動連番 (gap 採番) | "Untitled" / 必ずユーザー命名 |
| 8 | MAX_VIEWERS | **8** (Ctrl+Shift+2..9 に合わせて) | 4 / 16 / 無制限 |
| 9 | MAX_PANELS の解釈 | ビューア当たり 16 (現状据え置き) | 全体合計 16 |
| 10 | ビューア間タブ移動 | **DnD は v1 スコープ外**。代替に**タブ右クリックメニュー**「ビューア "X" へ移動」を追加 (§5.7, §4.6) | DnD 採用 / 移動 UI なし |
| 11 | 一覧 → ビューア結線 | **Card クリック → SampleModal → モーダル内ビューア選択ボタン群** で選んで開く。バルクは BulkActionsBar に **ビューア選択ドロップダウン + アクションボタン** を併設 (§5.6) | アクティブビューアに固定 / 一覧側で固定ピン留め |
| 12 | キーバインド `Ctrl+Shift+W` | **追加しない** | 追加 (アクティブビューア閉じる) |
| 13 | 非アクティブビューアの mount 戦略 | **unmount** (active のみマウント) | 全 mount + display:none |
| 14 | 名前バリデーション | trim 後 1 文字以上、32 文字以下、重複許容 | 重複禁止 / 改行禁止 |

> **§13 への追記 (確定)**:
> - #10 ビューア間 DnD は不採用継続。ただしタブ右クリックメニューに「ビューア "X" へ移動」を追加する (上表 #10、§4.6、§5.7 に反映)。
> - #11 一覧 → ビューア結線は刷新: 通常クリック → SampleModal → モーダル内のビューア選択メニュー、またはバルク選択 UI → 「開く」ボタン群にビューア選択ドロップダウン (上表 #11、§5.6 に反映)。

## 14. 受け入れ基準 (DoD checklist)

実装完了時にこのリストを `[x]` にしていく。

### 機能
- [ ] トップタブが「一覧 + ビューア × N」で動的レンダされる
- [ ] `+` ボタンでビューア追加できる、上限 8
- [ ] タブ hover で `×` 表示、クリックで削除 (タブあれば確認)
- [ ] タブダブルクリックでリネーム inline edit (Enter 確定 / Esc 破棄 / blur 確定)
- [ ] 各ビューアが独立した Layout を持つ (1 つで分割しても他に波及しない)
- [ ] アクティブビューアの active panel 機構が従来通り動作 (ズーム/パン/タブ操作)
- [ ] ビューア最後の 1 個は削除不可 (× ボタン disabled)

### 一覧 → ビューア結線 (§5.6)
- [ ] Card サムネ通常クリックで SampleModal が開く (旧: 即ビューア開きは廃止)
- [ ] Card の独立プレビューボタン (PreviewIcon) は削除されている
- [ ] `viewers.length === 1` のとき SampleModal フッターは「ビューア "{name}" で開く」1 ボタン
- [ ] `viewers.length >= 2` のとき SampleModal フッターはビューア横並びボタン群、active がハイライト + 既定フォーカス
- [ ] BulkActionsBar に「ビューア ▾ + タブで開く + 分割で開く」が並ぶ、ドロップダウン既定は active viewer
- [ ] 各経路で開いた後、`setTopTab("viewer")` + 選んだビューアが active になる

### ビューア間タブ移動 (§4.6, §5.7)
- [ ] タブ右クリックメニューに「ビューアへ移動 ▶」が `viewers.length >= 2` で表示される
- [ ] サブメニューに自ビューア除外の全ビューアが列挙される
- [ ] `viewers.length === 1` では「ビューアへ移動 ▶」項目と直前の区切りが非表示
- [ ] サブメニューがマウス hover (150ms 遅延) で開く / 親項目から離れて閉じる
- [ ] キーボード `→` / `Enter` でサブメニューを開いて先頭にフォーカス
- [ ] キーボード `←` / `Esc` (サブ内) でサブメニューを閉じて親項目に戻る
- [ ] サブメニュー内 `↑` / `↓` で項目移動 (ラップアラウンド)
- [ ] 画面右端でサブメニューが左側に flip する
- [ ] 移動でタブが src から消え、dst の active leaf に末尾追加 (重複 path はフォーカスのみ)
- [ ] 移動後、active viewer は src のまま (focus 移動なし) + トースト表示
- [ ] 移動で src leaf が空になったら collapseEmptyLeaf が走る (root leaf を除く)

### キーバインド
- [ ] `Ctrl+Shift+1` で一覧
- [ ] `Ctrl+Shift+2..9` で N-1 番目 (1〜8) のビューア、存在しなければ no-op
- [ ] `Ctrl+W` / `Ctrl+Tab` / `Ctrl+0` 系がアクティブビューアの active panel に効く
- [ ] リネーム input にフォーカスがある間は全グローバルキーバインドが抑制される

### 永続化
- [ ] v5 state.json があるユーザーがアプリ起動 → ビューア 1 個に packing される (内容ロスなし)
- [ ] v6 で Save → 再起動で完全復元 (viewers / activeViewerId / topTab / 各 layout / 各 tab の zoom/pan / window size/pos / list filter)
- [ ] viewers 空配列 / activeViewerId 不一致 / 重複 ID の壊れ方を検証 (validateState がよしなに修復、致命的なら fallback)

### テスト
- [ ] `go test ./internal/state/...` 全通過 (新規 v5→v6 マイグレーション 9 ケース含む)
- [ ] `npm run test` 全通過 (新規 viewers.test.ts 30 ケース見込み)
- [ ] `tsc --noEmit` クリア
- [ ] `wails build` 通過

### マニュアル
- [ ] `wails dev` で §8.3 の全シナリオが手で確認できる
- [ ] 既存機能 (Phase 3a〜5 + Phase 4 + Phase H) に regression なし

### ドキュメント
- [ ] `.claude/context.md` に state schema v6 + Phase 名追記
- [ ] `docs/spec-viewer-flexlayout.md` 冒頭に「複数ビューアは spec-multi-viewer.md 参照」追記
- [ ] `docs/todo.md` の該当項目を `[x]` に
