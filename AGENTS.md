# AGENTS.md

過去の PR レビュー (#36 / #37 など) で **複数回繰り返し指摘されたパターン** を集約した、
将来 Claude (および他のエージェント) が同じ轍を踏まないためのチェックリスト。

新しいコードを書く前に該当しそうな項目に目を通す。CLAUDE.md (プロジェクトの一次ルール) より
スコープが狭く、「実装中に陥りがちな罠」を実例ベースで列挙する。

---

## A. ドキュメンテーション

### A-1. `.claude/context.md` には動く値を書かない

固定数 (vitest ケース数、ファイル行数、ハッシュ、ビルド秒数等) はコードが進むたびに
陳腐化し、将来読んだエージェントが古い数字を信用して誤判断する。

- ❌ `vitest 107 ケース、Go テスト全通過`
- ❌ `Go テスト 11 → +5 ケース` / `vitest +3 ケース (合計 93)`
- ❌ `wails build 通過 (Linux ELF 5.281s)`
- ✅ `vitest / Go テスト全通過 (件数は最新の npm run test / go test ./... を参照)`
- ✅ `Go テスト追加` / `テスト追加 (詳細は次の commit message を参照)`

PR 内のサマリ (commit message / PR body) では `+5 ケース` のような **delta** は OK
(その時点のスナップショットなので)。**長寿命ドキュメント** (`.claude/context.md` /
`AGENTS.md` / `CLAUDE.md` / `docs/spec-*.md`) には数値スナップショットを書かない。
Phase 完了の記録という名目でも、context.md に書く時点で長寿命ドキュメント扱いになる。

### A-1 拡張. 「残作業」と「実装履歴」が同じ doc にあると整合が崩れる

`.claude/context.md` 冒頭に「残作業 issue リスト」を書き、本文に「実装完了履歴」を
書く構成の場合、issue を実装完了したら **両方** を更新する必要がある (履歴に "実装完了"
として追加し、残作業リストから消す)。片方だけ更新すると読者が「未完了」と誤解する。

長寿命の状態リスト (open issue / 残タスク等) は `gh issue list --state open` のような
ライブクエリへの誘導を残すだけにし、ドキュメント側に列挙しない方が安全。

### A-2. エクスポート一覧は実コードと突き合わせる

`.claude/context.md` の「エクスポート」一覧を更新したら、必ず `grep` で実体と照合する:

```bash
grep -nE "^(func|var|const|type) [A-Z]" internal/<pkg>/<file>.go
```

過去事例:
- `Modifier` / `Both` (実体は `MultiSelectModifier` / `MultiSelectBoth`)
- `ShiftZoom` (実体は `WheelModeShiftZoom`)
- `DefaultTagColors` (途中で unexport したのに記載は残った)

短縮表記やリネーム後の旧名を残さない。

### A-2 拡張. 識別子を rename / un-export した時はコメントも追う

識別子を変更したら、**ソースコード内の docstring / コメント** にも同じ名前が残って
いないか grep する。コンパイラは型/関数の使用箇所しか追わないので、
コメント内の旧名は静かに放置される。

過去事例:
- `maxThumbnailWorkerCount` → `MaxThumbnailWorkerCount` に export 化した際、
  `internal/thumb/defaults.go` の `maxAutoWorkers` のコメントだけ旧名のままだった

リネーム時に必ず実行:

```bash
git grep -n "<旧識別子名>" -- '*.go' '*.ts' '*.tsx' '*.md'
```

---

## B. 参照型データの公開境界

### B-1. ミュータブル参照を直接 export しない

Go の `map`, `slice`, TS の `Object`, `Array` は参照型。`export const seed = {...}`
や `var Seed = map[...]{...}` で公開すると、**インポータが seed そのものを書き換えられる**。
1 箇所 mutate されただけで以降の `DefaultSettings()` 呼び出しが汚染される。

- ❌ `var DefaultTagColors = map[string]string{ ... }` (Go・export)
- ❌ `export const KNOWN_TAG_COLORS = DEFAULT_PALETTE` (TS・指している先が live mutable)
- ✅ unexport して `DefaultSettings()` / `cloneTagColors(...)` 経由で必ず copy を返す
- ✅ getter (`getKnownTagColors()`) で `{ ...activeMap }` を返す

定数 (`const Foo = 64`) は immutable なので export OK。

### B-2. getter は snapshot を返す

「現在の状態を読みたい」用途の getter を作るとき、内部参照を返すと呼び出し側で
mutate されて live state が破壊される。`Readonly<T>` 型注釈はコンパイル時のみで
runtime 保護にならない。

- ❌ `function getX(): Readonly<...> { return liveMap; }`
- ✅ `function getX(): Readonly<...> { return { ...liveMap }; }`

---

## C. React と DOM 境界

### C-1. `setState` の直後に同期 DOM イベントを起こすと state は古い

`setText("revert")` → `el.blur()` の順で書くと、blur ハンドラは **DOM の古い値**
(`e.target.value`) を読む。React の再描画は次の microtask 以降。

過去事例: NumberInput の Esc revert が動かず commit されてしまった。

修正パターン:
- DOM 値を直接書き換えてから blur: `el.value = String(value); el.blur();`
- ref フラグで次の handler に「skip して」と伝える: `skipNextBlurRef.current = true;`
- そもそも blur しない (フォーカスを残す)

### C-2. 設定値の編集 input は keystroke ごとに save しない

`<input onChange={(e) => updateSetting(e.target.value)}>` にすると、

- 1 文字打つたびに IPC / network が走る (race)
- `Number("")` が 0 になり Validate に弾かれる (進行中の入力で)
- 削除して再入力する間にエラーが出る

パターン: ローカル文字列 state を持ち、blur / Enter で commit + clamp する。
Esc で revert (C-1 に注意)。

```tsx
const [text, setText] = useState(String(value));
const commit = (raw: string) => { ...clamp + onChange... };
<input value={text} onChange={(e) => setText(e.target.value)}
       onBlur={(e) => commit(e.target.value)}
       onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
```

---

## D. レイヤ間の定数同期

### D-1. 同じ概念の定数が 2 箇所にあるなら、ドリフト検知を入れる

- Go と TS にまたがる: 例 `DEFAULT_MAX_PIXELS` と `defaultMaxImagePixelsMP`
- Go の 2 パッケージにまたがる: 例 `internal/thumb.maxAutoWorkers` と `internal/settings.MaxThumbnailWorkerCount`

選択肢:
1. **単一ソース化**: 一方を export して他方が import する。依存方向が新規に増えるなら慎重に判断
2. **同値テスト**: 同パッケージの test (片方が import 可能なら) で `if A != B { t.Errorf(...) }` を書く

過去事例:
- `TestThumbDefaultsMatchSettings` で `defaultDisplaySize == settings.DefaultSettings().ThumbnailSize` を担保
- 同じテストで `maxAutoWorkers <= settings.MaxThumbnailWorkerCount` も担保

### D-2. `?? 200` のようなハードコード fallback は使わない

設定値の読み出しに `settings.data?.maxImagePixelsMP ?? 200` と書くと、`200` が
TS / Go / 他のフロント 3 箇所に独立して存在することになる。

- ❌ `(settings.data?.maxImagePixelsMP ?? 200) * 1_000_000`
- ✅ `import { DEFAULT_MAX_PIXELS } from "..."` してそれを fallback に使う

---

## E. データモデル設計

### E-1. 「ストレージ形 vs 表示形」を最初に決める

ユーザ設定のフィールドが「完全な状態のスナップショット」(=`tagColors` に全タグの色)
か、「上書きだけの sparse map」(= `tagColors` には変更したタグだけ) かで、
UI のロジックが大きく変わる。

過去事例: tagColors を「完全パレット」で保存しているのに UI を「上書きのみ表示」
にしたため、判定が `name in colors` ではダメで `value !== DEFAULT[name]` に修正必要だった。
4 ラウンドの review で fix し続けた。

着手時に以下を決める:
1. ストレージ形 (full state / sparse overrides)
2. 表示形 (effective merged / overrides only / raw stored)
3. setter / merger の挙動 (replace / merge / null と {} の違い)

3 点をコメントに書いてから実装する。

### E-2. live モジュール state の setter は precise semantics を docstring に書く

```ts
// setX merges overrides onto DEFAULT (override semantics).
// null / undefined / {} → revert to DEFAULT.
// Other key-value pairs → DEFAULT[key] is overridden by the given value.
// Keys not in DEFAULT are added (new tags).
export function setX(map: Record<...>) { ... }
```

「設計の曖昧さ」がそのまま review ラウンド数に直結するので、初手でドキュメント化する。

---

## F. アクセシビリティ

### F-1. 新しいインタラクティブ要素には focus 表示を付ける

hover / active のスタイルだけ書いて focus を忘れがち。キーボードユーザは Tab で
動くため、visible な focus indicator がないと現在位置が分からない。

- 普通の `<button>` `<input>`: `:focus-visible { outline / box-shadow }`
- `<input type="radio">` を視覚的に隠して `<label>` でデコレーションする場合: 親 label に
  `:focus-within { outline / box-shadow }` を付ける (radio が hidden だと `:focus-visible`
  が効かない)

### F-1 拡張. 同じ画面内の interactive 要素群はまとめて確認する

新規 1 つに focus 表示を付けても、**同じ画面の他の interactive 要素にも同水準の
表示が必要**。レビューが「もう一つの方にも付け忘れてる」と指摘してくるパターンが
繰り返し発生している。

過去事例:
- 設定ダイアログで `.settings-segment-opt:focus-within` を付けたが、同じダイアログ
  内の `.settings-nav-item` には付け忘れていた → 翌レビューで指摘

CSS に focus rule を 1 つ書いたら、grep で同レベルの他要素を確認:

```bash
git grep -nE "(:hover|cursor: pointer)" frontend/src/App.css
```

ボタン / クリック可能要素を列挙して、全部に `:focus-visible` / `:focus-within`
があるかチェック。

### F-2. label と input の関連付け

`<div className="label">テキスト</div>` の隣に `<input>` を置くだけだと、screen reader が
ラベルを読まない。`<label htmlFor>` か `<input aria-label>` を使う。

(本リポジトリは現状 `Field` コンポーネントが label を `<div>` で書いている。Issue #30 a11y
で扱う想定だが、新規追加コンポーネントでは可能なら最初から正しく書く)

---

## まとめ

実装着手前に該当する節を再読する。特に:

- データモデル系の change (E-1, E-2) → 設計を先にドキュメント化
- React の inputstate / DOM 操作 (C-1, C-2) → 過去のバグパターンを思い出す
- export 公開の追加 (B-1, B-2) → 参照型なら必ず clone
- ドキュメント更新 (A-1, A-2) → 実体と突き合わせる
