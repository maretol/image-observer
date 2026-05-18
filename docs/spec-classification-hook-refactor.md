# useClassification.ts リファクタ実装仕様書 (#66)

`frontend/src/features/classification/useClassification.ts` に集約されている
load / edit / conflict / merge / delete / watcher / replay の async フローを
**機能単位で分離** し、エラー経路と通知境界の見通しを上げる。挙動は完全互換、
race 対策の構造 (`requestGenRef` / `folderRef` / `pendingResultRef` 等) は
維持する。

> **ステータス**: ドラフト。§6 / §7 の決定事項をユーザー合意後に着手。

---

## 0. 改訂履歴

| 更新日 | 主な変更 |
|--------|---------|
| 2026-05-18 | 初版ドラフト。分割粒度を 3 案比較し、推奨案 (案 B: 軽量子フック分離) を提示 |

---

## 1. ゴール (DoD)

- `useClassification.ts` 本体 (現行 1 ファイル) を **責務別に複数モジュールへ分割**。
  本体は orchestrator として「子フック / 純関数を組み立てて 1 つの戻り値にまとめる」役割に縮小。
- 既存テスト (`watcherPolicy.test.ts` / `cardContextMenuLogic.test.ts` /
  `colors.test.ts` / `filters.test.ts` / `groups.test.ts` / `thumbnailCache.test.ts`)
  が **無修正で通過**。
- `npm --prefix frontend test -- --run` / `npm --prefix frontend run typecheck` /
  `go test ./...` / `go vet ./...` がすべてグリーン。
- 既存の race 対策 (`requestGenRef` / `loadingTokenRef` / `initialLoadInFlightRef` /
  `inFlightDeletesRef` / `folderRef` / `loadResultRef` 等) と
  **AGENTS.md §H-8 のレース変数マトリクスが維持される** (新しい race window を
  作らない / 既存の防御を弱めない)。
- 公開 API (`UseClassificationReturn` 型) は **完全に同一**。
  呼び出し側 (`ClassificationView.tsx` 他) は変更しない。
- 各分割モジュールに「責務 / どの shared ref に依存しているか / なぜ
  独立フックに切り出せたか」を 1 段落のヘッダコメントで明示
  (AGENTS.md A-2 / A-3: 説明文と実装の最終形が一致)。

### Non-Goals

- `useClassification` の戻り値 (`UseClassificationReturn`) のリネーム / 増減。
- `ClassificationView.tsx` / `App.tsx` 側の構造変更 (#67 で別途扱う)。
- race 設計の見直し (= 既存防御の削減や新方式の導入)。Maintainability 改善のみ。
- 新しい機能 / IPC / 永続化形式の追加。
- 既存テストの書き換え。

---

## 2. 用語

- **shared ref**: フック内に閉じた `useRef` で、複数の async コールバック /
  effect が読み書きする共有状態。`folderRef` / `requestGenRef` /
  `loadResultRef` / `inFlightDeletesRef` 等。
- **defer-park パターン**: 編集 / conflict / mergePrompt 表示中に watcher
  Load 結果を `pendingResultRef` に保存し、状態解消時に replay するパターン
  (AGENTS.md H-8 / spec-folder-watch.md §15)。
- **race 防御**: `requestGenRef` 世代トークン + folder check + mode check +
  pending gen check の組み合わせ (詳細は AGENTS.md §H-8)。

---

## 3. 現状把握

### 3-1. 現行ファイル構成 (1,635 行)

| 行範囲 (概数) | 内容 |
|---------------|------|
| 1-41 | imports / 定数 / event 名 |
| 42-115 | 型定義 (`EditingState` / `ConflictPrompt` / `MergePromptState` / `UseClassificationReturn`) |
| 116-131 | `Opts` 型 (consumer 入力) |
| 133-281 | hook 冒頭: useState / refs / `resetEntriesDependentState` |
| 283-323 | `loadInternal` |
| 331-376 | `postLoadFlow` |
| 386-403 | auto-load on mount effect |
| 405-450 | `openFolder` / `reload` |
| 452-473 | filter 系 (`setFilter` / `toggleTag` / `clearTags` / `filteredEntries`) |
| 475-532 | 選択系 (`selected` / `selectAnchor` / `toggleSelected` / `extendSelectionTo` / `clearSelected` / `selectedFilenames`) |
| 534-741 | watcher 系 (`handleWatcherPayload` / `commitFreshResult` / 各種 ref sync) |
| 743-862 | `silentRecheckAfterStart` |
| 864-1016 | watcher lifecycle (`dispatchWatchIntentRef` + 2 effects) |
| 1018-1178 | `performReplay` + 2 effects (defer-close 検知) |
| 1180-1296 | edit 系 (`openEdit` / `closeEdit` / `saveEdit` / `resolveConflictXxx`) |
| 1298-1345 | merge 系 (`resolveMergeMerge` / `resolveMergeSkip` / `resolveMergeCancel`) |
| 1347-1503 | `deleteOne` |
| 1505-1595 | `persistableState` + `useMemo` で戻り値を stabilize |
| 1598-1635 | ファイル末尾の純関数 (`normalizeConfidence` / `entriesEquivalent`) |

### 3-2. shared refs の依存関係 (= 分割境界の制約)

| ref 名 | 読み書きする経路 |
|--------|------------------|
| `folderRef` | load / openFolder / reload / watcher / silentRecheck / performReplay / saveEdit / resolveConflictForce / merge / delete |
| `requestGenRef` | 全 async 経路 (世代トークン共有) |
| `loadingTokenRef` | loadInternal のみ |
| `initialLoadInFlightRef` | loadInternal / silentRecheck |
| `loadResultRef` | watcher / silentRecheck / performReplay |
| `inFlightDeletesRef` | watcher / silentRecheck / deleteOne |
| `editingRef` | watcher / silentRecheck / performReplay |
| `conflictRef` | watcher / silentRecheck / performReplay |
| `mergePromptOpenRef` | watcher / silentRecheck / performReplay |
| `pendingResultRef` | watcher / silentRecheck / performReplay / resetEntriesDependentState |
| `watchModeRef` | watcher / silentRecheck / performReplay / dispatchWatchIntent |
| `dispatchWatchIntentRef` | reload / openFolder / watch effect |

→ **完全独立に切り出せるのは Filter と Selection のみ**。
他は何らかの shared ref を介して結合している。

---

## 4. 分割粒度の選択肢

### 案 A: 同一ファイル内の論理セクション化 (最小変更)

- ファイル分割なし。コードの並び順を「型 → state/refs → 各機能セクション (
  load / filter / selection / watcher / replay / edit / conflict / merge / delete /
  return) → 純関数」に整理し、各セクションの冒頭に責務ヘッダコメントを追加。
- メリット: 結合構造は維持されるので race 設計を傷つけない。レビュー差分が
  最小 (再配置と命名のみ)。
- デメリット: 1 ファイル 1,635 行は変わらない (= #66 の本来の動機を満たさない)。

### 案 B: 軽量子フック分離 (推奨)

- 子フック単位でファイルを分け、shared refs / state / setters を **props
  オブジェクト** で引き渡す。本体は orchestrator。
- 分割案:
  ```
  features/classification/
    useClassification.ts              // 本体 (orchestrator, ~250-300 行想定)
    useClassificationFilter.ts        // filter / filteredEntries (完全独立)
    useClassificationSelection.ts     // selected / selectAnchor / 範囲選択 (完全独立)
    useClassificationLoad.ts          // loadInternal / postLoadFlow / openFolder / reload
    useClassificationWatcher.ts       // handleWatcherPayload / silentRecheckAfterStart
                                      //   / dispatchWatchIntent / 2 effects / commitFreshResult
    useClassificationReplay.ts        // performReplay + 2 effects (defer-close)
    useClassificationEdit.ts          // saveEdit / resolveConflictXxx + openEdit / closeEdit
    useClassificationMerge.ts         // resolveMergeXxx
    useClassificationDelete.ts        // deleteOne
  ```
- メリット: ファイル粒度で責務が明確、認知負荷が下がる。`useClassificationLoad`
  などは将来テストを追加する単位として明確。
- デメリット: shared refs の props 渡しが冗長 (1 子フックあたり 5-10 個の
  ref / setter を受け取る)。新しい race window を作るリスクは props 渡しの
  ミス (ref の取り違え / setter の不整合) に集中する。

### 案 C: Context-based 分離

- `ClassificationContext` を作って refs / setters を共有、子フックは
  context から取得。
- メリット: props 渡しが消える。
- デメリット: provider 一段増える / 既存呼び出し側に変更が波及 / 個人開発で
  hook 1 つのために context を導入するのは過剰。本件は **不採用**。

### 推奨

**案 B (軽量子フック分離)**。理由:
1. #66 の文言「機能単位で分割」を素直に満たす
2. shared refs は明示的に props で渡るので「どの子フックがどの ref を読むか」
   が型シグネチャに現れる (案 A の暗黙参照より追跡しやすい)
3. context (案 C) を導入する重さに見合うメリットが無い
4. 案 A は #66 の動機を満たさず、レビュー時に「分割しなかった理由」を
   逐次説明する負担が残る

---

## 5. 提案する分割構造 (案 B 詳細)

### 5-1. 本体 `useClassification.ts` (orchestrator)

責務:
- すべての useState / useRef を **本体で宣言**。子フックには ref/state/setter
  を props で渡す (refs を子フックで宣言すると本体から見えないため)。
- `resetEntriesDependentState` ヘルパもここで宣言 (load / watcher / replay
  の 3 経路から共有されるため)。
- 各子フックを呼び出し、戻り値を組み立てて返す (`useMemo` で stabilize)。

```ts
// 擬似コード (シグネチャの方針提示用、実装ではない)
export function useClassification(opts: Opts): UseClassificationReturn {
  // ── shared state / refs ──
  const [folderPath, setFolderPath] = useState(...);
  const [loadResult, setLoadResult] = useState(...);
  // ...
  const folderRef = useRef(folderPath); folderRef.current = folderPath;
  const requestGenRef = useRef(0);
  // ... 他 refs

  const sharedRefs = {
    folderRef, requestGenRef, loadingTokenRef, initialLoadInFlightRef,
    loadResultRef, inFlightDeletesRef, editingRef, conflictRef,
    mergePromptOpenRef, pendingResultRef, watchModeRef,
    dispatchWatchIntentRef, /* etc. */
  };

  const resetEntriesDependentState = useCallback(() => { /* ... */ }, [...]);

  // ── child hooks ──
  const filter = useClassificationFilter({ initialList: opts.initialList });
  const selection = useClassificationSelection({ folderPath });
  const load = useClassificationLoad({
    ...sharedRefs, setLoading, setLoadResult, setError,
    resetEntriesDependentState, toast, confirm: opts.confirm,
  });
  const replay = useClassificationReplay({ ...sharedRefs, /* ... */ });
  const watcher = useClassificationWatcher({
    ...sharedRefs, /* setters */, performReplay: replay.performReplay,
    silentRecheckAfterStart: replay.silentRecheckAfterStart,
  });
  const edit = useClassificationEdit({ ...sharedRefs, /* ... */ });
  const merge = useClassificationMerge({ ...sharedRefs, /* ... */ });
  const del = useClassificationDelete({ ...sharedRefs, /* ... */ });

  // ── return ──
  return useMemo(() => ({ /* assemble all */ }), [/* deps */]);
}
```

### 5-2. 各子フックの責務 (詳細)

| 子フック | 入力 props (主要) | 戻り値 (主要) |
|----------|-------------------|---------------|
| `useClassificationFilter` | `initialList?.filter` | `filter` / `setFilter` / `toggleTag` / `clearTags` / `filteredEntries(loadResult)` (= 関数を返す or hook 内で memo) |
| `useClassificationSelection` | `folderPath` (reset trigger) | `selected` / `isSelected` / `toggleSelected` / `extendSelectionTo` / `clearSelected` / `selectedFilenames` |
| `useClassificationLoad` | refs + setters + `toast` + `confirm` | `openFolder` / `reload` / `loadInternal` (子フック間共有用) / `postLoadFlow` |
| `useClassificationWatcher` | refs + setters + `commitFreshResult` + `loadInternal` (or 必要なら親から再呼び出し) | `handleWatcherPayload` (内部) + 内部 effects |
| `useClassificationReplay` | refs + setters + `commitFreshResult` + `silentRecheckAfterStart` | `performReplay` + 内部 effects |
| `useClassificationEdit` | refs + setters + `loadResult` + `reload` + `toast` | `openEdit` / `closeEdit` / `saveEdit` / `resolveConflictXxx` |
| `useClassificationMerge` | refs + setters + `loadInternal` + `toast` | `resolveMergeMerge` / `resolveMergeSkip` / `resolveMergeCancel` |
| `useClassificationDelete` | refs + setters + `loadResult` + `loadInternal` + `confirm` + `toast` | `deleteOne` |

### 5-3. props 型の設計

- shared refs を1つの `ClassificationSharedRefs` 型で集約し、各子フックは
  必要な部分だけを picks (`Pick<>` で型を絞る) して受け取る。
  - 例: `useClassificationSelection` は refs 不要なので渡さない。
  - 例: `useClassificationFilter` も refs 不要。
- setters は `ClassificationSharedSetters` 型で集約。同様に Pick で絞る。
- これにより「どの子フックが何に依存しているか」が型シグネチャから読める。

### 5-4. watcher と replay の循環依存問題

`useClassificationWatcher` は `handleWatcherPayload` 内で
`commitFreshResult` を呼び、defer 判定で `pendingResultRef` を park する。
`useClassificationReplay` は `pendingResultRef` を read & clear し、defer-close
で `performReplay` を実行する。両者は **`pendingResultRef` を共有するだけで
直接の関数依存はない**。

ただし `silentRecheckAfterStart` は watcher lifecycle effect (`dispatchWatchIntent`)
から呼ばれる。これを replay 側に置くと watcher が replay に依存するため
**`silentRecheckAfterStart` も watcher 側に置く** (現状コードの構造を踏襲)。
→ replay は performReplay のみを持つ。

### 5-5. 純関数の配置

`normalizeConfidence` / `entriesEquivalent` (現行 1598-1635 行) は副作用なし。
- `normalizeConfidence` → `useClassificationFilter.ts` に同梱 (filter 側で使用)。
- `entriesEquivalent` → `useClassificationWatcher.ts` に同梱、または
  `entriesEquivalent.ts` に独立。silentRecheck 側でも使うので両者から
  import する。**`entriesEquivalent.ts` に独立配置** を推奨。

---

## 6. 設計判断 (合意したい事項)

### Q1. 案 B (軽量子フック分離) で進めてよいか

- 案 A (同一ファイル内セクション化) と比べて、規模は大きいが #66 の本来の
  動機を満たす。ただし spec § 5 の構造で **8 ファイル新規作成 + 本体大幅
  縮小** になる。これを受け入れるか。
- 代案として「案 A から段階的に着手 (Phase 1)、後で案 B に移行 (Phase 2)」も
  可能だが、ユーザーが個人開発であり一気にやって問題ない可能性が高い。

### Q2. shared refs の props 渡しは「集約型 + Pick」で OK か

- 各子フックの引数を `Pick<ClassificationSharedRefs, "folderRef" | "requestGenRef" | ...>`
  で絞る方針。これで型シグネチャから「この子フックが依存する ref」が一目で
  分かる。
- 代案: 個別 props (子フックごとに別個の type 定義) でも可。粒度が細かくなる
  分だけ追跡しやすい反面、ボイラープレートが増える。

### Q3. `loadInternal` を子フック間で共有する方法

- `useClassificationLoad` が `loadInternal` を return → orchestrator が他の
  子フック (`useClassificationMerge` / `useClassificationDelete`) に props で
  渡す。これが最も素直。
- 代案: `loadInternal` を ref に格納して shared refs に含める (循環依存を
  避けるため)。可読性は下がるが orchestrator の props 渡しは減る。
- **推奨は素直な props 渡し** (Q2 と整合)。

### Q4. ファイル名の prefix

- `useClassificationFilter.ts` (長い) vs `useFilter.ts` (短いが文脈依存)
  → `features/classification/` 配下に置くので **短い名前で OK** とも言えるが、
   `useClassification.ts` という親があるので prefix 揃えのほうが grep しやすい。
- **推奨: フル prefix で揃える** (`useClassification*.ts`)。

### Q5. テストの追加

- 既存の機能テスト (`watcherPolicy.test.ts` 等) は通過維持が必須。
- 子フック単位の test は **追加しない** (#66 の Non-Goals)。リファクタ後に
  必要なら別 issue で追加。
- 動作確認は wails dev + 既存 vitest で担保。

---

## 7. Phase 分割 / commit 戦略

### Phase 単一案 (推奨): 1 PR で完了

- リファクタは intermediate 状態が型エラー / 動作不整合を生む可能性が高く、
  段階分割しても各 phase が動かなければ意味がない。1 PR で完了させる。
- commit 単位 (PR 内):
  1. **prep**: `entriesEquivalent.ts` 独立化 (もっとも依存が小さい純関数)
  2. **filter**: `useClassificationFilter` 切り出し
  3. **selection**: `useClassificationSelection` 切り出し
  4. **load**: `useClassificationLoad` 切り出し (`loadInternal` / `postLoadFlow` /
     `openFolder` / `reload` / auto-load effect)
  5. **watcher**: `useClassificationWatcher` 切り出し (watcher payload +
     silentRecheck + lifecycle + commitFreshResult + entriesEquivalent 使用)
  6. **replay**: `useClassificationReplay` 切り出し (performReplay + 2 effects)
  7. **edit**: `useClassificationEdit` 切り出し
  8. **merge**: `useClassificationMerge` 切り出し
  9. **delete**: `useClassificationDelete` 切り出し
  10. **cleanup**: orchestrator の最終整理 + コメントヘッダ追加

各 commit の末尾で `npm --prefix frontend test -- --run` /
`npm --prefix frontend run typecheck` を通す。

### 段階分割案 (代替)

- Phase 1 として filter / selection (完全独立組) だけ分離 → PR
- Phase 2 として残りを分離 → PR
- 利点: review が小さい。
- 欠点: Phase 1 単独では「機能単位で分割」を満たさない (filter / selection
  は元から独立性が高く、orchestrator にも残せる)。**個人開発ペースなら
  単一案で十分**。

---

## 8. リスク

### R1. race 設計の regression

shared refs を子フックに props で渡す過程で、ref 取り違え / setter の
不整合 / effect の dep array ミスにより既存 race 防御が破綻する可能性。

**緩和策**:
- 各子フック切り出し commit ごとに既存 vitest を通す。
- AGENTS.md §H-8 の race 変数を **commit ごとに目視チェック** (本リファクタ
  対象の全 17 個の ref が想定の経路で読み書きされ続けているか)。
- `wails dev` で folder 切替 → 編集中に外部書き換え → defer → 編集 close
  までの defer-park パスを最低 1 度は手動で踏む。

### R2. effect の dep array ミス

子フックに分離するとそれぞれが独立した useEffect を持つ。dep array に shared
ref を渡すのは正しくない (refs はリレンダリングを起こさない) が、setter は
useCallback / useState が返すものなので stable。

**緩和策**:
- 親で useState を宣言 → 子フックに setter を渡すパターン。React の useState
  setter は識別子安定なので dep array に入れて OK。
- ref 引用は dep に入れない / 入れる場合は eslint-disable コメントを残す
  (既存コードと同じ流儀)。

### R3. ファイル数の増加で grep / 把握コストが上がる

8 ファイル分散すると初見の認知負荷は上がる。

**緩和策**:
- 本体 (orchestrator) の冒頭に「子フックの責務早見表」コメントを置く
  (本書 §5-2 の表をそのまま貼る)。
- ファイル名 prefix 揃え (Q4) で grep しやすくする。

---

## 9. テスト戦略

- 既存テスト全通過が DoD (§1)。
- 追加テストなし (Non-Goals)。
- 手動確認 (wails dev):
  - フォルダを開く → 編集 → 保存 → reload → 別フォルダに切替 → 戻る
    (load / edit 経路)
  - 編集中に外部から `_classification.json` を書き換え → 編集 close で
    auto-merge 反映 (watcher / replay / defer)
  - 編集中に外部から画像を 1 件削除 → 削除 toast + entries 更新
    (watcher / delete-detect)
  - 自分で削除 (右クリック → ゴミ箱) → self-echo 抑制で「外部削除」toast が
    出ないこと (watcher + deleteOne)
  - 子フォルダに sidecar あり / 親に sidecar なし → MergePromptDialog 表示 →
    merge → reload (merge 経路)
  - conflict 発生 (= 編集中に外部 save) → conflict ダイアログ →「再読込」
    / 「強制上書き」/ 「キャンセル」3 パターン (conflict 経路)

---

## 10. 関連

- 親 issue: [#66](https://github.com/maretol/image-observer/issues/66)
- 引用: PR #75 (25+ ラウンド) の race 対策が本ファイル内コメントに濃く反映
  されている。本リファクタは **これらの設計意図を維持する**。
- 関連 spec: [spec-classification.md](spec-classification.md) /
  [spec-folder-watch.md](spec-folder-watch.md)
- 関連 AGENTS: [AGENTS.md §H-8](../AGENTS.md) (非同期 / IPC 経路 race 検証
  マトリクス)
- 関連 issue (未着手): [#67](https://github.com/maretol/image-observer/issues/67)
  App.tsx の状態管理分離 — 本 issue とは独立。本リファクタが先に入っても
  競合しない (#67 は App.tsx 側のみ)。
