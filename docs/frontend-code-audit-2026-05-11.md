# フロントエンドコード総ざらい監査 (2026-05-11)

対象: `frontend/src/` 全ファイル (Phase 5 + Phase H1/H2/H4 + H UX 修正 完了時点)。
ブランチ: `claude/frontend-code-audit-Qr3rF`。

本ドキュメントは「コードを変更せずに気付きを列挙する」目的のレビューメモ。Phase H 以降の作業優先度付けや、リファクタリング PR の起点として利用する。

---

## 🔴 重要 (バグ / パフォーマンス影響大)

### 1. `ImageView.tsx` で原寸画像の base64 を毎レンダ再生成
- 該当: `frontend/src/features/viewer-grid/ImageView.tsx:373` の `const src = toDataURL(imageData.data, imageData.mimeType)`。
- `imageData` は `ReadImage` 完了時にしか変わらないが、pan/zoom/resize 等で `ImageView` は頻繁に再レンダされ、その度に **数十 MB の base64 文字列を再構築**して `<img src=...>` に渡している。
- chunked `bytesArrayToBase64` は呼ばれず、Wails が `[]byte` を string で返した場合は早期 return で済むため最悪ケースは `data:` テンプレートリテラル組み立てだけだが、それでも巨大文字列の連結は GC 圧。
- 対策: `useMemo(() => toDataURL(...), [imageData])` で memo 化。

### 2. `useViewerGrid` / `useClassification` の戻り値オブジェクトが毎回新規
- 両 hook とも最後に plain object literal を返す。React の memo 化対象としては毎レンダ identity が変わる。
  - `App.tsx:184` の keydown 用 `useEffect` の deps `[topTab, settingsOpen, viewer]` のせいで、**毎レンダ event listener を付け替え**ている。
  - `<ClassificationView state={classification} />` `<ViewerGrid ... />` の子ツリー全体が、関連のない state 更新 (例: window-poll の 2 秒インターバル) でも再レンダ候補になる。
- 個別 callback はすでに `useCallback` 済みなので、戻り値だけ `useMemo` で括ると効果が大きい。

### 3. サムネイルキャッシュが完全に無制限
- `features/classification/useGridThumbnail.ts:17` の module-scoped `Map<string, CacheValue>` は **エビクションなし**。
- 値が `data:` URL (base64 文字列) なので、256px サムネ 1 枚 ≈ 30〜150KB。数千枚のフォルダを開くと 100〜500MB 規模で常駐する。
- コメントにも「LRU は Phase H follow-up」とあるが、**実害が出る規模の問題**として明記しておくべき。`URL.createObjectURL` + revoke / LRU 化など。

### 4. `useClassification` の Hook 内で参照順が反転している箇所
- `useClassification.ts:268-295` の `extendSelectionTo` 内で `selectAnchorRef.current` を読んでいるが、`selectAnchorRef` の宣言は **その下の line 301**。
- `useCallback` の関数本体は呼び出し時にのみ評価されるので実害は出ていないが、TDZ の罠を踏みかねない並び。`useRef` 宣言を `useCallback` の前に移すべき。

### 5. `ClassificationView` の責務分割が曖昧 (件数集計の二重計算)
- `tagSummary(allEntries)` や `totalCountByGroup` は `ClassificationView` 側でも `useMemo` 計算しているが、`ClassificationHeader` には `filteredCount/totalCount` を上から渡しており、**集計責務が散らばっている**。
- バグではないが、`ClassificationView` が薄いオーケストレーション層に徹する形に整理した方が読みやすい。

---

## 🟡 改善余地 (構造 / 一貫性)

### 6. `as any` / `as unknown as` の散見
- `useSessionSave.ts:54` `SaveState(data as any)` — `state.StateData.createFrom(...)` で型を通す方が安全。Go 側で構造体フィールドが増えても TS で気付ける。
- `App.tsx:303` `ls.root as unknown as LayoutNodeState` — Wails 自動生成型と独自型のブリッジ。`layout.ts` の型を Wails 型から導出する形に揃えるか、コンバータを 1 か所に閉じ込めたい。
- `ImageView.tsx:374`, `useGridThumbnail.ts:29` `data as unknown as number[] | string` — Wails の `[]byte` 表現の揺れに対する保険。`base64.ts` 内部で完結させ、引数型を `unknown` にした方が呼び出し側がきれい。

### 7. `useSessionSave.ts` に dead-field を残している
- `buildStateData` に `rootPath: ""` / `leftPaneWidth: 280` を「v1 leftovers」コメント付きで詰めている。Go 側の構造体に残骸があるなら一緒に削除するのが本筋 (state schema v5 のタイミングで)。今のままだと「これは何なのか」が新規読者に伝わらない。

### 8. `style.css` が `#app` を指している
- 実際の root id は `index.html:9` で `<div id="root"></div>`。`style.css:23` の `#app { height: 100vh; ... }` は **無効化されたまま残っている** Wails テンプレ残骸。`#root` に直すか、`html, body, #root { height: 100% }` 系に整理。

### 9. `basename` / `errorMessage` の重複定義
- `basename(p)` が **4 箇所** に同じ実装でコピペ: `ImageView.tsx`, `useViewerGrid.ts`, `TabBar.tsx`, `TabDragGhost.tsx`。
- `errorMessage(e)` も **4 箇所**: `ImageView.tsx`, `useViewerGrid.ts`, `useClassification.ts`, `useSettings.ts`。
- `shared/utils/path.ts` (or `string.ts`) と `shared/utils/error.ts` に出して 1 箇所化すべき。

### 10. `useSessionLoad` だけ `console.warn`
- Phase 5 で `logger` API に統一したはずだが、`useSessionLoad.ts:16` だけ `console.warn("GetState failed, ...")` のまま。`useSessionSave.ts:55` も `console.warn` と `logger.warn` を併存させており半移行。

### 11. Effect deps が広すぎて頻繁に再アタッチする
- `ImageView.tsx:241-251` の wheel handler の deps に `tab.zoom / tab.panX / tab.panY` が含まれており、**ポインタ移動するたびに `removeEventListener` → `addEventListener` を繰り返している**。`tabRef` パターンと同様に refs 経由にすれば 1 度だけ attach で済む。
- 同じ問題が `ImageView.tsx:325-356` のドラッグ pan effect でも発生。

### 12. Mouse / Pointer event 混在
- DnD (`useDnD.ts`, `TabBar.tsx`) は **PointerEvent**、ImageView の pan / GridSplitter は **MouseEvent**。
- 現在のターゲット環境 (Windows + WebView2) では実害なしだが、片方に統一する方が読みやすく、修飾キー / `setPointerCapture` 等の振る舞いも揃う。

### 13. `body.style.cursor` / `userSelect` の 3 系統が同じグローバルを書き合う
- `useDnD`, `GridSplitter`, `ImageView` の 3 か所が `document.body.style.{cursor,userSelect}` を直接書き換え、終了時に `""` で戻している。
- 同時に重なるシナリオ (DnD 中に何かの理由で splitter が drop され、unmount で残留 等) で **ユーザの元設定を `""` で潰す** リスク。トークンスタックで管理するか、`pointer-events:none` overlay で代替。

### 14. アクセシビリティ
- `Card.tsx:48` の `cls-card-thumb` は `<div onClick>` で **キーボード操作不可**。`<button>` 化 (or `role="button" tabIndex=0` + Enter/Space ハンドラ) が WCAG 的に必要。
- `TabBar.tsx:79` の各タブも `<div>`、`role="tab"` と `aria-selected`、矢印キーナビが欲しい。
- `TabContextMenu.tsx` には `role="menu"`/`role="menuitem"` がなく、矢印キーで項目移動できない。

### 15. `selectedFilenames` を毎レンダ作り直し
- `useClassification.ts:305` `const selectedFilenames = Array.from(selected).sort();` は **毎レンダ新規配列**。`selected` Set が変わらなくても新インスタンス。
- `App.tsx` 経由で `ClassificationView` → `<DirectoryGroup>` まで渡るので、`useMemo([selected])` 化推奨。

### 16. wheel mode の振る舞い不整合
- `ImageView.tsx:188` (shift-zoom mode): `Shift+wheel` でズーム。
- `TabBar.tsx:41`: `if (e.shiftKey) return;` で「ブラウザの横スクロールに任せる」。
- 結果、Shift+ホイールが領域によって役割が違う。ドキュメント化されていれば OK だが、設定文言は「Shift / Ctrl + ホイールで拡大縮小」とのみ書いてあり、タブバーは例外扱いなのが伝わらない。

---

## 🟢 軽微 (整理・体裁)

### 17. `App.tsx` の hook 並びと初期 mount 構造
- `useSessionLoad` の loaded 待ちで早期 `return null` → `AppInner` 二段階 mount は妥当だが、`AppInner` 内で **window pos / size を 2 秒ポーリング**するのは実装上の制約 (Wails が move event を持たない) のためで、`logger.debug` で間隔と最終値を出しておかないとセッション保存の挙動が追いにくい。

### 18. `ClassificationView` に「すべて折りたたむ」ボタンがない
- 「すべて展開」だけある (`ClassificationView.tsx:152`)。対称性 (UX 的にも) のため、`expandAll` の対になる `collapseAll` も用意してよい。spec 範囲かは要確認。

### 19. `EditPopover.tsx` の保存ボタン文言
- `保存 (Cmd/Ctrl+Enter)` と表示しているが、`Ctrl+Tab` 等は `KEYBINDINGS` テーブル (`SettingsDialog.tsx`) にある一方、`Ctrl+Enter` は載っていない。一覧との整合性。

### 20. `ConfirmDialog` と `ConflictDialog` / `MergePromptDialog` でフォーカストラップ実装がバラバラ
- `ConfirmDialog` は Tab 循環 + Esc + 焦点復帰までやる。
- `ConflictDialog` は Esc のみで focus trap なし。
- `MergePromptDialog` は Esc も focus trap も無し (`open` 時の Esc 処理が漏れている、確認の価値あり)。
- 共通の `ModalShell` を抽出すれば 3 ダイアログとも一致した挙動にできる。

### 21. `SettingsDialog` の `e.stopPropagation()` は誤誘導
- `SettingsDialog.tsx:64` で `window` listener 内 `stopPropagation` しているが、**同じターゲット (`window`) 上の他 listener には効かない**。実際の保護は `App.tsx:131` の `if (settingsOpen) return;` 側でやっている。`stopPropagation` は削っても挙動同じ。

### 22. React 19 + StrictMode の二重実行
- `useClassification` の auto-load effect (line 191) はキャンセルフラグ付きだが、開発時 StrictMode で `loadInternal` → `postLoadFlow` が **2 重に走る**。`postLoadFlow` 中の `confirm()` が 2 回キューされる可能性 (本番では 1 回)。`useEffect` 内で `useRef` ガードを足すと dev も綺麗になる。

### 23. 不要に思える `display: contents` ラッパ
- `TabBar.tsx:77` `<div key={tab.path} style={{ display: "contents" }}>` で insert indicator と tab を兄弟化しているが、Fragment + key で十分のはず。`display:contents` は accessibility tree に影響することがある。

---

## まとめ / 次アクション提案

- **コミットすべきレベルの重大バグはなし**。全体としてはよく整理されていて、context.md 記載の規律 (単方向依存、純関数 + テストで守る、IPC 境界での as 変換) は守られている。
- 一方で、**(1) ImageView の base64 毎レンダ再構築 / (2) hook 戻り値オブジェクトの identity / (3) 無制限サムネイルキャッシュ** の 3 点は、フォルダが大きくなった際にユーザ体感に直結するので、Phase H の中で優先度を上げて解消するのが良さそう。
- **アクセシビリティ (Card / Tab / ContextMenu のキーボード操作)** と **共通ユーティリティ (basename / errorMessage / Modal)** は、機能境界の整理を兼ねて 1 PR にまとめると効果的。
- `todo.md` の Phase H 残作業 (テーマ / 既知タグ配色の settings 化) と上記 (1)〜(3) を併せ、Phase H の細目に追記する形で進めるのが妥当。

### おすすめ作業順
1. ImageView の `toDataURL` を `useMemo` 化 (1 行修正、即効性大)。
2. `useViewerGrid` / `useClassification` の戻り値を `useMemo` 化、`selectedFilenames` も `useMemo`。
3. `basename` / `errorMessage` の共通化 (`shared/utils/`)。
4. サムネイル LRU (or ObjectURL 化) — Phase H1/H2 の流れで `settings.json` に上限件数を持たせる。
5. `style.css` の `#app` → `#root` 修正 + Wails テンプレ残骸の整理。
6. アクセシビリティ (Card / Tab / ContextMenu のキーボード操作とロール) — 別 PR で。

---

レビュー実施: Claude (Opus 4.7, 1M context)。
