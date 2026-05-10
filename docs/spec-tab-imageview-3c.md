# Tab + ImageView 実装仕様書 (Phase 3c)

> ⚠️ **state スキーマは Phase 5 で v3 → v4 に更新された。** 本仕様の `GridState` (rows × cols + panels[]) は廃止され、BSP ツリーの `LayoutState` に置換された。現行の正本は [spec-viewer-flexlayout.md](spec-viewer-flexlayout.md) §7。Phase 3c の他の永続化方針 (アトミック書き込み / debounce 500ms / version mismatch → default fallback) は引き継がれている。

Phase 3 の **第 3 段階**。前回終了時の状態を JSON ファイルに永続化し、起動時に復元する。todo.md F (永続化) の方針を本フェーズで部分確定する。

## 1. ゴール (DoD)

- 終了 → 再起動の往復で以下が復元される:
  - 最後に選択していたフォルダ (rootPath) とツリーのルート展開状態
  - 左右ペイン (FolderPanel と ViewerGrid) の幅
  - メインウィンドウのサイズ + 位置 (※ Linux/GTK で位置復元できない場合あり、ベストエフォート)
  - グリッド形状 (rows × cols + 各スプリッター比率)
  - アクティブパネル
  - 各パネルのタブ一覧 (path) + アクティブタブ + 各タブの zoom / pan
- 状態は **JSON ファイル** で `os.UserConfigDir()/image-observer/state.json` に保存
- 状態変化時に **debounce 500ms** で保存 (連続変更で書き込み洪水を防ぐ)
- 不正 / 古い state.json はスキップして初期状態で起動 (アプリは必ず起動できる)
- パスが消えていても起動はできる (該当ファイルクリック時にエラー表示は既存挙動)
- `wails build` が通り、`wails dev` で操作確認できる
- Go 側ユニットテスト (state の load / save / 不正データ耐性) がパス

## 2. 永続化スキーマ

### 2.1 状態モデル (Go 側 `state.go`)

```go
const StateSchemaVersion = 1

type StateData struct {
    Version       int         `json:"version"`
    RootPath      string      `json:"rootPath"`         // "" if not selected
    LeftPaneWidth int         `json:"leftPaneWidth"`    // px
    Window        WindowState `json:"window"`
    Grid          GridState   `json:"grid"`
}

type WindowState struct {
    Width  int `json:"width"`
    Height int `json:"height"`
    X      int `json:"x"`     // -1 = unset (let WM decide)
    Y      int `json:"y"`     // -1 = unset
}

type GridState struct {
    Rows     int           `json:"rows"`
    Cols     int           `json:"cols"`
    RowSizes []float64     `json:"rowSizes"`
    ColSizes []float64     `json:"colSizes"`
    Active   PanelCoordSt  `json:"active"`
    Panels   []PanelState  `json:"panels"` // length = rows*cols, indexed row*cols + col (フロント側 Grid と同じ順)
}

type PanelCoordSt struct {
    Row int `json:"row"`
    Col int `json:"col"`
}

type PanelState struct {
    Tabs        []TabState `json:"tabs"`
    ActiveIndex int        `json:"activeIndex"`
}

type TabState struct {
    Path string  `json:"path"`
    Zoom float64 `json:"zoom"`
    PanX float64 `json:"panX"`
    PanY float64 `json:"panY"`
}
```

### 2.2 スキーマバージョン管理

- `Version` を必ず JSON 先頭に持たせる。
- ロード時に `Version != StateSchemaVersion` なら捨てて初期状態で起動 (警告ログ)。
- 将来スキーマ変更時は `Version++` し、必要なら migration 関数を追加。v1 では何もしない。

### 2.3 デフォルト値

ロード失敗時 / state.json 不在時のデフォルト:

```go
func defaultState() StateData {
    return StateData{
        Version:       StateSchemaVersion,
        RootPath:      "",
        LeftPaneWidth: 280,
        Window:        WindowState{Width: 1024, Height: 768, X: -1, Y: -1},
        Grid:          defaultGridState(),  // rows=1, cols=1, panels=[empty]
    }
}
```

## 3. Go 側設計

### 3.1 ファイル構成

```
image-observer/
├── state.go           # StateData 型 + LoadState / SaveState / state パス算出
├── state_test.go      # ロード / セーブ / 不正データ / バージョン不一致テスト
└── main.go            # (更新) 起動前に LoadState → Width/Height を options に反映
└── app.go             # (更新) GetState / SaveState バインディング追加 + OnStartup でウィンドウ位置復元
```

### 3.2 `state.go` 主要 API

```go
// 内部: state.json のパスを返す。エラー時は空文字。
func stateFilePath() string

// state.json をロード。失敗時 (不在 / 不正 / バージョン不一致) はデフォルト + 警告ログ。
func loadState() StateData

// state.json に書き込む。書き込み失敗はログのみ (アプリの動作には影響しない)。
// アトミック書き込み (一時ファイル → rename) で破損リスクを下げる。
func saveState(state StateData) error
```

`stateFilePath` の実装:
```go
base, err := os.UserConfigDir()
if err != nil { return "" }
return filepath.Join(base, "image-observer", "state.json")
```

### 3.3 アトミック書き込み

```go
func saveState(state StateData) error {
    path := stateFilePath()
    if path == "" { return errors.New("no config dir") }
    if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil { return err }
    data, err := json.MarshalIndent(state, "", "  ")
    if err != nil { return err }
    tmp := path + ".tmp"
    if err := os.WriteFile(tmp, data, 0o644); err != nil { return err }
    return os.Rename(tmp, path)
}
```

### 3.4 `app.go` 追加 API

```go
// 起動時にフロントが呼ぶ。Window 系は ここでは返すだけで、フロント側で解釈してから RestoreWindow を呼ぶ
func (a *App) GetState() (StateData, error) {
    return loadState(), nil
}

// 状態変化時にフロントから debounce で呼ばれる
func (a *App) SaveState(state StateData) error {
    return saveState(state)
}
```

### 3.5 main.go の更新

```go
func main() {
    app := NewApp()
    state := loadState()  // best effort: ファイルなければデフォルト

    // ウィンドウ初期サイズだけ反映 (位置は OnStartup で)
    width, height := state.Window.Width, state.Window.Height
    if width <= 0 { width = 1024 }
    if height <= 0 { height = 768 }

    err := wails.Run(&options.App{
        Title:     "image-observer",
        Width:     width,
        Height:    height,
        MinWidth:  400,
        MinHeight: 300,
        // ...
        OnStartup: func(ctx context.Context) {
            app.startup(ctx)
            // ウィンドウ位置復元 (Linux/GTK では効かない場合あり)
            if state.Window.X >= 0 && state.Window.Y >= 0 {
                runtime.WindowSetPosition(ctx, state.Window.X, state.Window.Y)
            }
        },
        Bind: []interface{}{ app },
    })
    // ...
}
```

注意: `loadState()` を main.go と OnStartup の両方で呼ばないよう、トップレベルで 1 回だけロードしてキャプチャする (上記コード)。

### 3.6 エラー方針

- state.json 不在: warn ログ なしでデフォルト起動 (初回起動時の正常動作)
- state.json パース失敗 / バージョン不一致: warn ログ + デフォルト起動
- 書き込み失敗: error ログ + アプリ続行 (次回起動時に旧 state が残るだけ)

## 4. フロント側設計

### 4.1 ファイル追加 / 更新

```
frontend/src/
├── App.tsx                       # 起動時に GetState → 各 hook の初期 state に反映、変化を debounce で SaveState
├── hooks/
│   ├── useSessionLoad.ts         # (新規) 起動時 state ロード + 復元完了フラグ
│   ├── useSessionSave.ts         # (新規) state を debounce で SaveState
│   ├── useTree.ts                # (更新) initialRootPath を受け取れるように
│   └── useViewerGrid.ts          # (更新) initialGrid を受け取れるように
└── utils/
    └── debounce.ts               # (新規) 単純な debounce helper
```

### 4.2 起動フロー

```tsx
function App() {
  const { loaded, initialState } = useSessionLoad();
  if (!loaded) return null;  // または短い loading 表示
  return <AppInner initialState={initialState} />;
}

function AppInner({ initialState }: { initialState: StateData }) {
  const [leftWidth, setLeftWidth] = useState(initialState.leftPaneWidth);
  const tree = useTree({ initialRootPath: initialState.rootPath });
  const viewer = useViewerGrid({ initialGrid: convertGridState(initialState.grid) });

  // debounce で SaveState
  useSessionSave({
    rootPath: tree.state.rootPath,
    leftPaneWidth: leftWidth,
    grid: viewer.grid,
    // window state は別途取得 (4.5 参照)
  });

  // ... 既存の splitter 処理など
  return (...);
}
```

`useSessionLoad`:
```ts
export function useSessionLoad() {
  const [loaded, setLoaded] = useState(false);
  const [initialState, setInitialState] = useState<StateData | null>(null);
  useEffect(() => {
    GetState()
      .then((s) => {
        setInitialState(s);
        setLoaded(true);
      })
      .catch(() => {
        setInitialState(defaultStateClient());
        setLoaded(true);
      });
  }, []);
  return { loaded, initialState };
}
```

### 4.3 `useSessionSave` (debounce 500ms)

```ts
export function useSessionSave(input: {
  rootPath: string | null;
  leftPaneWidth: number;
  grid: Grid;
}) {
  // 起動直後の連続レンダーで意味のない save が走らないよう、最初の 1 回はスキップする
  const skipFirstRef = useRef(true);
  const debounced = useDebounce(input, 500);

  useEffect(() => {
    if (skipFirstRef.current) {
      skipFirstRef.current = false;
      return;
    }
    SaveState(buildStateData(debounced)).catch((e) => console.warn("SaveState failed:", e));
  }, [debounced]);
}
```

`useDebounce`:
```ts
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
```

### 4.4 `useTree` 改修

`useTree` の reducer 初期値を `initialRootPath` から構築。`initialRootPath` が非空ならその path を rootPath に設定し、初回 mount 時に `loadChildren(initialRootPath)` を呼ぶ。

```ts
export function useTree(opts?: { initialRootPath?: string | null }) {
  const init: TreeState = {
    ...initial,
    rootPath: opts?.initialRootPath || null,
    expanded: opts?.initialRootPath ? new Set([opts.initialRootPath]) : new Set(),
  };
  const [state, dispatch] = useReducer(reducer, init);

  // 初回 mount 時、rootPath があれば子をロードする
  useEffect(() => {
    if (state.rootPath) {
      loadChildren(state.rootPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ...既存
}
```

### 4.5 `useViewerGrid` 改修

`initialGrid` をオプションで受け取り、Tab の `initialized` を `true` に設定して即時表示できるようにする (zoom/pan が確定済みのため fit 計算を走らせない)。

```ts
export function useViewerGrid(opts?: { initialGrid?: Grid }) {
  const [grid, setGrid] = useState<Grid>(opts?.initialGrid ?? initialGrid);
  // ...
}
```

復元時の Tab の `initialized` フラグ:
- 永続化スキーマには `initialized` は含めない (常に true で復元してよい)
- `imageWidth / imageHeight` は永続化しない (ImageView mount 時に再取得)
- ただし、imageWidth が 0 のままだと clampPan の判定が壊れる → ImageView の初期 mount 時に **必ず ReadImage して dims を取得 → そのうえで pan を clampPan で補正**

### 4.6 ImageView の改修

復元時の挙動:
1. `tab.initialized === true && tab.imageWidth === 0` の状態で mount される
2. ReadImage を呼ぶ
3. 取得後、`updateTabState` で imageWidth/Height を反映
4. **次の effect で zoom/pan を clampPan で補正** (ウィンドウサイズが変わっている場合に備える):
```ts
useEffect(() => {
  if (!tab.initialized || tab.imageWidth <= 0 || !containerRef.current) return;
  const rect = containerRef.current.getBoundingClientRect();
  const renderedW = tab.imageWidth * tab.zoom;
  const renderedH = tab.imageHeight * tab.zoom;
  const { panX, panY } = clampPan(tab.panX, tab.panY, renderedW, renderedH, rect.width, rect.height);
  if (panX !== tab.panX || panY !== tab.panY) {
    onUpdateTabState(tabIndex, { panX, panY });
  }
}, [tab.initialized, tab.imageWidth, tab.imageHeight]);
```

### 4.7 ウィンドウサイズ / 位置の取得

終了直前のウィンドウ状態は debounce save では取れない (ユーザーがリサイズしたあと debounce 待ち中にアプリを閉じる可能性)。

**対策**:
- `runtime.WindowSetPosition / WindowGetSize / WindowGetPosition` の TS 版が `wailsjs/runtime/runtime.js` に自動生成される
- `App.tsx` で 1 秒ごとに WindowGetSize / WindowGetPosition を取得して state に保存し続ける
- または Wails の `OnBeforeClose` フックで Go 側からウィンドウ寸法を取得して保存
- v1 では **debounce 500ms + リサイズ/移動イベントを debounce 対象に含める** で十分とする

実装案 (App.tsx):
```ts
const [windowSize, setWindowSize] = useState({ width: 1024, height: 768, x: -1, y: -1 });
useEffect(() => {
  const update = async () => {
    const sz = await WindowGetSize();
    const pos = await WindowGetPosition();
    setWindowSize({ width: sz.w, height: sz.h, x: pos.x, y: pos.y });
  };
  window.addEventListener("resize", update);
  // 定期取得 (移動はブラウザイベントが無いため)
  const interval = setInterval(update, 2000);
  update();
  return () => {
    window.removeEventListener("resize", update);
    clearInterval(interval);
  };
}, []);
```

これを `useSessionSave` の input に渡す。

「2 秒ポーリング」は理想的でないが、Wails JS Runtime に WindowMove イベントが無いので妥協。後から `OnBeforeClose` ハンドラでもう一度書く方式に切り替えられる。

### 4.8 状態構造の変換

Go 側の `GridState` (panels が `PanelState[]` フラット配列) と TS 側の `Grid` 型 (panels が `Panel[]` フラット配列) は構造的にほぼ同じ。Tab.initialized などのフィールドだけ補正:

```ts
function convertGridState(gs: main.GridState): Grid {
  return {
    size: { rows: gs.rows, cols: gs.cols },
    panels: gs.panels.map((p) => ({
      tabs: p.tabs.map((t) => ({
        path: t.path,
        zoom: t.zoom,
        panX: t.panX,
        panY: t.panY,
        initialized: true,        // 復元時は寸法計算済みとみなす
        imageWidth: 0,            // ImageView mount 時に再取得
        imageHeight: 0,
      })),
      activeIndex: p.activeIndex,
    })),
    rowSizes: gs.rowSizes,
    colSizes: gs.colSizes,
    active: { row: gs.active.row, col: gs.active.col },
  };
}

function buildStateData(input): StateData {
  return {
    version: 1,
    rootPath: input.rootPath ?? "",
    leftPaneWidth: input.leftPaneWidth,
    window: input.window,
    grid: {
      rows: input.grid.size.rows,
      cols: input.grid.size.cols,
      rowSizes: input.grid.rowSizes,
      colSizes: input.grid.colSizes,
      active: input.grid.active,
      panels: input.grid.panels.map((p) => ({
        tabs: p.tabs.map((t) => ({
          path: t.path, zoom: t.zoom, panX: t.panX, panY: t.panY,
        })),
        activeIndex: p.activeIndex,
      })),
    },
  };
}
```

## 5. 不整合 / エラー処理

| ケース | 挙動 |
|--------|------|
| state.json 不在 | デフォルト起動 (warn ログなし、初回起動の正常動作) |
| JSON パース失敗 | warn ログ + デフォルト起動 |
| Version 不一致 | warn ログ + デフォルト起動 |
| rowSizes / colSizes が rows/cols と長さ不一致 | warn ログ + 等分にフォールバック |
| panels が `rows × cols` と数が合わない | warn ログ + デフォルト起動 |
| active が grid 範囲外 | `(0, 0)` にフォールバック |
| 各 panel の activeIndex が tabs 範囲外 | `tabs.length > 0 ? 0 : -1` にフォールバック |
| rootPath が存在しないフォルダ | ツリー描画時に `読み込み失敗` 表示 (既存挙動) |
| タブの path が存在しないファイル | クリック時に `読み込み失敗` 表示 (既存挙動) |
| Window サイズ / 位置が不正 (負値、巨大値等) | 不正値は無視してデフォルト |

## 6. ビルド / 生成手順

1. `state.go` / `state_test.go` を追加
2. `app.go` に `GetState` / `SaveState` メソッド追加
3. `main.go` を更新 (起動前に `loadState`、OnStartup で位置復元)
4. `wails build` で TS バインディング自動生成
5. フロント側 hook / utils / App.tsx を更新
6. `wails build` で動作確認

## 7. テスト方針

### 7.1 Go 側 (`state_test.go`)

- `saveState` → `loadState` のラウンドトリップ (data 一致)
- `saveState` がアトミック (一時ファイル経由)
- `loadState` が不在 / 空 / 不正 JSON / バージョン違い でデフォルトを返す (panic しない)
- `cacheRootOverride` と同じパターンで `stateFilePath` をテストで上書き可能にする (テスト用 env)

### 7.2 フロント側

v1 ではテスト未導入。動作確認は `wails dev` で:
- フォルダ選択 → タブを 2-3 個開く → グリッドを 2×2 にする → アプリ閉じる → 再起動
- 各状態が復元されているか目視

## 8. スコープ外 (Phase 3c では作らない)

- ツリーの全展開状態の永続化 (rootPath 直下しか開かない)。将来検討
- Last-N 個 のフォルダ履歴 (init.md 「複数フォルダ同時オープン」スコープ外と整合)
- 状態の手動エクスポート / インポート
- 設定 (サムネサイズ / mode / worker 数 / グリッド最大数) の永続化 → Phase H で別 JSON ファイル `settings.json` として実装する
- Wails 標準の `OnBeforeClose` フックでの確定保存 → 必要なら後から追加

## 9. 完了条件チェックリスト

実装完了 (2026-04-26、`go test ./...` ok + `wails build` 通過)。実機での `wails dev` / 終了→再起動の動作確認はユーザーで実施。

- [x] `state.go` + `state_test.go` 実装 (state ファイル 9 ケース)
- [x] `GetState` / `SaveState` バインディング生成済み (`app.go` + 自動生成 TS)
- [x] `main.go` で起動前に `loadState` してウィンドウ寸法を反映
- [x] OnStartup でウィンドウ位置を `runtime.WindowSetPosition` で復元
- [x] `useSessionLoad` で起動時に GetState → 各 hook に初期 state 注入 (2 段階 mount)
- [x] `useSessionSave` で 500ms debounce で SaveState (JSON.stringify で stable diff)
- [x] フォルダ選択状態が復元される (`useTree` 初期 state + 自動 `loadChildren`)
- [x] 左ペイン幅が復元される (`leftPaneWidth` を初期値に)
- [x] グリッド形状 + スプリッター比率が復元される (`gridFromGridState` で復元)
- [x] 各パネルのタブとアクティブが復元される
- [x] 各タブの zoom / pan が復元される (ImageView の `clampedAfterRestoreRef` で post-restore に clampPan 補正)
- [x] アクティブパネルが復元される
- [x] ウィンドウサイズが復元される (`main.go` で options.App に反映、位置は OnStartup で復元、Linux/GTK では位置が効かない可能性は許容)
- [x] 不在 / 不正な state.json でもアプリは起動する (defaultState fallback、`TestLoadState_*`)
- [x] Version 不一致で初期状態にリセットされる (`TestLoadState_VersionMismatch_FallsBackToDefault`)
- [x] `wails build` 成功
- [x] Go 側ユニットテストがパス (`go test ./...` ok、計 34 ケース: tree 7 + thumb 11 + image 7 + state 9)

完了したら todo.md F (永続化) の保存対象 / 保存先 / 保存タイミングが Phase 3c スコープで確定する。完全な永続化 (設定値含む) は Phase H で `settings.json` を別途追加する形で完成。
