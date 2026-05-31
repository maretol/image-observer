# タグ未付与フィルタ (未分類だけ表示) 実装仕様書

> **ステータス**: §8 決定事項 **合意済み (2026-05-31)** → 実装着手。D1 = **A (無バンプ additive / schema は v6 据え置き)** / D2 = 独立 boolean (`untaggedOnly`) + 排他モード / D3 = 「すべて」の直後に固定 / D4 = 0 件でも常時表示。

issue [#116](https://github.com/maretol/image-observer/issues/116) に対応する。一覧 (分類) タブで **タグが 1 つも付いていない画像 (未分類) だけに絞り込む** 手段を追加する。

## 改訂履歴

| 日付 | 変更 |
|------|------|
| 2026-05-31 | 初版ドラフト。現状調査・設計案・決定事項を整理。triage 合意 (独立 boolean + 排他モード) を反映。 |
| 2026-05-31 | レビュー合意: D1 = A (無バンプ additive)、D3 = すべての直後固定、D4 = 0 件でも表示。実装着手。 |

## 1. ゴール (DoD)

- 一覧タブのタグチップ行 (`TagChips`) に **「未分類」チップ** が表示され、未付与エントリの件数が出る。
- 「未分類」チップを押すと、`extractTags(folder)` が空のエントリ (= `folder === ""` 相当) **だけ** がグリッドに表示される。
- 排他モード: 「未分類」選択中に通常タグを押すとそのタグ選択へ切り替わり (未分類は解除)、逆も同様。「すべて」で両方クリア。
- confidence / query フィルタは従来どおり独立に AND 合成される (未分類 × confidence × query が成立)。
- 選択状態がセッション復元 (`state.json`) で round-trip する (他フィルタと同水準で永続化)。
- `npm --prefix frontend run typecheck` / `npm --prefix frontend test` / `go test ./...` が緑。
- `wails dev` で ①未分類チップに件数表示 ②押すと未分類だけ表示 ③通常タグとの排他切り替え ④再起動後に選択復元、を確認できる。

## 2. 用語

- **未分類 (untagged)**: `extractTags(entry.folder).length === 0` のエントリ。サイドカー上は `folder === ""`。Card 上では既に `(未分類)` グレーバッジで表示される。
- **排他モード**: 「未分類」フィルタと通常タグ選択 (`tags[]`) が同時に立たない UI 制約。どちらかを選ぶと他方は解除される。
- **無バンプ additive**: state schema のバージョンを上げず、`ListFilterState` に後方/前方互換な省略可能フィールドを足す方式 (§5.3 D1)。

## 3. 背景・現状調査

### 3.1 現状のフィルタ機構 (フロント完結 / IPC なし)

| 層 | 実装 | 現状 |
|----|------|------|
| フィルタ型 | `features/classification/filters.ts` `ListTabFilter` (`tags[]` OR / `confidence` 単一 / `query`) | 「未分類だけ」を表す状態が **無い** |
| 適用 | `applyFilter(entries, f)` | `tags.length > 0` のとき OR マッチ。未分類は `extractTags("") === []` で **どのタグにもマッチしない** |
| 集計 | `tagSummary(entries)` → `TagChips` | タグ別件数のみ。未分類件数は集計対象外 |
| チップ UI | `TagChips.tsx` (`selected` / `onToggle` / `onClear`) | 「すべて」+ タグ群。未分類チップ無し |
| state hook | `useClassificationFilter.ts` (`toggleTag` / `clearTags` / `setFilter`) | tags 配列の add/remove のみ |
| 永続化 | `useSessionSave.ts` `ListPersist.filter` → Go `state.ListFilterState` (schema v6) | `tags` / `confidence` / `query` の 3 フィールドのみ |

ポイント: 既存の `applyFilter` は **未分類エントリを「どのタグにもマッチしない」もの** として扱う。よって `tags` 配列にセンチネルを混ぜる素朴案では OR ロジックを特別扱いせねばならず、永続化される `tags[]` の意味も濁る。triage では **独立 boolean フィールド + 排他モード** を採ることで合意した (§8 D2)。

### 3.2 未分類エントリの実在確認

- `extractTags` は `if (!folder) return []` で空フォルダを空配列にする (filters.ts L24)。`serializeTags` も空入力を `""` に round-trip する (L44-49)。よって「未分類 = `extractTags(folder).length === 0`」が唯一の判定式で良い (legacy/新形式どちらの保存形式でも整合)。
- Card は既に `(未分類)` バッジを出している (`Card.tsx`)。ラベル文言はこれに合わせる。

### 3.3 init.md との関係

- init.md (R1〜R7 / F1〜F10) に **タグ / フィルタの要件記述は無い** (分類タブのフィルタは Phase 4 以降の派生機能)。本 issue は init.md と矛盾せず、再解釈も不要。

## 4. 設計方針

### 4.1 データ型 (フロント)

`ListTabFilter` に boolean を 1 つ追加する:

```ts
export type ListTabFilter = {
  tags: string[];          // OR; empty = no tag filter
  untaggedOnly: boolean;   // 新規: true なら未分類だけ (tags とは排他)
  confidence: Confidence | "all";
  query: string;
};
```

### 4.2 適用 (`applyFilter`)

`untaggedOnly` を tags より優先して判定する (排他なので実際には両立しないが、防御的に well-defined にする):

```ts
if (f.untaggedOnly) {
  if (extractTags(e.folder).length > 0) return false;   // 未分類以外を除外
} else if (f.tags.length > 0) {
  const tags = extractTags(e.folder);
  if (!f.tags.some((t) => tags.includes(t))) return false;  // 既存 OR ロジック
}
// confidence / query は従来どおり後段で AND 合成 (未変更)
```

### 4.3 集計ヘルパ (テスト容易性のため純関数化)

`filters.ts` に追加:

```ts
// untaggedCount: extractTags が空になるエントリ数。未分類チップの件数表示用。
export function untaggedCount(entries: classification.Entry[]): number {
  let n = 0;
  for (const e of entries) if (extractTags(e.folder).length === 0) n++;
  return n;
}
```

### 4.4 排他モードのトグル配線 (`useClassificationFilter.ts`)

UI 制約 (排他) はチップ側ではなく **hook 側で実現** する。`TagChips` は「どれが押されたか」を伝えるだけ。

| 操作 | 結果の state |
|------|-------------|
| 通常タグ `t` を toggle | `untaggedOnly = false`、`tags` を従来どおり add/remove |
| 「未分類」を toggle | `untaggedOnly = !untaggedOnly`、ON にするとき `tags = []` |
| 「すべて」(clear) | `tags = []`、`untaggedOnly = false` |

```ts
const toggleTag = useCallback((tag: string) => {
  setFilterState((cur) => {
    const has = cur.tags.includes(tag);
    return {
      ...cur,
      untaggedOnly: false,  // 通常タグを触ったら未分類モードは抜ける
      tags: has ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag],
    };
  });
}, []);

const toggleUntagged = useCallback(() => {
  setFilterState((cur) =>
    cur.untaggedOnly
      ? { ...cur, untaggedOnly: false }
      : { ...cur, untaggedOnly: true, tags: [] },
  );
}, []);

const clearTags = useCallback(() => {
  setFilterState((cur) => ({ ...cur, tags: [], untaggedOnly: false }));
}, []);
```

initial state は `untaggedOnly: opts.initial?.untaggedOnly ?? false`。

### 4.5 UI (`TagChips.tsx`)

- props を拡張: `untaggedActive: boolean`、`untaggedCount: number`、`onToggleUntagged: () => void`。
- チップ配置: **「すべて」の直後・通常タグ群の前** に「未分類」チップを固定挿入 (§8 D3)。
- アクティブ判定の整理:
  - 「すべて」active = `selected.length === 0 && !untaggedActive`
  - 「未分類」active = `untaggedActive`
  - 通常タグ active = 従来どおり `selected.includes(tag)`
- 配色: 「未分類」チップは Card の `(未分類)` バッジと揃えたグレー系で固定 (tagColor のハッシュ配色は使わない)。className は既存 `cls-chip` を流用し、`untaggedCount === 0` のときも表示するか非表示にするかは §8 D4。

### 4.6 オーケストレータ / 永続化グルー

- `useClassification.ts`:
  - 返却型 (`UseClassificationReturn`) に `toggleUntagged` を追加し、`filter` 経由で `untaggedOnly` を公開。
  - `persistableState.filter` に `untaggedOnly` を含める (現状 tags/confidence/query の 3 つを組む箇所、L477-481 付近)。
- `useSessionSave.ts`:
  - `ListPersist.filter` 型に `untaggedOnly: boolean` を追加。
  - `buildStateData` の `list.filter` 構築に `untaggedOnly` を含める (L105-109 付近)。
- `ClassificationView.tsx`: `TagChips` への配線に新 props を渡す。

## 5. データモデル / 永続化 / マイグレーション

### 5.1 フロント永続化形式

`ListPersist.filter` / `useClassificationFilter` initial に `untaggedOnly: boolean` を追加 (上記)。

### 5.2 Go state schema (`internal/state/state.go`)

`ListFilterState` に省略可能フィールドを追加:

```go
type ListFilterState struct {
    Tags         []string `json:"tags"`
    UntaggedOnly bool     `json:"untaggedOnly"`
    Confidence   string   `json:"confidence"`
    Query        string   `json:"query"`
}
```

- `validateState`: bool は default false で安全なので追加バリデーション不要。既存の `Tags == nil → []` / `Confidence` の正規化はそのまま。
- `defaultListTabState()`: `UntaggedOnly: false` は zero 値なので明示不要 (既存コードに合わせて省略可)。

### 5.3 schema バージョンとマイグレーション — **§8 D1 で確定**

**推奨 = 無バンプ additive (schema は v6 のまま)**。根拠と互換性:

| ケース | 挙動 |
|--------|------|
| 旧 v6 ファイル (`untaggedOnly` キー無し) を新バイナリが読む | `encoding/json` が zero 値 false を代入。`version == 6` で strict 一致パスを通過。**ロスレス** |
| 新 v6 ファイル (`untaggedOnly` 有り) を旧バイナリが読む | 未知フィールドは `encoding/json` が無視。**ロスレス** (前方互換) |

→ **前方/後方とも完全互換** なので migration コード不要・データ消失リスクなし。フロント側 `STATE_SCHEMA_VERSION = 6` も据え置き。

**代替 = v6→v7 バンプ** を採る場合の必須作業 (D1 で選ぶなら):

- `StateSchemaVersion = 7` に更新 + `useSessionSave.ts` の `STATE_SCHEMA_VERSION = 7`。
- **`Load()` に `case 6:` migration を必須追加** (`migration_v6.go`)。これを書かないと既存ユーザーの v6 `state.json` (viewers / layout / folder すべて) が `default:` に落ちて **全消失する退行**。
- v5 の扱いを判断 (現状 v5→v6 を 1 世代だけ救済。v7 化で v5 を切るか v5→v6→v7 と繋ぐか)。
- migration / fallback の追加テスト。

> CollapsedGroups 追加時に v3 へバンプした precedent はあるが、現在の `Load()` は strict 一致 + 1 世代 migration 設計なので、バンプの度に migration を書かないとデータ消失する。additive bool ではバンプの便益 (トレーサビリティ) に対しコスト/リスクが見合わないと判断し、**無バンプを推奨**。triage の preview では「v6→v7 migration」と表現していたが、検証の結果 migration は不要かつ高リスクと判明したため D1 で再確認する。

## 6. 画面・操作

- タグチップ行: `[ すべて(N) ] [ 未分類(M) ] [ tagA(..) ] [ tagB(..) ] ...`
- 「未分類(M)」クリック → グリッドが未分類エントリだけになる。`tags` 選択は解除。
- 未分類表示中に「tagA」クリック → tagA フィルタへ切り替え (未分類解除)。
- 「すべて」クリック → 全表示 (tags / untaggedOnly 両クリア、confidence / query は維持)。
- アコーディオン (サブディレクトリ別グルーピング) / 複数選択 / Card 右クリック等の既存挙動には影響しない (filteredEntries の供給元が変わるだけ)。

## 7. テスト

### 7.1 フロント (vitest, 純関数中心)

- `filters.test.ts`:
  - `applyFilter` `untaggedOnly: true` → 未分類エントリのみ通過、タグ付きは除外。
  - `untaggedOnly: true` + `tags` 非空 (防御ケース) → `untaggedOnly` が優先され未分類のみ。
  - `untaggedOnly: true` + `confidence` / `query` → AND 合成が成立。
  - `untaggedCount` → 未分類件数を正しく数える (legacy parens / 新 comma 形式混在でも空のみ計上)。
- `useClassificationFilter` (renderHook): 排他遷移 (`toggleUntagged` ON で `tags=[]`、`toggleTag` で `untaggedOnly=false`、`clearTags` で両クリア) を検証。
- 既存スイート緑 + `tsc --noEmit` 緑。

### 7.2 Go (`internal/state`)

- 無バンプ案: 旧 v6 fixture (untaggedOnly キー無し) を `Load` → `UntaggedOnly == false` でロスレス、他フィールド不変。新フィールド込みの round-trip (`Save`→`Load`) で `true` が保持される。
- v7 バンプ案を採る場合: `TestMigrateV6` (v6→v7 ロスレス + `UntaggedOnly` default) と post-migration validation を追加。

### 7.3 手動 (`wails dev`)

- ①未分類チップに件数 ②押すと未分類のみ ③通常タグとの排他切替 ④「すべて」で復帰 ⑤再起動後に選択復元。

## 8. 決定事項

### D1: state schema をバンプするか **【最重要】**

- **A (推奨): 無バンプ additive** — `ListFilterState` に `untaggedOnly bool` を足すだけ。schema は v6 のまま。migration ゼロ・データ消失リスクなし (§5.3 互換性表)。
- **B: v6→v7 バンプ + `migration_v6.go`** — トレーサビリティは上がるが、migration を書かないと既存 state 全消失。v5 の扱い判断 + テスト追加が要る。
- triage の preview 文言は B 寄りだったが、技術検証で **A が安全かつ低コスト** と判明。**A を推奨し、レビューで確定する**。

### D2: 表現方法・意味論 (triage で合意済み・確認)

- 独立 boolean フィールド `untaggedOnly` + **排他モード**。センチネル方式 (tags に特別値) は採らない (永続化される `tags[]` の意味を濁さないため)。

### D3: 「未分類」チップの配置

- **推奨: 「すべて」の直後・通常タグ群の前** に固定。未分類は件数変動に依らず常に同じ位置にあるべき (タグ群は使用頻度ソートで動くため、その中に混ぜると位置が安定しない)。

### D4: 未分類が 0 件のときチップを出すか

- **推奨: 0 件でも常時表示** (「未分類が無い」ことが一目で分かる + 位置が安定)。代替: 0 件のとき非表示にして UI を簡潔に保つ。レビューで確定。

### D5: 排他にせず独立 AND にする余地

- 不採用。triage で排他に合意済み。「未分類 AND tagA」は定義上ほぼ空集合になり無意味なため、排他の方が UX が明快。

## 9. Out of scope

- 「特定タグが付いていない」等の否定タグフィルタ一般化 (本 issue は「タグが 1 つも無い」に限定)。
- confidence 未設定 (`confidence === ""`) だけを抽出するフィルタ (タグの有無とは別軸。要望が出たら別 issue)。
- フィルタ条件の保存プリセット / 名前付きフィルタ。
- アコーディオングルーピング側での未分類グループの特別扱い変更。

## 10. Phase 分割

1 PR で完結可能 (フロント中心 + Go は型 1 行 + テスト):

1. `filters.ts` (型 + `applyFilter` + `untaggedCount`) + `filters.test.ts`。
2. `useClassificationFilter.ts` (排他トグル) + renderHook テスト。
3. `TagChips.tsx` + `ClassificationView.tsx` 配線。
4. 永続化グルー (`useClassification.ts` / `useSessionSave.ts`) + Go `ListFilterState` (+ D1 の採否に応じた migration/テスト)。
5. `wails dev` 手動確認 + セルフレビュー (AGENTS.md H 章) + PR。
