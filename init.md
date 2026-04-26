# Wails 画像ビューア — 要件定義 & Hello World セットアップ

## 0. このドキュメントの目的

本書は、Wails (Go + Web) で実装する Windows 向け画像ビューアの **要求 → 要件 → 仕様** を整理し、その第一マイルストーンとして **Claude Code がリポジトリを生成し、ビルド可能な Hello World を立ち上げるまで** の手順を定義する。

機能実装（ツリー、サムネイル、タブ、ビューア等）は本書のスコープ外。本書のゴールは「`wails build` が通り、ウィンドウが起動し、2ペインレイアウトの空のシェルが表示される」ところまで。

---

## 1. 要求（ユーザー視点）

参考プロダクト：**VSCode**（フォルダのサムネイル表示が無い点だけが不足、それを補完する）。

| # | 要求 |
|---|------|
| R1 | 左にフォルダ、右に画像ビューアの2ペイン構成 |
| R2 | フォルダ内の画像をツリー構造で表示（`a/b/c.jpg`, `a/d/e.jpg` を `a` 配下のツリーで表示） |
| R3 | フォルダツリー上で各画像のサムネイルが見られる |
| R4 | 画像ビューア内でタブを持ち、複数画像を切り替えられる |
| R5 | ペインのサイズを可変にできる（左右分割の境界をドラッグで調整） |
| R6 | ビューア内で画像を自在に拡大縮小できる |
| R7 | Windows で動作する |

---

## 2. 要件（システム視点）

### 2.1 機能要件

| ID | 要件 | 備考 |
|----|------|------|
| F1 | フォルダを選択してツリー表示できる | ネイティブのフォルダ選択ダイアログ経由 |
| F2 | ツリーは再帰的にディレクトリと画像ファイルを列挙する | 対応形式の画像のみ表示 |
| F3 | ツリーノード（画像ファイル）の隣にサムネイルを表示する | 縦横比維持、固定サイズ（例: 64px） |
| F4 | サムネイルはディスクキャッシュする | 専用フォルダ。元画像のパス＋mtime＋サイズをキーにする |
| F5 | ツリーのファイルをクリックするとビューア側に新しいタブとして開く | 既に開いていれば該当タブをアクティブ化 |
| F6 | タブはクローズ可能・並び替え可能（最低限はクローズのみでも可） | |
| F7 | ビューア内で画像をマウスホイールで拡大縮小できる | 中心位置がカーソル基準 |
| F8 | ビューア内で画像をドラッグでパン（位置移動）できる | 拡大時のみ意味を持つ |
| F9 | 左ペインと右ペインの境界をドラッグでリサイズできる | 最小幅を持つ |
| F10 | 対応形式は **JPEG / PNG / GIF / WebP**（拡張子 `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`） | アニメーションGIFはブラウザ表示に任せる |

### 2.2 非機能要件

| ID | 要件 |
|----|------|
| N1 | 対象OS: Windows 10 / 11 (x64)。WebView2 ランタイム必須（多くの環境では既にプリインストール済み） |
| N2 | サムネイル生成は非同期。ツリー表示はサムネイル待ちでブロックしない |
| N3 | 大きいフォルダ（数千枚）でも UI が固まらない（仮想化スクロールは将来課題、初版では性能目標を「3000ファイルまで実用」） |
| N4 | オリジナル画像はディスクキャッシュしない。タブで開いている画像のみオンメモリ保持 |
| N5 | アプリ専用ディレクトリは Windows なら `%LOCALAPPDATA%\<AppName>\cache\thumbnails` を使う |

### 2.3 スコープ外（v1 では作らない）

- 画像の編集、回転保存、メタデータ編集
- 複数フォルダ同時オープン
- Mac / Linux 対応（コードレベルでは可能性を残すが、テスト・ビルドはしない）
- アニメーションWebPのコマ送り制御
- RAW、HEIC、TIFF、SVG など対象外フォーマット
- ペインの3分割以上、ドッキング、フローティング

---

## 3. 仕様（実装方針）

### 3.1 技術スタック

| レイヤ | 採用技術 | バージョン目安 |
|--------|----------|----------------|
| デスクトップフレームワーク | **Wails v2** | v2.10 系（安定版。v3 は alpha のため不採用） |
| バックエンド言語 | Go | 1.22 以降 |
| フロントエンド | **React + TypeScript + Vite** | React 18, TS 5.x（Wails v2 公式テンプレートに準拠） |
| パッケージマネージャ (FE) | npm | Wails テンプレート初期値に従う |
| 画像デコード（サムネイル生成） | Go 標準 `image/jpeg`, `image/png`, `image/gif` + `golang.org/x/image/webp` | WebP は標準ライブラリに無いので追加 |
| サムネイルリサイズ | `golang.org/x/image/draw`（双線形/CatmullRom） | 外部依存最小化 |
| 状態管理 (FE) | 初版は React の useState / useReducer で十分。必要になれば Zustand を検討 | |
| スタイル | CSS Modules または Tailwind（Hello World 段階では決定不要、デフォルトCSSで進める） | |

### 3.2 アーキテクチャ概略

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React + TS, WebView2)                    │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ FolderTree   │  │ ViewerPanel                  │ │
│  │  + Thumbnail │  │  ┌──────────────────────────┐│ │
│  │              │  │  │ TabBar                   ││ │
│  │              │  │  ├──────────────────────────┤│ │
│  │              │  │  │ ImageCanvas (zoom/pan)   ││ │
│  │              │  │  └──────────────────────────┘│ │
│  └──────────────┘  └──────────────────────────────┘ │
│         ↑                  ↑                        │
│         │ Wails bindings (TS ←→ Go)                 │
└─────────┼──────────────────┼────────────────────────┘
          │                  │
┌─────────┴──────────────────┴────────────────────────┐
│  Backend (Go)                                       │
│  ・ListDirectory(path)  → ツリー構造のJSON           │
│  ・GetThumbnail(path)   → base64 PNG（または bytes） │
│  ・ReadImage(path)      → 画像バイト列              │
│  ・OpenFolderDialog()   → 選択されたフォルダパス      │
└─────────────────────────────────────────────────────┘
```

Wails の標準的な構成。Go 側のメソッドを WebView 経由で TypeScript から呼び出す（バインディング自動生成）。画像本体は `assetserver` 経由のカスタムプロトコル、もしくはバインディング経由で base64 / バイトを返す方式のどちらかを後段で選択する。**Hello World 段階ではこの設計まで踏み込まない。**

### 3.3 ディレクトリ構成（初期）

```
image-viewer/
├── README.md
├── wails.json                # Wails プロジェクト設定
├── go.mod
├── go.sum
├── main.go                   # アプリ起動エントリポイント
├── app.go                    # Go 側の API メソッド集約
├── build/                    # アイコン、Windows用 manifest 等
└── frontend/                 # Vite + React + TS
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        └── App.css
```

---

## 4. Hello World の定義（このフェーズの完了条件）

以下すべてを満たすこと：

1. リポジトリ `image-viewer/` が初期化されている（`git init` 済み、`.gitignore` 整備済み）
2. `wails dev` がエラーなく起動し、ホットリロードが効く
3. `wails build` が成功し、`build/bin/image-viewer.exe` が生成される（Windows 環境で実行）
4. 起動した EXE がウィンドウを開く
5. ウィンドウ内に **左ペイン（"Folder" というラベルのみ）** と **右ペイン（"Viewer" というラベルのみ）** の2分割レイアウトが表示される
6. 左右ペイン間のスプリッターをマウスでドラッグするとペイン幅が変わる
7. README.md にビルド手順と起動手順が書かれている

> 注: サムネイル、ツリー、タブ、ズームは **この段階では実装しない**。レイアウトの骨格と Wails のビルドパイプラインが通ることだけが目標。

---

## 5. Claude Code 向けセットアップ手順

以下の手順を Claude Code で順に実行する。各ステップで失敗したら停止し、原因を特定すること。

### 5.1 前提環境チェック

ユーザーの開発機（Windows）で以下が揃っていること。揃っていない場合、ユーザーに案内する：

- Go 1.22 以降（`go version`）
- Node.js 20 以降 と npm（`node -v` / `npm -v`）
- WebView2 ランタイム（Windows 11 標準搭載、Win10 でも最近の更新で導入済みのことが多い）
- NSIS（インストーラ作成時のみ必要、Hello World では不要）

### 5.2 Wails CLI のインストール

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails doctor
```

`wails doctor` が全項目 OK を返すことを確認する。

### 5.3 プロジェクト雛形生成

リポジトリを置きたい親ディレクトリに移動して：

```bash
wails init -n image-viewer -t react-ts
cd image-viewer
```

`-t react-ts` は React + TypeScript + Vite の公式テンプレート。

### 5.4 Git 初期化

```bash
git init
```

`.gitignore` に以下が含まれていること（テンプレートが生成するものに加えて確認・追記）：

```gitignore
# Wails
build/bin/

# Node
frontend/node_modules/
frontend/dist/

# Go
*.exe
*.test
*.out

# IDE
.vscode/
.idea/
.DS_Store
```

### 5.5 初回ビルド確認（雛形のまま）

```bash
wails build
```

`build/bin/image-viewer.exe` が生成され、起動するとデフォルトの「Hello」画面が出ることを確認する。

ここまでで **Wails のビルドパイプラインが通っている** ことが確認できる。

### 5.6 2ペインの空シェル UI に差し替え

`frontend/src/App.tsx` を以下に置き換える：

```tsx
import { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";

function App() {
  const [leftWidth, setLeftWidth] = useState(280);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(() => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = Math.min(Math.max(e.clientX - rect.left, 120), rect.width - 200);
      setLeftWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="app" ref={containerRef}>
      <aside className="pane left" style={{ width: leftWidth }}>
        <div className="pane-label">Folder</div>
      </aside>
      <div className="splitter" onMouseDown={onMouseDown} />
      <main className="pane right">
        <div className="pane-label">Viewer</div>
      </main>
    </div>
  );
}

export default App;
```

`frontend/src/App.css` を以下に置き換える：

```css
html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #1e1e1e;
  color: #ddd;
}

.app {
  display: flex;
  height: 100vh;
  width: 100vw;
}

.pane {
  height: 100%;
  overflow: hidden;
}

.pane.left {
  background: #252526;
  flex-shrink: 0;
}

.pane.right {
  flex: 1;
  background: #1e1e1e;
}

.pane-label {
  padding: 12px 16px;
  font-size: 12px;
  text-transform: uppercase;
  color: #888;
  letter-spacing: 0.05em;
}

.splitter {
  width: 4px;
  cursor: col-resize;
  background: #333;
  flex-shrink: 0;
}

.splitter:hover {
  background: #007acc;
}
```

### 5.7 動作確認

```bash
wails dev
```

ブラウザではなく Wails のネイティブウィンドウが立ち上がり、左右2ペイン（"Folder" / "Viewer"）と境界スプリッターが表示されること。スプリッターをドラッグして左ペイン幅が変わることを確認する。

その後：

```bash
wails build
build\bin\image-viewer.exe
```

EXE 単体で同じ画面が起動することを確認する。

### 5.8 README.md 整備

リポジトリ直下の `README.md` に以下を含めること：

- プロジェクト概要（1〜2行）
- 必要環境（Go, Node, WebView2）
- `wails dev` での開発起動手順
- `wails build` でのリリースビルド手順
- 現状のスコープ（「Hello World 完了、機能未実装」と明記）

---

## 6. このフェーズの DoD（Definition of Done）

- [ ] `wails doctor` が OK
- [ ] `wails dev` が起動する
- [ ] `wails build` で EXE が生成される
- [ ] EXE 起動でウィンドウが開く
- [ ] 左右2ペインのレイアウトが表示される
- [ ] スプリッターのドラッグでペイン幅が可変
- [ ] `git init` 済み・`.gitignore` 整備済み
- [ ] README.md に手順が記載されている

すべてチェックが付いたら、次フェーズ（フォルダツリー実装）に進む。

---

## 7. 次フェーズの予告（参考）

本ドキュメントの範囲外だが、次に着手する順序の案：

1. **Folder Tree の実装** — フォルダ選択ダイアログ → Go側の再帰列挙 → React 側のツリー描画
2. **Thumbnail の実装** — Go側のサムネイル生成 + ディスクキャッシュ → ツリー上に表示
3. **Tab + Image View** — タブUI + 画像表示の最低限
4. **Zoom/Pan** — ホイールズーム + ドラッグパン
5. **仕上げ** — エラーハンドリング、空フォルダ、巨大画像、アニメGIF など