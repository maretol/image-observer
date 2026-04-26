# image-observer

Wails (Go + React/TS) で実装する Windows 向け画像ビューア。**プロジェクトの全体像 / 確定方針 / 技術スタック / 開発環境の特殊事情** は [.claude/context.md](.claude/context.md) を参照すること。新規セッション開始時に必ず一読する。

## 一次ソースの優先順位

1. [init.md](init.md) — 要求 / 要件 / スコープ (元仕様、変更しない)
2. [todo.md](todo.md) — 方針決定ログ (実装着手前の意思決定はここに記録)
3. [spec-*.md](.) — 各フェーズの実装仕様書 (実装着手時の参照)

## クイックリファレンス

- Go バージョン: `goenv global` (現在 1.26.2) に従う。プロジェクトに `.go-version` は置かない。
- 開発機は WSL2 / Ubuntu 22.04。`wails dev` / `wails build` は Linux ターゲットで OK (本番 EXE 化は将来課題)。
- フロント追加ライブラリは原則入れない (アイコンも SVG 直書き)。導入時は事前に合意を取る。
