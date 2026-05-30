# 編集 auto-save のテスト基盤導入と境界リファクタ 仕様書 (#110 B+C)

PR #109 (6 round) の post-mortem (#110) で残った action item **B (component/hook テスト基盤)** と **C (境界の責務リファクタ)** を実装するための仕様書。A (spec/着手プロトコル) / D (運用ルール) は PR #111 で反映済み。本 spec はそれらの「再発防止策を、実際に再発しうる SampleEditPane auto-save の配線部分へ適用する」フォローアップにあたる。

> **ステータス**: §11 決定事項ユーザー合意済み (2026-05-30、D-1〜D-5 すべて推奨 A 案)。**Phase 1 (B) 着手中** → Phase 2 (C) は Phase 1 マージ後。
> issue triage で先行合意済み: **テスト基盤 = happy-dom + @testing-library/react 最小構成** (§11 D-5) / **B+C を 1 spec で Phase 分割** (§12)。
> §4 の同期モデル表が C の target 設計であり、CLAUDE.md「非同期処理の着手前ルール」に従い **C の最初の commit はこの表** にする。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-05-30 | 初版 | #110 B+C の要件整理。§4 同期モデル表 (C の target) / §5 Phase 1 (B: happy-dom + RTL + `useAutoSaveQueue` 抽出 + renderHook テスト) / §6 Phase 2 (C: `onSave` context API 化 + `folderPathRef` guard 撤去) / §11 決定事項を提示。 |
| 2026-05-30 | ユーザー合意 | §11 D-1〜D-5 すべて推奨 (A) 案で確定。Phase 1 (B) 着手。D-2 は (a) 案 = ctx は folder のみ意味付け / mtime は fresh read 温存 / `setTimeout(0)` dequeue 据え置き。 |

---

## 1. ゴール (DoD)

### Phase 1 (B): テスト基盤 + hook 抽出

- `frontend` に **happy-dom + @testing-library/react** を devDependency として追加 (最小構成、§5.1)。
- 既存の純関数 vitest テストは **node 環境のまま** 動き続ける (happy-dom はDOM が要るテストにのみ適用、§5.2)。
- SampleEditPane の **in-flight 直列化キュー**を `useAutoSaveQueue` 純 hook として抽出する。**抽出は挙動不変** (PR #109 round 1〜6 の race 修正をそのまま温存)。
- `renderHook` で以下を programmatic に pin する (§5.4):
  - 連続 `runSave` の直列化 (in-flight 1 + queued 1)
  - in-flight / queued と同一 snapshot の重複抑止 (round 3)
  - in-flight 完了後の dequeue replay (round 1)
  - entry 切替時の queue 破棄 (stale snapshot が新 entry に着地しない)
- baseline reset の per-field 同期 + `touched` 追跡 (round 2 / round 5) を純関数 reducer として抽出しユニットテスト (§5.5)。
- `npm --prefix frontend run test` / `typecheck` がローカル / CI で通過。CI yaml は **変更不要** (vitest を既に呼んでいる)。

### Phase 2 (C): 境界の責務リファクタ

- `onSave` の signature を `(entry) => void | Promise<void>` から **`(entry, ctx: SaveContext) => void | Promise<void>`** に変更 (`SaveContext = { folder: string; baselineMtime: number }`、§6.1)。
- `useClassificationEdit.saveEdit` が `ctx.folder` を保存先・gate の一次ソースにする (§6.3)。
- `ClassificationView.handleSave` の `folderPathRef` guard (round 6 の応急処置) を **撤去**し、同等の gate を `saveEdit` 内の `ctx.folder` チェックへ移す (§6.4)。
- Phase 1 で書いた renderHook テストが C 後も green。さらに **cross-folder cleanup の skip** をテストで pin (§6.6)。
- §4 同期モデル表の「現状」列が消え「target」列が実装最終形と一致する (H-6 spec↔実装 diff 照合)。
- `go test ./...` 通過 (Go 側は変更なしだが回帰確認)、`typecheck` / `vitest` 通過、`wails dev` で auto-save の手動確認 (§8.3)。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **B / C** | #110 の action item。B = テスト基盤導入、C = 境界の責務リファクタ。 |
| **runSave** | SampleEditPane 内の保存キュー投入関数。in-flight があれば 1 段 queue に最新 snapshot を載せる (`SampleEditPane.tsx`)。 |
| **Snapshot** | `{ filename, tags, confidence, note }`。保存対象フォームの確定値。 |
| **SaveContext (ctx)** | C で新設する `{ folder, baselineMtime }`。snapshot が「どの folder の、どの mtime を baseline とした保存か」を明示的に運ぶ。 |
| **capture 時** | snapshot を確定する瞬間 (blur / radio change / Cmd+Enter / unmount cleanup)。 |
| **dispatch 時** | `UpdateClassificationEntry` IPC を実際に発射する瞬間 (queue replay では capture より後)。 |
| **renderHook** | `@testing-library/react` の hook 単体テスト API。DOM 環境 (happy-dom) を要する。 |

---

## 3. 背景 — なぜ B / C が要るか

### 3.1 6 round の根因 (issue #110 post-mortem の要約)

SampleEditPane の auto-save は本質的に **multi-source mutation queue** (tag blur / note blur / radio change / unmount cleanup / save 成功 cascade が同一 sidecar を mutate)。PR #109 は着手前マトリクスを書かずに始めたため、1 round 1 経路ずつ race の穴が顕在化した:

| round | 顕在化した経路 |
|------|------|
| 1 | runSave の stale onSave closure / cleanup の過剰発火 |
| 2 | per-field baseline reset / unmount 後 queue replay の stale mtime |
| 3 | in-flight と同一 snapshot の重複 queue |
| 5 | per-field の「touched then reverted」未捕捉 |
| 6 | folder 切替 unmount → 新 folder に旧 entry を save する race |

### 3.2 現状実装の脆い点

1. **race を起こす配線が抽出も test もされていない**。`shouldAutoSave` / `computeEditDirty` は純関数化済みだが、肝心の `runSave` / baseline reset / cleanup は SampleEditPane に inline で残り、Copilot レビューが事実上唯一の検出機構になっている。→ **B で解決**。
2. **save context (folder + mtime) が stale closure 経由でしか繋がっていない**。`runSave` → `onSaveRef.current(entry)` → `handleSave` (closure に folderPath) → `saveEdit` (`folderRef.current` / `loadResultRef.current.mtime` を call 時に読む)。round 6 はこの脆さの帰結で、`ClassificationView.handleSave` に `folderPathRef` の pre-IPC guard を足す応急処置で塞いだ。AGENTS.md H-8 同期モデル表でも **「context struct を渡す」を target、`folderPathRef` guard を応急処置**と明記済み。→ **C で解決**。

---

## 4. 同期モデル (着手前マトリクス — C の target)

> CLAUDE.md「非同期処理の着手前ルール」/ AGENTS.md H-8 に従い、**C の配線を書く前にこの表を確定する**。表は「現状 (PR #109 最終実装)」と「target (C 後)」を併記し、C の各変更がどの行を解消するかを追跡できるようにする。「該当軸なし」は明示する。

### 4.1 event source × race 変数 (5 列 + 現状/target)

| event source | trigger | capture したい値 | stale 化リスク (mtime / folder / dirty / touched / inflight) | 現状 gate (PR #109) | target gate (C 後) |
|---|---|---|---|---|---|
| tag blur | `TagInput.onBlur` | `tagsRef` (post-commit) | **inflight** (連続 blur で mtime 競合) | `onSaveRef` render-sync + queue 直列化 | 同左 (B で hook 化、挙動不変) |
| note blur | `textarea.onBlur` | `noteRef` | **inflight** | 同上 | 同左 |
| radio change | `onChange` | 引数 override | **inflight** + dirty (1 render 遅れ) | 引数 override + merged dirty 再計算 | 同左 |
| Cmd/Ctrl+Enter | window keydown | refs (全フィールド) | dirty (gate 済) | `entry && dirty` で gate | 同左 |
| unmount cleanup | `useEffect` cleanup | `entryRef` / `autoSaveRef` | **folder** + mtime + dirty | `ClassificationView.handleSave` の `folderPathRef` pre-IPC guard (応急処置) | **ctx.folder を capture 時に固定し `saveEdit` で `ctx.folder !== folderRef.current` を pre-IPC skip** (guard を撤去) |
| save 成功 cascade | parent `setLoadResult` | new entry (per-field) | **touched** (touched then reverted) | per-field `touchedAfterBaselineRef` + 旧 baseline 一致判定 | 同左 (B で純 reducer 化、挙動不変) |
| queue replay (dequeue) | `runSave` の `finally` | queued snapshot | **mtime** (前 save が mtime を advance) | `setTimeout(0)` 後に `onSaveRef.current` 経由で最新 mtime を再取得 + `loadResultRef.current.mtime` fresh read | §11 D-2: (a) 同左を温存 / (b) 前 save 戻り値 `out.mtime` を queue が伝播し `setTimeout(0)` 退役 |

### 4.2 folder と mtime は capture/dispatch の扱いが異なる (C の肝)

C で `ctx = { folder, baselineMtime }` を導入する際、**folder と mtime を同じ「capture 時固定」で扱うと round 2 の CONFLICT が再発する**。両者は意味が違う:

- **folder = capture 時に固定**。保存先はユーザーが編集した瞬間に確定し、後続 save が state を進めても変わらない。cleanup-after-switch では capture 時 (= 切替前 render) の folder を運ぶことで、**OLD folder に書き / NEW folder を汚さない**。SampleEditPane が render-time sync する `folderPropRef` は、folder 切替で modal が unmount されると更新されない (= OLD のまま) ので、cleanup が読む値は自然に OLD になる。これは現状 `onSaveRef.current` が OLD `handleSave` を握るのと同じ仕組みを **意図的に** 使う。
- **mtime = dispatch 時に解決**。同一 folder への連続 save (queue replay) では、各 save 成功で sidecar mtime が advance する楽観ロックトークン。capture 時に固定すると、queue replay の 2 本目が pre-save mtime を送り `CONFLICT:` を踏む (= round 2 で塞いだ穴)。

target の `saveEdit(entry, ctx)`:

```ts
async function saveEdit(entry, ctx) {
  // pre-IPC: capture 時の folder から現在離れていれば、この save は
  // もう居ない folder のもの → skip。round 6 の folderPathRef guard を置換。
  if (folderRef.current !== ctx.folder) return;
  // ここに来た = ctx.folder に居る → loadResultRef が ctx.folder を追跡中。
  // queue replay 整合性のため mtime は fresh read (§11 D-2 (a) 案)。
  const lr = loadResultRef.current;
  if (!lr) return;
  const out = await UpdateClassificationEntry(ctx.folder, entry, lr.mtime);
  if (folderRef.current !== ctx.folder) return;   // post-IPC: await 中の switch
  ++requestGenRef.current;
  setLoadResult(/* patch */);
  setEditing({ open: false, filename: null });
}
```

- **pre-IPC `ctx.folder !== folderRef.current`** = 「call 前に switch した」(round 6 の cleanup-after-switch)。`ClassificationView.handleSave` の `folderPathRef` guard をここに移し、guard 撤去。
- **post-IPC `folderRef.current !== ctx.folder`** = 「await 中に switch した」(PR #75 14th)。現状の `folderRef.current !== cur` を `ctx.folder` ベースに置換。
- 2 つの gate は別軸 (pre-call switch / mid-await switch) を覆い、現状の「`handleSave` の guard + `saveEdit` の post-IPC check」と同じカバレッジを **stale closure に依存せず** 達成する。

> **注意**: §11 D-2 で「mtime を ctx に含め `loadResultRef` 非依存にして `setTimeout(0)` を退役する」(b) 案も選べるが、queue の mtime 伝播を誤ると round 2 を再発させるリスクがある。**初期実装は (a) 案 (fresh read 温存) を推奨**し、(b) は B のテスト網が green になってから別途検討する。

---

## 5. Phase 1 (B): テスト基盤 + hook 抽出

### 5.1 依存追加 (最小構成)

`frontend/package.json` の `devDependencies` に追加 (Q1 合意 = 最小):

| パッケージ | 用途 |
|---|---|
| `happy-dom` | vitest の DOM 環境。jsdom より軽量・高速。renderHook の `act` / microtask flush に十分。 |
| `@testing-library/react` | `renderHook` / `act`。React 19 対応版を選ぶ。 |

- `@testing-library/user-event` / `@testing-library/jest-dom` は **入れない** (renderHook ベースの hook テストには不要、§11 D-5)。
- CLAUDE.md「フロント追加ライブラリは原則入れない」の例外として、本 spec のレビュー合意をもって導入する (= 導入合意フェーズ)。context.md L64 の「DOM テストは未導入 (必要時に happy-dom + @testing-library を別途検討)」を「導入済み」へ更新する (§9)。

### 5.2 vitest 環境の指定方法

既存の純関数テスト (`filters.test.ts` 等) を happy-dom に巻き込むと無駄に遅くなるため、**DOM が要るテストファイルにのみ docblock で環境指定**する:

```ts
// useAutoSaveQueue.test.ts 冒頭
// @vitest-environment happy-dom
```

- `vite.config.ts` に `test: { environment: 'node' }` を明示 (デフォルト node を固定)。グローバルを happy-dom にしない (§11 D-3)。
- 既存テストはファイル無変更で node のまま動く (回帰なし)。

### 5.3 `useAutoSaveQueue` の抽出 (挙動不変)

SampleEditPane の以下を `frontend/src/features/classification/useAutoSaveQueue.ts` へ移す:

- `saveInFlightRef` / `inFlightSnapshotRef` / `queuedSnapshotRef`
- `snapshotsEqual(a, b)` (純関数 → 単体でも export してユニットテスト)
- `runSave(snap)` の本体 (in-flight 判定 → queue → `finally` dequeue → `setTimeout(0)` replay)
- entry 切替で queue を捨てる reset 経路

抽出後の signature (案、§11 D-1 で確定):

```ts
export type Snapshot = { filename: string; tags: string[]; confidence: string; note: string };
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean;

export type UseAutoSaveQueueArgs = {
  // 実際の保存。SampleEditPane は onSaveRef.current(buildEntry(snap)) を読む
  // 安定 wrapper を渡す (render-time sync は呼び出し側に残す = 挙動不変)。
  save: (snap: Snapshot) => Promise<void>;
  // dequeue の macrotask scheduler。テストで決定論的に flush するため注入可能に
  // する (デフォルト (cb) => setTimeout(cb, 0))。
  scheduleDequeue?: (cb: () => void) => void;
};
export type UseAutoSaveQueueReturn = {
  runSave: (snap: Snapshot) => void;
  resetQueue: () => void;   // entry 切替時に呼ぶ
};
export function useAutoSaveQueue(args: UseAutoSaveQueueArgs): UseAutoSaveQueueReturn;
```

- SampleEditPane 側に残すもの: `onSaveRef` の render-time sync、`buildEntry`、`performAutoSave` の dirty gate、cleanup の発火条件。**hook はキューの状態機械だけを担う** (関心の分離)。
- `entry?.filename` 変化で `resetQueue()` を呼ぶ既存 effect は SampleEditPane に残す (entry 監視は pane の責務)。

### 5.4 renderHook テスト項目 (`useAutoSaveQueue.test.ts`)

`save` に **手動解決できる deferred Promise** を、`scheduleDequeue` に **手動 flush** を注入し、実 timer / 実 IPC なしで race を決定論的に検証する:

1. `runSave(A)` 1 回 → `save` が 1 回・A で呼ばれる。
2. in-flight 中に `runSave(B)` (B≠A) → `save` は A の 1 回だけ。A 解決 + dequeue flush → `save` が B で 2 回目。
3. in-flight 中に `runSave(A)` (同一) → queue に積まれず、A 解決後 2 回目の `save` が走らない (round 3 in-flight dedup)。
4. queued=B のとき `runSave(B)` 再投入 → queue 上書きは no-op、replay は 1 回 (round 3 queued dedup)。
5. `runSave(A)` → `runSave(B)` → `runSave(C)` 連続 → IPC は最大 2 回 (A in-flight + 最新 C が queued、B は捨てられる)。
6. dequeue が `setTimeout(0)` 相当の macrotask 後である (flush 前は replay が走らない)。
7. `resetQueue()` 後は queued snapshot が破棄され replay されない (entry 切替時の stale 着地防止)。

### 5.5 baseline reset の純 reducer 抽出 (round 2 / round 5)

baseline reset useEffect の per-field 同期判定を純関数へ:

```ts
// sampleEditBaselineSync.ts
export type BaselineFields = { filename: string | null; folder: string; confidence: string; note: string };
export type LocalFields = { tags: string[]; confidence: string; note: string };
export type Touched = { tags: boolean; confidence: boolean; note: boolean };
// 戻り値: 各フィールドを新 baseline に同期すべきか + 新 baselineRef + touched リセット
export function computeBaselineSync(
  prevBaseline: BaselineFields,
  entry: classification.Entry | null,
  local: LocalFields,
  touched: Touched,
): { syncTags: boolean; syncConfidence: boolean; syncNote: boolean; resetAll: boolean };
```

- useEffect は「reducer を呼んで結果に従い setState するだけ」に縮退。
- `sampleEditBaselineSync.test.ts` で round 2 (partial save で未 blur フィールド消失) / round 5 (touched then reverted) を pin。これらは現状コメント (`SampleEditPane.tsx` の `touchedAfterBaselineRef` 周辺) でしか担保されていない最重要 race。

### 5.6 Phase 1 のスコープ外

- `onSave` signature 変更・guard 撤去は **しない** (C の領域)。Phase 1 は「現状挙動を抽出してテストで固める」だけ。
- SampleEditPane の full DOM render テスト (TagInput 操作等) は入れない (user-event 未導入)。hook + 純関数で race を担保する方針を維持。

---

## 6. Phase 2 (C): `onSave` context API 化 + guard 撤去

> Phase 1 のテスト網が green になってから着手する。§4 同期モデル表を最初の commit にする。

### 6.1 `SaveContext` 型と `onSave` signature

```ts
export type SaveContext = { folder: string; baselineMtime: number };
// SampleEditPaneProps
onSave: (next: classification.Entry, ctx: SaveContext) => void | Promise<void>;
```

### 6.2 SampleEditPane 側

- 新 prop `folder: string` / `baselineMtime: number` を受け取り、**render-time sync** で `folderPropRef` / `baselineMtimePropRef` に書く (AGENTS.md H-8「state ref の同期タイミング」)。
- snapshot を capture する全経路 (`performAutoSave` / `handleSave` / cleanup) で `ctx = { folder: folderPropRef.current, baselineMtime: baselineMtimePropRef.current }` を同時に確定し、`runSave(snap, ctx)` で渡す。
- これにより cleanup-after-switch では capture 時 (= 切替前 render) の OLD folder が ctx に乗る (§4.2)。

### 6.3 `useClassificationEdit.saveEdit`

- signature を `saveEdit(entry, ctx)` に変更。保存先を `folderRef.current` ではなく **`ctx.folder`** にする。
- pre-IPC で `if (folderRef.current !== ctx.folder) return;` (round 6 の置換、§4.2)。
- mtime は §11 D-2 の合意に従う。**(a) 推奨**: `ctx.folder` 上に居る前提で `loadResultRef.current.mtime` を fresh read (queue replay 整合性を温存)。

### 6.4 `ClassificationView.handleSave` の guard 撤去

- `folderPathRef` / `folderPath !== folderPathRef.current` の pre-IPC guard ブロック (`ClassificationView.tsx` の round 6 追加分) を **削除**。
- `handleSave` は `ctx` を `saveEdit` に素通しするだけになる (folder/mtime の保持責務は SampleEditPane の capture へ移譲)。
- `folderPathRef` が他で使われていないことを grep 確認してから ref 宣言ごと撤去 (H-7 波及確認)。

### 6.5 同期モデル表の更新

C 実装後、§4.1 の「現状 gate」列を削除し「target gate」列が実装最終形と一致することを確認 (H-6)。cleanup 行 / queue replay 行の脚注 (応急処置・follow-up 予定) を解消済みに更新する。AGENTS.md H-8 の同表脚注「† context struct を渡す は #110 action C として follow-up 予定」も「実装済み (本 spec)」へ追従させる。

### 6.6 Phase 2 で追加する renderHook / 純関数テスト

- `saveEdit` の pre-IPC / post-IPC folder gate を `ctx.folder` 違いで分岐させ、cross-folder 時に **IPC を撃たない / 撃つが local commit skip** を pin (saveEdit を testable な形にできるか、または `shouldCommitSave(ctx, currentFolder)` 純関数を切り出して単体テスト)。
- Phase 1 の queue テストに `ctx` を載せ、folder 切替後 replay が `ctx.folder` を保ったまま走ることを確認。

---

## 7. データモデル / IPC / 永続化

- **settings schema**: 変更なし (`editAutoSave` は #105 のまま)。
- **Go 側 IPC (`UpdateClassificationEntry`)**: signature 不変 (`folder, entry, expectedMtime`)。C は **どの folder/mtime を渡すか** の JS 側決定経路を変えるだけで、Go API は不変。`go test ./...` は回帰確認のみ。
- **永続化形式 / マイグレーション**: 該当なし (sidecar 形式・settings.json 形式とも不変)。
- **ユーザー向け仕様 (init.md)**: 矛盾なし。本 spec は内部品質 (テスト網) と内部 TS 契約 (`onSave`) の改善で、ユーザーから見た auto-save の挙動は #105 (spec-edit-autosave.md) のまま不変。init.md の再解釈は不要。

---

## 8. テスト計画

### 8.1 Go 側

変更なし。`go test ./...` / `go vet ./...` を回帰確認として通す。

### 8.2 TS 側 (新規)

| ファイル | 対象 | Phase |
|---|---|---|
| `useAutoSaveQueue.test.ts` (`// @vitest-environment happy-dom`) | §5.4 の 7 ケース | 1 |
| `sampleEditBaselineSync.test.ts` (node) | §5.5 round 2 / round 5 | 1 |
| (上記に ctx ケース追加) | §6.6 cross-folder skip | 2 |

既存純関数テスト (`autoSaveTrigger.test.ts` / `sampleEditDirty.test.ts` 等) は無変更で通過すること。

### 8.3 手動確認 (wails dev、Phase 2 後)

spec-edit-autosave.md §8.3 の手動確認を再走し、**特に round 6 シナリオ**を再現:

- auto モードで note にタイピング → blur せず別フォルダを開く (folder 切替で modal unmount) → **OLD folder の sidecar にだけ反映 / NEW folder の同名ファイルに誤書き込みされない**。
- 連続 blur (tag → note) で `CONFLICT:` が出ない (queue 直列化が C 後も機能)。
- conflict 経路 (外部 sidecar 書換) が auto / manual 双方で従来通り。

---

## 9. ドキュメント追従 (実装時)

- `.claude/context.md` L64「DOM テストは未導入 (必要時に happy-dom + @testing-library を別途検討)」→ 「happy-dom + @testing-library/react 導入済み (renderHook で hook race を検証)」へ更新。L175 のフロントテスト記述にも hook テストを追記。
- `AGENTS.md` H-8 同期モデル表の脚注 († context struct follow-up 予定 / 応急処置 `folderPathRef`) を C 実装後に「実装済み」へ更新 (§6.5)。
- `docs/spec-edit-autosave.md` §8.2.3「DOM テスト基盤の追加は別 issue で扱う」「今回は導入しない方針」を本 spec への参照に更新 (改訂履歴 +1 行)。
- `docs/todo.md` の #110 行を「B+C は別 issue に切り出し」→「本 spec で Phase 分割対応」に更新 (着手前に 1 行、§12)。

---

## 10. Out of scope

- SampleEditPane の full DOM 統合テスト (user-event ベースの blur→保存反映の end-to-end)。最小構成方針のため hook + 純関数で代替。
- debounce auto-save / idle timer / 「保存中…」インジケータ (spec-edit-autosave.md §9 Phase 2 のまま据え置き)。
- 他フックへのテスト基盤横展開 (`useDnD` / `useViewerSet` 等)。本 spec は auto-save 経路に限定。導入された happy-dom 基盤は将来それらにも使えるが本 issue では着手しない。
- §11 D-2 (b) 案 (mtime を ctx で運び `setTimeout(0)` 退役)。初期は (a) を採用し、別途検討。

---

## 11. 決定事項 (要合意)

レビューで確定する。**推奨案を A とするが redirect 可**。

### D-1. `useAutoSaveQueue` の抽出境界

- **A 案 (推奨)**: キュー状態機械 (`runSave` / in-flight / queued / dedup / dequeue) だけを hook 化し、`save` と `scheduleDequeue` を注入。baseline reset は別の純 reducer (§5.5) に分離。
- B 案: baseline reset + cleanup 判定まで 1 つの大きな hook にまとめる。テスト 1 ファイルで済むが関心が混ざり、抽出 diff が大きく挙動不変の確認が難しくなる。

### D-2. C での mtime の扱い

- **A 案 (推奨)**: `ctx` は folder のみ意味を持たせ、mtime は `saveEdit` 内で `loadResultRef.current` から fresh read (現状の round 2 対策を温存)。`setTimeout(0)` dequeue も残す。最小変更で round 2/6 を両立。
- B 案: `ctx.baselineMtime` を save 戻り値 `out.mtime` で queue が次 replay に伝播し、`loadResultRef` 依存と `setTimeout(0)` を退役。配線は綺麗になるが mtime 伝播ミスで round 2 を再発させるリスク。テスト網が安定してから別 PR を推奨。

### D-3. vitest 環境指定

- **A 案 (推奨)**: DOM が要るテストファイルに `// @vitest-environment happy-dom` docblock。`vite.config.ts` のデフォルトは node 明示。既存テストは無変更。
- B 案: グローバル `environment: 'happy-dom'`。設定 1 箇所だが全純関数テストが happy-dom 起動分遅くなる。

### D-4. Phase 1 / Phase 2 の PR 分割

- **A 案 (推奨)**: 別 PR。Phase 1 (テスト基盤 + 抽出、挙動不変) を先にマージし net を確定 → Phase 2 (リファクタ) を net の下で。レビューも「挙動不変の抽出」と「挙動を変えるリファクタ」を分離でき H-6 照合が楽。
- B 案: 1 PR。往復は 1 回だが diff が大きく、抽出由来の変更とリファクタ由来の変更が混ざる。

### D-5. テストライブラリ構成 (issue triage で先行合意済み)

- **確定**: `happy-dom` + `@testing-library/react` のみ。`user-event` / `jest-dom` は入れない。将来 full DOM 統合テストが必要になった時点で追加合意。

---

## 12. Phase 分割サマリ

| Phase | issue action | 内容 | PR | 前提 |
|---|---|---|---|---|
| **1** | B | happy-dom + RTL 導入 / `useAutoSaveQueue` + baseline reducer 抽出 (挙動不変) / renderHook + 純関数テスト | PR-1 | 本 spec 合意 |
| **2** | C | `onSave` context API 化 / `saveEdit` の ctx gate / `folderPathRef` guard 撤去 / cross-folder テスト | PR-2 | PR-1 マージ (テスト網 green) |

- 各 Phase 着手時に `docs/todo.md` の #110 行を更新 (B+C を本 spec で Phase 分割対応へ書き換え)。
- #110 は **両 Phase 完了でクローズ**。Phase 1 のみで止める場合は issue を open のまま C を残タスクとして追跡。

---

## 13. 関連

- 振り返り元: issue [#110](https://github.com/maretol/image-observer/issues/110) (action B/C)、PR #109 (6 round) / PR #111 (A+D 反映)
- 前提機能 spec: [docs/spec-edit-autosave.md](spec-edit-autosave.md) (#105 auto-save 本体)、[docs/spec-sample-modal-edit.md](spec-sample-modal-edit.md) (#93 統合モーダル)
- 着手前マトリクス規約: [AGENTS.md](../AGENTS.md) H-8 (同期モデルテンプレ — §4 の表はこれに準拠) / I-1 (3 round で立ち止まる)
- CLAUDE.md「非同期処理の着手前ルール」(複数 async source が同一 state を mutate する change は最初の commit が同期モデル表)
- 触るコード: `frontend/package.json` / `vite.config.ts` (B) / `SampleEditPane.tsx` / `useClassificationEdit.ts` / `ClassificationView.tsx` (C)
