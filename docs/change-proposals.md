# 変更案（Issue登録用まとめ）

以下は、分割してIssue登録できる変更案の一覧です。

## 1. refactor(settings): SettingsDialog.tsx の責務分割
- 対象: `frontend/src/components/SettingsDialog.tsx`
- 目的: UI表示・入力制御・設定更新ロジックの分離
- 変更案:
  - セクション別コンポーネントへ分割
  - 共通入力（数値入力/トグル）を共通化
  - アイコン描画や説明文を責務ごとに整理
- 完了条件:
  - 既存挙動を維持したまま可読性/保守性が向上
  - 既存テストが通過

## 2. refactor(viewer-grid): useViewerSet.ts の操作ロジック分割
- 対象: `frontend/src/features/viewer-grid/useViewerSet.ts`
- 目的: ビューワー集合操作の重複排除と見通し改善
- 変更案:
  - openMany 系処理の共通化
  - 追加/削除/置換の処理境界を明確化
  - 補助関数を機能別に整理
- 完了条件:
  - 同一挙動を保ったまま重複コードが削減される
  - 関連ユニットテストが通過

## 3. refactor(classification): useClassification.ts の非同期フロー分離
- 対象: `frontend/src/features/classification/useClassification.ts`
- 目的: 非同期処理の責務分離とエラー経路の明確化
- 変更案:
  - load/edit/conflict/merge/delete を機能単位で分割
  - 例外処理とUI通知の境界を整理
  - 競合解決分岐を読みやすく再編
- 完了条件:
  - 既存の分類編集フローと互換
  - 関連テストが通過

## 4. refactor(app): App.tsx のトップレベル状態管理分離
- 対象: `frontend/src/App.tsx`
- 目的: 画面統合ロジックの複雑度低減
- 変更案:
  - ViewerTab 周辺の状態管理を専用フック/モジュールへ分離
  - UI構成と状態遷移ロジックを切り分け
  - モーダル/通知制御を責務単位で整理
- 完了条件:
  - UI挙動を維持しつつ `App.tsx` の責務が縮小
  - 既存テストが通過

## 5. refactor(viewer-layout): layout.ts の機能別モジュール化
- 対象: `frontend/src/features/viewer-grid/layout.ts`
- 目的: レイアウト計算ロジックの保守性向上
- 変更案:
  - ドメイン関数を機能別ファイルへ分割
  - 入出力契約を明確化
  - テスト対象単位を細分化
- 完了条件:
  - 既存レイアウト結果が維持される
  - レイアウト関連テストが通過

## 6. refactor(image-view): ImageView.tsx の表示/操作ロジック分離
- 対象: `frontend/src/components/ImageView.tsx`
- 目的: 表示処理とインタラクション処理の分離
- 変更案:
  - zoom/pan/drag のイベント管理を専用ロジックへ移動
  - 描画状態と入力状態の依存を整理
  - 後続機能追加時の影響範囲を限定
- 完了条件:
  - 操作性（ズーム/パン/ドラッグ）を維持
  - 関連テストまたは既存検証が通過

## 7. refactor(css): App.css の機能別分割
- 対象: `frontend/src/App.css`
- 目的: スタイル保守性と変更影響の見通し改善
- 変更案:
  - viewer/classification/settings/shared などに分割
  - 既存クラス名との対応表を保ちながら段階移行
  - 不要/重複ルールを整理
- 完了条件:
  - 見た目・操作性の退行がない
  - ビルドと既存テストが通過

## 8. refactor(go-state): state.go の責務分割
- 対象: `internal/state/state.go`
- 目的: 永続化・検証・ID生成ロジックの分離
- 変更案:
  - 状態保存/読込と検証ロジックを分離
  - ID生成規約を明示しテスト可能にする
  - エラーハンドリング経路を整理
- 完了条件:
  - 既存の保存・復元挙動を維持
  - `go test ./internal/...` が通過

## 備考
- 1Issue=1責務を原則に、依存がある場合は親Issueで順序を定義する。
- まずはリスクの低い分割（`layout.ts` / `App.css`）から着手する。
