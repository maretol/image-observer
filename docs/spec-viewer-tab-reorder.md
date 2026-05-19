# ビューアタブ並び替え (DnD) 実装仕様書 (#50)

トップタブ列のビューアタブ (`top-tabs-viewers` 配下の `ViewerTab` 群) を **DnD で並び
替え可能** にする。`viewer.viewers` 配列の順序を変えるだけなので state schema 変更は
不要、state.json は既存 `useSessionSave` で自動追従する。

> **ステータス**: Phase 1 実装完了。§11 の決定事項は確定済み。Phase 2 は §13 を参照。

---

## 0. 改訂履歴

- 2026-05-19 初版ドラフト。pointer events 自前ベース、専用 hook (`useViewerTabReorder`)、
  キーボード並び替えは Out of scope (§12)。
- 2026-05-19 Phase 1 実装完了 (PR #TBD)。`viewers.ts::moveViewer`、`useViewerSet.reorderViewer`、
  `useViewerTabReorder.ts` (+純関数 `computeInsertIdxFromRects` を export してテスト)、
  `App.tsx::ViewerTab` 改修、`.top-tab-viewer.dragging` / `.viewer-tab-insert-indicator`
  CSS 追加。改訂履歴に従って Spec をスリム化。

---

## 1. ゴール (DoD)

- トップタブのビューアタブを **マウス DnD で並び替え** できる。並び替え後の順序は
  state.json に自動保存される (既存 `useSessionSave`、schema 変更なし)。
- 5px threshold を超えるまでは通常 click として扱い、activate 動作を維持。閾値越え後は
  drag が active 化、source タブが半透明 + 挿入位置に縦線インジケータ。
- ドラッグ可能対象は **ビューアタブのみ**。`一覧` / `+` / 設定アイコンは drop ターゲットに
  しない。
- 中断: Escape / pointercancel で取り消し (元の順序に戻る)。
- 既存挙動を保全: rename 中 / close ボタン上 / `viewers.length === 1` では drag を開始しない。
- `go test ./...` 通過、`tsc --noEmit` クリア、vitest 全通過。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **ビューアタブ** | `App.tsx` のトップタブ列のうち各ビューアに対応する `ViewerTab` 要素。 |
| **armed** | pointerdown 直後の状態。threshold 未到達のため click にも drag にも倒れていない。 |
| **active (drag)** | threshold 超え後の状態。以降 click を発火させず、drop 確定で reorder する。 |
| **insertIdx** | 挿入位置インデックス。`viewers` 配列における新しい位置を 0..N で表す。 |

---

## 3. アーキテクチャ概観

```
[ViewerTab pointerdown]
       │
       ▼
useViewerTabReorder.startDrag(srcIdx, ev)
       │
       ▼ (document pointermove)
threshold (5px) 未満 → armed のまま (click 経路に委ねる)
threshold 越え     → active 化、ghost 位置追従、insertIdx 計算
       │
       ▼ (document pointerup)
active なら commit → viewer.reorderViewer(srcIdx, insertIdx)
armed のみで up    → no-op (click が通常通り発火)
       │
       ▼
viewers.ts::moveViewer(set, fromIdx, toIdx) で順序更新
       │
       ▼
useSessionSave (既存) が state.json に debounce 500ms で保存
```

役割分担:

- **`viewers.ts::moveViewer`** — 純関数 (splice ベース)。
- **`useViewerSet.ts::reorderViewer`** — アクション ( logger + `moveViewer` のラッパ)。
- **`useViewerTabReorder.ts`** — DnD ロジック (pointer events 自前、`useDnD` は再利用しない)。
  純関数 `computeInsertIdxFromRects` を export してテスト対象に分離。
- **`App.tsx::ViewerTab`** — `data-viewer-tab` 属性付与、pointerdown ハンドラ配線、
  `dragging` className、`shouldSuppressClick` 適用。
- **`App.css`** — `.top-tab-viewer.dragging` (opacity 0.5) と `.viewer-tab-insert-indicator`
  (縦線、`var(--accent)` ではなく直値 `#d97a3c` でアクセント色を当てる既存規約に従う)。

---

## 4. データモデル

state schema 変更 **なし**。`viewer.viewers: Viewer[]` の配列順がそのまま並び順、
`useSessionSave` 経由で自動永続化。マイグレーション不要。

新規型 (hook 内部):

```ts
type ReorderState = {
  srcIdx: number;
  ghostX: number;
  insertIdx: number;  // splice 位置 0..len。fromIdx と fromIdx+1 は両方 no-op スロット
  active: boolean;
};
```

---

## 5. 画面 / 操作

### 5.1 操作シーケンス

| 状態 | 入力 | 反応 |
|------|------|------|
| 通常 | ビューアタブ name 部分で pointerdown (`button === 0`) | armed に遷移 (state 設定 + `pushBodyStyle({ cursor:"grabbing", userSelect:"none" })`) |
| armed | pointermove (< 5px) | `ghostX` のみ更新、`active` 昇格しない |
| armed | pointerup | 解放、style release。click が通常通り発火 → activate |
| armed | pointermove (≥ 5px) | `active` 昇格、ghostX + insertIdx 更新 |
| active | pointermove | ghostX + insertIdx 更新 |
| active | pointerup | `reorderViewer(srcIdx, insertIdx)` → release。**直後の click は 1 回だけ抑止** (§5.3) |
| active | Escape | release、配列不変 |
| active | pointercancel | release、配列不変 |

### 5.2 開始抑制条件 (drag を armed にしない)

- `viewers.length < 2` (並び替え対象なし)
- `isEditing === true` (rename 中)
- 対象が `closest('.top-tab-viewer-close')` 内 (既存 close 動作優先)
- `e.button !== 0` (primary 以外)
- **二重 pointerdown 防御** (AGENTS.md H-2): `stateRef.current` 既存なら即 return

### 5.3 click 抑制

pointerup で active → commit したとき、直後にブラウザが発火する click を握り潰す:

- `justFinishedDragRef.current = true` をセット
- 次の `requestAnimationFrame` で false に戻す
- `ViewerTab.onClick` の冒頭で `if (shouldSuppressClick()) return;`

理由: drag commit 直後にもう一度同じタブを activate してしまうと、reorder した直後に
旧 active が戻る挙動になりうる。1 回分の click を捨てるのは DnD UI として一般的。

### 5.4 挿入位置の計算

`computeInsertIdxFromRects(rects, x)` を export:

```ts
for (let i = 0; i < rects.length; i++) {
  const r = rects[i];
  if (x < r.left + r.width / 2) return i;
}
return rects.length;
```

`DATA_VIEWER_TAB`(`data-viewer-tab`) 属性を持つ要素群を `containerRef.current!.querySelectorAll`
で集めて rects を取得。コンテナ外 (`x < container.left || x > container.right`) に出たら
**最後の insertIdx を保持** (一覧タブ / + / 設定アイコン上では追従しない)。

### 5.5 視覚フィードバック

| 要素 | 表現 | 実装 |
|------|------|------|
| ドラッグ中ソースタブ | `opacity: 0.5` | className `top-tab-viewer.dragging` (App.css に新規 rule) |
| 挿入位置インジケータ | 幅 2px / アクセント色 (`#d97a3c`) の縦線 | `<span class="viewer-tab-insert-indicator" aria-hidden="true" />` を insertIdx 位置に flex 子として挿入 |
| カーソル | 全体 `grabbing` + `userSelect: none` | 既存 `pushBodyStyle` |

`.viewer-tab-insert-indicator` は `.tab-insert-indicator` (パネル内タブ DnD 用) とは別 class。
トップタブ列の高さ・gap (`gap: 2px`) に合わせた margin を持つ。

---

## 6. IPC

なし (フロント内完結)。

---

## 7. 永続化

`useSessionSave` (既存) が `viewer.viewers` を `state.json` の `viewers` 配列に保存する
経路をそのまま使う。reorder 後は配列順が変わるだけなので、debounce 500ms 後に自動で
書き込まれる。`activeViewerId` は不変 (= reorder 後も同じ viewer が active)。

---

## 8. マイグレーション

state schema 変更なし → なし。

---

## 9. テスト

### 9.1 vitest 純関数

- **`viewers.test.ts > moveViewer`** (11 ケース)
  - 右端送り / 左端送り / 同一位置 (no-op) / 隣接後ろ (no-op) / 隣接前 / fromIdx 範囲外 (負 / 過大) /
    toIdx clamp (過大 → append / 負 → prepend) / 1件のみ no-op / activeViewerId 不変
- **`useViewerTabReorder.test.ts > computeInsertIdxFromRects`** (RectLike 配列ベース)
  - 左外 / 左半 / 右半 / 中位タブ前後 / 末尾超え / 1 タブ列 / 空列 / midpoint ちょうど

DOM テスト基盤 (happy-dom / @testing-library) は **本 PR でも追加しない** (CLAUDE.md
方針)。hook 自体のフルテストは見送り、純関数ロジックの分離で代替。

### 9.2 手動 (Linux dev / Windows 実機)

- ビューアタブを 1 つ右にドラッグ → 並び順が入れ替わる
- threshold 未満で離す → 通常 activate
- `viewers.length === 1` 状態でドラッグしても何も起きない
- rename 中のタブはドラッグ開始しない (input focus 維持)
- ドラッグ中 Esc → 元の順序、カーソル / userSelect 復元
- コンテナ外 (一覧タブ / 設定アイコン上) にポインタ移動 → insertIdx 保持、戻ると追従再開
- 再起動 → 並び順が復元される
- `Ctrl+Shift+2..9` が並び替え後も「配列 index ベース」で正しく動く

---

## 10. エラーハンドリング / ログ

| 経路 | ログ |
|------|------|
| 正常 commit | `logger.info("viewer-tab-dnd", "commit", { from, to })` |
| insertIdx が src と同位置 (no-op) | `logger.debug("viewer-tab-dnd", "no-op", { from, to })` |
| pointercancel (active 時のみ) | `logger.info("viewer-tab-dnd", "cancel", { reason:"pointercancel" })` |
| Escape (active 時のみ) | `logger.info("viewer-tab-dnd", "cancel", { reason:"escape" })` |

`moveViewer` 自体は範囲外 fromIdx / clamp / no-op を全て静かに吸収する。

---

## 11. 決定事項

| § | 論点 | 採用 |
|---|------|------|
| 11.1 | `useDnD.ts` 再利用 vs 専用 hook | **専用 hook** (`useViewerTabReorder.ts` 新規)。`DropHit` が panel/edge/tab-bar に強く結合しており、一般化コストが見合わない。同じ思想 (5px threshold / `pushBodyStyle` / `pointercancel` + Esc) を共有するが、コードは独立 |
| 11.2 | 視覚フィードバック | source 半透明 + 縦線インジケータのみ。ghost (タブのスクリーンショット) は Phase 1 で作らない |
| 11.3 | キーボード並び替えの代替 | Phase 1 では実装しない (§12)。`Ctrl+Shift+2..9` は「index 番目のビューアに飛ぶ」を維持 |
| 11.4 | `moveViewer` の範囲外引数 | `fromIdx` 範囲外なら no-op、`toIdx` は `[0, len]` に clamp、`dst === fromIdx` / `dst === fromIdx + 1` は no-op |
| 11.5 | drop ターゲット範囲 | `.top-tabs-viewers` コンテナ内のみで insertIdx を更新。範囲外では「最後の insertIdx を保持」 |
| 11.6 | drag 中の click 抑制 | `justFinishedDragRef` で pointerup 直後の 1 click だけ握り潰す。次 rAF で flag クリア |
| 11.7 | 1 件のときの動作 | `viewers.length < 2` のとき pointerdown を drag に変換しない |
| 11.8 | rename 中の動作 | `isEditing === true` のときは drag を開始しない (input フォーカス維持) |
| 11.9 | close ボタン上の pointerdown | drag に変換しない (`closest('.top-tab-viewer-close')` で除外) |
| 11.10 | state schema / migration | **無変更**。`useSessionSave` で自動永続化 |
| 11.11 | パネル内タブ DnD (`useDnD`) との相互作用 | **完全独立**。DOM 階層が分離、`elementFromPoint` の hit セット重ならない |

---

## 12. Out of scope (Phase 2 以降で別途判断)

- **キーボード並び替え** (例 `Alt+←` / `Alt+→`): 他キーバインドとの衝突調査が必要、
  Phase 1 では入れない
- **右クリックメニューによる並び替え** (`左へ移動` / `右へ移動` / `先頭へ` / `末尾へ`):
  Card 右クリック (#58) / TabContextMenu (パネル内タブ) と命名・動作を揃える必要があり、
  独立の spec が要る
- **タブのスクリーンショット ghost 表示**: 外部依存 (html2canvas 等) になるため見送り
- **DnD 中のオートスクロール**: MAX_VIEWERS=8 で短いコンテナ前提のため不要
- **i18n** (#16 で別途)

---

## 13. Phase 分割

### Phase 1 (本 spec のスコープ — 実装完了)

- `viewers.ts::moveViewer` 純関数 + vitest テスト
- `useViewerSet.ts::reorderViewer` アクション
- `useViewerTabReorder.ts` 新規 hook (pointer events 自前) + `computeInsertIdxFromRects` テスト
- `ViewerTab` 改修 (`data-viewer-tab` / `onPointerDown` / `dragging` className / `shouldSuppressClick`)
- `.top-tab-viewer.dragging` / `.viewer-tab-insert-indicator` CSS 追加
- 挿入インジケータの描画
- Esc / pointercancel cancel
- 既存 click / dblclick / close / rename ハンドラとの共存

### Phase 2 (将来 issue 化)

- ghost 表示 (タブのスクリーンショット or 凡名)
- キーボード並び替え (`Alt+←` / `Alt+→` 等)
- 右クリックメニューでの並び替え (トップタブ用 ContextMenu の新設)
- オートスクロール (タブ数増 or 横幅縮小時)
- 一覧タブ / 設定アイコンの「並び替え不可」を視覚的に強調 (drop forbidden カーソル等)

Phase 2 着手判断は Phase 1 の実運用で「DnD だけで足りるか / キーボード並び替えがほしいか」を
見極めてから。

---

## 14. 参考 (実装着手時に必ず読む)

- [AGENTS.md](../AGENTS.md):
  - A-2 / A-3: 識別子リネーム時のコメント / context.md 同期
  - H-2: 新規 `onPointerDown` のマルチタッチ / 二重 pointerdown 防御 + `pointercancel` cleanup
  - H-3: モジュール scoped state を持たず hook 内 state + ref で完結
  - H-4: 新規 className の rule を App.css に **必ず** 追加 (Copilot 指摘頻発パターン)
  - H-7: 新規 `onPointerDown` 箇所が他にもあれば二重防御パターンを確認
- [docs/spec-multi-viewer.md](spec-multi-viewer.md): `useViewerSet` 構造 (`addViewer` / `closeViewer` / `renameViewer` の隣に `reorderViewer` を足す)
- [docs/spec-viewer-flexlayout.md](spec-viewer-flexlayout.md): panel 内 DnD (`useDnD.ts`) の設計 (本 spec はその最小サブセット)
- 既存類似実装: [frontend/src/features/viewer-grid/useDnD.ts](../frontend/src/features/viewer-grid/useDnD.ts) / [frontend/src/features/viewer-grid/TabBar.tsx](../frontend/src/features/viewer-grid/TabBar.tsx) (`computeTabInsertIndex`)
- 関連 issue: [#67](https://github.com/maretol/image-observer/issues/67) (App.tsx リファクタ) — `useViewerTabReorder` を独立 hook で書いておいたので #67 着手時の移動コストが下がる
