# spec-error-handling — Phase G エラー・境界条件

todo.md G (壊れた画像 / 巨大画像 / アクセス権なしフォルダ / フォルダ消失) を 3 段階で実装する。各段階は独立した PR/コミットを想定。

## 0. フェーズ分割

| # | スコープ | 主な変更先 | 推定 LOC |
|---|---|---|---|
| **G-1** | Toast 基盤 | 新規 `shared/components/Toast.tsx` + App.tsx | ~150 |
| **G-2** | 画像系エラー (壊れた + 巨大) | Go `imgread` + `useViewerGrid` + `ImageView` | ~120 |
| **G-3** | フォルダ系エラー (permission + 消失) | Go `tree` + `useTree` + `TreeNode` | ~150 |

依存: G-1 が前提。G-2/G-3 は順序自由 (互いに独立)。

---

## 1. G-1 — Toast 基盤

### 1.1 公開 API

`shared/components/Toast.tsx` から以下を export:

```ts
export type ToastSeverity = "info" | "warn" | "error";

export type ToastFn = (message: string, severity?: ToastSeverity) => void;
// severity 省略時は "info"

export function useToast(): {
  toast: ToastFn;
  toastHost: ReactNode; // App.tsx でレンダ
};
```

`useConfirm` と同じ流儀 (フックがホスト要素を返し、呼び出し側が JSX に挿入)。

### 1.2 動作仕様

- **配置**: 画面右下から積み上がる (`position: fixed; bottom: 16px; right: 16px;`)。新しいトーストが下、古いものが上。
- **表示数上限**: 5 件。超過時は最古を即削除。
- **自動消滅時間**: `info` = 3000ms / `warn` = 5000ms / `error` = 7000ms。
- **手動クローズ**: `error` のみ × ボタンを表示。`info` / `warn` はクリック自体で閉じる動作はなし (時間で消える)。
- **重複制御**: 同一 `(message, severity)` が表示中なら新規生成せず既存のタイマーをリセット (連続発火対策)。
- **アニメーション**: フェード in/out のみ (CSS transition 200ms)。スライドはなし。
- **Portal**: `createPortal(host, document.body)`。
- **アクセシビリティ**: 各トーストに `role="status"` (info/warn) / `role="alert"` (error)、`aria-live="polite"` / `"assertive"`。

### 1.3 内部状態

`ToastItem = { id: number, message, severity, timeoutHandle }` の配列を `useState` で管理。`toast()` で追加、タイムアウトまたは close ボタンで削除。

see `frontend/src/shared/components/Toast.tsx`

### 1.4 配線

- `App.tsx` で `useToast()` を呼び `toastHost` を JSX 末尾 (ConfirmDialog の隣) に挿入。
- `useTree({ initialRootPath, toast })` / `useViewerGrid({ initialGrid, confirm, toast })` に `toast` プロパティを追加 (G-2/G-3 で参照)。
- `ImageView` には props 経由ではなく React Context 経由で渡す (3 階層下のため)。`ToastContext` を `Toast.tsx` で export し、App でプロバイダ化。

→ **方針修正**: 全部 Context にしたほうが一貫する。

```tsx
// Toast.tsx
const ToastContext = createContext<ToastFn>(() => {});
export function useToastFn(): ToastFn { return useContext(ToastContext); }
export function ToastProvider({ children }) { ... } // host を中で render
```

App.tsx は `<ToastProvider>` で全体ラップ。各 hook/component は `useToastFn()` で取得。useTree / useViewerGrid の opts には toast を入れない (Context で取れる)。

### 1.5 CSS (App.css 追記)

クラス: `.toast-host` / `.toast` / `.toast-info` / `.toast-warn` / `.toast-error` / `.toast-message` / `.toast-close`。VS Code 配色に合わせる (info: `#007acc`、warn: `#cc8400` 系、error: `#f48771` 系)。

### 1.6 受け入れ基準

- [ ] `useToastFn()` を呼んで `toast("hello")` で右下に表示される
- [ ] 5 件超で最古が消える
- [ ] severity ごとの色分けと自動消滅時間
- [ ] error のみ × ボタンで即時クローズ
- [ ] 同一メッセージ連発でタイマーがリセットされる (新規追加されない)
- [ ] tsc / vite build PASS

---

## 2. G-2 — 画像系エラー (壊れた + 巨大)

### 2.1 Go: `imgread.Info` 追加

```go
// internal/imgread/imgread.go
type Info struct {
    Width    int    `json:"width"`
    Height   int    `json:"height"`
    MimeType string `json:"mimeType"`
}

// Info reads only the image header to obtain dimensions.
// Returns the same errors as Read for non-image / missing / dir paths.
func Info(path string) (Info, error) {
    // 既存 decodeImageDimensions を流用
}
```

`app.go` に `func (a *App) GetImageInfo(path string) (imgread.Info, error)` を追加。

### 2.2 TS: 巨大画像チェック

`useViewerGrid` 近傍に定数:

```ts
// Phase H で設定 UI 化予定。それまではここを書き換える。
export const MAX_PIXELS = 200_000_000; // 200MP
```

`openInActive` を async 化:

```ts
const openInActive = useCallback(async (path: string) => {
  let info: imgread.Info;
  try {
    info = await GetImageInfo(path);
  } catch (e) {
    toast(`画像を開けません: ${errorMessage(e)}`, "error");
    return;
  }
  if (info.width * info.height > MAX_PIXELS) {
    const mp = (info.width * info.height / 1_000_000).toFixed(1);
    toast(
      `画像が大きすぎます (${mp}MP > ${MAX_PIXELS / 1_000_000}MP)。開けません。`,
      "warn"
    );
    return;
  }
  setGrid((g) => { ... }); // 既存ロジック
}, [toast]);
```

`FolderPanel → onImageOpen` への伝播は変えない (内部で await されるが呼び出し側は気にしない)。

### 2.3 TS: 壊れた画像のトースト

`ImageView.tsx` の既存 `ReadImage(...).catch` ハンドラに toast 呼び出しを追加 (タブ内エラー表示はそのまま残す):

```ts
.catch((e) => {
  if (cancelled) return;
  const msg = errorMessage(e);
  setLoadError(msg);
  toast(`画像読み込みに失敗: ${basename(tab.path)} — ${msg}`, "error");
});
```

`basename` ヘルパは TabBar.tsx と同じものを util 化するか、ImageView に複製するかは実装時判断 (1 箇所増えるだけなので複製可)。

### 2.4 受け入れ基準

- [ ] 壊れた JPEG (バイト破損) を開く → タブ内エラー + 赤トースト
- [ ] 200MP 超の PNG を開く → タブ作成されず、警告トーストのみ
- [ ] 通常画像 (5MP 等) は変わらず開く
- [ ] 同一画像をクリック連打しても toast 重複制御で 1 件のまま (G-1 の重複抑止が効く)

---

## 3. G-3 — フォルダ系エラー (実装不要に)

> Phase 4 で `internal/tree` および `features/folder-tree/` が完全削除されたため、G-3 (permission / not_found 種別分岐) は **不要になった**。フォルダ選択は OS のネイティブダイアログ経由になり、ツリー走査は分類スキャナの再帰 walk が `os.ReadDir` 失敗を per-entry でスキップする設計に置換されている。当時の設計 (`PERM:` / `NOENT:` プレフィクス + `noPermission` Set + grayscale FolderIcon) は `git log -- docs/spec-error-handling.md` 参照。

---

## 4. テスト観点まとめ

### Go (`go test ./...`)
- `imgread.Info`: 正常 / not image / not exist / broken header

### 手動 (wails dev)
- 上記受け入れ基準のチェックリスト
- 各 toast の severity 表示 (色 / 時間 / クローズ)

## 5. スコープ外

- 縮小プレビュー機能 (巨大画像の代替表示) — 実装しない
- toast の積み重ね順をユーザがピン留めする UI — 出さない
- toast の履歴閲覧 — 出さない
