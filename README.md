# image-observer

Wails (Go + React/TypeScript) で実装している、画像分類補助つきのデスクトップ画像ビューアです。  
現在は **Windows を本番ターゲット** としつつ、開発・検証は Linux (WSL2) でも行える構成になっています。

> `image-observer` はリポジトリ / プロジェクト名です。アプリの表示名（ウィンドウタイトル等）は **Imago** を使用します（#88）。

---

## 現在の実装内容（2026-05 時点）

### 1. 一覧タブ（分類ビュー）

- フォルダ選択と再帰スキャン（隠しディレクトリは除外）
- 対応画像の一覧表示（拡張子ベース: jpg/jpeg/png/gif/webp）
- `_classification.json`（および既存 `_classification.csv` 読み込み）による分類データ管理
- タグ / 信頼度 / テキストによるフィルタ
- ディレクトリ単位のグルーピングと折りたたみ
- カード編集（folder/confidence/note）、サンプルモーダル表示
- 複数選択（checkbox / modifier / both）と一括操作
- 画像削除（Windows はごみ箱、非 Windows は削除）
- 競合検出（mtime ベース）と競合解決ダイアログ

### 2. ビューアタブ

- マルチビューア（最大 8）
- ビューアの追加 / リネーム / 並べ替え / クローズ
- 各ビューア内でのタブ管理
- パネル分割（BSP レイアウト）
- タブ DnD（移動・並び替え・分割・別ビューア移動）
- 画像表示のズーム / パン、キーボードショートカット対応

### 3. 自動監視（Folder Watch）

- fsnotify ベースの再帰監視
- デバウンス（200ms）+ 変更集約
- 設定で `auto` / `off` 切り替え
- 監視イベント受信時に一覧の再読込フローへ接続

### 4. 設定ダイアログ

- ログレベル
- UI スケール
- ビューア操作モード（ホイール動作など）
- 画像サイズ上限（MP）
- サムネイルサイズ / 生成モード / ワーカー数
- 一覧タブの複数選択モード
- 監視モード
- タグ色マッピング

### 5. 永続化

- アプリ状態: `state.json`
- ユーザ設定: `settings.json`
- 分類データ: `_classification.json`（フォルダごと）
- いずれも不正値や競合を考慮したフォールバック / 検証付き

### 6. ログ

- 統合ログ: `app.log`
- ローテーション: 2MB, 最大 3 世代（`app.log`, `.1`, `.2`）
- パス:
  - Windows: `%LOCALAPPDATA%\image-observer\logs\app.log`
  - Linux: `~/.cache/image-observer/logs/app.log`
  - macOS: `~/Library/Caches/image-observer/logs/app.log`

---

## 対応画像形式

- `.jpg`
- `.jpeg`
- `.png`
- `.gif`
- `.webp`

---

## 必要環境

- Go: **1.26.x**
- Node.js: **22+**
- npm: **10+**
- Wails CLI: **v2.12.x**

Linux で `wails dev` / `wails build` する場合は Wails の依存ライブラリ（GTK/WebKit など）が必要です。`wails doctor` で確認してください。

---

## 開発起動

```bash
# リポジトリルート
cd /home/runner/work/image-observer/image-observer

# フロント依存導入
cd frontend
npm ci
cd ..

# 開発実行
wails dev
```

---

## ビルド

```bash
cd /home/runner/work/image-observer/image-observer
wails build
```

成果物は `build/bin/` に出力されます。  
本番向け Windows リリースは GitHub Actions の `release.yml`（タグ push）で作成します。

---

## テスト

### Go

`main.go` の `//go:embed all:frontend/dist` を満たすため、`frontend/dist` プレースホルダを作ってから実行します。

```bash
cd /home/runner/work/image-observer/image-observer
mkdir -p frontend/dist
touch frontend/dist/.ci-placeholder
go test ./...
```

### Frontend

```bash
cd /home/runner/work/image-observer/image-observer/frontend
npm ci
npm run test
npx tsc --noEmit
```

---

## 主要ディレクトリ

```text
docs/          # 仕様・設計メモ
frontend/      # React フロントエンド
internal/      # Go 内部パッケージ（分類・設定・監視・サムネイル等）
main.go        # Wails エントリーポイント
app.go         # Wails バインド API
wails.json     # Wails プロジェクト設定
```

---

## 参考ドキュメント

- 要件の原本: [`init.md`](./init.md)
- 実装方針ログ: [`docs/todo.md`](./docs/todo.md)
- 各機能仕様: [`docs/spec-*.md`](./docs/)
