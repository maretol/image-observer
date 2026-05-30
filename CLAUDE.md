# image-observer

Wails (Go + React/TS) で実装する Windows 向け画像ビューア。**プロジェクトの全体像 / 確定方針 / 技術スタック / 開発環境の特殊事情** は [.claude/context.md](.claude/context.md) を参照すること。新規セッション開始時に必ず一読する。

過去の PR レビューで複数回繰り返し指摘されたパターンは [AGENTS.md](AGENTS.md) に集約してあるので、新しいコードを書く前に該当しそうな節を確認する。

## 一次ソースの優先順位

1. [init.md](init.md) — 要求 / 要件 / スコープ (元仕様、変更しない)
2. [docs/todo.md](docs/todo.md) — 方針決定ログ (実装着手前の意思決定はここに記録)
3. [docs/spec-*.md](docs/) — 各フェーズの実装仕様書 (実装着手時の参照)

## クイックリファレンス

- Go バージョン: `goenv global` (現在 1.26.2) に従う。プロジェクトに `.go-version` は置かない。
- 開発機は WSL2 / Ubuntu 22.04。`wails dev` / `wails build` は Linux ターゲットで OK (本番 EXE 化は将来課題)。
- フロント追加ライブラリは原則入れない (アイコンも SVG 直書き)。導入時は事前に合意を取る。

## 非同期処理の着手前ルール

複数の async event source (blur / change / IPC completion / EventsOn / unmount cleanup /
setTimeout 等) が **同一の state を mutate** する機能を実装するときは、**最初の commit を
`docs/spec-*.md` の「同期モデル」表**にする (機能コードより先)。各 event source について
capture したい値 / stale 化リスク (mtime / folder / dirty / touched / inflight) / gate 方針を
列挙してから配線を書く。テンプレと詳細マトリクスは [AGENTS.md](AGENTS.md) H-8 を参照。

PR #75 (16 round) / PR #109 (6 round) は着手前マトリクスを書かず、1 round 1 経路ずつ race の
穴が顕在化した。レビュー往復が 3 round を超えたら立ち止まる規約は [AGENTS.md](AGENTS.md) I-1。
