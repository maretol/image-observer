# ビューア フレックスレイアウト 実装仕様書 (Phase 5 ドラフト)

Phase 3b で実装した「最大 2 行 × 3 列の固定グリッド」+「ツールバー操作で行/列を増減」「右クリックでパネル間タブ移動」というビューア構造を、**タブの DnD でレイアウトを動的に作り変える自由分割**に置き換える。VS Code のエディタグループや IntelliJ のツールウィンドウ分割に近い UX を目指す。

> **ステータス**: 決定事項確定済み (§11)。実装着手可能。
>
> **複数ビューア対応 (#11) 以降の補足**: 本仕様の `Layout` は **1 ビューア分** の BSP 構造である。複数ビューア対応 (#11) で `Viewer[]` を上に被せ、各ビューアが本仕様の `Layout` を 1 個ずつ持つ構造になった。クロスビューアのタブ移動 / トップタブ UI / state schema v6 については [spec-multi-viewer.md](spec-multi-viewer.md) を参照。本仕様の §3 〜 §10 の内容は 1 ビューア内では従来どおり成立する。

---

## 0. 改訂履歴

- 2026-05-10 初版ドラフト。要求は次の 2 点:
  1. 行追加 / 列追加のボタン UI を廃止し、**タブを既存パネルの端にドラッグ&ドロップする** ことで分割を発生させる。
  2. 「行」「列」の単位ではなくパネルごとの自由配置を認める。例:「左半分は上下 2 段の小さなビュー、右半分は縦長 1 枚」のように、`rows × cols` で表現できないレイアウトを許容する。

---

## 1. ゴール (DoD)

- ビューア領域がアプリ起動時は **1 パネル** で表示される (Phase 3 と同じ初期見た目)。
- ツールバーの `+ 行` / `+ 列` / `- 行` / `- 列` ボタンは廃止する (代替は DnD)。
- タブの右クリックメニューは **最小機能のみ残す**: 「閉じる」「右に分割」「下に分割」 (DnD ができない / しない場合の救済手段。詳細は §5.6)。
- タブをパネルの 4 辺いずれかにドロップすると、ドロップ先の対辺方向にパネルが分割され、新しいパネルにそのタブが入る。
- タブをパネルの中央 (タブバーまたはキャンバス中央) にドロップすると、既存のパネルへタブが移動 (重複時はフォーカス、空にならなければ source 側は減る) する。
- タブを同一パネルのタブバー内にドロップすると **タブの並び替え** ができる (今までは並び替え不可)。
- タブを別パネルのタブバー上にドロップすると、その位置に挿入される。
- ある leaf パネルの最後のタブを閉じる / 移動するとパネル自体が消滅し、兄弟パネルが親分割を吸収する (折り畳み)。
- 分割の境界 (Splitter) はドラッグで比率変更可能 (Phase 3b と同じ感覚、ただしツリー上の任意の SplitNode に対して効く)。
- 「アクティブパネル」は常に 1 つ存在し、青枠でハイライトされる。一覧タブから画像を開く動線 (`onOpenInViewer`) はアクティブパネルに対して機能する (E2 改定はそのまま継承)。
- セッション復元: グリッド形状 + 各パネルのタブ状態 + アクティブパネル + ズーム/パン が、再起動後も復元される。
- `wails build` が通り、`wails dev` で操作確認できる。Phase 3a 〜 3c / Phase 4 の機能 (画像表示、ズーム/パン、サムネ、分類タブ、セッション復元) に劣化なし。

## 2. 用語

| 用語 | 意味 |
|------|------|
| **Layout** | ビューア全体のレイアウトツリー。1 個の `LayoutNode` (= ルート) を持つ。 |
| **LayoutNode** | `SplitNode` か `LeafNode` のいずれか (再帰タグ付きユニオン)。 |
| **SplitNode** | 内部ノード。方向 `direction` と比率 `ratio` を持ち、子 2 つ (`a` / `b`) を分割する。 |
| **LeafNode** | 葉。タブ列とアクティブタブを持つ「パネル」相当。 |
| **panel** | UI 上の用語。`LeafNode` 1 個に対応する画面上の 1 領域。 |
| **active panel** | ユーザーが直近に操作した leaf。`activeId` で参照。 |
| **edge drop** | 既存パネルの 4 辺いずれかに DnD でドロップする操作。新しい兄弟パネルを生成する。 |
| **center drop** | 既存パネルの中央付近にドロップする操作。タブをそのパネルへ移動する。 |
| **tab-bar drop** | パネルのタブバー内 (タブの隙間や末尾) にドロップする操作。並び替え / 挿入する。 |

## 3. データモデル

### 3.1 主要型

```ts
// frontend/src/features/viewer-grid/layout.ts (新規)

export type SplitDirection =
  | "row"  // 親領域を上下に分割 (a が上、b が下)。Splitter は横方向に伸びる
  | "col"; // 親領域を左右に分割 (a が左、b が右)。Splitter は縦方向に伸びる

export type LayoutNode = SplitNode | LeafNode;

export type SplitNode = {
  kind: "split";
  id: string;            // 安定 ID。React key、splitter ターゲット参照に使う
  direction: SplitDirection;
  ratio: number;         // 0 < ratio < 1。a の取り分。b は 1 - ratio
  a: LayoutNode;
  b: LayoutNode;
};

export type LeafNode = {
  kind: "leaf";
  id: string;            // 安定 ID。React key、DnD ドロップターゲット参照に使う
  tabs: Tab[];           // Phase 3a の Tab 型を再利用 (zoom/pan 込み)
  activeIndex: number;   // -1 if tabs.length === 0 (一時状態。通常は 0..tabs.length-1)
};

export type Layout = {
  root: LayoutNode;
  activeId: string;      // 現在のアクティブ leaf の id
};
```

`Tab` 型は Phase 3a / 3b の `useTabs.ts` のものをそのまま再利用する (変更なし)。

### 3.2 ID の生成

- `crypto.randomUUID()` を使用。Wails 環境のブラウザは Chromium ベースなので利用可能。
- ノード生成時に必ず 1 回振り、以降は不変。setState で構造を作り変えても、変化しないノードの ID は維持する (React の reconciler に効く + DnD ターゲット解決を安定させる)。

### 3.3 初期状態

```ts
const initialLayout: Layout = {
  root: { kind: "leaf", id: <uuid>, tabs: [], activeIndex: -1 },
  activeId: <ルート leaf の id>,
};
```

### 3.4 不変条件 (invariants)

ツリーの整合性を常に満たす。`useViewerGrid` の各 mutation の最後に validateLayout(root) でチェックし、デバッグビルドでは throw、リリースビルドでは reset to default + log warning。

- `SplitNode.ratio` は `[MIN_RATIO, 1 - MIN_RATIO]` の範囲。`MIN_RATIO = 0.05` (固定下限) と、Splitter ドラッグ時に親 SplitNode の bounding rect から導出する **`MIN_PX = 100` のピクセル下限** の **両方** を満たすよう clamp する。コンテナが極端に狭い場合は MIN_PX の方が支配的になる。
- ID はツリー全体でユニーク。
- `LeafNode.tabs.length === 0 && LeafNode === root` だけが空 leaf を許容する状況 (= 起動時 / 全タブ閉じた時)。それ以外で空 leaf が発生したら直ちに親ごと折り畳む (§4.4)。
- `activeId` は必ずどこかの leaf の id を指す。指している leaf が消えたら、ツリー DFS 順で **前の leaf** または **次の leaf** にフォーカスを移す (§4.5)。

## 4. 操作とアルゴリズム

### 4.1 タブを別パネル中央へドロップ (= 既存パネルへ移動)

```
moveTabIntoLeaf(srcLeafId, srcIdx, dstLeafId, dstIdx?: number)
```

- `srcLeafId === dstLeafId` のときは並び替えとして扱う (§4.2 へ委譲)。
- src の tab を取り出す。zoom / pan / panX / panY などの状態は保持。
- dst に同じ path のタブが既にあれば、そのタブにフォーカスし、src からは削除する (重複統合)。
- 同じ path がなければ:
  - `dstIdx` が指定されていればその位置に挿入、未指定なら末尾に append。
  - dst の `activeIndex` を **挿入したタブ** にする。
- src の `activeIndex` は Phase 3a の `recomputeActiveAfterClose` と同じロジックで再計算。
- src が空になった場合、§4.4 で leaf を折り畳む。
- `Layout.activeId` を dst の id に更新。

### 4.2 同一パネル内でタブの並び替え

```
reorderTab(leafId, srcIdx, dstIdx)
```

- 配列の並び替え (insert before / after は dst 端の判定で吸収)。
- `activeIndex` は **ドラッグしたタブをアクティブ** に設定する (UX が直感的)。

### 4.3 タブを既存パネルの辺にドロップ (分割発生)

```
splitTabIntoEdge(srcLeafId, srcIdx, dstLeafId, edge: "top"|"bottom"|"left"|"right")
```

エッジ → 分割方向と新 leaf の位置:

| edge | direction | 新 leaf の位置 |
|------|-----------|---------------|
| top | row | a (上) |
| bottom | row | b (下) |
| left | col | a (左) |
| right | col | b (右) |

手順:
1. src からタブを取り出す。zoom/pan は保持。
2. 新しい `LeafNode` (id: 新 uuid, tabs: [取り出したタブ], activeIndex: 0) を作る。
3. dst の親をツリー上で探し、dst を「以下の SplitNode」に置換する:
   - 新 SplitNode = { kind: "split", id: 新 uuid, direction, ratio: 0.5, a: 新 leaf or dst leaf, b: dst leaf or 新 leaf } (edge により a/b 入れ替え)
4. src は §4.4 で必要に応じて折り畳む。
5. `Layout.activeId` を新 leaf の id に。

### 4.4 leaf 折り畳み (= 自動コラプス)

`tabs.length === 0` になった `LeafNode L` が現れたら:
- `L === root` なら何もしない (空のルート leaf は維持。アプリ起動直後と同じ状態に戻る)。
- それ以外: `L` の親 SplitNode `P` を探し、`P` を「`L` の兄弟ノード」で置き換える。`P` の親が SplitNode なら、その a/b のうち P を指していた側を兄弟に差し替える。`P` の親がなければ (= P がルート) 兄弟をルートに昇格させる。
- 兄弟が SplitNode ならそのまま昇格 (内部構造はそのまま温存)。
- 兄弟が LeafNode で、ratio や splitter は失われる (構造単純化のため復元しない)。

この処理は `move` / `close` / `splitTabIntoEdge`(src 側) のすべてから呼ばれる共通ヘルパとして実装する。

### 4.5 leaf 削除時の active 更新

ツリーを左から右、上から下の DFS 順序で leaf を列挙する `enumerateLeaves(root): LeafNode[]` を持つ。`activeId` の指す leaf が消えたら、削除前の DFS 順序で:
- 同じインデックス位置の leaf (= 削除直後に「同じ場所」を埋めた leaf)
- なければインデックス -1 の leaf
- なければ単純に列挙の先頭

を新 active にする。

### 4.6 アクティブパネル切替

- パネル内でクリック / mousedown / wheel イベントが起きたとき `activeId` をその leaf に。
- DnD で発生した分割や移動の最後に、新しい / フォーカスを継ぐ leaf に `activeId` を移す (§4.1 〜 4.3 で記述済)。

### 4.7 一覧タブからの画像オープン (`openInActive`)

- 既存の `useViewerGrid.openInActive(path)` の呼び出し契約を維持。実装内部で `Layout.activeId` から leaf を取得して、Phase 3b と同じロジック (重複検出 + 末尾追加) を適用する。

### 4.8 タブを閉じる

`closeTab(leafId, idx)`: タブを配列から削除、`activeIndex` を再計算。空になったら §4.4 で折り畳む。確認ダイアログは出さない (Phase 3b の `removeRow` / `removeCol` 確認は **廃止** — そもそもボタンが無いので発火しない。タブを 1 枚ずつ閉じる UX に統一)。

### 4.9 Splitter ドラッグ

- 各 SplitNode の境界に Splitter を 1 個描画。Phase 3b の `GridSplitter` を recursive 配置できるようリファクタする。
- ドラッグ中は親 SplitNode の bounding rect を `getBoundingClientRect` で取得し、ピクセル → 比率変換。
- clamp は `MIN_PX = 100` (Phase 3b と同じ) と `MIN_RATIO = 0.05` の **両方** を満たす範囲 (§3.4 参照)。
- mouseup で確定。

## 5. UI / UX 設計

### 5.1 全体レイアウト

```
┌──────────────────────────────────────────────────────────────────┐
│ (GridToolbar は廃止。ビューアタブ直下に余分な帯は出さない)       │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────┬─────────────────────────────────────────┐   │
│ │ [Tab1] [Tab2]    │ [TabA]                                  │   │
│ │ ╭──────────────╮ │ ╭─────────────────────────────────────╮ │   │
│ │ │ ImageView    │ │ │            ImageView                │ │   │
│ │ │              │ │ │                                     │ │   │
│ │ ╰──────────────╯ │ │                                     │ │   │
│ ├══════════════════│ │                                     │ │   │
│ │ [TabX] [TabY]    │ │                                     │ │   │
│ │ ╭──────────────╮ │ │                                     │ │   │
│ │ │ ImageView    │ │ │                                     │ │   │
│ │ ╰──────────────╯ │ ╰─────────────────────────────────────╯ │   │
│ └──────────────────┴─────────────────────────────────────────┘   │
│ ↑ left col の中で row 分割                  ↑ right col は単一 │
└──────────────────────────────────────────────────────────────────┘
```

ルート: SplitNode (col) — 左右分割。
- a (左): SplitNode (row) — 上下分割
  - a (上): Leaf [Tab1, Tab2]
  - b (下): Leaf [TabX, TabY]
- b (右): Leaf [TabA]

これがユーザーの「左は上下 2 段、右は縦長 1 枚」要求の最小例。

### 5.2 ドラッグ操作の検出

ネイティブの HTML5 DnD は VS Code でも使われているが、画像のドラッグやネイティブ動作と干渉しがちなので、**ポインタイベントベース** で実装する:
- タブ要素の `onPointerDown` でドラッグ候補を確定 (5px 以上動いたらドラッグ開始)。
- `setPointerCapture` でカーソル外もイベントを取得。
- ドラッグ開始時、ビューア全体に `<DnDOverlay>` を `position: absolute; inset: 0; pointer-events: auto` で被せる。各 leaf のキャンバス領域に対する hit-test はオーバーレイ側でやる。
- ドラッグ中は各 leaf キャンバスの上に **ドロップゾーンインジケータ** を表示:
  - 中央 60% 矩形 (薄い青の塗り) → center drop
  - 上下左右の各 20% 帯 → edge drop (該当辺に向けて少し濃い青)
- カーソルが leaf キャンバスを離れて `タブバー` 上に戻ってきたら、タブの隙間にインジケータ (1px の青ライン) を表示 → tab-bar drop。
- カーソルがビューア外に出たら全インジケータ非表示。`pointerup` でキャンセル。

`DnDOverlay` は単一コンポーネントとし、現在のドラッグ状態 (`{ srcLeafId, srcTabIdx, currentHit: { leafId, zone } | null }`) を hold する。`pointerup` で確定。

### 5.3 ドラッグ中のゴースト

タブのプレビュー (タブ名 1 行 + 画像サムネのフォールバックアイコン) を `position: fixed` でカーソル右下に追従させる。CSS:

```css
.tab-drag-ghost {
  position: fixed;
  pointer-events: none;
  background: #2a2a2a;
  border: 1px solid #555;
  padding: 4px 8px;
  border-radius: 3px;
  font-size: 12px;
  opacity: 0.85;
  z-index: 9999;
}
```

### 5.4 アクティブパネルの表示

Phase 3b と同じ: `box-shadow: inset 0 0 0 2px #007acc` の青枠。

### 5.5 「すべてのタブを閉じてレイアウトをリセット」

タブが全部閉じられて `root` が空 leaf になったら、ImageView 領域は Phase 3a の「画像を選択してください」プレースホルダになる。明示的なリセットボタンは v1 では作らない (発生頻度が低いと判断)。

### 5.6 アクセシビリティ / フォールバック

- DnD は pointer events なので、タッチでも動く (将来モバイル対応が来れば)。
- **キーボード操作は v1 では一切サポートしない** (Esc によるドラッグキャンセルも含む)。Phase H で「フォーカスパネルを Alt+矢印で移動」「Ctrl+\ で active パネルを縦分割 / 横分割」「Esc キャンセル」等を検討。
- DnD だけだと操作ミス時の救済手段がないため、**最小限の右クリックメニューを残す**:

```
┌──────────────────┐
│ 閉じる            │
├──────────────────┤
│ 右に分割          │
│ 下に分割          │
└──────────────────┘
```

- **閉じる**: そのタブを閉じる (`closeTab(leafId, tabIdx)`)。
- **右に分割**: 右クリックされたタブを取り出し、現パネルを `direction: "col"` で分割、新 leaf を b (右) に作成 (= `splitTabIntoEdge(leafId, tabIdx, leafId, "right")`)。
- **下に分割**: 同様に `direction: "row"` で分割、新 leaf を b (下)。
- 「別パネルへ移動」サブメニューは廃止 (DnD で完全代替)。Phase 3b の TabContextMenu のうち「閉じる」「分割」だけ残し、「別パネルへ移動」リストはまるごと取り除く。

## 6. フロント側設計

### 6.1 ファイル構成

```
frontend/src/features/viewer-grid/
├── ViewerGrid.tsx          # (改修) GridToolbar 削除、Layout を再帰描画
├── Panel.tsx               # (改修) DnD onPointerDown でタブドラッグ開始、ドロップゾーン表示
├── TabBar.tsx              # (改修) 並び替え DnD ターゲット (タブ間の隙間) を追加
├── ImageView.tsx           # (変更なし)
├── GridSplitter.tsx        # (改修) recursive 配置に対応するよう props 形を見直し
├── TabContextMenu.tsx      # (改修) 「閉じる + 右に分割 + 下に分割」の 3 項目に縮小
├── DnDOverlay.tsx          # (新規) ドラッグ中のオーバーレイ + ヒットテスト
├── TabDragGhost.tsx        # (新規) ドラッグゴースト
├── layout.ts               # (新規) LayoutNode 型 + 純関数 (find/replace/collapse/enumerate)
├── layout.test.ts          # (新規) vitest: 純関数のユニットテスト
├── useTabs.ts              # (変更なし) Tab 型のみ
└── useViewerGrid.ts        # (大幅改修) Grid を Layout に置換、新操作 API
```

**削除**:
- `GridToolbar.tsx` (DnD で代替)

### 6.2 `useViewerGrid` 新 API

```ts
function useViewerGrid(opts?: {
  initialLayout?: Layout;
  confirm?: ConfirmFn;  // 残す。ただし v1 では「壊れた状態の復旧」用に握っておくだけで使わない可能性
}) {
  const [layout, setLayout] = useState<Layout>(opts?.initialLayout ?? initialLayout);

  return {
    layout,

    // ツリーから / 一覧タブから
    openInActive: (path: string) => Promise<void>,

    // パネル内アクション
    setActivePanel: (leafId: string) => void,
    setActiveTab:   (leafId: string, tabIndex: number) => void,
    closeTab:       (leafId: string, tabIndex: number) => void,
    updateTabState: (leafId: string, tabIndex: number, patch: Partial<Tab>) => void,

    // DnD operations
    moveTabIntoLeaf:   (srcId: string, srcIdx: number, dstId: string, dstIdx?: number) => void,
    reorderTab:        (leafId: string, srcIdx: number, dstIdx: number) => void,
    splitTabIntoEdge:  (srcId: string, srcIdx: number, dstId: string, edge: Edge) => void,

    // Splitter
    setSplitRatio:     (splitId: string, ratio: number) => void,
  };
}
```

### 6.3 純関数 (layout.ts) の責務分離

ツリー操作はすべて純関数として `layout.ts` に切り出し、`useViewerGrid` の `setLayout(prev => transform(prev, ...))` から呼ぶ:

```ts
export function findLeaf(root: LayoutNode, id: string): LeafNode | null;
export function findParent(root: LayoutNode, childId: string): SplitNode | null;
export function enumerateLeaves(root: LayoutNode): LeafNode[];
export function replaceNode(root: LayoutNode, targetId: string, replacement: LayoutNode): LayoutNode;
export function collapseEmptyLeaf(root: LayoutNode, leafId: string): LayoutNode;
export function updateLeaf(root: LayoutNode, id: string, fn: (l: LeafNode) => LeafNode): LayoutNode;
export function updateSplit(root: LayoutNode, id: string, fn: (s: SplitNode) => SplitNode): LayoutNode;
export function validateLayout(root: LayoutNode): string | null; // null = ok
```

これらは `O(N)` でツリーを走査する単純な再帰実装でよい (パネル数の上限が低いため)。

### 6.4 ViewerGrid 描画

ViewerGrid は LayoutNode を受け取って再帰的に描画する単一コンポーネント (or `RenderNode` ヘルパ):

```tsx
function RenderNode({ node, ...handlers }: Props) {
  if (node.kind === "leaf") {
    return <Panel leaf={node} {...handlers} />;
  }
  // SplitNode
  const isCol = node.direction === "col";
  return (
    <div className={`split split-${node.direction}`}
         style={isCol
           ? { display: "flex", flexDirection: "row" }
           : { display: "flex", flexDirection: "column" }}>
      <div style={{ flex: `${node.ratio} 1 0` }}>
        <RenderNode node={node.a} {...handlers} />
      </div>
      <GridSplitter direction={node.direction} splitId={node.id}
                    onChangeRatio={handlers.onSetSplitRatio} />
      <div style={{ flex: `${1 - node.ratio} 1 0` }}>
        <RenderNode node={node.b} {...handlers} />
      </div>
    </div>
  );
}
```

CSS Grid ではなく **Flexbox の入れ子** で実装する (BSP ツリーとの相性が良いため。Phase 3b の `grid-template-*` は廃止)。

## 7. セッション復元

### 7.1 Go state スキーマ (state.go)

`StateSchemaVersion` を `4` に上げる。`GridState` は **シリアライザブルなツリー表現** に置き換える:

```go
const StateSchemaVersion = 4

type StateData struct {
    Version       int          `json:"version"`
    RootPath      string       `json:"rootPath"`      // v1 leftover
    LeftPaneWidth int          `json:"leftPaneWidth"` // v1 leftover
    Window        WindowState  `json:"window"`
    Layout        LayoutState  `json:"layout"`        // ★ Grid の置き換え
    TopTab        string       `json:"topTab"`
    List          ListTabState `json:"list"`
}

type LayoutState struct {
    Root     LayoutNodeState `json:"root"`
    ActiveID string          `json:"activeId"`
}

// JSON 上は { "kind": "leaf" | "split", ... } のタグ付きユニオン。
// Go では一旦オブジェクトに全フィールドを持たせて kind で分岐する形 (簡素化)。
type LayoutNodeState struct {
    Kind      string             `json:"kind"`           // "split" | "leaf"
    ID        string             `json:"id"`

    // SplitNode のとき
    Direction string             `json:"direction,omitempty"` // "row" | "col"
    Ratio     float64            `json:"ratio,omitempty"`
    A         *LayoutNodeState   `json:"a,omitempty"`
    B         *LayoutNodeState   `json:"b,omitempty"`

    // LeafNode のとき
    Tabs        []TabState `json:"tabs,omitempty"`
    ActiveIndex int        `json:"activeIndex,omitempty"`
}

// TabState は Phase 3c の既存型を流用。
```

`Grid` フィールドは削除する。v3 以前は `s.Version != 4` で default fallback されるので、マイグレーションコードは書かない (今までの方針と整合)。

`validateState` の `Layout` 部分は次を満たさない場合 default に落とす:
- root が nil でない。
- 全ノードの kind が "split" / "leaf" のどちらか。
- split の ratio が `(0, 1)` の範囲。なければ 0.5 にクランプ (soft fix)。
- split の a / b がともに非 nil。
- ID がツリー内ユニーク (重複時はリセット)。
- activeId が leaf のいずれかを指す。指してなければ DFS 先頭 leaf に。
- TabState の zoom は Phase 3c と同じ soft-fix を leaf 内で適用。

### 7.2 useSessionSave (フロント)

`buildStateData` を新スキーマに合わせて書き換え。`grid` セクションを `layout` に置換。LayoutNode → LayoutNodeState への変換は `frontend/src/features/viewer-grid/layout.ts` 内に `serializeNode(node): LayoutNodeState` として実装。

### 7.3 useSessionLoad / App.tsx

`gridFromGridState` を `layoutFromLayoutState` に置換。逆変換 `LayoutNodeState → LayoutNode` を `layout.ts` の `deserializeNode` で実装。runtime 専用フィールド (`Tab.initialized` / `imageWidth` / `imageHeight`) は復元時に Phase 3c と同じ要領で再初期化 (`initialized: t.zoom > 0`)。

## 8. ビジュアル / インタラクション細則

### 8.1 ドロップゾーンの当たり判定

各 leaf キャンバスを 5 領域に分ける:
```
+---+---------------+---+
| L |      T        | R |
|   +---------------+   |
|   |               |   |
|   |    CENTER     |   |
|   |               |   |
|   +---------------+   |
| L |      B        | R |
+---+---------------+---+
```
- 横幅の 20% (左右各) が L / R 領域。
- 上下高さの 20% (上下各) が T / B 領域。
- 残り 60% × 60% が CENTER。
- 角は隣接する横/縦のうち、カーソル位置からの相対距離が短い方を採る (= L が T に勝つときと B に勝つときがある)。

タブバー上にカーソルがある場合は別判定 (= tab-bar drop) で、leaf キャンバスより優先する。

### 8.2 アニメーション

- 分割発生時のアニメーション: なし (簡素化)。
- ドロップゾーンインジケータの表示は、CSS opacity 100ms フェードイン程度。
- パネル折り畳み: アニメーションなし。

### 8.3 タブバー DnD (並び替え)

タブ間の隙間 6px に hit-zone を仕込む。カーソルが当たったら隙間に 2px の縦青ライン (CSS `::after`)。ドロップで並び替え or 挿入。

### 8.4 同一 tab を同一 leaf へドロップ (no-op)

- center drop: no-op。
- edge drop: 例外的に扱う必要があるか? → **同一 leaf 上の edge drop は no-op** とする。「自分自身を分割」は意味が無い。

### 8.5 ドラッグキャンセル

- pointer up が「ドラッグ可能領域 = leaf キャンバス + タブバー」の外で発火 → キャンセル。
- v1 では **キーボード操作 (Esc 含む) を提供しない** (Q8 (a) Phase H 持ち越し)。Esc キャンセルは Phase H で追加する。
- キャンセル時はレイアウトに変更を加えない。

## 9. 実装ステップ (作業順)

1. **layout.ts の純関数 + ユニットテスト**: ツリーへの全 mutation を純関数として書く。vitest で各関数を単独テスト (find / replace / collapse / serialize / deserialize / validate)。**まず先にここを固める**。
2. **state.go の v4 スキーマ + Go テスト**: 旧 GridState 削除、新 LayoutState 追加。round-trip + validate のテストを Phase 3c と同レベルで書く。
3. **useViewerGrid を Layout 駆動に書き換え**: 各 mutation はステップ 1 の純関数経由で。Phase 3b の `addRow` / `addCol` などは削除。
4. **ViewerGrid + Panel の再帰描画化 + Flexbox レイアウト**: GridToolbar 削除、CSS Grid → Flexbox に置換。GridSplitter は recursive 配置に対応。
5. **DnD オーバーレイ + ドロップゾーン UI 実装**: pointer events ベース。ドラッグゴースト + ヒットテスト + インジケータ。
6. **TabBar の並び替え DnD**: タブ間 hit-zone + 並び替え操作呼び出し。
7. **セッション復元の更新**: useSessionSave / useSessionLoad / App.tsx の gridFromGridState 系を Layout 用に置換。
8. **TabContextMenu の縮小**: 「閉じる + 右に分割 + 下に分割」の 3 項目に削減 (§5.6)。
9. **`wails build` + `wails dev` で実機確認**: §1 DoD を 1 個ずつ checkbox。
10. **ドキュメント更新**: `.claude/context.md` の §2 (現在のフェーズ) / §8 (ファイル構成) / §11 (パッケージ境界) / §12 (フロント feature 境界) / `docs/todo.md` の E.「タブ / ビューア」セクション更新。

## 10. テスト計画

### 10.1 vitest (純関数中心)

- `layout.test.ts`:
  - findLeaf / findParent / enumerateLeaves: 簡単なツリーで網羅。
  - replaceNode: ルート置換 / 中間置換 / 葉置換。
  - collapseEmptyLeaf: ルート単独 leaf は no-op、子 leaf 削除 → 兄弟が昇格、孫 leaf 削除 → 親 SplitNode が崩壊、兄弟が祖父の a/b に置き換わる、ratio は失われる。
  - serializeNode / deserializeNode: round-trip。
  - validateLayout: 各 invariant 違反を検出。
  - splitTabIntoEdge ヘルパ (4 方向): a/b の順序確認。

### 10.2 Go テスト

- `state_test.go`:
  - v4 round-trip (Layout 含む)。
  - v3 / v2 / v1 → default fallback。
  - validate での soft fix: ratio out of range → 0.5、activeId が指すノードなし → DFS 先頭 leaf。

### 10.3 手動 (`wails dev`)

§1 DoD のチェックを 1 項目ずつ。特に:
- 4-panel 非対称レイアウト (§5.1 の例) を再現できる。
- 起動 → 分割 → タブ移動 → アプリ再起動 → 同じレイアウト復元。
- 連打: タブを高速にドラッグ&ドロップしても crash しない。
- 大画像 (200MP 直前) で重い Panel を含むレイアウト分割中に UI が固まらない。

## 11. 決定事項

| # | トピック | 決定 |
|---|---------|------|
| Q1 | パネル数の上限 | **16**。`MAX_PANELS = 16` 定数を `useViewerGrid.ts` に置き、edge drop 発生時に DFS leaf 数 ≥ 16 ならドロップを no-op + トースト「パネル数の上限 (16) に達しました」。 |
| Q2 | TabContextMenu の扱い | **最小機能を残す**: 「閉じる」「右に分割」「下に分割」の 3 項目。「別パネルへ移動」は廃止。詳細 §5.6。 |
| Q3 | Splitter の最小サイズ | **`MIN_PX = 100` と `MIN_RATIO = 0.05` の両方** で clamp (§3.4 / §4.9)。 |
| Q4 | エッジドロップゾーンの幅 | **上下左右 20% / CENTER 60%×60%** (§8.1)。 |
| Q5 | DnD の実装方式 | **pointer events 自前** (§5.2)。HTML5 DnD は使わない。 |
| Q6 | アニメーション | **なし** (§8.2 のドロップゾーン fade-in 100ms のみ)。 |
| Q7 | レイアウトのプリセット | **なし**。 |
| Q8 | キーボード操作 | **Phase H 持ち越し**。v1 では Esc キャンセルも実装しない (§5.6 / §8.5)。 |
| Q9 | パネルが空になった場合の表示 | 空 leaf は **root のみ** プレースホルダ表示、それ以外は自動折り畳み (§4.4)。 |
| Q10 | DnD 中のアクティブパネル更新 | **ドロップ確定時のみ** 更新。hover 中は更新しない。 |

## 12. 影響範囲 / 既存機能との関係

### 12.1 init.md / todo.md / 既存 spec への影響

- **`init.md §2.3`** ペインの「3 分割以上」をスコープ外と明記している件 → 改定:「BSP ツリー + DnD による自由分割をサポート (パネル数上限 16)」。
- **`todo.md E3`** 「最大 2 行 × 3 列」 → 改定: 上限 16 パネル、`MAX_ROWS / MAX_COLS` 定数廃止、代わりに `MAX_PANELS = 16` 定数。
- **`docs/spec-tab-imageview-3b.md`** → 完全に上書き対象。本 spec が成立した時点で 3b の DoD §1 / データモデル §2 / UI 設計 §3 は本 spec で更新済みとし、`spec-tab-imageview-3b.md` 冒頭に「本仕様は spec-viewer-flexlayout で全面改定された」のリンクを追記する (削除はしない、履歴として残す)。
- **`docs/spec-tab-imageview-3c.md`** → 影響あり。GridState → LayoutState へのスキーマ変更を §7 で案として書いた。3c spec 冒頭に同様にリンクを追記。

### 12.2 アプリ層への影響

- `app.go` の Wails バインディング: GetState / SaveState は struct ごと TS 側で扱うので、Go の StateData に新 LayoutState を入れれば TS 型 (`state.LayoutState`) が自動生成される。コードに変更なし。
- `main.go`: 起動時 `loadState` の中身 (LayoutState) は不可視のまま。変更なし。
- `internal/imgread` / `internal/thumb` / `internal/classification`: 影響なし。

### 12.3 Phase 4 一覧タブとの結線

- `App.tsx` の `onOpenInViewer(filename)` 関数は `viewer.openInActive(...)` を呼ぶだけなので、新 API 名と整合させれば変更なし。

## 13. 受け入れ基準 (実機確認)

`wails dev` で次の操作を順に実行し、すべて期待通りに動くこと:

1. アプリ起動直後、ビューアタブが 1 パネル / 0 タブ / プレースホルダ表示。
2. 一覧タブから画像を選択 → 1 パネルにタブ追加 + ビューアタブに自動切替。
3. 同じ操作でもう 1 枚開く → 同パネルに 2 枚目のタブ。
4. タブを別のパネルへ移動 ... ではなく、まず分割を作る:タブを **下端** にドラッグ → 下に新パネルが現れ、ドラッグしたタブがそちらに移動。
5. 新パネルに別の画像を一覧から開く → 2 枚目のパネルに新タブ。
6. 上のパネルのタブを **下のパネルの右端** にドラッグ → 下のパネル内が左右分割され、新パネル (右側) にタブ移動。
7. § 5.1 の「左 2 段 + 右 1 段」レイアウトを再現できる。
8. Splitter をドラッグして比率変更できる (左右 / 上下とも、各レベル独立)。
9. 任意のパネルの最後のタブを閉じる → そのパネルが消滅し、兄弟が領域を吸収する。
10. アプリを `Ctrl+C` (or close) で閉じ、再度 `wails dev` で起動 → 同じレイアウト + タブ構成で復元される。
11. ドラッグ中にビューア領域外で pointer up → ドロップ確定せず、レイアウト無変更。
12. 画像のズーム / パン操作が引き続き動作 (Phase 3a 機能)。
13. 一覧タブとビューアタブの切替に伴うレイアウト消失なし。
14. タブを右クリック → 「閉じる / 右に分割 / 下に分割」のメニューが出て、いずれも期待通り動作。
15. 16 パネルまで分割した状態で、さらに edge drop しようとするとトーストで上限通知 + ドロップ無効化。
