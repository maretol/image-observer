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

新しい非同期処理 (await IPC / Promise / EventsOn ハンドラ / setTimeout) を **複数経路** で
追加するとき、各経路が以下のレース変数を **個別に検証しているか** マトリクスで
列挙する。1 経路を直しても他経路に同じ穴があるとレビューが何 round もかかる。

検証すべきレース変数 (例):
- **世代トークン** (`requestGenRef` / version counter): 自分の await 中に新しい要求が
  立ち上がった場合に「自分は古い」と判定して commit を skip するか。**ローカル
  mutation の成功直後にも generation を bump** すること — そうでないと watcher /
  replay / manual reload の in-flight Load が ローカル mutation の結果を読まない
  まま後着で setLoadResult してユーザー編集を巻き戻す (PR #75 10th)
- **コンテキスト同一性** (`folderRef.current === payloadFolder`、`tabId` etc.): await
  中に対象が切り替わったら結果を破棄するか
- **モード / フラグ** (`watchMode === "auto"` / `enabled === true`): await 中にユーザーが
  機能を off にしたら結果を捨てるか。チェックは **entry (await の前) と post-await
  (await から戻った直後) の両方** で必要 — 前者だけだと「await 中に off に切り替えた
  payload」がそのまま処理され、後者だけだと「最初から off だったのにレジスタを
  漁ってしまう」 (PR #75 8th で post-await チェック忘れを指摘された)
- **state ref の同期タイミング**: `setFoo()` の直後に async path が走ると `fooRef.current`
  はまだ古い (useEffect 反映前)。`fooRef.current = picked; setFoo(picked);` の順で
  同期書きするか、render-time に `fooRef.current = foo;` を assignment するか
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

| 経路 | gen check | folder check | mode (entry) | mode (post-await) | error clear | spinner token | intent reconcile (post-IPC) |
|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| manual reload | ✓ | ✓ | – | – | ✓ | ✓ | – |
| watcher handler 成功 | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| watcher handler 失敗 | ✓ | ✓ | ✓ | ✓ | – | – | – |
| replay reload 成功 | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| replay reload 失敗 | ✓ | ✓ | ✓ | ✓ | – | – | – |
| replay (no-reload 経路) | – | ✓ | ✓ | – | – | – | – |
| auto-load on mount | ✓ | ✓ | – | – | ✓ | ✓ | – |
| silent recheck after Start | ✓ | ✓ | ✓ | – | – | – | – |
| Start IPC success | – | ✓ | ✓ | – | – | – | ✓ |
| Start IPC fail | – | ✓ | ✓ | – | – | – | ✓ |
| Stop IPC success | – | – | – | – | – | – | ✓ |
| Stop IPC fail | – | – | – | – | – | – | ✓ |
| ローカル mutation (saveEdit / deleteOne) | ✓ (bump で他経路を stale 化) | – | – | – | – | – | – |

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

毎回 1 つずつ別 variant が出てきた。初手でマトリクス (mode entry/post-await 分離 +
intent reconcile 列付き) を書いていれば横並びで全部列挙できていた。**マトリクスの
1 行 1 経路で書く**こと — 経路を束ねると (例: 「Start IPC success/fail」と
ひとくくり) success と fail で挙動が違うケースを見落とす (Round 10 suppressed-B
は Start fail の reconcile 漏れ)。

## まとめ

実装着手前に該当する節を再読する。特に:

- データモデル系の change (E-1, E-2) → 設計を先にドキュメント化
- React の inputstate / DOM 操作 (C-1, C-2) → 過去のバグパターンを思い出す
- export 公開の追加 (B-1, B-2) → 参照型なら必ず clone
- ドキュメント更新 (A-1, A-2) → 実体と突き合わせる
- 実装 iterate / レビュー対応 (A-3) → 変更後に context.md / コメントが追従しているか再確認
- commit 段階 (G-1) → SSH 署名で Claude が直接 commit して構わない。署名バイパス (`--no-verify` / `--no-gpg-sign`) は依然禁止

PR を作る直前には:

- **H 章のチェックリスト全項目** を通読し、自分の変更に該当する箇所を確認
- 複数の非同期 / IPC 経路を新規追加するなら **H-8 のマトリクス**を書く
- 大きい spec を書いた PR では **H-6 の spec ↔ 実装 diff 照合**を必ず実施
- レビューが返ってきたら **H-7 の波及確認** を必ず実施 (D-1 ハードコードは 1 件目
  発見時に全部潰す)
