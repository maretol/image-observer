# Folder Tree 実装仕様書 (Phase 1)

init.md §7 の次フェーズ ① に相当。フォルダ選択ダイアログ → Go 側の遅延列挙 → React 側のツリー描画 までを対象とする。サムネイル / タブ / ビューアは含まない。

## 1. ゴール (DoD)

- フォルダ選択ボタンを押すとネイティブのフォルダ選択ダイアログが開き、選んだパスがルートとしてツリーに反映される。
- ツリーは遅延展開 (lazy load) で動作する。展開時に Go 側へ問い合わせて子要素を取得。
- ディレクトリと画像ファイルのみ表示。隠しファイル・隠しフォルダは表示しない。
- シンボリックリンクは辿る。循環は検出して打ち切る。
- 名前昇順でソート。
- 各ノードは「アイコン + 名前」で描画 (フォルダ用 / 画像用 2 種)。
- 画像ファイル拡張子は `.jpg .jpeg .png .gif .webp` (大小無視)。
- 画像ノードのクリックは現段階では何も起きない (Phase 3 でタブ生成にフック)。
- `wails build` が通り、`wails dev` でツリーが操作可能。

## 2. データモデル

### 2.1 Go 側型定義 (`tree.go`)

```go
type Node struct {
    Path  string `json:"path"`  // 絶対パス
    Name  string `json:"name"`  // ベースネーム (filepath.Base)
    Kind  string `json:"kind"`  // "dir" | "image"
    Mtime int64  `json:"mtime"` // Unix 秒
    Size  int64  `json:"size"`  // バイト (dir は 0)
}
```

- `Kind` は `"dir"` か `"image"` の 2 値のみ。それ以外のファイル種別はそもそも返さない (フィルタ済み)。
- 展開アローは UI 側で `Kind == "dir"` のノードに常に表示する。展開後に空 (`[]`) が返れば「(空)」表示に切替。
- 将来 shallow peek (先頭 N エントリだけ走査して空 dir を弾く) を入れる必要が出たら、その時点で `HasChildren bool` を追加する。Wails 自動生成型なのでフィールド追加コストは低い。

### 2.2 TS 側型定義

Wails が `wailsjs/go/main/App.d.ts` と `wailsjs/go/models.ts` を自動生成する。フロントは `import { main } from '../../wailsjs/go/models'` で `main.Node` を直接使う。手書きラッパーは作らない。

## 3. Go 側 API

`app.go` に追加:

```go
// 既存の App 構造体を流用。状態は当面持たない。

// ネイティブのフォルダ選択ダイアログ。ユーザーがキャンセルしたら ("", nil) を返す。
func (a *App) OpenFolderDialog() (string, error)

// path 直下の子要素を返す (一階層のみ)。
// - path は絶対パス前提。相対パスが渡されたら絶対化してから処理。
// - 隠しファイル / 隠しフォルダは除外。
// - シンボリックリンクは辿る。循環検出時はそのリンクを通常ディレクトリ扱いとし、
//   そのノード自身を ListDirectory した時に空配列を返すようにする (3.4 参照)。
// - ディレクトリと画像ファイルのみ返す。それ以外は除外。
// - 名前で昇順ソート (case-insensitive、ディレクトリ・ファイル混在で単純名前順)。
func (a *App) ListDirectory(path string) ([]Node, error)
```

### 3.1 `OpenFolderDialog` 実装

`runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{Title: "フォルダを選択"})` を呼ぶ。

- キャンセル時の Wails の戻りは空文字列。これをそのまま返却。
- エラー (例: ダイアログ起動失敗) はそのまま返す。

### 3.2 `ListDirectory` 実装

擬似コード:

```
func ListDirectory(path):
    abs := filepath.Abs(path)
    // 循環検出: abs 自身が祖先のシンボリックリンクをたどった結果か判定。
    // ListDirectory 呼び出しのたびに「abs の解決先が abs の祖先のいずれかと一致するか」を見る。
    // 一致するなら循環なので空配列を返して終了。
    if isCyclicPath(abs):
        return []Node{}, nil

    entries := os.ReadDir(abs)        // ReadDir は名前順ソート済みだが case-sensitive。後で再ソート
    out := []Node{}
    for entry in entries:
        full := filepath.Join(abs, entry.Name())
        if isHidden(full, entry):
            continue
        info := entry.Info()                 // Lstat 相当
        if info.Mode()&os.ModeSymlink != 0:
            // シンボリックリンク: ターゲットを stat して種別を判定
            target := filepath.EvalSymlinks(full)
            tinfo := os.Stat(target)
            info = tinfo                     // 以降は target の属性で判定 (循環は次回 ListDirectory で検出)
        if info.IsDir():
            out = append(out, Node{Path:full, Name:entry.Name(), Kind:"dir", Mtime:info.ModTime().Unix(), Size:0})
        else if isImage(entry.Name()):
            out = append(out, Node{Path:full, Name:entry.Name(), Kind:"image", Mtime:info.ModTime().Unix(), Size:info.Size()})
        // それ以外のファイルは無視
    sort.Slice(out, func(i,j) { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
    return out
```

### 3.3 隠しファイル判定 (`isHidden`)

クロスプラットフォーム対応のため build tag で分割。

- `tree_unix.go` (build tag `//go:build !windows`): 名前が `.` で始まれば hidden。
- `tree_windows.go` (build tag `//go:build windows`): 上記に加えて、`syscall.Win32FileAttributeData` の `FileAttributes & syscall.FILE_ATTRIBUTE_HIDDEN != 0` なら hidden。

### 3.4 循環検出 (`isCyclicPath`)

シンプル方式: 渡された絶対パス `abs` を `EvalSymlinks` で解決した結果が、`abs` の祖先のいずれかと一致するなら循環とみなす。

```
func isCyclicPath(abs string) bool:
    resolved := filepath.EvalSymlinks(abs)
    if resolved == "" || resolved == abs: return false
    cur := filepath.Dir(abs)
    for {
        if cur == resolved:
            return true
        parent := filepath.Dir(cur)
        if parent == cur: break   // root に達した
        cur = parent
    }
    return false
```

循環検出されたパスは `ListDirectory` が空配列 `[]` を返す。UI 上は「展開してみたら空だった」となり、循環の概念をフロントに漏らさない。これは B 決定 (空ディレクトリも表示) と一貫した扱い。

セッション横断のグローバル visited セットは持たない (実装が複雑になる + ユーザーが意図的に別経路で同じ実体を見たいケースを潰す)。「祖先一致」だけで実用上の自己ループ (foo → ./foo, foo → ../) を防げる。

### 3.5 画像拡張子判定 (`isImage`)

```go
var imageExts = map[string]bool{".jpg":true, ".jpeg":true, ".png":true, ".gif":true, ".webp":true}

func isImage(name string) bool {
    return imageExts[strings.ToLower(filepath.Ext(name))]
}
```

### 3.6 エラー方針

- `os.ReadDir` が失敗 (権限なし等) → そのままエラーを返す。フロント側でツリーノードの位置にエラー表示。
- 個別エントリの `Stat` 失敗 → そのエントリをスキップ (log のみ)。ツリー全体は壊れない。
- `EvalSymlinks` 失敗 (リンク切れ) → そのエントリをスキップ。

## 4. フロント側設計

### 4.1 ファイル追加

```
frontend/src/
├── App.tsx                      # 既存。<FolderPanel/> を左ペインに差し込む
├── components/
│   ├── FolderPanel.tsx          # 左ペインの中身全体 (ピッカー + ツリー)
│   ├── TreeView.tsx             # ルートノード群を再帰描画
│   └── TreeNode.tsx             # 単一ノード行 (アイコン + 名前 + 子)
├── icons/
│   ├── ChevronIcon.tsx          # 展開/折りたたみアロー (▶ / ▼)
│   ├── FolderIcon.tsx           # フォルダアイコン
│   └── ImageIcon.tsx            # 画像アイコン
└── hooks/
    └── useTree.ts               # ツリー状態管理フック
```

アイコンはインライン SVG を返すコンポーネント。外部依存を増やさない。

### 4.2 状態 (`useTree`)

```ts
type TreeState = {
  rootPath: string | null;
  childrenByPath: Map<string, Node[]>;   // 親パス → 子配列
  expanded: Set<string>;                  // 展開中の dir パス
  loading: Set<string>;                   // 読み込み中の dir パス (アロー部にスピナー)
  errors: Map<string, string>;            // 読み込み失敗の dir パス → メッセージ
};
```

`useReducer` で管理。Action:

- `selectRoot(path)` — ルート設定 + ルート直下を即読み込み開始
- `requestExpand(path)` — 未読み込みなら ListDirectory 呼び出し開始、読み込み済みなら expand に追加
- `requestCollapse(path)` — expanded から削除 (子データはキャッシュ保持)
- `loadSucceeded(path, nodes)`
- `loadFailed(path, error)`

### 4.3 `FolderPanel.tsx` 構造

```
┌──────────────────────────────┐
│ [📁 フォルダを選択] (button) │  ← クリックで OpenFolderDialog
├──────────────────────────────┤
│ /home/.../selected           │  ← rootPath 表示 (省略あり)
├──────────────────────────────┤
│ ▼ 📁 selected                 │  ← TreeView ルート
│   ▶ 📁 sub1                   │
│   ▼ 📁 sub2                   │
│       🖼 a.jpg                │
│       🖼 b.png                │
│   🖼 top.jpg                  │
└──────────────────────────────┘
```

### 4.4 `TreeNode.tsx` 仕様

Props: `node: Node`, `depth: number`

行の構成 (左から):
1. インデント (depth × 16px の左マージン)
2. 展開アロー (`Kind == "dir"` のみ表示。`Kind == "image"` は同幅のスペーサーで揃える)
3. アイコン (FolderIcon / ImageIcon)
4. 名前テキスト

イベント:
- アロー or 行のダブルクリック (dir): `requestExpand` / `requestCollapse`
- 行クリック (image): 何もしない (Phase 3 で `onImageClick(node.path)` を hook)

展開時の子描画: `expanded.has(node.path)` なら `childrenByPath.get(node.path)` を `<TreeNode/>` で再帰描画。

ローディング表示: `loading.has(node.path)` ならアロー位置を回転スピナー (CSS animation) に置換。
エラー表示: `errors.has(node.path)` なら子の代わりに赤字でメッセージ + リトライリンク。

### 4.5 `App.tsx` への組み込み

既存の左ペイン中身 (`<div className="pane-label">Folder</div>`) を `<FolderPanel/>` に置換。スプリッター動作・右ペインは現状維持。

### 4.6 Wails 呼び出し

```ts
import { OpenFolderDialog, ListDirectory } from '../../wailsjs/go/main/App';
import { main } from '../../wailsjs/go/models';
type Node = main.Node;
```

`OpenFolderDialog` の戻りが空文字列ならキャンセル扱いで何もしない。

## 5. ビルド / 生成手順

1. `app.go` と `tree.go` (および `tree_unix.go` / `tree_windows.go`) を追加
2. `wails generate module` (または `wails dev` / `wails build` 実行で自動生成) で `wailsjs/go/...` 更新
3. フロント側コンポーネント追加
4. `wails build` で動作確認

## 6. テスト方針

### 6.1 Go 側 (`tree_test.go`)

- `t.TempDir()` 配下にフィクスチャ作成 (画像数種、隠しファイル、サブディレクトリ、シンボリックリンクのループ) し、`ListDirectory` の出力を検証。
- `isHidden` / `isImage` の単体テスト。
- 循環検出: シンボリックリンク `loop -> .` を作り、ループしないことを確認。

最低限のカバレッジ: フィルタ (隠し/拡張子)・ソート・循環検出。

### 6.2 フロント側

v1 ではフロントテストフレームワーク (Vitest) は導入しない (todo.md J で結論次第)。

## 7. スコープ外 (Phase 1 では作らない)

- サムネイル生成・表示 (Phase 2)
- 画像クリックでタブを開く (Phase 3)
- ツリー内検索 / フィルタ UI
- 右クリックメニュー
- キーボードナビゲーション (上下キー、Enter で展開等)
- 複数選択
- ドラッグ & ドロップ
- フォルダ変更検知 (fsnotify)
- ペイン幅・選択フォルダの永続化 (Phase F)

## 8. 完了条件チェックリスト

実装完了 (2026-04-26、`wails build` 通過 + Go テストパス済み)。実機での `wails dev` 操作確認はユーザーで実施。

- [x] フォルダ選択ダイアログが動作し、選択したパスがルートとして表示される (実装: `OpenFolderDialog` + `FolderPanel`)
- [x] ルート直下のディレクトリと画像が表示される (`ListDirectory` + `TreeNode`)
- [x] 隠しファイル・隠しフォルダが除外される (`tree_unix.go` / `tree_windows.go` の `isHidden`)
- [x] 名前順にソートされる (大小無視) (`listDirectory` 末尾 `sort.Slice`)
- [x] ディレクトリのアロークリックで展開、再クリックで折りたたみ (`useTree.toggle`)
- [x] 展開時にローディング表示が出る (`SpinnerIcon` + `loading` set)
- [x] シンボリックリンクの自己ループでクラッシュ・無限ループしない (`isCyclicPath`、`TestListDirectory_SymlinkLoop` 確認)
- [x] 空ディレクトリを展開すると子なしで表示される (`TreeNode` の "(空)" 表示)
- [x] 画像ファイルクリックで何も起きない (`TreeNode.handleClick` は dir のみ処理)
- [x] フォルダ・画像それぞれにアイコンが表示される (`FolderIcon` / `ImageIcon`)
- [x] `wails build` 成功
- [x] Go 側ユニットテストがパス (`go test ./...` ok)

完了したら todo.md の B 項目を全部 `[x]` に更新し、次フェーズ (Phase 2: Thumbnail) に進む。
