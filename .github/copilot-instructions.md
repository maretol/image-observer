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