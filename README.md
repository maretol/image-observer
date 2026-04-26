# image-observer

Wails (Go + React/TypeScript) で実装する Windows 向け画像ビューア。VSCode 風の2ペイン UI に、フォルダツリー上のサムネイル表示を加えたものを目指す。

現状はリポジトリ初期化フェーズ (Hello World) のみ完了。ツリー / サムネイル / タブ / ズーム等の機能は未実装。

## 必要環境

- Go 1.22 以降 (本リポジトリの開発時バージョンは 1.26.2、`goenv` の global で管理)
- Node.js 20 以降 + npm
- Wails CLI v2.10 以降 (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`)
- 実行ターゲットが Windows の場合: WebView2 ランタイム (Win11 標準搭載)
- Linux で開発 / 動作確認する場合: `libgtk-3-dev` `libwebkit2gtk-4.0-dev` 等 (`wails doctor` で確認)

`wails doctor` を実行し、すべて Installed / SUCCESS であることを確認してから始める。

## 開発起動 (ホットリロード)

```bash
wails dev
```

Wails のネイティブウィンドウが開き、左ペイン "Folder" / 右ペイン "Viewer" の2分割レイアウトと、間にスプリッターが表示される。スプリッターをドラッグすると左ペイン幅が変わる。

フロントエンドのみブラウザで触りたい場合は <http://localhost:34115> に接続することで Go 側のメソッドを devtools から呼べる。

## リリースビルド

```bash
wails build
```

成果物は `build/bin/` に出力される。

- Linux 上でビルドした場合: `build/bin/image-observer` (ELF 実行ファイル)
- Windows 上でビルドした場合: `build/bin/image-observer.exe`

Windows EXE を作るには Windows 環境上で `wails build` を実行するのが基本。クロスコンパイルは Wails 公式ドキュメント (<https://wails.io/docs/guides/crosscompile>) を参照。

## 現状のスコープ

Hello World 完了 (`init.md` セクション 4 の DoD 達成):

- [x] `wails doctor` OK
- [x] `wails dev` で起動するシェル UI
- [x] `wails build` で実行ファイル生成
- [x] 左右2ペインのレイアウト + スプリッターでペイン幅可変
- [x] `git init` 済み / `.gitignore` 整備済み
- [x] README に手順記載

未実装 (次フェーズ以降):

- フォルダ選択ダイアログとフォルダツリーの再帰列挙 (F1, F2)
- サムネイル生成・表示・ディスクキャッシュ (F3, F4)
- タブ UI と画像ビューア (F5, F6)
- ホイールズーム / ドラッグパン (F7, F8)
- 対応形式: JPEG / PNG / GIF / WebP

詳細な要求 / 要件 / 仕様は [init.md](init.md) を参照。
