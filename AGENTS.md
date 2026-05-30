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

### A-3. 実装が iterate したら context.md / コメントも追従させる

レビュー対応や設計変更で実装の中身が変わったとき、関連する `.claude/context.md` の
記述やコード内コメント / docstring が **古い実装を指したまま** になりがち。
コンパイラ / linter はコードしか見ないので、説明だけが silent に陳腐化する。
特に「初版実装 → レビュー対応 → 別レビュー対応」のように commit が分かれる流れでは、
context.md / コメントが初版の前提のまま取り残されやすい。

過去事例 (PR #41):
- `useEffect` で実装 → レビュー対応で `useLayoutEffect` に切り替えたが、context.md の
  記述は `useEffect` のまま残った (初版コミットで context.md を更新したきり再同期せず)
- ConfirmDialog で zoom を overlay から内側ダイアログに移動した際、Toast.tsx の
  コメント "See App.css UI scale block" が App.css に存在しないルール (`.toast-host`)
  を指す misleading な状態になった (元々は ConfirmDialog/Toast を同じ書きぶりで
  説明していたが、ConfirmDialog だけ非対称パターンになって参照が壊れた)

**実装を変えたら必ず以下を確認**:

1. **`.claude/context.md`** — 変更した issue / セクション全体を読み直し、関数名 /
   フック名 / 制御フロー / 設計説明が現在のコードと一致するか目視確認
2. **変更したファイル + そこから参照されるコメント** — 「See X」「同 X パターン」
   「同じ理屈」のような cross-reference が、参照先 (X の rename / 削除 / 構造変更)
   で破綻していないか grep:

```bash
git grep -nE "(See |see |参照|同様|同じ)" -- '*.ts' '*.tsx' '*.go' \
  | grep -i "<変更した識別子 / クラス名>"
```

3. **複数 commit に跨る PR では、最終 commit 直前に context.md / コメントを diff で再読**
   — `git diff main...HEAD -- .claude/context.md '*.tsx' '*.ts'` で「説明文と実装の
   時系列がズレていないか」を確認するのが確実。

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

## G. コミット運用

### G-1. commit は Claude が実行できる (SSH 鍵署名)

このリポジトリは **署名付き commit のみ取り込み可** に制限されているが、
署名を SSH 鍵 + ssh-agent 構成に切り替えてあり、`git commit` 実行時に
passphrase プロンプトは出ない (agent にキャッシュ済み)。Claude Code
から `git commit` を **直接走らせて構わない**。

通常運用:
- `git commit -m "..."` / `git commit -m "$(cat <<'EOF' ... EOF)"` を
  そのまま使える。
- 大きい PR は論理単位ごとに複数 commit に分け、各 commit を Claude が
  順番に作る。
- commit メッセージ規約は CLAUDE.md / issue-triage コマンド側を参照
  (`<type> (#<issue番号>): <短い要約>`)。

過去事例 (履歴 / why の補助): 当初は GPG 署名で運用していたが、GPG 鍵の
passphrase を Claude Code に共有していなかったため、`git commit` が
pinentry タイムアウトで失敗していた (issue #30 PR)。SSH 署名 +
ssh-agent への移行で解消。

注意:
- `--no-verify` / `--no-gpg-sign` / その他署名バイパス系のフラグを
  使うのは **依然 NG** (system prompt の "NEVER bypass signing unless
  explicitly asked")。SSH 署名が透過的に通る今、これらを付ける理由は
  通常ない。pre-commit hook が失敗したら hook 側を直す。
- amend で署名済み commit を改変する場合も同様。新しい commit を
  作る方向で対処する (CLAUDE.md の `--amend` 回避と整合)。
- `git push --force` / `git reset --hard` 等の destructive ops は
  従来通りユーザー確認を取る (system prompt の reversibility ルール)。

---

## H. PR 投稿前セルフレビューチェックリスト

Copilot reviewer / 人間レビュアーが **複数ラウンドに分けて指摘してくる頻出
パターン** を集約したチェックリスト。PR を作る直前にこのリスト全項目に目を通せ
ば、1〜2 ラウンド分のレビュー往復が省ける。

新しい指摘パターンが出たら追記して育てる (= 過去 PR の Round 2 以降で出てきた
指摘で「初回に気づけたな」と思うもの)。古くなった項目は削除して短く保つ。

### H-1. ARIA / アクセシビリティ

- **`alertdialog` / `dialog` には accessible name を必ず付ける**
  - `aria-label` (短い名前) or `aria-labelledby` (見出し要素 id)。`aria-describedby` は
    本文用でラベルにはならない。
  - 過去事例: `ConfirmDialog` で `aria-describedby` だけ付けて name が無かった (#43)
- **`role="button"` / `role="tab"` の中に他の interactive 要素を入れる場合**
  - 厳密 ARIA Authoring Practices では非推奨だが、VS Code / Finder などで広く使われる
    現実的パターン。本リポジトリは現状受け入れている。
  - 入れる場合は子の interactive 要素に `tabIndex={-1}` を付けて Tab 巡回 / roving
    tabindex から除外する。
  - 過去事例: `TabBar` の tab 内 close button、`Card.cls-card-thumb` 内の checkbox /
    edit button (#43)
- 新規 interactive 要素には **`:focus-visible` スタイル**を必ず付ける (F-1)。**同じ画面
  内の周辺 interactive 要素にも同レベルの focus 表示があるか**併せて確認 (F-1 拡張)
- input は **`<label htmlFor>` か `aria-label`** で必ずラベル関連付け (F-2)

### H-2. イベントハンドラ

- **新規 `onKeyDown` / `onClick` がバブリングで二重発火しないか**
  - 親に handler を付けて子に interactive 要素がある場合、子で Enter/Space を押すと
    子の通常動作 + 親 handler が両方走る。
  - 対策: 親側で `if (e.target !== e.currentTarget) return;` か、子側で
    `stopPropagation()`。
  - 過去事例: `Card.cls-card-thumb` の `onKeyDown` (#43)
- **PointerEvent ベースのドラッガはマルチタッチ / 二重 pointerdown を防御**
  - 既存ドラッグ中に新規 pointerdown が来ると、`dragRef` が上書きされ古い `release()`
    が orphan 化し、`body.cursor` / `userSelect` が戻らないリークを生む。
  - 対策: `onPointerDown` 冒頭で `if (dragRef.current) return;`。
  - 過去事例: `ImageView` / `GridSplitter` (#43)
- **`pointercancel` と unmount の cleanup 両方で release が呼ばれる**こと
  - drag 中に component が unmount される / ブラウザが drag をキャンセルするケース。

### H-3. グローバル / モジュール state のリーク

- **token stack / baseline cache / module-scoped Map** などの global state は
  **full lifecycle で正しくリセット** されるか
  - 初回キャプチャしたままにせず、空になった時に再キャプチャ可能な状態へ戻す。
  - 過去事例: `bodyStyles.ts` で `baseCursor` / `baseUserSelect` を null に戻し忘れ、
    ドラッグ間に他処理が `body.style` を変えても次のドラッグ終了で巻き戻された (#43)

### H-4. CSS クラス参照

- **参照する CSS クラスが実在するか必ず grep で確認** (新規 / 既存問わず)
  - 既存コードから引き継いだクラス名も「動いていた前提」で信用しない。
  - 過去事例: `MergePromptDialog` が Phase 4 v1.2 から未定義の `.confirm-overlay` を
    引きずっており、本来 backdrop / 中央配置が効いていなかった (#43)
  - 確認: `git grep -n '\.confirm-overlay' frontend/src/App.css` のようにピンポイントで
- **CSS rule を追加したら、同じ目的の周辺要素にも同じ rule が必要か**確認
  - 過去事例: UI scale の chrome rule に `.top-tabs` / `.tab-bar` を追加したが
    `.cls-empty-state` を追加し忘れていた (#41)

### H-5. Modal / Dialog の意図と prop default

- **`ModalShell` の `closeOnBackdrop` default (true)** が「そのダイアログの意図」と
  一致するか
  - yes/no 確認 (`ConfirmDialog`) や複数 action 必須 (`MergePromptDialog`) なら明示的に
    `false` を渡す。誤クリックで暗黙のキャンセル扱いになるのは大抵 NG。
  - 過去事例: `MergePromptDialog` が旧コードでは backdrop click を無視していたのに、
    ModalShell 移行で default true のまま放置された (#43)
- **`closeOnEscape`** も意図通りか (大抵 true でよい)

### H-6. ドキュメント追従

- **A-3 に従い、`.claude/context.md` の説明が**実装の最終形と**一致**しているか
  - 旧クラス名 / 旧 hook 名 / 旧フロー説明が残っていないか。
  - 過去事例: context.md §20 に `confirm-overlay` を既存 CSS クラスとして書いていたが、
    実コードは `confirm-dialog-overlay` に統一済みだった (#43)
- **`docs/spec-*.md` が実装最終形と一致**しているか。レビュー対応で実装が iterate
  すると spec が一番 stale になりがち。**PR を作る直前 / レビュー対応の最後の commit
  直前** に必ず `git diff main...HEAD -- 'docs/spec-*.md'` と「現状コード」を突き
  合わせる。特に以下が古いまま放置されやすい:
  - API シグネチャ例 (関数 / メソッドの引数・戻り値)
  - 擬似コードブロック (初版実装をそのまま貼り、後の DI / refactor が反映されない)
  - テスト方針表 (実際に書いた test 関数名 / 対象範囲)
  - 改訂履歴: 「PR #XX レビュー対応」を 1 行追加
  - 過去事例 (PR #75): spec-folder-watch.md が **6 ラウンド連続**で「現状実装と
    乖離」を指摘された。§4.2 TS binding 生成記述 / §7.3 debounce 擬似コード /
    §11.1 テスト方針 / §12 API 例 など、初版から実装が iterate するたびに spec の
    別箇所が陳腐化。spec を書いた人 = レビュー対応する人なのに、毎回 spec を読み
    返さなかったため。
- **PR 説明の test plan** に、自動テストできない手動確認項目を明示しているか

### H-7. レビュー指摘を受けた後の波及確認

レビューで 1 件指摘されたら、**同種のパターンが他に無いか必ず grep で広く探す**。
Copilot は diff 中心に見るので「同じ問題が別ファイルにもある」のは検出されにくい。

例:
- ARIA name 不在指摘 → 全 `role="alertdialog"` / `role="dialog"` を grep して確認
- マルチタッチ二重 pointerdown 指摘 → 全 `onPointerDown` を grep
- 未定義 CSS クラス指摘 → 全 `overlayClassName=` / `className=` を grep
- D-1 ハードコード指摘 (例 `"200ms"` / `"auto"`) → 同概念のリテラルを **全リポジトリで grep** し、
  発見した時点で **共通定数モジュール + 両側 pinning test** を 1 commit で全部入れる。
  「今回だけ直して残りは次回」は次回も同じ往復を生む。
  - 過去事例 (PR #75): Round 2 で hint `約 200ms` の D-1 を指摘 → debounce 数値だけ
    取り除いた → Round 6 で `"auto"` / `"off"` の D-1 を指摘される。同じ「Go と
    TS で同概念の文字列定数が分散」パターンが 4 ラウンド遅れで再来。Round 2 時点で
    `watchMode.ts` を作っていれば 1 round で済んだ。

### H-8. 非同期 / IPC 経路の race 検証マトリクス

> **このマトリクスは「着手前」に書く** (PR #75 / PR #109 の反省 = issue #110)。H 章は
> 本来「PR 投稿前」チェックリストだが、H-8 だけは例外で **実装に入る前** に
> `docs/spec-*.md` の「同期モデル」セクション (下記テンプレ) として書き起こす。PR 直前に
> 初めて書くと、1 経路ずつ穴が顕在化して何 round も回る (PR #75 = 16 round / PR #109 =
> 6 round がいずれもこのパターン。PR #109 では folder 列を round 6 で初めて意識した =
> 着手前にマトリクスを書かなかった証拠そのもの)。CLAUDE.md「非同期処理の着手前ルール」
> (複数 async source が同一 state を mutate する機能は最初の commit が同期モデル表) と対。

新しい非同期処理 (await IPC / Promise / EventsOn ハンドラ / setTimeout) を **複数経路** で
追加するとき、各経路が以下のレース変数を **個別に検証しているか** マトリクスで
列挙する。1 経路を直しても他経路に同じ穴があるとレビューが何 round もかかる。

#### spec に書く「同期モデル」セクションのテンプレ (着手前に埋める)

機能着手前に、まず各非同期 event source を以下の **5 列の表**で列挙する。これが下の
詳細マトリクス (gen check / folder check / mode entry-post / ...) の前提になる。
下表は PR #109 SampleEditPane (multi-source mutation queue) を題材にした **着手前に
書くべき理想形の記入例** — gate 方針列は「こう gate すべきだった」を書く欄であり、
PR #109 の最終実装そのものではない (下の ※ 参照):

| event source | trigger | capture したい値 | stale 化リスク | gate 方針 (理想形) |
|---|---|---|---|---|
| tag blur | TagInput onBlur | tagsRef (post-commit) | onSave closure の mtime | render-time ref sync + mtime guard |
| note blur | textarea onBlur | noteRef | onSave closure の mtime | 同上 |
| radio change | onChange | 引数 override | onSave closure の mtime | 引数で override してから save |
| unmount cleanup | useEffect cleanup | entryRef / autoSaveRef | mtime + **folderPath** | folder/mtime を context struct として onSave に渡す †|
| save success cascade | parent setLoadResult | new entry (per-field) | baseline reset の touched 判定 | per-field touched flag |

> **※ gate 方針列は「着手前に立てる理想の gate」を書く** (= 最初に書いていれば round 6
> の folder race を防げた設計)。実装が iterate しても表は target を保持する。
> **† unmount cleanup 行の「context struct を渡す」は #110 action C で実装済み** (PR で
> `SaveContext = { folder }` を `onSave(entry, ctx)` に渡し、`saveEdit` が `ctx.folder` で
> pre/post-IPC gate。mtime は ctx に載せず `loadResultRef` から fresh read = D-2 a。
> 応急処置だった `ClassificationView.handleSave` の `folderPathRef` guard (PR #109 round 6)
> は撤去)。この表自体は「着手前にこう書くべきだった理想形」を示すためのもの — 実装が
> 追いついた後も target として温存する。詳細は [docs/spec-edit-autosave-testing.md](docs/spec-edit-autosave-testing.md) §4/§6。

列の意味:
- **capture したい値**: その source が「正」とする最新値 (どの ref / 引数から取るか)
- **stale 化リスク**: closure / ref が古くなる軸 — **mtime / folder / dirty / touched / inflight**
  を毎回列に立てる (1 軸でも書き漏らすとその経路が round 遅れで顕在化する)
- **gate 方針**: その軸をどう防ぐか (render-time sync / generation guard / context struct /
  per-field flag / in-flight 直列化)

この 5 列表を **全 event source 分**埋めてから下の詳細マトリクスに進むと、
「folder 列を round 6 で初めて意識する」(PR #109 の実際の失敗) を構造的に防げる。
「該当軸なし」も明示する (検討した記録)。

検証すべきレース変数 (例):
- **世代トークン** (`requestGenRef` / version counter): 自分の await 中に新しい要求が
  立ち上がった場合に「自分は古い」と判定して commit を skip するか。**ローカル
  mutation の成功直後にも generation を bump** すること — そうでないと watcher /
  replay / manual reload の in-flight Load が ローカル mutation の結果を読まない
  まま後着で setLoadResult してユーザー編集を巻き戻す (PR #75 10th)。
  - **snapshot vs bump の使い分け**:
    - **bump**: 自分の commit を他経路より優先したい経路 — manual reload /
      watcher handler / replay / ローカル mutation 成功。bump することで他の
      in-flight 経路を stale 化する。
    - **snapshot only**: 自分の commit は他経路の commit が無ければ採用したいが、
      他経路 (特に in-flight の initial load) を巻き戻したくない経路 — silent
      recheck after Start が代表例。`myGen = requestGenRef.current` (bump せず) +
      success/catch で `if (myGen !== requestGenRef.current) return;`。
    - 両方混同すると Round 11 thread A のように silent recheck が initial-load の
      postLoadFlow をスキップさせる逆方向リグレッションを生む。
- **pending gen check** (defer-park パターン): 編集中などで結果を park して後で
  replay する場合、`pending.capturedGen = requestGenRef.current` を保存し、replay 時に
  `capturedGen !== requestGenRef.current` なら「他経路が commit した」と判定して
  pending を破棄する。mtime / entries 比較だけでは「entries だけ変化で sidecar
  mtime 不変」のケースを取り逃す (PR #75 11th)
- **multi-step side-effect chain の folder stale check**: `postLoadFlow` のように
  `await IPC1 → setX → await IPC2 → setY → ...` と複数の await を跨ぐ side-effect
  chain は、各 await 後に `folderRef.current === capturedPath` を確認する必要がある。
  await 中にユーザーが folder を切り替えると、旧 folder の prompt / setX が新 folder
  画面で surface してしまう (PR #75 12th preemptive)。これは Load の race とは別軸で、
  「state 更新の正当性」自体が folder context に依存する点が違う
- **entries-dependent state の同時 clear**: `loadResult` を null にする catch 経路
  (Load 失敗 / 失敗ハンドリング) では、`editing` (編集中のファイル名) / `conflict` /
  `mergePrompt` / `pendingResultRef` (parked auto-merge) / `selected` (filename keyed)
  / `selectAnchor` も同時に clear する必要がある。entries が無い状態でこれらが残ると
  「visually は entry=null で非表示だが内部 state は open のまま」になり、後続の
  watcher event が defer 判定で誤動作したり、同名ファイル復活時に popover が
  再表示される (PR #75 13th)。`resetEntriesDependentState` のような単一ヘルパで
  まとめ、catch 経路の波及漏れを防ぐ。**folder 切替時にも同じヘルパを呼ぶ** —
  selected だけクリアでは editing / conflict / mergePrompt が旧フォルダ context の
  まま残り、同名ファイルで誤発動する (PR #75 14th)
- **OS event の多重発火に対する per-window dedup**: inotify の Remove は単一の
  ファイル削除に対して IN_DELETE (parent watch) + IN_DELETE_SELF (target's own
  watch) + IN_IGNORED の最大 3 つを fsnotify 経由で fsnotify.Remove として届ける。
  Rename も同様 (IN_MOVED_FROM + IN_MOVE_SELF + IN_IGNORED)。これらを愚直に
  count すると `removedFiles` が 2-3 倍になる。`acc.removedPaths` のような
  per-window dedup set で path 単位で 1 回だけ処理する (PR #75 14th)
- **OS event の戻り値ベース検出の脆さ**: `fsnotify.Watcher.Remove(path)` の戻り値で
  「dir watch だったか」を判定する設計は **タイミング依存で信頼できない** — inotify
  は IN_IGNORED を非同期に処理して watch を内部 evict するため、最初の IN_DELETE
  処理時点で watch がもう無く error が返ることがある。代わりに **自前で
  watched dirs の set を保持** し (`watchState.watchedDirs`)、Remove 時にそれを
  consult する。Add 成功時に set に登録 / Remove 時に削除する一方向更新で並行性
  問題なし (PR #75 14th, thread D)
- **subtree cleanup の単位**: subdir 単体の watch を解除しても、その配下に張った
  watch は別 entry として残る (Linux inotify は inode 単位で tracking)。rename
  out で moved 先 inode が依然 watch されたままだと、外部の event がこの root の
  名義で流れ続け `current folder only` 違反になる。Remove/Rename 時は **prefix
  配下を全部解除する `removeSubtreeFromWatch(st, prefix)` ヘルパで一括処理**
  (PR #75 15th, thread B/C)
- **root の特殊扱い**: hidden filter (e.g. `.foo`) / 通常の filter は **descendant
  にのみ適用、root 自体は always 監視対象**。root を filter で弾くと、root 自身の
  Remove / Rename event すらドロップされて root vanish 検知が走らなくなる。
  scanner / addSubtree が root を `if p == root { return nil }` で特例処理して
  いるのと同じ理屈で、watcher の event handler でも `if ev.Name != st.root && ...`
  と root 例外を入れる (PR #75 15th, thread A)
- **コメントと実装の整合 (return / assert level)**: 「X の場合は ErrConflict を
  返す」のような **docstring レベルの assertion** をコメントに書いたなら、その
  下のコード block で必ず対応する `return ErrConflict` を置く。コメントを書いて
  満足してコードを書き忘れる古典バグ — fall-through だと silently success path
  に流れてコメントと逆の挙動になる (PR #75 16th, thread E: SaveJSON の
  "If the file went away entirely, treat that as a conflict too" コメントに
  対応するコードがなく、ファイル削除後の Save が silently 再作成していた)
- **コンテキスト同一性** (`folderRef.current === payloadFolder`、`tabId` etc.): await
  中に対象が切り替わったら結果を破棄するか
- **モード / フラグ** (`watchMode === "auto"` / `enabled === true`): await 中にユーザーが
  機能を off にしたら結果を捨てるか。チェックは **entry (await の前) と post-await
  (await から戻った直後) の両方** で必要 — 前者だけだと「await 中に off に切り替えた
  payload」がそのまま処理され、後者だけだと「最初から off だったのにレジスタを
  漁ってしまう」 (PR #75 8th で post-await チェック忘れを指摘された)
- **state ref の同期タイミング**: `setFoo()` の直後に async path が走ると `fooRef.current`
  はまだ古い (useEffect 反映前)。`fooRef.current = picked; setFoo(picked);` の順で
  同期書きするか、render-time に `fooRef.current = foo;` を assignment するか。
  **handler が分岐判定に使う state は全て render-time sync が必要** — folderRef /
  watchModeRef だけでなく editingRef / conflictRef / mergePromptOpenRef のような
  「defer 判定」用 ref も対象。useEffect で同期している ref が混ざっていると、
  open 直後 (effect 発火前) に届いた watcher event が「閉じている」と誤判定して
  即 commit してしまう (PR #75 12th)
- **spinner / loading フラグの token 分離**: 「いずれかの非同期が増減させる」設計だと、
  別経路が世代を進めただけで finally が skip して spinner が残る。loading は loading
  を立てた経路だけが下げるよう **専用 token** を持つ
- **エラーフラグのクリア**: 成功経路で `setError(null)` を入れているか (前回失敗の
  エラーが成功後も残らない)
- **intent reconcile (post-IPC)**: Start/Stop のような JS → Go IPC の completion 後に
  「dispatch した時点の意図」と「現在の意図」をもう一度突き合わせて、ズレていれば
  再 dispatch するか。Wails IPC は call ごとに別 goroutine で dispatch されるため
  JS 側の発行順は Go 側の `m.mu` 取得順と一致しない (Start("A") → Start("B") が
  Start("B") → Start("A") の順で Go に到着しうる)。fire-and-forget だと最後に
  到着した IPC が "勝者" になってしまうので、Start same-root no-op + Stop
  idempotent の性質を利用して **completion 時に現 intent を再 dispatch する
  fixed-point パターン** で収束させる (PR #75 7th / 10th)

マトリクスを表で書く。**mode check は entry / post-await を分けて 2 列で書く** —
1 列にまとめると「entry はあるが post-await を忘れた」典型ミスが見えなくなる:

**gen check 列は「snapshot」と「bump」を区別する**。`requestGenRef` を bump する経路は
他経路を stale 化する権限を持つ (= 自分の commit を他より優先したい場合に使う)。
snapshot だけする経路は「他に supersede されたら自分を drop するが、自分は他を
supersede しない」セマンティクス (= 自分の commit が他経路の commit より優先しては
いけない場合 — Round 11 thread A で silent recheck が initial-load の postLoadFlow
を skip させた典型例)。

| 経路 | gen check (snapshot/bump) | folder check | mode (entry) | mode (post-await) | error clear | spinner token | intent reconcile (post-IPC) | pending gen check |
|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| manual reload (loadInternal) | bump | ✓ | – | – | ✓ | ✓ | – | – |
| watcher handler 成功 | bump | ✓ | ✓ | ✓ | ✓ | – | – | – |
| watcher handler 失敗 | bump | ✓ | ✓ | ✓ | – | – | – | – |
| replay reload 成功 | bump | ✓ | ✓ | ✓ | ✓ | – | – | – |
| replay reload 失敗 | bump | ✓ | ✓ | ✓ | – | – | – | – |
| replay (no-reload 経路) | – | ✓ | ✓ | – | – | – | – | ✓ |
| auto-load on mount (loadInternal) | bump | ✓ | – | – | ✓ | ✓ | – | – |
| silent recheck after Start | **snapshot** | ✓ | – | ✓ | ✓ | – | – | – |
| Start IPC success | – | ✓ | ✓ | ✓ | – | – | ✓ | – |
| Start IPC fail | – | ✓ | ✓ | ✓ | – | – | ✓ | – |
| Stop IPC success | – | – | – | – | – | – | ✓ | – |
| Stop IPC fail | – | – | – | – | – | – | ✓ | – |
| ローカル mutation success (saveEdit / deleteOne) | bump | ✓ | – | – | – | – | – | – |
| ローカル mutation success (resolveConflictForce / resolveMergeMerge / resolveMergeSkip) | bump | ✓ | – | – | – | – | – | – |
| ローカル mutation コンフリクトリトライ (loadInternal null) | – (早期 return) | – | – | – | – | – | – | – |
| postLoadFlow (await を跨ぐ side-effect 経路) | – | ✓ (各 await 後) | – | – | – | – | – | – |

**pending gen check** 列: defer-park 時に `pendingResultRef.capturedGen` に
`requestGenRef.current` を保存し、replay 起動時に再評価して drift があれば pending を
破棄する。mtime 比較だけでは「entries だけ変化 + sidecar mtime 不変」のケースで
巻き戻し可能だった (Round 11 suppressed-A)。

「該当なし」は明示する (検討した記録)。横並びで穴が見えるので 1 ラウンドで全部潰せる。

過去事例 (PR #75): `useClassification.ts` の非同期 Load 経路 (handler success /
handler catch / performReplay の再 Load / loadInternal の手動 reload /
StartFolderWatch success catch) が **6 round 連続**で「もう一つの経路が
世代/folder/watchMode の検証から漏れていた」と指摘された:

- Round 3: handler catch に gen/folder check 抜け
- Round 4: performReplay の再 Load が gen check 不参加
- Round 5: loadInternal (手動 reload) が gen 非共有
- Round 6: loadInternal の stale 時 return null 化、handler 冒頭の mode check 追加
- Round 7: StartFolderWatch success に stale check 追加
- Round 8: handler / performReplay の **await 後** mode check 追加 (entry だけ
  あっても in-flight payload は素通り)
- Round 9: 監視 root vanish 検知 + silent recheck after Start + DeleteImage の
  in-flight set による self-echo 抑制
- Round 10: ローカル mutation (saveEdit / deleteOne) の gen bump + silentRecheck
  の gen 参加 + Start/Stop IPC completion 後の intent reconcile (fixed-point
  収束パターン)
- Round 11: silent recheck の gen 参加が **bump も含めた**ため initial-load
  (openFolder の loadInternal) を stale 化して postLoadFlow がスキップされる
  逆方向リグレッション。snapshot only に修正 + pending に capturedGen を追加 +
  deleteOne の loadInternal null 経路で patch スキップ + reload() で watcher
  reconcile
- 12th 用 preemptive 修正 (= レビュー前の自己 audit): postLoadFlow の各 await 後に
  `folderRef.current === path` を check (folder switch 中に旧フォルダの
  merge prompt / sidecar-create confirm が新フォルダで surface する UX バグ) +
  resolveConflictForce / resolveMergeMerge / resolveMergeSkip にも mutation 後の
  gen bump を追加 (Round 10 thread A ルールの波及 = AGENTS.md H-7 観点で「同種
  パターンを全 grep」した結果)
- Round 12 (preemptive と同時実施): editingRef / conflictRef / mergePromptOpenRef を
  render-time sync に変更 (defer 判定 ref も対象だった反省) + silentRecheck が
  initial-load 完了まで defer (snapshot only でも older snapshot の後着 commit に
  上書きされる race) + dir Create double-count (discoveredImagePaths 共有 dedup)
- Round 13: Load 失敗の catch 経路で `loadResult` を null にする際に、entries に
  依存する editing / conflict / mergePrompt / pendingResultRef / selected も
  同時に clear する必要 (folder 削除時に編集ポップオーバーの内部 state が残って
  後続 watcher event を defer + 同名ファイル復活時に popover 再表示する問題)。
  `resetEntriesDependentState` ヘルパで 3 catch 経路一括対応
- Round 14: (1) folder 切替時の openFolder にも `resetEntriesDependentState` 適用
  (selected だけクリアでは editing / conflict / mergePrompt が旧 context のまま残る)。
  (2) `loadResultRef` も useEffect 同期では NG → render-time sync (handler の
  self-echo 判定で古い entries を見る race)。(3) 全 mutation 経路 (saveEdit /
  deleteOne / resolveConflictForce / resolveMergeMerge / resolveMergeSkip /
  postLoadFlow) で disk IPC 完了後の state commit 前に `folderRef.current === cur`
  check (folder switch 中に旧フォルダの mutation 結果で新フォルダ state を上書き
  する問題 — gen bump だけでは解決しない)。(4) image-extension dir Remove は
  `watchState.watchedDirs` で dir-vs-file 検出 (`w.Remove` 戻り値は inotify
  IN_IGNORED の処理順でタイミング依存になり信頼できない) + `acc.removedPaths` で
  inotify 多重 Remove 発火を dedup
- Round 15: (1) root の hidden filter bypass (root のフォルダ名が `.` 始まりだと
  root vanish event 自体が hidden filter で捨てられ loop が dead fd で hang)。
  (2) subdir rename/remove 時に `prefix` 配下の watch を一括解除する
  `removeSubtreeFromWatch` helper (inode-tracked watch が残ると subtree 違反で
  rename 先の event が流れ続ける)。両方とも個別 path 単位の cleanup ではなく
  **path tree 全体**の cleanup が必要
- Round 16: (1) コメントと実装の乖離 — `repository.SaveJSON` のコメントに
  「file gone を conflict として扱う」と書いてあるのにコードは silently 再作成
  していた古典的バグ。コメントを書いた人と実装した人が同じでも、レビュー段階で
  fall-through case を見落とした。コメントが docstring レベルで明示しているなら
  実装側にも対応する **return / assert** を必ず置く (PR #75 16th, thread E)。
  (2) silentRecheckAfterStart の success 経路で `setError(null)` 漏れ
  (handler / replay 経路に追加した時の波及確認漏れ、AGENTS.md H-7 違反)

毎回 1 つずつ別 variant が出てきた。初手でマトリクス (mode entry/post-await 分離 +
intent reconcile 列 + **gen check は snapshot/bump 区別** + pending gen check 列付き)
を書いていれば横並びで全部列挙できていた。**マトリクスの 1 行 1 経路で書く**こと
— 経路を束ねると (例: 「Start IPC success/fail」とひとくくり) success と fail で
挙動が違うケースを見落とす (Round 10 suppressed-B は Start fail の reconcile 漏れ)。
**gen check も snapshot / bump を区別**すること — 「gen 参加」が全部 bump だと
勘違いすると Round 11 thread A のように silent recheck が他経路を巻き戻す逆方向の
リグレッションを生む。

## I. レビュー対応ラウンドの運用

### I-1. レビュー対応が 3 round を超えたら一度立ち止まる

同じ PR でレビュー往復が **3 round** に達したら、4 round 目の小手先修正に入る前に
**一度手を止めて** 以下を強制する:

1. **H-7 の波及確認を全リポジトリで** — 今 round までに指摘された全パターンを `git grep`
   で洗い出し、同種の穴を残らず列挙する (「今回だけ直して残りは次回」を禁止)
2. **H-8 マトリクスの再構築** — 非同期 / state ref / cleanup 系の指摘が続いているなら、
   spec の同期モデル表 (H-8 テンプレ) を **白紙から引き直し**、各 event source × race 変数を
   横並びで埋め直す。round を重ねて場当たりで潰した結果、表と実装がズレている前提で疑う
3. 立ち止まった結果 (何を再 audit し、何を予防的に潰したか) を PR コメント or commit
   message に残す

理由: PR #75 (16 round) / PR #109 (6 round) はいずれも「1 round 1 経路ずつ穴が顕在化」
する同じパターンだった。3 round 時点で matrix を引き直していれば、PR #109 の folder race
(round 6) は予防的に潰せた。round を重ねるほど「次の 1 経路だけ」を場当たりで潰す誘惑が
強くなるので、明示的なブレーキを置く。

関連: 着手前マトリクスは H-8、波及確認は H-7。レビュー対応の実行フローは
[.claude/commands/pr-review-handle.md](.claude/commands/pr-review-handle.md)。

---

## まとめ

実装着手前に該当する節を再読する。特に:

- データモデル系の change (E-1, E-2) → 設計を先にドキュメント化
- React の inputstate / DOM 操作 (C-1, C-2) → 過去のバグパターンを思い出す
- export 公開の追加 (B-1, B-2) → 参照型なら必ず clone
- ドキュメント更新 (A-1, A-2) → 実体と突き合わせる
- 実装 iterate / レビュー対応 (A-3) → 変更後に context.md / コメントが追従しているか再確認
- 複数 async event source が同一 state を mutate する change → **着手前に H-8 同期モデル表**
  を spec に書く (CLAUDE.md「非同期処理の着手前ルール」と対。PR 直前では手遅れ)
- commit 段階 (G-1) → SSH 署名で Claude が直接 commit して構わない。署名バイパス (`--no-verify` / `--no-gpg-sign`) は依然禁止

PR を作る直前には:

- **H 章のチェックリスト全項目** を通読し、自分の変更に該当する箇所を確認
- 複数の非同期 / IPC 経路を新規追加した PR は、**着手前に書いた H-8 マトリクスを
  実装最終形と再照合** (iterate で表がズレていないか。新規に書くのは着手前)
- 大きい spec を書いた PR では **H-6 の spec ↔ 実装 diff 照合**を必ず実施
- レビューが返ってきたら **H-7 の波及確認** を必ず実施 (D-1 ハードコードは 1 件目
  発見時に全部潰す)
- レビュー往復が **3 round を超えたら I-1 に従って一度立ち止まる** (波及確認 +
  マトリクス再構築を強制)
