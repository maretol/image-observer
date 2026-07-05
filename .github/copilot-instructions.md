# Copilot Instructions

## プロジェクト概要

Wailsを利用した、Go+Reactのネイティブアプリケーション。現在はWindows向けのみで開発中。画像ビューアアプリケーション

## リポジトリ構成

```
docs/          # ドキュメント。Claude Codeで実装する際に利用
frontend/      # フロントエンド（React）。`wails build`でGoのmainパッケージに組み込まれる
internal/      # Goの内部パッケージ。テストコードもここに置く
main.go        # Goのエントリーポイント。`wails build`でフロントエンドと組み合わされる
wails.json     # Wailsのプロジェクト設定ファイル
.github/        # GitHub関連。ワークフローやCopilot Instructionsなど
```

## 前提条件

- Node.js 22+、npm 10+
- wails application
- Go 1.26


## レビュー方針

レビューでは、セキュリティとパフォーマンスを特に重視してレビューしてください
デザイン、挙動に関するレビューは、ユーザビリティの観点から行ってください。コードの可読性や保守性も重要なポイントです。

## 使用言語

レビューコメントやコード提案の説明は日本語にしてください。
コード提案は、GoとReact（JavaScript/TypeScript）でお願いします。

## コメント方針

コード内コメントは以下の方針に統一する。新規提案でもレビューでもこの基準に従うこと。

- **「何をするか」は書かない**。目的は関数名・シグネチャ・内部処理から読み取れるため、復唱しない。
- **非自明な「なぜ」だけを簡潔に残す**。godoc は `// 名前 は…` の 1 行、それ以外は 1〜3 行に畳む。
- **レビュー往復の情報は残さない**（PR 番号 / round N / suppressed-X など）。ただし判断の**理由は保持**する。
- 日本語に寄せる。技術用語（IPC / ref / mtime / inotify / syscall / HWND など）は英語のまま。

### 残すべきコメント

- spec 参照（`spec-*.md §X`）/ AGENTS.md 参照（D-1 など）/ issue 参照（`#129` など）
- race / 並行処理の非自明な前提（event の順序契約、OS 固有の timing 依存など。load-bearing なので削らない）
- Win32 / syscall の構造前提（フィールド順一致、int32 saturation など）
- module の役割を示す file header、挙動を要約する behavior-summary の表・箇条書き

### レビュー時の扱い

- 簡潔なコメントを「説明不足」として**追記を求めない**。上記方針では意図的に短くしている。
- 手続きをなぞる冗長なコメントや目的の復唱には、むしろ**削減を提案**する。