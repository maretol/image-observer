# Card 右クリックメニュー拡張 実装仕様書 (#58)

一覧 (グリッド) タブの Card 右クリックメニューを **単一項目から複数項目へ拡張** し、
「ビューアで開く」「選択モードに切り替え」「削除」を集約する。バルク選択中はメニュー
形態を切り替えて「バルクで開く / 選択解除」を提示する。

> **ステータス**: Phase 1 実装完了 (2026-05-16, PR #74)。Phase 2 (設定 UI / バルク削除 / フォルダ移動) は §10 / §12 を参照。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-05-16 | 初版 | Phase 1 を「拡張メニュー + selection 連動 + 固定項目」に絞り、Phase 2 は後ろ倒し |
| 2026-05-16 | ユーザー合意 | §11-D 案 A / §5.3 項目順 / bulk-toolbar 共有を採用、実装着手可に更新 |
| 2026-05-16 | PR #74 完了 | §8 テスト計画を純関数テストのみに整理、§9 受け入れ基準・§13 テストファイル名を実装に合わせ修正 |
| 2026-05-16 | Round 2 | §5.3 divider 常時あり に修正 |
| 2026-05-16 | Round 3 | §11-G outside-click wrapper を Tab 側と Card 側で class 名を書き分け、§13 CSS 詳細度修正 |

---

## 1. ゴール (DoD)

- 一覧タブの Card 上で右クリックすると、以下のメニュー項目が **selection 状態に応じて切り替わって** 表示される:
  - **単一モード** (selection 0件 / または selection ≥1 だが右クリックされた card が選択外):
    - ビューア「{name}」で開く × ビューア数 (フラット展開、#57 と整合)
    - (divider)
    - 選択モードに切り替え (= 右クリック対象の card を selection に追加)
    - (divider)
    - 削除
  - **バルクモード** (selection ≥1 かつ 右クリックされた card が selection に含まれる):
    - {N} 件をタブで開く (bulk-toolbar と同じ「開く先」ビューアを尊重)
    - {N} 件をパネル分割で開く ({N} ≤ 8 のとき有効、それ以外は disabled)
    - (divider)
    - 選択解除
- メニュー UI のフォーカス / Esc / outside-click 挙動は既存 `CardContextMenu` / `TabContextMenu`
  と統一 (ArrowUp/Down/Home/End ナビゲーション込み)。
- 右クリックを起点とした選択リスト書き換えは **行わない** (= 該当 card が選択外でも selection は不変、
  単一モードに切り替えるだけ)。Finder の「選択を 1 件に置換」スタイルは v1 では採用しない (§11-D)。
- ビューア側 `TabContextMenu` と chrome (`.tab-context-menu`) / フォーカス挙動 / フラット展開ルール
  (#57) を **意図的に揃える**。
- 既存の bulk-toolbar (`.cls-bulk-toolbar`) は **削除しない**。バルクメニューは toolbar の捷径
  として共存する (キーボードナビ / 右クリックの即時操作 vs toolbar の常時表示の二択)。
- 設定 UI (項目順 / 表示制御) は v1 では **入れない**。固定メニュー。
- `go test ./...` 全通過、`tsc --noEmit` クリア、vitest 全通過、`wails build` 通過。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **単一モード** | Card 右クリック時、メニューが「1 枚のカードに対する操作」を提示する形態。 |
| **バルクモード** | Card 右クリック時、メニューが「現在の選択集合に対する操作」を提示する形態。 |
| **bulk-toolbar** | 既存 `.cls-bulk-toolbar`。selection ≥1 で表示される常設バルク操作 UI。 |
| **selection 集合** | `useClassification.selectedFilenames` (`Set<filename>`)。フォルダ変更で自動クリア。 |
| **inSelection** | 右クリックされた card の filename が selection 集合に含まれるかどうかの bool。 |

---

## 3. アーキテクチャ概観

```
[Card 右クリック]
       │
       ▼
ClassificationView の cardCtxMenu state に { filename, x, y } をセット
       │
       ▼
CardContextMenu 描画
  ├ mode = (selection.size > 0 && inSelection(filename)) ? "bulk" : "single"
  ├ 単一モード: 「ビューア×N で開く / 選択モードへ / 削除」
  └ バルクモード: 「N件をタブで開く / N件をパネル分割で開く / 選択解除」
       │
       ▼
ハンドラ呼び出し (既存 hooks を流用)
  ├ viewer.openInViewer(viewerId, filename)
  ├ viewer.openManyInViewer(viewerId, [filenames])
  ├ viewer.openManyAsSplitInViewer(viewerId, [filenames])
  ├ classification.toggleSelected(filename) (= 選択モード入り口)
  ├ classification.clearSelected()
  └ classification.deleteOne(filename) (= Phase 1 #47 そのまま)
```

ファイルシステム / IPC は **触らない**。Phase 1 (#47) で確立した削除フローと既存
`useViewerSet` の open API を **そのまま再利用**するだけの組み替え。新規型なし。

---

## 4. データモデル

| 項目 | 変更 |
|------|------|
| state schema | **変更なし** (v6 のまま) |
| settings schema | **変更なし** (v1 のまま) |
| 新規 IPC | **無し** |
| 新規 hook / API | **無し** (既存 `useClassification` / `useViewerSet` を流用) |

---

## 5. 画面 / 操作

### 5.1 右クリック検出 (既存)

- `Card.cls-card` の `onContextMenu` で `preventDefault()` + `onRequestContextMenu(filename, x, y)` を親に通知。
- `ClassificationView` が `cardCtxMenu` state を更新し `CardContextMenu` を render。
- 既存 `#47` 実装そのまま。本 spec で変更しない。

### 5.2 mode 決定ロジック

```ts
const inSelection = selectedFilenames.includes(cardCtxMenu.filename);
const mode: "single" | "bulk" =
  (selectedFilenames.length > 0 && inSelection) ? "bulk" : "single";
```

- selection 0件: 常に **single**
- selection ≥1 かつ 該当 card 選択中: **bulk**
- selection ≥1 かつ 該当 card 非選択: **single** (selection は不変。§11-D 決定事項)

### 5.3 単一モードの項目

| 項目 | 表示条件 | 動作 |
|------|---------|------|
| ビューア「{name}」で開く | viewers の各エントリ (現在のアクティブビューア含む全て) | `viewer.openInViewer(viewerId, filename)` |
| --- divider --- | viewers.length ≥ 1 のとき | |
| 選択モードに切り替え | 常時 | `classification.toggleSelected(filename)` (= selection 集合に追加、bulk-toolbar が出現) |
| --- divider --- | 常時 | |
| 削除 | 常時 | `classification.deleteOne(filename)` (既存 #47 フロー) |

**フラット展開ルール (#57 と整合)**: ビューアは N 個全てフラットに並べる。アクティブビューアも
リストに含む (区別したい場合はチェックマーク等で `(現在)` を示唆。下記 §5.6)。
viewers.length === 1 のときも上の表通り「ビューア「{name}」で開く」項目 1 個 + viewer 後の
divider + 「選択モードに切り替え」 + divider + 「削除」が表示される (§9 受け入れ基準と整合、
`(現在)` サフィックスのみ抑制)。

### 5.4 バルクモードの項目

| 項目 | 表示条件 | 動作 |
|------|---------|------|
| {N} 件をタブで開く | 常時 | `viewer.openManyInViewer(bulkDstViewerId, selectedFilenames)` → 既存 bulk-toolbar の挙動と同一 |
| {N} 件をパネル分割で開く | N ≤ 8 で enabled、N > 8 で disabled | `viewer.openManyAsSplitInViewer(bulkDstViewerId, selectedFilenames)` |
| --- divider --- | 常時 | |
| 選択解除 | 常時 | `classification.clearSelected()` |

**「開く先」ビューアの解決**: 既存 bulk-toolbar の `bulkDstViewerId` を `ClassificationView`
から CardContextMenu に prop として渡す。**bulk-toolbar 内の `<select>` で選んだビューアと
同一の宛先を共有**するため、ユーザは「toolbar で宛先を選んで」「右クリックメニューで実行」
の組み合わせも可能。viewers.length === 1 のときは `<select>` は出ないので
`bulkDstViewerId === activeViewerId` で確定。

**バルク削除はメニューに含めない** (Phase 2 後ろ倒し、#47 spec §0 と整合)。

### 5.5 「選択モードに切り替え」の挙動

- `toggleSelected(filename)` を呼ぶ → 該当 card が selection に追加され、bulk-toolbar が出現。
- ユーザはその後 toolbar の `<select>` で宛先ビューアを選び、追加でカードを (checkbox / Ctrl 等で) 選択し、
  「タブで開く / パネル分割で開く / 削除」(toolbar) に進める想定。
- 設定 `multiSelectMode = "modifier"` (checkbox 非表示) のときは特に有用 — 修飾キーを覚えていなくても
  右クリックメニューから選択モードに入れる導線になる。

### 5.6 アクティブビューアのハイライト

`SampleModal` の footer (multi-viewer.md §5.x) と同様、アクティブビューアの項目には
`(現在)` のサフィックスを付けるか、チェックマーク `✓` を先頭に出す。spec では `(現在)` 表記で
統一する (SampleModal の `viewers.length > 1` のときの動作と同等)。
viewers.length === 1 のときは表記不要 (1 個しかないので情報量ゼロ)。

### 5.7 メニュー UI / chrome の共通化

- chrome class は **`.tab-context-menu`** を引き続き再利用 (#47 / #57 と整合)。
- ルート wrapper class は **`.cls-card-context-menu-root`** のまま (outside-click スコープ)。
- バルクモードでフォーカスや色を変える必要があれば追加 modifier class `.tab-context-menu-bulk`
  を用意 (現状の `.cls-card-context-item-danger` (削除) のような追加クラス方式と整合)。
- フォーカスナビゲーション (ArrowUp/Down/Home/End ラップアラウンド) は `TabContextMenu` と
  同じパターン。`CardContextMenu` 内部に同等の `onMenuKeyDown` を実装する (現状は単一項目で
  実装されていないので追加が必要)。
- メニュー位置決め (`createPortal` + viewport clamp) は #72 で確立した方式を踏襲。サイズが
  伸びるためビューポート右下クランプの seed 値 (`APPROX_MENU_HEIGHT`) を mode / viewers 数に
  応じて再計算する (TabContextMenu の `useLayoutEffect` 再 clamp パターンに揃える)。

### 5.8 メニュー外クリック / Esc

- メニュー外クリック → close (既存挙動)。
- Esc → close (既存挙動)。
- メニューの項目をクリック → close してから処理を呼ぶ (バルク削除 vs 単一削除の race 回避)。

---

## 6. IPC

**変更なし**。既存の以下を流用する:

- `DeleteImage(folderPath, filename)` — #47 で導入
- `SaveClassification(folderPath, data)` — 削除後の sidecar 再保存
- (バルク open / split は IPC 不要 — フロント内のレイアウト操作)

---

## 7. 永続化 / マイグレーション

- state schema / settings schema **変更なし** → マイグレーション不要。
- selection 集合は **永続化しない** (フォルダ変更で自動クリア、既存挙動を踏襲)。

---

## 8. テスト

- **vitest (純関数)**:
  - mode 決定ロジック (`computeCardContextMenuMode(selectedFilenames, filename)`) を純関数として切り出し、ケース 4 種 (selection 空 / selection ≥1 + inSelection / selection ≥1 + not inSelection / 同一 filename が重複) をテスト。
  - `canBulkSplitOpen(count)` も同 module の純関数として 4 ケース (0 / 1 / `SPLIT_OPEN_LIMIT` / `SPLIT_OPEN_LIMIT + 1`) をテスト。
  - メニュー項目組み立て (`buildSingleEntries` / `buildBulkEntries`) は **本 Phase ではテストを書かない** — CardContextMenu.tsx の private helper として実装し、a11y / レイアウト変更を伴う将来の Phase で必要になった時点で component-light テスト (`render` + `getByRole("menu")`) を追加する方針。
- **Go テスト追加なし** (IPC 変更なし)。
- **手動確認 (test plan)**:
  - selection 0件: 単一メニューが出る → ビューア複数時に全ビューアがフラット展開 → 「選択モードに切り替え」→ bulk-toolbar が出現 → 再右クリックでバルクメニュー
  - selection ≥1 + 該当 card 選択中: バルクメニュー → 「N件をタブで開く」→ bulk-toolbar の dst viewer が宛先になっている
  - selection ≥1 + 該当 card 非選択: 単一メニュー (selection は不変であることを確認)
  - パネル分割 9 件選択: 「パネル分割で開く」が disabled (title hint 表示)
  - 削除フロー: 単一モード時のみ「削除」項目があり、Phase 1 既存挙動と完全互換
  - UI scale 90/115/130%: メニュー位置ズレなし (#72 と整合)
  - キーボード: Tab で menu に入る、ArrowDown でナビゲーション、Esc で close

---

## 9. 受け入れ基準

- selection 0件で Card を右クリック → 「ビューア「{name1}」で開く」… 「選択モードに切り替え」… 「削除」が表示される
- selection ≥1 で **選択中の** Card を右クリック → 「{N} 件をタブで開く」… 「選択解除」が表示される
- selection ≥1 で **選択外の** Card を右クリック → 単一メニュー (selection は不変)
- viewers.length === 1 のとき: 単一モードで「ビューア「{name}」で開く」(`(現在)` サフィックスなし) → 「選択モードに切り替え」 → 「削除」が表示される (項目構成は §5.3 と同一、`(現在)` の付与のみ抑制される)
- メニュー上で ArrowDown/ArrowUp で項目間移動、Home/End で先頭/末尾、Esc で close
- 削除フロー (Phase 1 #47) が回帰していない
- bulk-toolbar の dst viewer 選択が右クリックメニューの「{N}件を…」と連動する
- `.cls-view` の zoom 領域内でも cursor 位置にメニューが出る (#72 と整合)

---

## 10. Out of scope (Phase 2 以降)

| 項目 | 移送先 |
|------|--------|
| 設定 UI で項目順 / 表示有無を制御 | Phase 2 (本 spec §11-F 案 b を採用するなら settings schema 追加) |
| バルク削除 (selection 全件をゴミ箱送り) | #47 Phase 2 |
| フォルダ移動 | 別 issue |
| 右クリックで選択を 1 件に置換 (Finder 風) | UX 検証後に再検討 (§11-D) |
| ビューア側 (`TabContextMenu`) との操作 ID 共通モデル化 | 必要が出たら別 issue (現状は chrome class 共有で十分) |
| Card 複数選択時の右クリック中に出る「サンプル一覧プレビュー」(SampleModal の grid 展開) | 別 issue |

---

## 11. 決定事項

### A. メニュー項目セット — 固定 (v1)

設定 UI を入れず、§5.3 / §5.4 の固定セットで出す。
理由: v1 では複雑度を抑えたい。設定 UI を入れると schema 拡張 / 設定ダイアログ拡張 / 永続化が
発生し、PR が 1.5〜2 倍に膨らむ。固定メニューでもユーザ要件 (「ビューアで開く」「選択モード」「削除」)
は満たせる。設定 UI は Phase 2 に後ろ倒し。

### B. selection 中の挙動切替 — mode で分岐 (§5.2)

selection ≥1 かつ 該当 card 選択中 → バルクメニュー。それ以外 → 単一メニュー。
**右クリックを起点に selection を書き換えない** (§11-D の通り)。

### C. ビューア複数時の展開 — フラット (§5.3)

#57 と整合。サブメニュー化はしない。viewers.length が増えても spec のメニューは縦に伸びる
だけで操作は 1 クリック完結する。viewers の上限 (#11 で `maxViewers = 8`) で項目数も天井あり。

### D. 選択外カードを右クリック — selection 不変 (§5.2 mode 決定ロジック)

採用: 案 A (selection を不変のまま単一モード)。
**不採用**: 案 B (Finder 風に「選択を 1 件に置換」)。
理由: 選択モード中に他カードを右クリックして意図せず選択が消える事故を避ける。
v1 はシンプルな挙動を優先し、Finder 風が望ましいという要望が出てから §10 で再検討する。

### E. 「開く先」ビューアの解決 — bulk-toolbar と共有 (§5.4)

`bulkDstViewerId` は ClassificationView から CardContextMenu に prop で渡す。
toolbar の `<select>` で選んだ宛先が右クリックメニューにも反映される。
理由: 「toolbar で選んだ宛先」と「右クリックで実行」を別状態にすると混乱する。一元化する。

### F. 設定 UI — v1 では入れない (§11-A)

Phase 2 で別 issue 化して検討。spec 案ベースの先取り設計:
- 案 a (推奨): `settings.cardContextMenuItems: { id, visible }[]` で表示制御のみ
  (項目順は固定、enabled 切替のみ)。schema bump なし (per-field fallback)。
- 案 b: 項目順も settings に持つ。drag-and-drop で並べ替え UI を提供。schema bump あり。

### G. メニュー UI の共通化スコープ — chrome class のみ (§5.7)

`.tab-context-menu` chrome class を共有し、outside-click のスコープ wrapper (Tab 側
`.tab-context-menu-root` / Card 側 `.cls-card-context-menu-root` — class 名は別だが
`.closest(<wrapper>)` の判定パターンは共通) を踏襲するが、コンポーネントは
**`CardContextMenu` と `TabContextMenu` で別実装**。
共通基底コンポーネント化は v1 では行わない。
理由: 操作セットが異なる (Card は単一/バルク 2 モード、Tab は移動 / 分割)。早すぎる抽象化は
将来の Phase 2 拡張 (フォルダ移動 / 設定 UI) を縛る。chrome の見た目さえ揃っていれば UI
一貫性は維持される。

### H. キーボードナビゲーション — TabContextMenu と同等 (§5.7)

ArrowUp/Down/Home/End ラップアラウンド + 初期フォーカス先頭。
**変更**: 現状の `CardContextMenu` は単一項目なので onMenuKeyDown 未実装 → 本 spec で
TabContextMenu と同等の実装を追加する。

---

## 12. Phase 分割

| Phase | スコープ |
|-------|---------|
| **Phase 1 (本 spec)** | §5.3 / §5.4 の固定メニュー、selection 連動 mode 切替、§11-A〜H の決定事項。設定 UI なし。バルク削除なし。 |
| Phase 2 | 設定 UI (§11-F)、バルク削除 (#47 Phase 2 と束ねる可能性あり)、フォルダ移動。 |
| Phase 3+ | TabContextMenu との共通基底化 (もし複数機能で重複が出てきたら) |

---

## 13. 実装スコープ予測

| ファイル | 変更内容 |
|---------|---------|
| `frontend/src/features/classification/CardContextMenu.tsx` | mode prop + 各モードの項目組み立て + キーボードナビ + viewport clamp 再計算 |
| `frontend/src/features/classification/ClassificationView.tsx` | mode 判定 + CardContextMenu への prop 注入 + bulkDstViewerId 共有 |
| `frontend/src/App.css` | `.ctx-item:hover` / `:focus-visible` を `:not(:disabled)` で絞り (disabled item の hover/focus を抑制)、`.ctx-item:disabled` (opacity 0.45 / cursor not-allowed) を追加。`:not()` で詳細度が上がる影響で `.cls-card-context-item-danger:hover` が退行するため、danger 側を `.ctx-item.cls-card-context-item-danger:hover:not(:disabled)` に書き直して詳細度を引き上げ。新規 modifier class や「選択モードに切り替え」専用スタイルは追加しない。 |
| `frontend/src/features/classification/cardContextMenuLogic.ts` (新規) | `computeCardContextMenuMode` / `canBulkSplitOpen` / `SPLIT_OPEN_LIMIT` の純関数モジュール (CardContextMenu.tsx と大文字小文字違いのファイル名衝突を避けるため `Logic` suffix を採用、レビュー #58 thread #8) |
| `frontend/src/features/classification/cardContextMenuLogic.test.ts` (新規) | 純関数の vitest (mode 4 ケース + canBulkSplitOpen 4 ケース) |

新規 Go コード / IPC: なし。

---

## 14. 関連

- 元 issue: #58 (#52 分割)
- 既存メニュー実装 (#47 Phase 1): [docs/spec-image-delete.md](spec-image-delete.md)
- ビューア側メニュー: `frontend/src/features/viewer-grid/TabContextMenu.tsx` (#11 / #57)
- UI scale + portal 化の経緯: PR #73 (#72)
- multiSelectMode 設定: `internal/settings.SettingsData.MultiSelectMode` (Phase H 確定済み)
