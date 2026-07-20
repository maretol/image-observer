# ビューアタブ最大数の設定化 実装仕様書 (#148)

ビューアタブの最大数 (現在 `MAX_VIEWERS = 8` 固定) を設定 (settings.json) で変更できる
ようにする。既定は現行どおり 8、許容レンジは 1..32。上限強制は「追加時の gate」のみとし、
設定を下げても開いている viewer / 復元 session は壊さない (§7 D2)。

> **ステータス**: ユーザー合意済み (2026-07-20)。D1〜D5 を初版どおり採用して実装。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-07-20 | 初版ドラフト | issue #148 を受けて起案。settings additive field + state ハードキャップ 32 + add-gate 方式。 |
| 2026-07-20 | 実装 + セルフレビュー反映 | D1〜D5 初版どおり実装、DoD チェック。レビュー指摘で TS 側に D-1 pin テスト (viewers.test.ts) と `MIN_VIEWERS` 定数を追加 (§6 の定数群に含める)。 |
| 2026-07-20 | 検証パス反映 (§13) | 多段レビュー (finder 2 系統 + 指摘ごとの反証エージェント) で確定した 4 件に対応: settings.Load の型不一致 fallback / useSettings 直列化 (§13.2 に同期モデル表) / MaxViewers 境界受理テスト / useViewerSet hook テスト新設。 |

---

## 1. ゴール (DoD)

- [x] 設定ダイアログから「ビューアタブの最大数」(1..32) を変更できる
- [x] 変更は保存後すぐ反映 (再起動不要): + ボタンの活性 / 追加拒否 toast が新上限に追従
- [x] 上限を現在の open viewer 数より下げても既存 viewer は閉じられない (追加だけ拒否)
- [x] settings.json への保存 / 復元、欠落・不正値の per-field fallback (既定 8)
- [x] state.json 復元で 9..32 個の viewer が truncate されない (ハードキャップ 32 のみ適用)
- [x] Go / フロントのテストが上記境界を検証する

## 2. 用語

| 用語 | 意味 |
|------|------|
| 設定上限 (`maxViewers`) | ユーザーが settings で選ぶ上限。**追加時の gate にのみ**使う |
| ハードキャップ (`maxViewersHard = 32`) | garbage 除去のための絶対上限。state 復元 truncate と settings Validate の上界に使う |

## 3. データモデル / settings.json (additive、version bump なし)

`SettingsData` に追加 (settings.go の per-field fallback 方針に従う):

```go
// MaxViewers はビューアタブの追加上限 (#148)。追加時 gate のみで、下げても open 中の
// viewer は閉じない。範囲外 / 欠落は既定 8 に fallback。
MaxViewers int `json:"maxViewers"`
```

- 既定値: `defaultMaxViewers = 8` / 範囲: `minMaxViewers = 1` .. `maxViewersHard = 32`
- 欠落時: encoding/json のゼロ値 0 は範囲外なので、既存の範囲チェックだけで既定 8 に落ちる。
  **probe 不要** (DuplicateThreshold と違い 0 が正当値でないため)
- `Validate` / `applyFieldDefaults` に範囲チェックを追加 (他の数値 field と同型)

## 4. 画面 / 操作

### 4.1 設定ダイアログ

- 数値入力 (1..32) を追加。ラベル「ビューアタブの最大数」、補足文言「9 個目以降のタブには
  ショートカット (Ctrl+Shift+2〜9) が割り当たりません」
- 配置は既存の数値設定 (サムネイルサイズ等) と同じ入力パターン / section 構成に従う
  (実装時に SettingsFields / sections の現物に合わせる)

### 4.2 タブ追加の gate (挙動変更なし、上限値だけ動的化)

- TopTabsBar の + ボタン: `viewers.length >= maxViewers` で disabled + tooltip (既存 prop のまま、
  渡す値を settings 由来に変更)
- useViewerSet の追加拒否 toast: 文言中の上限数を live 値に

### 4.3 上限を open 数より下げた場合

- 既存 viewer は**一切閉じない**。追加だけ拒否 (+ ボタン disabled / toast)
- 特別な警告 UI は出さない (数が上限超のままでも通常操作可能)

### 4.4 キーバインド

- Ctrl+Shift+2..9 は従来どおり viewer 1..8 の切替のみ。9 個目以降はクリック / タブ操作でのみ
  アクティブ化 (キーバインド拡張は Out of scope §10)
- KeybindingsTable の説明と viewers.ts / state.go の「8 はキーバインド範囲」コメントを
  「既定 8。上限は settings.maxViewers (ショートカットは先頭 8 個まで)」に更新 (H-6)

## 5. IPC

なし。既存の settings Load / Save 経路 (Wails 公開済み) に乗るだけ。

## 6. フロント配線

`maxImagePixelsMP` と同じ「settings live 値 + 定数 fallback」パターン (App.tsx:86-93 参照):

- `viewers.ts`: `MAX_VIEWERS = 8` は**既定値 (settings ロード中 fallback) として存続**。
  `addViewer(set, max = MAX_VIEWERS)` のように上限を引数化。`ViewerSet.viewers` の不変条件
  コメントは「長さ 1..32 (ハードキャップ)」に更新。設定 UI の入力範囲用に `MIN_VIEWERS = 1` /
  `MAX_VIEWERS_HARD = 32` も export し、Go 側リテラルとのドリフトは viewers.test.ts の
  D-1 pin テストで検知 (duplicateDetect.test.ts と同じ流儀)
- `useViewerSet`: opts に `maxViewers?: number` (fallback `MAX_VIEWERS`) を追加し、
  追加 gate / toast / addViewer 呼び出しに使う
- `App.tsx`: `settings.data?.maxViewers ?? MAX_VIEWERS` を計算し、useViewerSet opts と
  TopTabsBar の既存 prop `maxViewers` の両方に渡す

## 7. Go 側 state 検証 (state.json は schema bump なし)

- `state.go` の `maxViewers = 8` を `maxViewersHard = 32` にリネームし、`validateState` の
  truncate は 32 超のみに緩和
- 理由 (D2): `validateState` の役目は garbage 除去。ユーザー上限は「追加時 gate」(フロント)
  で強制するので、復元時に設定値で truncate すると「設定を下げた → 再起動 → open していた
  viewer が消える」というデータ破壊が起きる。ハードキャップは settings の上界 (32) と一致
  させ、それを超える state だけ捨てる
- state パッケージは settings に依存しない (現状どおり独立を維持)

## 8. 同期モデル (CLAUDE.md 着手前ルール / AGENTS.md H-8)

**H-8 マトリクス不要と判断**: 本変更で mutate される state は settings (既存の単一
Save 経路) と ViewerSet (既存の追加 gate の上限値が変わるだけ) で、新しい async event
source を導入しない。上限値は render 時に props で流れる純データ。

## 9. 決定事項 (合意対象)

| # | 決定 | 内容 |
|---|------|------|
| D1 | ハードキャップ 32 | settings 上界 = state truncate 上界 = 32 で一致させる |
| D2 | add-gate 方式 | 上限強制は追加時のみ。下げても既存 viewer / 復元 session を壊さない |
| D3 | キーバインドは 8 まで | Ctrl+Shift+2..9 は据え置き。9 個目以降はマウス操作のみ |
| D4 | 既定 8 / 範囲 1..32 | 既定は現行値を維持。probe 不要 (0 は不正値) |
| D5 | 再起動不要 | settings live 値を props で流す (maxImagePixelsMP と同型) |

## 10. Out of scope

- パネル分割上限 `MAX_PANELS` の設定化 (別軸。要望が出たら別 issue)
- 9 個目以降へのキーバインド割当 (Ctrl+Shift+10 は物理的に存在しない)
- タスクバーからのタブ切替 (#149)
- タブバーの overflow UI 改善 (32 個開いたときの横スクロール等は現状の挙動のまま)

## 11. テスト

- `settings_test.go`: `maxViewers` 欠落→8 / 0→8 / 33→8 / 1・32→そのまま / Validate 範囲外エラー
- `state_test.go`: 既存の truncation テストを 32 超→32 に更新 (9..32 個は温存されることを追加検証)
- `viewers.test.ts`: `addViewer` の max 引数化 (max 到達で拒否 / max 未指定は 8 fallback /
  max より多い viewers を持つ set への add も拒否)
- 手動確認 (wails dev): 設定変更→+ ボタン活性が即追従 / 上限超に下げても viewer が残る

## 12. Phase 分割

単一 Phase (1 PR)。

## 13. PR #151 検証パスで確定した対応 (2026-07-20)

多段レビュー (correctness / test-coverage の finder 2 系統 → 指摘ごとに反証エージェントで
実証再現) で CONFIRMED になった 4 件。13.1 / 13.2 は既存の repo 全体の問題で #148 が導入した
ものではないが、`maxViewers` も影響を受けるため本 PR で修正する (ユーザー指示)。

### 13.1 settings.Load: 型不一致 1 field で全設定が飛ぶ (既存)

`json.Unmarshal(data, &s)` の `*json.UnmarshalTypeError` を fatal 扱いしていたため、
`"maxViewers": 8.5` のような型不一致が 1 つあると per-field fallback に到達する前に
`DefaultSettings()` へ全落ちしていた (tagColors 等の正当な値も消える)。encoding/json は
型エラーの field をゼロ値のまま skip して sibling の decode を継続する (最初のエラーだけ返す)
ので、型不一致は fatal にせずログして続行し、既存の `applyFieldDefaults` + probe に不正 field の
reset を委ねる。構文エラー等 (文書全体が読めない) は従来どおり defaults へ。

### 13.2 useSettings.update: lost-update race (既存)

`update` が `useCallback([data])` で render 時点の `data` snapshot を閉じ込めるため、IPC
round-trip 中に 2 発目の編集が走ると両者が同じ旧 `data` から `next` を作り、後着応答が先の
変更を silent に上書きしていた (例: maxViewers 8→3 の直後に wheelMode を変更すると 8 に戻る)。

**修正**: 最新値は `dataRef` で持ち、update / reset を promise chain (`queueRef`) で直列化。
各 update は前の save 完了後に `dataRef.current` (= 直前の save 結果) から `next` を作る。

同期モデル (H-8):

| event source | capture する値 | stale 化リスク | gate 方針 |
|---|---|---|---|
| mount 時 GetSettings | 応答 s | unmount 後の応答 | `cancelled` flag (既存のまま) |
| update(patch) | patch のみ (data は capture しない) | closure の旧 data → **廃止** | 実行時に `dataRef.current` を読む + queue 直列化 |
| reset() | なし | update と交錯 | 同じ queue で直列化 |
| Save 応答 | saved | 並行応答の順序不定 | 直列化により常に 1 in-flight |

### 13.3 / 13.4 テスト補強

- `settings_test.go`: `MaxViewers = 1 / 32` (境界そのもの) が Save→Load を素通りすることを
  検証 (§11 の「1・32→そのまま」を実テスト化。off-by-one ミューテーションが suite を
  すり抜けることを実証済みだったため)
- `useViewerSet.test.ts` 新設: `maxViewersRef` + effect 同期 + addViewer gate の hook 配線を
  renderHook で検証 (純関数 `addViewer` のみだった coverage の穴。maxPixelsRef と同型ブロック
  ゆえのコピペ事故を将来検知する)
