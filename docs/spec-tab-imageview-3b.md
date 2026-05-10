# Tab + ImageView 実装仕様書 (Phase 3b)

> ⚠️ **本仕様は Phase 5 で全面改定された。** 現行の正本は [spec-viewer-flexlayout.md](spec-viewer-flexlayout.md)。本ファイルは履歴として残置。データモデル (rows×cols Grid) / UI (GridToolbar) / TabContextMenu の「別パネルへ移動」はすべて Phase 5 で置換 (BSP ツリー + DnD + 縮小コンテキストメニュー)。

Phase 3 の **第 2 段階**。ビューア領域 (右ペイン) を最大 2 行 × 3 列 = 6 パネルのグリッドに分割し、各パネルが独立した TabBar / ImageView を持つようにする。アクティブパネル概念を導入し、パネル間でタブを移動できるコンテキストメニューを実装する。Phase 3a の単一パネル実装をベースにリファクタする形で進める。セッション復元は Phase 3c に分離。

## 1. ゴール (DoD)

- ビューア領域が **1 行 × 1 列** で起動する (Phase 3a と同じ初期見た目)。
- グリッドツールバーで「行追加」「列追加」「行削除」「列削除」が可能。最大 2 行 × 3 列まで。
- 各パネルが独立した TabBar + ImageView を持つ。タブの zoom/pan 状態はパネルごとに独立。
- **アクティブパネル** が常に 1 つ存在し、視覚的にハイライト (枠線) 表示される。
- ツリーで画像をクリックすると、**アクティブパネル内** で重複検出 (todo.md E2 改定通り):
  - そのパスがアクティブパネルに既にあれば → そのタブにフォーカス
  - 無ければ → アクティブパネルに新規タブとして開く
  - 他のパネルに同じパスがあっても無関係
- タブを **右クリック** で「別パネルへ移動」サブメニューが出て、任意の他パネルへ移動できる。
- 行間 / 列間に **スプリッター** があり、ドラッグでパネルサイズを再配分できる。
- パネル削除時にタブが残っていたら **確認ダイアログ** を出す。
- `wails build` が通り、`wails dev` で操作確認できる。
- 既存の Phase 1〜3a 機能 (フォルダツリー、サムネポップアップ、ズーム/パン等) は劣化なし。

## 2. データモデル

### 2.1 主要型 (`hooks/useViewerGrid.ts`)

```ts
import type { Tab } from "./useTabs";  // Phase 3a の Tab 型を再利用

export type PanelCoord = { row: number; col: number };

export type Panel = {
  tabs: Tab[];
  activeIndex: number;  // -1 if no tabs
};

export type GridSize = {
  rows: number;  // 1..MAX_ROWS
  cols: number;  // 1..MAX_COLS
};

export type Grid = {
  size: GridSize;
  panels: Panel[];        // length = size.rows * size.cols, indexed by row * cols + col
  rowSizes: number[];     // ratios summing to 1.0, length = size.rows
  colSizes: number[];     // ratios summing to 1.0, length = size.cols
  active: PanelCoord;
};
```

**グリッド最大数の設定可能化 (将来対応)**:
```ts
// hooks/useViewerGrid.ts の冒頭に集約
// 将来 Phase H で設定画面 UI から変更できるよう、定数を 1 箇所にまとめる。
// 設定モジュール導入時はこの const を Settings struct から差し替えるだけで済む。
export const MAX_ROWS = 2;
export const MAX_COLS = 3;
```

`addRow` / `addCol` の有効判定はこの定数を参照する形で書く。`GridSize.rows` / `cols` の TS 型は `number` (リテラル合併ではなく) にしておくことで、将来の最大値変更時に型を直す必要がない。

### 2.2 ヘルパ

```ts
const panelIndex = (size: GridSize, c: PanelCoord): number => c.row * size.cols + c.col;
const panelAt    = (grid: Grid, c: PanelCoord): Panel => grid.panels[panelIndex(grid.size, c)];
const allCoords  = (size: GridSize): PanelCoord[] => /* 全座標を [{0,0}, {0,1}, ...] の順で返す */;
```

### 2.3 初期状態

```ts
const initialGrid: Grid = {
  size: { rows: 1, cols: 1 },
  panels: [{ tabs: [], activeIndex: -1 }],
  rowSizes: [1.0],
  colSizes: [1.0],
  active: { row: 0, col: 0 },
};
```

### 2.4 Tab 型 (Phase 3a 既存、変更なし)

```ts
export type Tab = {
  path: string;
  zoom: number;
  panX: number;
  panY: number;
  initialized: boolean;
  imageWidth: number;
  imageHeight: number;
};
```

## 3. UI / UX 設計

### 3.1 全体レイアウト (右ペイン)

```
┌───────────────────────────────────────────────────────────────┐
│ [+ 行] [+ 列] [- 行] [- 列]                                   │ ← GridToolbar
├───────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────┬───────────────────────────────┐   │
│ │ [Tab1] [Tab2]           │ [TabA]                        │   │
│ │ ╭─────────────────────╮ │ ╭───────────────────────────╮ │   │
│ │ │      ImageView      │ │ │         ImageView         │ │   │
│ │ │   (active panel)    │ │ │                           │ │   │
│ │ ╰─────────────────────╯ │ ╰───────────────────────────╯ │   │
│ ├─────────────────────────┼───────────────────────────────┤   │
│ │ ▍▍ (col splitter)       │ ▍▍                            │   │
│ ├═════════════════════════╪═══════════════════════════════┤   │
│ │ (row splitter)          │                               │   │
│ │ ╭─────────────────────╮ │ ╭───────────────────────────╮ │   │
│ │ │      ImageView      │ │ │         ImageView         │ │   │
│ │ ╰─────────────────────╯ │ ╰───────────────────────────╯ │   │
│ └─────────────────────────┴───────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

要素:
- **GridToolbar**: 上部 28px の細い帯。4 つの小さなボタン (`+ 行` / `+ 列` / `- 行` / `- 列`)
- **PanelGrid**: 残りの領域全体。CSS Grid で `grid-template-rows`/`grid-template-columns` を `colSizes`/`rowSizes` で指定 (例: `grid-template-columns: 1fr 1.5fr;`)
- **Panel**: 個別パネル。TabBar + ImageView を内包。アクティブ時は周囲に 2px の青枠
- **Splitter**: 行間と列間に挟まれる 4px のドラッグ可能領域 (既存の `.splitter` を流用 / 拡張)

### 3.2 GridToolbar 操作

| ボタン | 有効条件 | 動作 |
|--------|---------|------|
| `+ 行` | `rows < MAX_ROWS` | 一番下に空の行を追加。新しい行の各セルは空 Panel。 `rowSizes` は等分にリセット (簡単な v1 仕様) |
| `+ 列` | `cols < MAX_COLS` | 一番右に空の列を追加。各行に空 Panel を 1 個ずつ追加。 `colSizes` は等分にリセット |
| `- 行` | `rows > 1` | 一番下の行を削除。タブが残っているパネルがあれば確認ダイアログ |
| `- 列` | `cols > 1` | 一番右の列を削除。タブが残っているパネルがあれば確認ダイアログ |

無効ボタンは disabled 表示 (グレーアウト)。

確認ダイアログ:
- `window.confirm("X 個のタブが閉じられます。続行しますか?")` を v1 では使う (Wails のネイティブダイアログは使わない、シンプル優先)

行/列削除でアクティブパネルが消える場合:
- アクティブを `(0, 0)` に戻す

### 3.3 アクティブパネルの表示 / 切替

- アクティブパネルは CSS `box-shadow: inset 0 0 0 2px #007acc` (内側 2px の青枠)
- 切替トリガ:
  - パネル内の任意のクリック (TabBar / ImageView / 空状態プレースホルダ)
  - パネル内のホイール操作 (ズーム時もアクティブ化したい)

### 3.4 タブ右クリック → 移動メニュー

タブを右クリック (`contextmenu` イベント) すると、以下のメニューが出る:

```
┌──────────────────────┐
│ 閉じる                │
├──────────────────────┤
│ 別パネルへ移動 →      │
│   行1 列1            │
│   行1 列2            │
│   行2 列1            │
│   ...                │
└──────────────────────┘
```

- 「閉じる」: そのタブを閉じる (タブの × と同じ)
- 「別パネルへ移動」: グリッドが 1 パネルのみのときは表示しない。複数パネルあれば、自分以外の全パネルが座標表記で並ぶ。クリックで移動実行
- メニューはカスタム React コンポーネントで実装 (ブラウザ既定の右クリックメニューは `e.preventDefault()` で抑止)
- メニュー外をクリック / Esc で閉じる

### 3.5 タブ移動の挙動

`moveTab(srcCoord, srcIndex, dstCoord)`:
1. ソースパネルから tab を取り出す (zoom/pan 状態込み)
2. 宛先パネルに同じ path のタブが既にあるか検査
   - **あれば**: 宛先パネルの該当タブにフォーカスを移し、ソースタブは破棄 (重複統合)
   - **なければ**: 宛先パネルの末尾に append し、その新タブをアクティブにする
3. ソースパネルから tab を削除し、ソースの `activeIndex` を再計算 (Phase 3a `closeTab` と同じロジック)
4. アクティブパネルを宛先パネルに切替

### 3.6 ツリーから画像オープン (E2 改定通り)

`openInActive(path)`:
1. アクティブパネルを取得
2. アクティブパネル内に同 path のタブがあれば → そのタブを active にする
3. なければ → 末尾に新タブを追加し、その新タブを active にする
4. 他のパネルは触らない

### 3.7 スプリッター

- **列スプリッター**: 各列の境界に縦長 4px の領域。ドラッグで `colSizes` を再配分 (隣接 2 列のみ影響)
- **行スプリッター**: 各行の境界に横長 4px の領域。ドラッグで `rowSizes` を再配分
- 最小サイズ: 100px (パネルが潰れないため)
- ホバーで色変化 (既存 `.splitter:hover` と同じ青)

実装方針:
- スプリッターは `position: absolute` ではなく、CSS Grid のセル間に `grid-template` の固定サイズトラックとして埋め込む
- 例: `grid-template-columns: ${col0}fr 4px ${col1}fr 4px ${col2}fr;`
- ドラッグ時は親 grid の getBoundingClientRect でコンテナ幅を取得し、ドラッグ移動量から比率を更新

## 4. フロント側設計

### 4.1 ファイル追加 / 更新

```
frontend/src/
├── App.tsx                       # useTabs → useViewerGrid に置換、ViewerPanel → ViewerGrid に置換
├── components/
│   ├── ViewerGrid.tsx            # (新規) GridToolbar + PanelGrid を統括、置換: ViewerPanel
│   ├── GridToolbar.tsx           # (新規) [+ 行] [+ 列] [- 行] [- 列] ボタン
│   ├── Panel.tsx                 # (新規) 1 パネル分: TabBar + ImageView + active highlight
│   ├── GridSplitter.tsx          # (新規) 行 / 列スプリッター
│   ├── TabContextMenu.tsx        # (新規) 右クリック時の移動メニュー
│   ├── TabBar.tsx                # (更新) onContextMenu prop を追加して TabBar 経由で受ける
│   ├── ImageView.tsx             # (更新) パネルアクティブ化フックを呼べるように onActivate prop を追加
│   └── ViewerPanel.tsx           # 削除 (ViewerGrid + Panel に置換)
├── hooks/
│   ├── useTabs.ts                # 廃止予定 (useViewerGrid 内に取り込む)。Tab 型のみ export し続ける
│   └── useViewerGrid.ts          # (新規) Grid 全体の状態管理
└── icons/
    ├── PlusIcon.tsx              # (新規) [+ 行/列] 用
    └── MinusIcon.tsx             # (新規) [- 行/列] 用
```

`useTabs.ts` は完全廃止せず、`Tab` 型と `newTab` ファクトリだけ export する形に縮小する (再利用のため)。

### 4.2 `useViewerGrid` API

```ts
function useViewerGrid() {
  const [grid, setGrid] = useState<Grid>(initialGrid);

  return {
    grid,
    // ツリーから呼ばれる
    openInActive: (path: string) => void,

    // パネル内アクション
    setActivePanel: (coord: PanelCoord) => void,
    setActiveTab:   (coord: PanelCoord, tabIndex: number) => void,
    closeTab:       (coord: PanelCoord, tabIndex: number) => void,
    updateTabState: (coord: PanelCoord, tabIndex: number, patch: Partial<Tab>) => void,

    // タブ移動
    moveTab: (srcCoord: PanelCoord, srcIndex: number, dstCoord: PanelCoord) => void,

    // グリッド操作
    addRow:    () => void,
    removeRow: () => void,    // タブあり時は内部で confirm
    addCol:    () => void,
    removeCol: () => void,

    // スプリッター
    setRowSizes: (sizes: number[]) => void,
    setColSizes: (sizes: number[]) => void,
  };
}
```

### 4.3 コンポーネント階層

```
<App>
  └ <ViewerGrid grid actions />
       ├ <GridToolbar size onAddRow onAddCol onRemoveRow onRemoveCol />
       └ <div className="panel-grid" style={{gridTemplate: ...}}>
            ├ <Panel coord panel isActive ... /> × N
            ├ <GridSplitter direction="col" indices={[i, i+1]} ... /> × (cols-1)
            └ <GridSplitter direction="row" indices={[i, i+1]} ... /> × (rows-1)
       └ <TabContextMenu ... />  (絶対配置で 1 つだけ存在、状態に応じて描画)
```

`<Panel>` の中身 (Phase 3a の `<ViewerPanel>` を簡素化):
```tsx
<div className={`panel ${isActive ? "active" : ""}`} onMouseDown={onActivate}>
  {tabs.length > 0 && <TabBar ... onContextMenu={openContextMenuFor} />}
  <div className="panel-canvas">
    {activeTab ? <ImageView .../> : <div className="panel-empty">画像を選択</div>}
  </div>
</div>
```

### 4.4 タブの右クリックメニュー

- TabBar が `onContextMenu` event を受け取り、ViewerGrid に「どのパネルのどのタブで右クリックされたか + クリック座標」を通知
- ViewerGrid が `<TabContextMenu>` を `position: fixed` で表示
- メニュー項目クリックで `moveTab` を呼ぶ
- メニュー外クリック / Esc で閉じる

### 4.5 active panel ハイライト

CSS:
```css
.panel { position: relative; display: flex; flex-direction: column; min-width: 100px; min-height: 100px; }
.panel.active::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 0 2px #007acc;
  z-index: 10;
}
```

### 4.6 grid-template の組み立て

```ts
function buildGridTemplate(sizes: number[]): string {
  // sizes = [0.4, 0.6] → "0.4fr 4px 0.6fr"
  return sizes.map((s, i) => i === 0 ? `${s}fr` : `4px ${s}fr`).join(" ");
}

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateRows: buildGridTemplate(grid.rowSizes),
  gridTemplateColumns: buildGridTemplate(grid.colSizes),
  height: "100%",
};
```

スプリッターはこの 4px トラックに `grid-row` / `grid-column` で位置指定して配置する。

### 4.7 アクティブパネル切替トリガ

`<Panel>` のルート要素に `onMouseDown={() => setActivePanel(coord)}` を付与する。click ではなく mousedown にしておくことで、ImageView でドラッグを始める前にアクティブ化が反映される。

### 4.8 スプリッター実装

`GridSplitter` props: `{ direction: "row" | "col", index: number, sizes: number[], setSizes: (s: number[]) => void }`

ドラッグ中の挙動:
- mousedown でドラッグ開始 (記憶: 初期マウス位置 + 初期 sizes 配列)
- mousemove で `delta = (currentMouse - startMouse) / containerSize` を計算
- `newSizes[index] = oldSizes[index] + delta`
- `newSizes[index+1] = oldSizes[index+1] - delta`
- 最小サイズ (100px / containerSize に相当する比率) を下回らないようクランプ
- `setSizes(newSizes)` を呼ぶ
- mouseup でドラッグ終了

実装は Phase 0 の左右ペインスプリッターと同じパターンで OK。

## 5. グリッド操作の詳細

### 5.1 `addRow`

```
if (rows >= 2) return;
新しい panels = 既存 + 新規列分 (size.cols 個の空 Panel)
新しい size = { rows: rows + 1, cols }
新しい rowSizes = 等分配列 (新サイズで [1/n, 1/n, ...])  // 既存比率は捨てる、簡素化
```

### 5.2 `removeRow`

```
if (rows <= 1) return;
削除対象 = 最後の行 (row = rows - 1)
削除対象内のタブ総数 = panels[lastRow][*].tabs.length の合計
if (タブ総数 > 0) {
  if (!window.confirm(`${タブ総数} 個のタブが閉じられます。続行しますか?`)) return;
}
新しい panels = 最後の行を除く
新しい size = { rows: rows - 1, cols }
新しい rowSizes = 等分配列にリセット
新しい active = (active.row が削除されたなら (0, active.col)、そうでなければそのまま)
```

### 5.3 `addCol` / `removeCol`

`addRow` / `removeRow` と対称な処理。

### 5.4 等分リセット方針について

- `addRow/Col` / `removeRow/Col` 直後は `rowSizes/colSizes` を等分にリセットする
- ユーザーは追加直後にスプリッターをドラッグして好みのサイズに調整する
- これは Phase 3b の簡素化方針 (前回の比率を保持しようとすると複雑)。Phase 後ろ倒しで「リサイズ時に既存比率を保つ」改善も可能

### 5.5 `moveTab` 詳細

```ts
function moveTab(srcCoord, srcIndex, dstCoord) {
  if (samePanelCoord(srcCoord, dstCoord)) return;  // 同パネル内移動は何もしない (3b ではタブ並び替えなし)
  const srcPanel = panelAt(grid, srcCoord);
  const dstPanel = panelAt(grid, dstCoord);
  const tab = srcPanel.tabs[srcIndex];

  // 重複検出
  const existingIdx = dstPanel.tabs.findIndex(t => t.path === tab.path);

  let newDstTabs: Tab[];
  let newDstActiveIndex: number;
  if (existingIdx >= 0) {
    // 宛先に同じパスがある: そのタブをアクティブに、ソースは破棄
    newDstTabs = dstPanel.tabs;
    newDstActiveIndex = existingIdx;
  } else {
    // 末尾に追加してアクティブに
    newDstTabs = [...dstPanel.tabs, tab];
    newDstActiveIndex = newDstTabs.length - 1;
  }

  // ソースから削除 + activeIndex 補正
  const newSrcTabs = srcPanel.tabs.filter((_, i) => i !== srcIndex);
  const newSrcActive = recomputeActiveAfterClose(srcPanel.activeIndex, srcIndex, newSrcTabs.length);

  // panels 配列を更新、active を dstCoord に
  setGrid(...);
}
```

## 6. ビルド / 生成手順

1. `useViewerGrid.ts` を新規作成 (Tab 型は `useTabs.ts` から import)
2. `useTabs.ts` を縮小 (Tab 型と newTab だけ残す)
3. 新規コンポーネント (ViewerGrid / GridToolbar / Panel / GridSplitter / TabContextMenu) を作成
4. 既存コンポーネント (TabBar / ImageView / App.tsx) を更新
5. CSS 追加 (panel-grid / panel / panel.active / context-menu / grid-toolbar)
6. `wails build` で動作確認 (Go 側変更なし、バインディング再生成不要)

## 7. テスト方針

### 7.1 Go 側

変更なし。Phase 1〜3a のテストがそのまま通ること。

### 7.2 フロント側

v1 ではテスト未導入 (todo.md J 未確定)。`useViewerGrid` のロジックは複雑になるが、目視確認で済ませる。Phase 3c 着手時に Vitest 導入を再検討する余地あり。

## 8. スコープ外 (Phase 3b では作らない)

- セッション復元 → Phase 3c
- パネル内タブの並び替え (DnD で順序変更) → todo.md E3 通り v1 後回し
- DnD によるタブ移動 (右クリックメニューのみ) → 将来検討
- グリッド形状変更時の `rowSizes/colSizes` 比率保持 → 等分リセットで簡素化
- パネルの最小化 / 最大化 → スコープ外
- 各パネル独立のキーボードショートカット → todo.md H 全体で検討
- **グリッド最大数の設定 UI** → 現状 `MAX_ROWS = 2` / `MAX_COLS = 3` で固定。設定画面 UI は Phase H。`useViewerGrid.ts` の冒頭定数を Settings 由来に差し替える設計にしておく

## 9. 完了条件チェックリスト

実装完了 (2026-04-26、`wails build` 通過)。実機での `wails dev` 操作確認はユーザーで実施。

- [x] グリッドが初期 1×1 で起動し、Phase 3a と同じ見た目 (`initialGrid` in `useViewerGrid.ts`)
- [x] `[+ 行]` / `[+ 列]` でグリッドが拡張 (最大 `MAX_ROWS=2` × `MAX_COLS=3`、定数化済み)
- [x] `[- 行]` / `[- 列]` でグリッドが縮小、無効時は disabled 表示 (`GridToolbar` の `canAddRow` 等)
- [x] パネル削除時にタブが残っていれば confirm が出る (`removeRow` / `removeCol` の `window.confirm`)
- [x] アクティブパネルが青枠でハイライトされる (`.panel.active::after` の `box-shadow: inset`)
- [x] パネル内のクリックでアクティブが切り替わる (`<Panel>` の `onMouseDown={() => onActivate(coord)}`)
- [x] ツリー画像クリック → アクティブパネルに開く / 既存タブにフォーカス (`useViewerGrid.openInActive`)
- [x] 異なるパネルで同じ画像を別タブとして開ける (`openInActive` はアクティブパネル内のみで重複検査)
- [x] タブを右クリック → 「別パネルへ移動」メニューが出る (`TabContextMenu`、ブラウザ既定は `preventDefault`)
- [x] 移動先パネルに同じパスがあれば既存タブにフォーカス、無ければ新タブで追加 (`useViewerGrid.moveTab`)
- [x] 行 / 列のスプリッターをドラッグでパネルサイズが変わる (`GridSplitter` + 100px 最小クランプ)
- [x] 各パネルの zoom/pan は独立に保持される (各 Panel の `tabs[]` は独立)
- [x] 既存の Phase 1〜3a 機能がそのまま動く (`TabBar` の中クリッククローズ + ホイール横スクロールも維持)
- [x] `wails build` 成功
- [x] Go 側ユニットテストがパス (変更なし、25 ケース全パス)
- [x] グリッド最大数 (`MAX_ROWS` / `MAX_COLS`) は `useViewerGrid.ts` 冒頭に集約。Phase H で設定 UI 化する境界が確定

完了したら todo.md の E3 (パネル分割 + タブ移動部分)、E2 (パネル別重複検出) の実装根拠が揃う。E4 (セッション復元) は Phase 3c で扱う。
