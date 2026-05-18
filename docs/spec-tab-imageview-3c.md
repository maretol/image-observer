# Tab + ImageView 実装仕様書 (Phase 3c) — 永続化ポリシー

> ⚠️ **state スキーマは Phase 5 で v3 → v4 に更新された。** `GridState` (rows × cols + panels[]) は廃止され、BSP ツリーの `LayoutState` に置換された。現行スキーマの正本は [spec-viewer-flexlayout.md](spec-viewer-flexlayout.md) §7。

Phase 3c で確定した以下の **永続化ポリシー** は引き続き有効:

- **保存先**: `os.UserConfigDir()/image-observer/state.json`
- **アトミック書き込み**: `.tmp` ファイルに書いてから `os.Rename` で差し替え (破損リスク低減)
- **debounce 500ms**: 状態変化後 500ms の静止で保存 (連続変更で書き込み洪水を防ぐ)
- **Version 不一致 → default fallback**: スキーマバージョンが合わない / パース失敗時は warn ログ + デフォルト起動 (アプリは必ず起動できる)

現行の Go 実装は `internal/state/state.go`、フロント実装は `frontend/src/features/session/` を参照。

Phase 3c 設計の詳細 (GridState 等の廃止スキーマ) が必要な場合は `git log -- docs/spec-tab-imageview-3c.md` を参照。
