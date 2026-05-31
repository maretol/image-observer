# UI 文字列の外部データ化 仕様書 (spec-ui-string-catalog.md / #83)

> **ステータス**: Phase 1 実装中。§9 決定事項 はユーザー合意済み (案 A = 段階移行)。
> 種別: 軽量 spec (`difficulty:medium` / `impact:low`)。新ライブラリ導入なし・新 IPC なし・永続化変更なし。

関連 issue: #83「UIの文字データを外部データに切り替える」
本文: 「多言語対応とセットになるがその前に日本語だけでもUI変更がしやすいようにマップデータに対応させる」

## 0. 改訂履歴

| 日付 | 版 | 変更内容 |
|------|----|---------|
| 2026-05-31 | 0.1 | 初版ドラフト |
| 2026-05-31 | 0.2 | D-6 = 案 A (段階移行) で合意。Phase 1 実装着手。Phase 1 の実スコープを「shared dialogs + 設定ダイアログ + 各セクション + TagColorsView」に確定し、`KeybindingsTable` (自己完結のデータ表) と `<code>`/`<strong>` を文中に挟む 2 ブロックは Phase 2 に明示的に繰り延べ。 |

## 1. ゴール (DoD)

- フロントの **ユーザーに表示される日本語文字列** を、コンポーネント内のハードコードから **単一のメッセージカタログ (マップデータ)** に集約する。
- 文字列の取得は `t(key, params?)` 関数経由に統一する。`key` は **型 (union) で縛られ**、存在しないキーや欠けたプレースホルダは `tsc --noEmit` で検出できる。
- パラメータ入りメッセージ (例: `ビューア "X" を閉じますか?`) は **プレースホルダ + 補間** でカタログに収まる (テンプレートリテラルを各所に散らさない)。
- **多言語切替は実装しない** (ja 固定)。ただしカタログを差し替えるだけで将来 locale を増やせる構造にする (i18n の前段)。
- フロントに **新ライブラリを追加しない** (CLAUDE.md クイックリファレンス遵守)。React 標準のみ。`t` は純関数 (hook / context 不使用)。
- `npm --prefix frontend run typecheck` / `npm --prefix frontend test` / 既存 vitest が通る。挙動・文言は現状と完全一致 (見た目の回帰ゼロ)。

## 2. 用語

| 用語 | 意味 |
|------|------|
| カタログ (catalog) | キー → 文言 のマップ。`Record<MessageKey, string>` 1 個 (ja)。 |
| メッセージキー (key) | `<feature>.<文脈>.<用途>` のドット区切り文字列。例: `viewer.close.confirm`。 |
| `t(key, params?)` | カタログからキーで文言を引き、`params` で `{placeholder}` を埋めて返す純関数。 |
| プレースホルダ | カタログ文言中の `{name}` 等。`params` のキーと対応。 |

## 3. データモデル (新規構造)

新ライブラリなし。`frontend/src/shared/messages/` に閉じる。

```
frontend/src/shared/messages/
├── ja.ts        # カタログ本体: as const のフラットなオブジェクト
├── t.ts         # t(key, params?) 関数 + MessageKey 型 + 補間ロジック
├── t.test.ts    # 補間 / 欠落キー / 余剰・欠落 param の挙動テスト
└── index.ts     # re-export (t, MessageKey)
```

### 3.1 カタログ (`ja.ts`)

```ts
// フラット・ドット区切りキー。`as const` でリテラル型を固定し、
// MessageKey = keyof typeof ja を導出する。値に {name} 等のプレースホルダ可。
export const ja = {
  "common.cancel": "キャンセル",
  "common.yes": "はい",
  "viewer.close.confirm": 'ビューア "{name}" を閉じますか?\n{count} 個のタブが破棄されます。',
  "viewer.limit.reached": "ビューア数の上限 ({max}) に達しました",
  "list.bulk.openTabs": "{count} 件をタブで開く{suffix}",
  // ... 既存のハードコード文字列をすべてここへ
} as const
```

- **キー命名規約**: `<feature>.<文脈>.<用途>`。feature は `common` / `viewer` / `list` / `settings` / `thumbnail` 等 (`features/` 配下のディレクトリ名に概ね対応)。横断的なものは `common.*`。
- フラット構造を採用 (ネストより grep しやすく、`keyof` で union が素直に出る)。

### 3.2 `t()` 関数 (`t.ts`)

```ts
import { ja } from "./ja"

export type MessageKey = keyof typeof ja

// params の {key} を順に置換。未知キーは __MISSING__ + warn ログ (本番でも
// 落とさず可視化)。プレースホルダ過不足は警告のみ (描画は継続)。
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const tmpl = ja[key] ?? `__MISSING:${key}__`
  if (!params) return tmpl
  return tmpl.replace(/\{(\w+)\}/g, (_, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}
```

- 戻りは常に `string`。`t("viewer.close.confirm", { name, count })` の形で呼ぶ。
- `MessageKey` union により、タイポ・廃止キーは tsc が検出。
- **補間プレースホルダ自体の型保証まではしない** (キー単位で param 名を型に出すのは型レベルが重くなりすぎる)。過不足は runtime warn + テストで担保 (§8)。

### 3.3 なぜ hook / context にしないか

ja 固定で locale 切替がないため、`t` は **モジュールレベルの純関数** で十分。context/hook にすると全描画への配線と re-render 検討 (= AGENTS.md H-8 同期モデル) が必要になり、軽量化の主旨に反する。将来 locale 切替を入れる時に `t` を hook 化 or `t(key, params, locale)` へ拡張する (§10 Out of scope)。

→ **本 issue は async event source が同一 state を mutate する変更を含まない**ため、H-8 同期モデル表は N/A (CLAUDE.md「非同期処理の着手前ルール」非該当)。

## 4. 対象範囲 (どの文字列を移すか)

| 種別 | 対象 | 例 |
|------|------|----|
| 画面に描画される本文・ボタン・見出し | ✅ 対象 | `<button>キャンセル</button>`、見出し、空状態テキスト |
| `aria-label` / `title` / `placeholder` の日本語 | ✅ 対象 (a11y も UI 文言) | `aria-label={`ビューア "${name}" を閉じる`}` → `t("viewer.close.aria", {name})` |
| トースト / 確認ダイアログ文言 | ✅ 対象 | `toast(t("list.load.failed", {msg}), "error")` |
| キーバインド表 (`KeybindingsTable.tsx`) の action / scope | ✅ 対象 (件数多め・別キー名前空間 `keybinding.*`) | |
| `ConfirmDialog` の既定ボタン (`キャンセル` / `はい`) | ✅ 対象 → `common.cancel` / `common.yes` | |
| logger / console メッセージ | ❌ 対象外 (開発者向け) | `logger.info("viewer-set", ...)` |
| ソースコメント | ❌ 対象外 | |
| Go 側の文字列 (`state.go` の `ビューア %d` 既定名 等) | ❌ 本 issue 対象外 (§10) | フロントの「UI文字データ」に限定。Go 連携は別途 |

> 実際の対象文字列は実装時に grep (`[\x{3040}-\x{30ff}\x{4e00}-\x{9fff}]`) で全列挙し、移行漏れを潰す。件数はドキュメントに固定しない (AGENTS.md A-1: 動く値は書かない)。

## 5. 画面・操作

UI の見た目・挙動・文言は **一切変えない**。内部実装 (文字列の出どころ) だけを差し替える純リファクタ。

## 6. IPC

**追加・変更なし。**

## 7. 永続化

**変更なし** (settings.json / state.json スキーマに影響しない)。

## 8. テスト

- `t.test.ts` (新規, 純関数):
  - 補間: `t("viewer.close.confirm", {name:"A", count:3})` が期待文字列。
  - param 省略時はテンプレートをそのまま返す。
  - 未知キー (型を握り潰した場合) は `__MISSING:...__` を返す。
  - 余剰 param は無視、欠落プレースホルダは `{name}` のまま残す (落ちない)。
- **カタログ網羅テスト**: `ja` の全キーが空文字でないこと。重複キー (= 同一文字列で別キー) は許容。
- 既存 vitest: 文言をアサートしているテスト (例: `watcherPolicy.test.ts` がメッセージ文字列を期待しているなら) は `t(...)` 呼び出しに合わせて更新。**期待文字列は変えない**ので、`t("...")` の戻りと突き合わせる形にする。
- 型チェック: 移行後 `tsc --noEmit` でキー誤りゼロを担保。

## 9. 決定事項 (レビューで合意してから着手)

- **D-1 (構造)**: カタログは **フラットなドット区切りキー** の `as const` オブジェクト 1 個。`MessageKey = keyof typeof ja`。ネスト構造は採らない。
- **D-2 (取得 API)**: `t(key, params?)` の **純関数**。hook / context にしない (ja 固定のため)。
- **D-3 (補間)**: `{placeholder}` 形式 + 正規表現置換。param 名の型保証はキー union までとし、プレースホルダ過不足は runtime warn + テストで担保。
- **D-4 (対象範囲)**: フロントの描画文言 + a11y 属性 (aria-label / title / placeholder) を対象。logger / console / コメント / Go 側文字列は対象外 (§4)。
- **D-5 (配置)**: `frontend/src/shared/messages/`。`shared` 配下なので全 feature から import 可、shared → feature 依存を作らない (context.md §12 の境界順守)。
- **D-6 (Phase 分割)**: **案 A (段階移行) で合意・採用**。
  - **案 A (採用)**: Phase 1 で `t()` 基盤 + カタログ + 型 + テストを入れ、代表 feature (`shared/components` の dialogs + `settings` 一式) を移行。Phase 2 以降で feature 単位 (classification / viewer-grid / App / KeybindingsTable) に分割 PR。→ 巨大 1 PR を避け、レビュー往復を抑える。
  - **案 B (不採用)**: 全文字列を 1 PR で移行。差分が大きくレビューしにくい。
  - Phase 1 PR は `Closes #83` ではなく「#83 の基盤 + 一部移行」とし、残りは同 issue 内 Phase 2 で消化 (issue は open のまま)。
- **D-7 (mixed-markup の据え置き)**: `<code>` / `<strong>` を**文中に挟む**テキスト (MergePromptDialog の `<p>`、TagColorsView 末尾の hint) は、flat string catalog では markup span を表現できないため Phase 1 では移行しない。コード内にコメントで明示。Phase 2 でリッチフォーマッタ (例: 文字列 + 既知トークンの分割 or `Trans` 風コンポーネント) を検討してから対応する。

## 10. Out of scope (本 issue では作らない)

- **多言語切替 UI / 複数 locale** (en 等)。本 issue は ja カタログ化まで。`t` を将来 locale 対応に拡張する余地だけ残す。
- **Go 側文字列の外部化** (`internal/state` の既定ビューア名等)。フロントと別レイヤなので追従 issue。
- **複数形 (plural) / 日付・数値フォーマットの locale 化**。
- **動的なカタログ差し替え / ホットリロード**。

## 11. Phase 分割

- **Phase 1 (本 PR)**: `shared/messages/` (`ja.ts` / `t.ts` / `index.ts` / `t.test.ts`) 新設 + 移行:
  - `shared/components/`: ConfirmDialog / ConflictDialog / MergePromptDialog / Toast
  - `settings/`: SettingsDialog + sections (Logging / Appearance / Viewer / Thumbnail / List) + TagColorsView
  - 据え置き (Phase 2): KeybindingsTable、D-7 の mixed-markup 2 ブロック。
- **Phase 2+**: KeybindingsTable + 各 feature view (classification / viewer-grid / App / TopTabsBar 等) を feature 単位で順次移行。各 PR は「文言不変・型チェック緑」を DoD にする。D-7 の mixed-markup 対応もここで方式を決めてから着手。
