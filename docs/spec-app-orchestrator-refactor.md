# App.tsx トップレベル状態管理分離 実装仕様書 (#67)

`frontend/src/App.tsx` (現行 819 行) に集約されている初期 hydration / window
polling / global keybindings / viewer rename / list→viewer wiring / top-tabs UI /
ViewerTab サブコンポーネントを **責務単位で分離** し、`App.tsx` 本体を
orchestrator (子フック呼び出し + JSX 並べ替え) に縮小する。挙動は完全互換、
既存テストは無修正で通過させる。

> **ステータス**: 実装完了。Phase 単一 PR / 8 commit 構成
> (prep → window-polling → global-keybindings → viewer-rename → list-to-viewer
> → viewer-tab → top-tabs-bar → doc-followup) で実装。App.tsx は 819 → 282 行。
> §6 確定事項は §0 改訂履歴に追記済み。

---

## 0. 改訂履歴

| 更新日 | 主な変更 |
|--------|---------|
| 2026-05-23 | 初版ドラフト。#66 (useClassification リファクタ) で確立した「軽量子フック分離 + orchestrator 集約」パターンを踏襲。 |
| 2026-05-23 | §6 Q1-Q8 をすべて推奨案で確定 (ユーザー合意)。実装着手。 |
| 2026-05-23 | 実装完了。App.tsx 819 → 282 行 (目安 ~200 行 ±50 行の上限近く、ヘッダコメント込み)。新規 6 ファイル: `src/TopTabsBar.tsx` / `src/useGlobalKeybindings.ts` / `src/topTab.ts` / `features/session/useWindowGeometryPolling.ts` / `features/viewer-grid/{ViewerTab.tsx, useViewerRename.ts, useListToViewerHandlers.ts}`。`viewers.ts` 拡張: `hydrateInitialViewerSet` / `countLeafTabs`。`.claude/context.md` §8 / §12 を本リファクタの構造で更新済み。 |

---

## 1. ゴール (DoD)

- `App.tsx` (現行 819 行) を **責務別に複数モジュールへ分割**。
  本体は orchestrator として「初期 hydration → 子フック呼び出し → JSX 並べ替え」のみを担い、大幅に縮小する。
- 既存テスト (vitest 全件 + `tsc --noEmit` + `go test ./...` + `go vet ./...`) が
  **無修正で通過**。
- UI 挙動は **完全互換**:
  - トップタブ切替 (一覧 / ビューア × N) / `+` / 設定歯車 / viewer rename / viewer reorder DnD
  - Global keybindings: `Ctrl+W` / `Ctrl+Tab` / `Ctrl+0/1/±` / `Ctrl+Shift+1..9`
  - Window geometry / maximized state の永続化 (#86) と 2s polling
  - settings → モジュール setter / `--ui-scale` の即時反映
  - 一覧 → viewer の単一 / バルク open 系
  - confirm dialog / toast の表示
- AGENTS.md H-6 (ドキュメント追従): `.claude/context.md` §8 / §12 の「`App.tsx`: 唯一の複数 feature オーケストレーション層」の説明が、本リファクタ後の構造を正しく反映するよう更新する。
- 各分離モジュールに「責務 / どの state / ref に依存しているか / なぜ独立フックに切り出せたか」を 1 段落のヘッダコメントで明示 (AGENTS.md A-2 / A-3)。

### Non-Goals

- 公開 API (`App.tsx` の default export) のリネーム / 増減。
- `useClassification` / `useViewerSet` / `useSessionLoad/Save` / `useSettings` の API 変更。
- `App.css` の分割 (= 別 issue 候補)。className 参照を変えないことで並行可能にする。
- 新機能 / IPC / 永続化形式の追加。
- 既存テストの書き換え。
- Window polling や global keybindings の **設計変更** (interval / fallback の値変更や、events への置換)。本リファクタは「同じ挙動を hook に括り出すだけ」。

---

## 2. 用語

- **orchestrator**: 複数 feature を組み立てる UI 層 (本件では `App.tsx`)。子フックの呼び出し + 子コンポーネントへの props 配線 + JSX 並べ替えに専念する。
- **子フック**: 1 つの責務 (window polling / global keybindings / viewer rename / list→viewer wiring) を持つ局所 hook。orchestrator から呼び出される。
- **shared state**: orchestrator が宣言し、子フック / 子コンポーネントに props で渡す state (`topTab` / `viewer` / `classification` / `settings` / `windowState` / `editingViewerId` 等)。

---

## 3. 現状把握

### 3-1. 現行 `App.tsx` のセクション内訳 (819 行)

| 行範囲 | 内容 |
|--------|------|
| 1-53 | imports + side-effect 初期化 (`installGlobalErrorHandlers` / module-load log) |
| 59-69 | `App` (ToastProvider + useSessionLoad 待ち) |
| 71-95 | initial ViewerSet hydration (useMemo) |
| 97-108 | settings / settingsOpen / logPath state |
| 110-120 | settings 副作用 (tag colors / thumbnail params) |
| 122-139 | useViewerSet / useClassification の組み立て |
| 141-146 | listScrollTopRef |
| 148-244 | **WindowGeometry polling** (windowState + 単一 effect、~90 行) |
| 246-252 | useSessionSave |
| 254-345 | **Global keybindings** (refs 同期 + 単一 effect、~90 行) |
| 347-354 | onSelectList / onSelectViewer |
| 356-370 | viewerList memo (id+name signature) |
| 372-397 | onAddViewer / closeViewerWithConfirm |
| 399-421 | viewer rename state + handlers |
| 423-460 | list → viewer wiring (3 handlers) |
| 462-468 | UI scale 副作用 (`--ui-scale` CSS 変数) |
| 470-483 | viewer reorder DnD (useViewerTabReorder + dragSrcIdx/dragInsertIdx 派生) |
| 485-609 | JSX (top-tabs nav + content + dialog) |
| 614-803 | **ViewerTab サブコンポーネント** (~190 行) |
| 807-819 | `countLeafTabs` ヘルパ |

### 3-2. shared state / refs の依存関係 (= 分割境界の制約)

| state / ref | 読み書きする経路 |
|-------------|------------------|
| `topTab` / `setTopTab` | App-render / onSelectList / onSelectViewer / onAddViewer / onOpenInViewer 系 / global keybindings |
| `viewer` (useViewerSet 戻り値) | App-render / onSelectViewer / onAddViewer / closeViewerWithConfirm / open 系 / global keybindings / viewerSig / reorder DnD |
| `viewerRef` | global keybindings (live 参照) |
| `topTabRef` / `settingsOpenRef` | global keybindings (live 参照) |
| `settings.data` | tag colors / thumbnail 副作用 / `--ui-scale` / open 系 (maxImagePixels) |
| `settingsOpen` / `setSettingsOpen` | App-render / global keybindings (Esc 抑止) |
| `editingViewerId` / setter | ViewerTab / startRename/stopRename/commitRename / reorder DnD (anyRenaming) |
| `windowState` | useSessionSave |
| `classification.folderPath` | list → viewer wiring |
| `confirm` (useConfirm) | closeViewerWithConfirm / classification |

→ 完全独立に切り出せるのは **WindowGeometry polling** と **ViewerTab** のみ。
他は何らかの shared state を介して結合する (子フックには props で渡す)。

---

## 4. 分割粒度の選択肢

### 案 A: WindowGeometry polling + ViewerTab だけ分離 (最小)

- 単一 effect で巨大化している部分だけ抽出し、残りは App.tsx に据え置く。
- メリット: 変更が最小、レビュー差分が小さい。
- デメリット: rename / list→viewer wiring / keybindings は inline のまま残り、App.tsx は ~600 行に留まる。issue 本文 (「専用フック / モジュールへ分離して複雑度を下げたい」「モーダル / 通知制御を責務単位で整理」) の意図を満たしきれない。

### 案 B: 軽量子フック分離 + TopTabsBar コンポーネント抽出 (推奨)

- 子フック単位 / コンポーネント単位でファイルを分け、shared state / setter を props で引き渡す。App.tsx は orchestrator。
- 分割案:
  ```
  frontend/src/
    App.tsx                                       // orchestrator (大幅縮小)
    TopTabsBar.tsx                                // top-tabs nav 全体
    useGlobalKeybindings.ts                       // Ctrl+W/Tab/0/1/±/Shift+1..9
    features/
      session/
        useWindowGeometryPolling.ts               // windowState polling
      viewer-grid/
        ViewerTab.tsx                             // viewer タブ表示 (rename / drag / close)
        useViewerRename.ts                        // editingViewerId + handlers
        useListToViewerHandlers.ts                // open in viewer / many tabs / many split
        viewers.ts                                // countLeafTabs / hydrateInitialViewerSet を追加
  ```
- メリット: ファイル粒度で責務が明確、認知負荷が下がる。`useGlobalKeybindings` は将来テストを書く際の単位にもなる (Ctrl+Shift+N の境界条件など)。
- デメリット: ファイル数が増える (新規 6 ファイル + viewers.ts 拡張)。shared state の props 渡しが冗長 (5-10 個)。

### 案 C: Context-based 分離

- `AppContext` を作って state / refs / setters を共有、子フックは context から取得。
- メリット: props 渡しが消える。
- デメリット: provider 一段増える / 個人開発で hook 1 つのために context を導入するのは過剰。本件は #66 と同じく **不採用**。

### 推奨

**案 B (軽量子フック分離 + TopTabsBar コンポーネント抽出)**。理由:

1. issue #67 の文言「専用フック / モジュールへ分離」「モーダル / 通知制御を責務単位で整理」を素直に満たす。
2. #64 (SettingsDialog 分割) / #65 (useViewerSet 分割) / #66 (useClassification 分割) で同じパターンが確立済み。一貫性を保つ。
3. WindowGeometry polling (~90 行) / Global keybindings (~90 行) / ViewerTab (~190 行) はそれぞれ単体で十分な規模があり、個別ファイル化の価値が高い。
4. shared state は props で明示的に渡すので「どの子フックがどの state を読むか」が型シグネチャに現れる (案 A の暗黙参照より追跡しやすい)。

---

## 5. 提案する分割構造 (案 B 詳細)

### 5-1. orchestrator `App.tsx` (縮小後の責務)

責務:
- 永続状態から初期値を組み立てる (`useSessionLoad` の結果から ViewerSet / topTab を hydrate)。
- すべての useState / useRef を **本体で宣言**して子フック / 子コンポーネントに props で渡す。
- 各子フックを呼び出し、戻り値を子コンポーネント (TopTabsBar / ClassificationView / ViewerGrid / SettingsDialog) に配線する。
- 副作用 hook (settings → tag colors / thumbnail / `--ui-scale`、useSessionSave) を呼び出す。
- ToastProvider / useConfirm の境界。

JSX は以下の構造に縮小する:

```tsx
<div className="app-toplevel">
  <TopTabsBar
    topTab={topTab}
    onSelectList={onSelectList}
    onSelectViewer={onSelectViewer}
    viewer={viewer}
    rename={rename}
    reorder={tabReorder}
    onAddViewer={onAddViewer}
    onCloseViewer={closeViewerWithConfirm}
    onOpenSettings={() => setSettingsOpen(true)}
  />
  <div className="top-tab-content">
    {topTab === "list" ? (
      <ClassificationView ... />
    ) : (
      <ViewerGrid ... />
    )}
  </div>
  <SettingsDialog ... />
  {confirmDialog}
</div>
```

擬似コード (シグネチャ方針の提示、実装ではない):

```tsx
function AppInner({ initialState }: AppInnerProps) {
  // ── initial hydration ─────────────────────────────────────
  const initialSet = useMemo<ViewerSet>(
    () => hydrateInitialViewerSet(initialState),
    [initialState],
  );
  const initTopTab: TopTab = initialState?.topTab === "viewer" ? "viewer" : "list";
  const [topTab, setTopTab] = useState<TopTab>(initTopTab);

  // ── shared state hubs ─────────────────────────────────────
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logPath, setLogPath] = useState("");
  useEffect(() => { GetLogPath().then(setLogPath).catch(() => setLogPath("")); }, []);
  const { confirm, dialog: confirmDialog } = useConfirm();

  // ── settings side-effects (tag colors / thumbnail / ui scale) ─
  useEffect(() => { /* setKnownTagColors + setThumbnailParams */ }, [settings.data]);
  useLayoutEffect(() => { /* document.documentElement.style.setProperty("--ui-scale", ...) */ }, [...]);

  // ── core feature hooks ────────────────────────────────────
  const maxImagePixels = settings.data?.maxImagePixelsMP != null
    ? settings.data.maxImagePixelsMP * 1_000_000 : DEFAULT_MAX_PIXELS;
  const viewer = useViewerSet({ initialSet, maxImagePixels });
  const classification = useClassification({ ... });
  const listScrollTopRef = useRef(0);

  // ── window geometry polling ───────────────────────────────
  const windowState = useWindowGeometryPolling({ initial: initialState?.window });

  // ── session save ──────────────────────────────────────────
  useSessionSave({ window: windowState, viewers: viewer.viewers, ... });

  // ── viewer rename (inline edit) ───────────────────────────
  const rename = useViewerRename({ renameViewer: viewer.renameViewer });

  // ── list → viewer wiring ──────────────────────────────────
  const openHandlers = useListToViewerHandlers({
    folderPath: classification.folderPath,
    viewer,
    setTopTab,
  });

  // ── global keybindings ────────────────────────────────────
  useGlobalKeybindings({
    topTab, setTopTab, viewer, settingsOpen,
  });

  // ── top-tab handlers ──────────────────────────────────────
  const onSelectList = useCallback(() => setTopTab("list"), []);
  const onSelectViewer = useCallback((viewerId: string) => {
    viewer.setActiveViewer(viewerId);
    setTopTab("viewer");
  }, [viewer]);
  const onAddViewer = useCallback(() => {
    viewer.addViewer();
    setTopTab("viewer");
  }, [viewer]);
  const closeViewerWithConfirm = useCallback(async (viewerId: string) => {
    /* ... countLeafTabs + confirm + viewer.closeViewer */
  }, [confirm, viewer]);

  // ── reorder DnD ───────────────────────────────────────────
  const tabReorder = useViewerTabReorder({
    count: viewer.viewers.length,
    onReorder: viewer.reorderViewer,
  });

  // ── viewerList (id+name signature memo) ───────────────────
  const viewerList = useMemo(() => viewer.viewers.map(v => ({ id: v.id, name: v.name })),
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
    [viewer.viewers.map(v => `${v.id}:${v.name}`).join("|")]);

  return (/* JSX 上掲 */);
}
```

縮小後の目安: **~200 行** (現在 ~610 行)。`hydrateInitialViewerSet` (10 行) /
ViewerTab (190 行) / countLeafTabs (12 行) / WindowGeometry polling (90 行) /
Global keybindings (90 行) / Viewer rename (20 行) / List→viewer wiring (40 行) /
TopTabsBar JSX (90 行) を外に出す合計 ~540 行が削減見込み。実装してみて
±50 行のズレは許容。

### 5-2. 子フック / 子コンポーネントの責務

#### `useWindowGeometryPolling` (`features/session/`)

- 入力 props: `{ initial?: WindowState | null }` (state.json から読み込んだ初期値)
- 戻り値: `{ width, height, x, y, maximized }` (state object)
- 内部:
  - 現行 `App.tsx` lines 154-244 をそのまま hook 化。
  - 2s interval + window resize listener。`WindowIsMaximised()` の post-await 再確認 (#86 で入れた race 対策) を踏襲。
  - cleanup で interval / listener を解除。
- shared ref / state 依存なし → **完全独立**。

#### `useGlobalKeybindings` (`src/` 直下)

- 入力 props: `{ topTab, setTopTab, viewer, settingsOpen }`
- 戻り値: なし (effect のみ)
- 内部:
  - 現行 `App.tsx` lines 257-345 をそのまま hook 化。
  - 内部で `topTabRef` / `settingsOpenRef` / `viewerRef` の sync を実施 (render-time assignment、現行と同じ)。
  - keydown listener を window に 1 回だけ登録 (`useEffect(..., [])` のまま、ref で live 参照する設計を維持)。
- shared state は props で受け取り、live 参照は ref 同期で行う。
- 配置理由: `Ctrl+Shift+1` (list) と `Ctrl+Shift+2..9` (viewer) を両方扱うため list/viewer のいずれかの feature には属さない。`src/` 直下の App-level hook として置く (`useSessionLoad` / `useSessionSave` のような feature 固有でないものに準じる)。

#### `useViewerRename` (`features/viewer-grid/`)

- 入力 props: `{ renameViewer: (id: string, name: string) => void }`
- 戻り値: `{ editingViewerId, startRename, stopRename, commitRename }`
- 内部: 現行 `App.tsx` lines 401-421 をそのまま hook 化。
  - `commitRename` は `sanitizeName` で空白 trim → 空なら入力を hook に投げて toast (= 現在の挙動を維持)。
- shared state 依存なし (`viewer.renameViewer` のみ props で受け取る)。

#### `useListToViewerHandlers` (`features/viewer-grid/`)

- 入力 props: `{ folderPath: string | null, viewer: UseViewerSetReturn, setTopTab: (t: TopTab) => void }`
- 戻り値: `{ onOpenInViewer, onOpenManyInTabs, onOpenManyAsSplit }`
- 内部: 現行 `App.tsx` lines 427-460 をそのまま hook 化。
- 配置理由: 全 handler が viewer 起点 + folderPath を入力に取るため `viewer-grid/` 配下が自然。`ClassificationView` から見ても feature 境界を跨ぐが、orchestrator (`App.tsx`) が cross-feature wiring を担う原則 (`.claude/context.md` §12) は維持される。

#### `TopTabsBar` (`src/` 直下)

- 入力 props:
  ```ts
  type TopTabsBarProps = {
    topTab: TopTab;
    onSelectList: () => void;
    onSelectViewer: (viewerId: string) => void;
    viewers: Viewer[];
    activeViewerId: string;
    rename: UseViewerRenameReturn;
    reorder: UseViewerTabReorderReturn;
    onAddViewer: () => void;
    onCloseViewer: (viewerId: string) => void;
    onOpenSettings: () => void;
    maxViewers: number;  // = MAX_VIEWERS
  };
  ```
- 戻り値: `<nav className="top-tabs" role="tablist">...</nav>` JSX。
- 内部: 現行 `App.tsx` lines 485-558 (top-tabs nav 全体) + ViewerTab を import して描画。`dragActive` / `dragSrcIdx` / `dragInsertIdx` の派生計算もここに移す。
- 配置理由: App-level の UI コンポーネント。`features/` 配下に置くと top-tabs が viewer 固有 UI に見えてしまうので `src/` 直下 (App.tsx と並ぶ層)。

#### `ViewerTab` (`features/viewer-grid/`)

- 入力 props: 現行 `App.tsx` lines 614-642 と同じシグネチャ。
- 内部: 現行 lines 644-803 をそのままファイル分割。
- 配置理由: viewer 固有 UI コンポーネント。

#### `hydrateInitialViewerSet` (`features/viewer-grid/viewers.ts`)

- 入力: `initialState: state.StateData | null`
- 戻り値: `ViewerSet`
- 内部: 現行 `App.tsx` lines 80-94 (useMemo 内のロジック) をそのまま pure 関数化。
- 既存 `initialViewerSet()` (= 空のフォールバック) と同居するファイルが最も自然。
- 副作用なしなので vitest 追加候補だが Non-Goals (テスト追加なし)。

#### `countLeafTabs` (`features/viewer-grid/viewers.ts`)

- 入力: `viewer: Viewer`
- 戻り値: `number`
- 内部: 現行 `App.tsx` lines 807-819 をそのまま pure 関数化。
- 配置理由: viewer の Layout を再帰的に走査する pure 関数なので `viewers.ts` (= viewer の純関数群) に最も馴染む。

### 5-3. props 型の設計

[spec-classification-hook-refactor.md](spec-classification-hook-refactor.md) §5-3 の Q2 結論 (= 個別 props) に倣う:

- 各子フック / コンポーネントは **個別 `Props` 型**を宣言。
- 集約型 + `Pick<>` 案は採用しない (型レベル遅延評価で grep しにくい欠点)。
- ボイラープレートは増えるが、shared state が 5-10 個に収まるので現実的。

### 5-4. 副作用の配置方針

`App.tsx` に残す副作用 (= orchestrator が抱える):

- `installGlobalErrorHandlers()` / module-load logger.info (module top-level、現状維持)
- `GetLogPath()` の useEffect (~5 行、独立 hook 化のメリットなし)
- settings → `setKnownTagColors` / `setThumbnailParams` の useEffect (~5 行、同上)
- `--ui-scale` の useLayoutEffect (~3 行、同上)
- `useSessionSave` 呼び出し (現状維持)
- `useViewerTabReorder` 呼び出し + 派生計算 (`dragActive` / `dragSrcIdx` / `dragInsertIdx`) は **TopTabsBar に渡すために orchestrator で計算** (現状維持)。

子フックに出すのは以下に限定する:
- `useWindowGeometryPolling` (90 行)
- `useGlobalKeybindings` (90 行)
- `useViewerRename` (20 行 + closure refs)
- `useListToViewerHandlers` (40 行 + 3 useCallback)

### 5-5. 既存 hook / コンポーネントとの干渉

- `useClassification` / `useViewerSet` / `useSessionLoad/Save` / `useSettings` / `useConfirm` / `useViewerTabReorder` は **すべて未改変**。本リファクタは App.tsx 側のみ。
- `ToastProvider` / `confirmDialog` の表示位置 / DOM 構造は変えない。
- `ClassificationView` / `ViewerGrid` / `SettingsDialog` は **未改変**。orchestrator から渡す props も同じ。

---

## 6. 設計判断 (合意したい事項)

### Q1. 案 B (軽量子フック分離 + TopTabsBar コンポーネント抽出) で進めてよいか

- 案 A (最小) では issue 本文の意図を満たしきれない。
- 案 C (Context) は #66 と同じく不採用 (個人開発に過剰)。
- 案 B で 6 ファイル新規作成 + `viewers.ts` 拡張 + `App.tsx` 大幅縮小 になることを受け入れるか。

### Q2. TopTabsBar の配置 (`src/` 直下 vs `features/viewer-grid/`)

- (元案 1 = 推奨) `src/TopTabsBar.tsx`: App.tsx と並ぶ App-level UI として扱う。
- (元案 2) `features/viewer-grid/TopTabsBar.tsx`: viewer タブが中心なので viewer-grid feature 配下。
- 推奨: 元案 1。一覧タブと viewer タブの両方を含み、設定歯車も持つため、特定 feature には属さない App-level UI。

### Q3. `useGlobalKeybindings` の配置 (`src/` 直下 vs feature 配下)

- (元案 1 = 推奨) `src/useGlobalKeybindings.ts`: `Ctrl+Shift+1` (list) + `Ctrl+Shift+2..9` (viewer) を両方扱うため App-level hook として扱う。
- (元案 2) `features/viewer-grid/useGlobalKeybindings.ts`: 大半 viewer 操作なので viewer-grid feature 配下。
- 推奨: 元案 1。`useSessionLoad/Save` のような App-level hook と同じレイヤに置く方が見つけやすい。

### Q4. `useListToViewerHandlers` の配置

- (元案 1) `features/viewer-grid/useListToViewerHandlers.ts`: viewer 起点 (open in viewer / many tabs / many split) なので viewer-grid feature 配下。
- (元案 2 = 推奨) `features/viewer-grid/useListToViewerHandlers.ts` (同上)
- 推奨: viewer-grid 配下。consumer (`ClassificationView`) ではなく producer 側に寄せる。

### Q5. `countLeafTabs` / `hydrateInitialViewerSet` の配置

- (推奨) `features/viewer-grid/viewers.ts` に追加。viewer の純関数群と同居。
- 代案: それぞれ独立ファイル (`countLeafTabs.ts` / `hydrateInitialViewerSet.ts`)。テスト追加時に独立ファイルのほうが import しやすいが、Non-Goals (テスト追加なし) なので **viewers.ts 同居で OK**。

### Q6. 副作用 hook の inline 維持基準

- `GetLogPath()` (5 行) / settings → setKnownTagColors/setThumbnailParams (5 行) / `--ui-scale` (3 行) は **inline 維持**。
- 理由: 各 5 行以下で他から参照されず、抽出してもファイル数が増えるだけで認知負荷低減のメリットが薄い。
- 代案: `useSettingsSideEffects` に集約。しかし依存 effect が 2 つ (useEffect + useLayoutEffect) で内容も独立しているので、まとめると逆に意図が分かりにくくなる懸念。推奨は **inline 維持**。

### Q7. `editingViewerId !== null` を「rename 中」判定に使う設計

- 現状 ViewerTab に `anyRenaming` props として渡している。
- `useViewerRename` の戻り値に `isAnyRenaming: boolean` を含めるか、`editingViewerId` を露出して呼び出し側で `!== null` 判定するか。
- 推奨: **`editingViewerId` を露出して `!== null` 判定**。すでに ViewerTab が `editingViewerId === v.id` で `isEditing` 判定もするので、両方同じ source を見るほうが整合する。

### Q8. テストの追加

- 既存テスト (`viewers.test.ts` / `useViewerTabReorder.test.ts` / 他) は通過維持が必須。
- 子フック単位の test は **追加しない** (#66 と同じく Non-Goals)。リファクタ後に必要なら別 issue で追加。
- 動作確認は wails dev + 既存 vitest で担保。

---

## 7. Phase 分割 / commit 戦略

### 単一 PR 完了案 (推奨)

リファクタは intermediate 状態が型エラー / 動作不整合を生む可能性が高く、段階分割しても各 phase が動かなければ意味がない。1 PR で完了させる。

commit 単位 (PR 内):

1. **prep**: `hydrateInitialViewerSet` / `countLeafTabs` を `viewers.ts` に追加。App.tsx は inline 定義から該当 import に差し替え。
2. **window-polling**: `useWindowGeometryPolling` 切り出し (`features/session/`)。
3. **global-keybindings**: `useGlobalKeybindings` 切り出し (`src/` 直下)。
4. **viewer-rename**: `useViewerRename` 切り出し (`features/viewer-grid/`)。
5. **list-to-viewer**: `useListToViewerHandlers` 切り出し (`features/viewer-grid/`)。
6. **viewer-tab**: `ViewerTab` を独立ファイルに分離 (`features/viewer-grid/ViewerTab.tsx`)。
7. **top-tabs-bar**: `TopTabsBar` 切り出し (`src/` 直下)。App.tsx を最終形に縮小。
8. **doc-followup**: `.claude/context.md` の §8 / §12 を更新 (新ファイル群を反映、AGENTS.md A-3 / H-6 準拠)。

各 commit の末尾で以下を通す:

```bash
npm --prefix frontend test -- --run
npm --prefix frontend run typecheck
go test ./... && go vet ./...
```

### 段階分割案 (代替)

- Phase 1: `useWindowGeometryPolling` + ViewerTab (= 独立性が高い 2 つ) → PR
- Phase 2: 残り → PR
- 利点: review が小さい。
- 欠点: Phase 1 単独では issue 本文を満たしきれない (= App.tsx は依然 600 行)。
- 推奨は **単一 PR**。個人開発ペースで、ステップごとに vitest / typecheck を通す前提なら risk は許容範囲。

---

## 8. リスク

### R1. Global keybindings の handler 取りこぼし

`useEffect` の deps を変えると handler が再登録されてしまい、キーイベントが取りこぼされる可能性がある。

**緩和策**:
- 現行と同じ `useEffect(..., [])` で 1 回だけ登録する設計を維持。
- live 参照は ref 同期 (render-time assignment) で行う、と hook 内に明示コメント。
- vitest では覆えないため、`wails dev` で `Ctrl+W` / `Ctrl+Tab` / `Ctrl+0/1/±` / `Ctrl+Shift+1..9` を全て手動で叩いて確認 (テスト計画 §9)。

### R2. Window polling の race regression (#86)

PR #89 で入れた「polling の WindowIsMaximised post-await 再確認で race を防ぐ」設計を hook 化時に取りこぼす可能性。

**緩和策**:
- 現行 `App.tsx` lines 154-244 をそのまま hook 内に移動する (ロジック改変なし)。
- 既存コメント (`// Re-check maximized: between the first WindowIsMaximised()...`) もそのまま持っていく。
- hook 化後に `git diff main...HEAD -- frontend/src/features/session/useWindowGeometryPolling.ts` のロジック部分が現行 App.tsx と完全一致することを確認。

### R3. `useSessionSave` の deps array drift

`useSessionSave` には `window: windowState` を渡している。`windowState` の identity が hook 化後に変わると save が頻発する可能性。

**緩和策**:
- `useWindowGeometryPolling` の戻り値は `useState` の値そのまま (`{width, height, x, y, maximized}`) を返す。`setWindowState((cur) => cur.maximized ? cur : ...)` で同値時は同一 reference を返す現行の挙動を維持。
- hook 内で `useMemo` で wrap しない (= identity を意図的に変えない)。

### R4. ViewerTab 抽出時の cycle import

`ViewerTab.tsx` は `useViewerTabReorder` の `DATA_VIEWER_TAB` constant を import している。`useViewerTabReorder` は `viewers.ts` を import していない (独立)。`viewers.ts` に `countLeafTabs` を追加しても cycle は発生しない。

**緩和策**:
- import 依存を実装前に確認。`features/viewer-grid/` 内の依存方向: `ViewerTab` → `useViewerTabReorder` (DATA_VIEWER_TAB) / `viewers` (Viewer 型) のみ。

### R5. ファイル数の増加で grep / 把握コストが上がる

App-level に新規 2 ファイル + viewer-grid に新規 4 ファイル + session に新規 1 ファイル。

**緩和策**:
- `.claude/context.md` §8 の `frontend/` 配下のディレクトリ図を更新し、新規ファイルの責務を 1 行で明示。
- App.tsx (orchestrator) の冒頭に「子フック / コンポーネントの責務早見表」コメントを置く (本書 §5-2 の表を要約)。

---

## 9. テスト戦略

### 自動テスト (DoD §1)

```bash
npm --prefix frontend test -- --run    # vitest (既存全件通過)
npm --prefix frontend run typecheck    # tsc --noEmit (既存全件通過)
go test ./...                          # Go 全件通過 (frontend/dist placeholder 必須)
go vet ./...                           # vet 警告なし
```

### 手動確認 (`wails dev`)

以下を **全て** 通すこと:

#### A. トップタブ操作

- 起動直後: 前回の topTab (`list` or `viewer`) が復元される
- 「一覧」タブクリック → 一覧ビュー
- ビューア タブクリック → そのビューアへ切替
- `+` ボタン → 新ビューア追加 + その新ビューアにフォーカス
- ビューアタブ × ボタン → 確認ダイアログ (タブあり) or 即削除 (タブなし) → 1 個に満たないと無効化
- 設定歯車 → SettingsDialog 開く / Esc で閉じる

#### B. Viewer rename

- ビューアタブをダブルクリック → input にフォーカス + 全選択
- Enter で commit / Esc で revert
- 空入力 → toast「ビューア名を入力してください」(または現状の挙動どおり)
- rename 中に他タブをドラッグしようとしても drag が始まらない (anyRenaming guard)

#### C. Viewer reorder DnD (#50)

- ビューアタブを 5px 以上ドラッグ → indicator 表示 + dragSource 半透明
- drop → 並び順が変わる + クリック扱いにならない
- pointercancel / Esc → indicator 消える + 並び順変わらない

#### D. Window geometry / maximized (#86)

- ウィンドウ位置 / サイズ変更 → 2s 以内に state.json に反映 (closing で確認)
- maximize → maximized=true (位置 / サイズは freeze)
- maximize 中に位置 / サイズが state.json に書き込まれない
- restore → 元の位置 / サイズに復帰

#### E. Settings 副作用

- タグ色変更 → 一覧の Card / chip に即時反映 (setKnownTagColors)
- サムネサイズ / mode 変更 → 一覧の hover popup サムネに反映 (setThumbnailParams)
- UI scale 変更 → top-tabs / nav の高さに反映 (`--ui-scale`)
- maxImagePixelsMP 変更 → 次の画像 open で clamp 反映

#### F. List → viewer wiring

- Card クリック → SampleModal → ビューア選択 → そのビューアに新規タブ
- バルク選択 → 「タブで開く」+ ビューア選択 → 全件タブ追加
- バルク選択 → 「分割で開く」+ ビューア選択 → 全件 panel split

#### G. Global keybindings

- `Ctrl+W`: アクティブタブ close
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: タブ循環
- `Ctrl+0`: fit / `Ctrl+1`: 100% / `Ctrl+±`: zoom
- `Ctrl+Shift+1`: 一覧タブ
- `Ctrl+Shift+2..9`: N-1 番目のビューア
- input 編集中 (= isEditableTarget true) → 上記すべて無視される
- SettingsDialog 開いている間 → 上記すべて無視される

#### H. confirm / toast

- viewer 削除 (タブあり) → ConfirmDialog 表示 → OK で削除 / Cancel で残る
- viewer 数上限 (8 個) で `+` → toast「ビューア数の上限 (8) に達しました」(useViewerSet 側、本リファクタで挙動変わらない)

---

## 10. ドキュメント追従 (AGENTS.md A-3 / H-6)

PR 作成前に必ず確認:

- `.claude/context.md` §8 (ファイル構成図) を更新 — `App.tsx` 単独だった行に
  `TopTabsBar.tsx` / `useGlobalKeybindings.ts` の新規ファイルを追記。
  `features/viewer-grid/` の説明に `ViewerTab.tsx` / `useViewerRename.ts` /
  `useListToViewerHandlers.ts` を追記。`features/session/` に
  `useWindowGeometryPolling.ts` を追記。
- `.claude/context.md` §12 (フロント feature 境界) — `App.tsx` の責務記述を
  「orchestrator (TopTabsBar / 各子フック呼び出し / Toast/Confirm 境界)」に更新。
- `App.tsx` 冒頭に「子フック / コンポーネントの責務早見表」コメントを追加
  (本書 §5-2 の表を要約)。
- 各新規ファイルの冒頭に「責務 / 依存 / 切り出し理由」を 1 段落コメントで記載。
- 本 spec の `0. 改訂履歴` に「実装完了」を追記、`ステータス` を「実装完了」に更新。

---

## 11. 関連

- 親 issue: [#67](https://github.com/maretol/image-observer/issues/67)
- 先行リファクタ: #64 (SettingsDialog 分割) / #65 (useViewerSet 分割) / #66 (useClassification 分割、spec: [spec-classification-hook-refactor.md](spec-classification-hook-refactor.md))
- 関連 AGENTS: [AGENTS.md §A-3](../AGENTS.md) (実装 iterate 時の context.md / コメント追従) / [§H-6](../AGENTS.md) (PR 前ドキュメント追従) / [§H-7](../AGENTS.md) (波及確認)
- 関連 issue (Out of scope): App.css の分割 (open issue にはまだ無いが、issue #67 メモで言及あり)
