# 画像クリップボードコピー 実装仕様書 (#127)

ビューア (ビューア-グリッド) と一覧 (分類) の **右クリックメニューに「コピー」を追加**し、
表示中 / 対象の画像を OS のクリップボードに画像としてコピーできるようにする。
他アプリ (チャット / ドキュメント / ペイント等) に **貼り付け可能**にするのがゴール。

> **ステータス**: ユーザーレビュー合意 (2026-06-14) → 本 PR で実装。§12 の決定事項は確定
> (D1 = フロント Clipboard API / D2 = PNG fast-path / D4 = image/png のみ / D5 = 単一モードのみ /
> D8 = ビューアは「コピー」先頭)。実クリップボード動作の検証は Windows 実機で行う (§9.3 / D9)。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-06-14 | 初版ドラフト | triage 合意 (フロント Clipboard API) を前提に、両メニューへの「コピー」追加 + 共有ユーティリティ `copyImageToClipboard` を設計。Go / IPC 変更なし。 |
| 2026-06-14 | ユーザー合意 → 実装 | レビュー合意 (D2/D4/D5/D8 確定) を受けて実装。`shared/utils/clipboard.ts` + ビューア (`TabContextMenu`/`ViewerGrid`) + 一覧 (`CardContextMenu`/`ClassificationView`) に「コピー」を配線。Go 変更なし。 |

---

## 1. ゴール (DoD)

- **ビューア**: 画像エリア右クリック (= 既存 `TabContextMenu`、`Panel.onCanvasContextMenu` 経由)
  / タブ右クリックのメニューに「コピー」項目が出て、対象タブの画像をクリップボードへコピーできる。
- **一覧**: Card 右クリックの **単一モード** (`CardContextMenu`) に「コピー」項目が出て、
  その画像をクリップボードへコピーできる。
- コピーされるのは **常に原寸画像** (一覧のサムネイルではなく `ReadImage` の原寸バイト)。
- コピー後、他アプリ (Windows: ペイント / Office / Slack 等) に画像として貼り付けできる。
- 対応フォーマット: jpg / jpeg / png / gif / webp / **avif** (WebView がデコードできる全形式。
  #118 の「Go で decode せず WebView に委ねる」方針と整合)。
- 成功 / 失敗をトーストでユーザー通知し、失敗時はログに詳細を残す。
- `tsc --noEmit` クリア、vitest 全通過、`go test ./...` 全通過 (Go 変更なしのため回帰のみ)、
  `wails build` 通過。
- **Go コード / IPC / state schema / settings schema の変更なし** (既存 `ReadImage` を流用)。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **コピー** | 本仕様で扱う「画像をクリップボードに画像データとして載せる操作」。テキスト (ファイルパス) のコピーではない。 |
| **原寸画像** | `app.go::ReadImage(path)` が返す元ファイルのバイト列 (再エンコードなし)。一覧のサムネ / プレビューとは別。 |
| **PNG 化** | クリップボードに載せるために、原寸バイトを `image/png` Blob へ変換する処理。元が PNG ならそのまま、それ以外は WebView デコード + canvas 再エンコード。 |
| **Clipboard API** | ブラウザ標準 `navigator.clipboard.write([new ClipboardItem({...})])`。WebView (本番 = WebView2 / dev = WebKitGTK) が実体を提供。 |

---

## 3. アーキテクチャ概観

```
[ビューア: 画像/タブ右クリック → TabContextMenu「コピー」]   [一覧: Card 右クリック → CardContextMenu「コピー」(単一モード)]
                    │                                                          │
                    │ ctx(leafId,tabIndex) から tab.path 解決                  │ `${folderPath}/${filename}` で absPath 構築
                    ▼                                                          ▼
                    └──────────────────────────►  copyImageToClipboard(absPath)  ◄────────────────────────┘
                                                            │ (shared/utils/clipboard.ts)
                                                            ▼
                                       1) ReadImage(absPath) ── 既存 Wails IPC (原寸 bytes + mimeType)
                                       2) new Blob([toBytes(res.data)], {type: res.mimeType})   ← 既存 base64 util
                                       3) toPngBlob(blob)  ── PNG ならそのまま / それ以外は createImageBitmap → canvas → toBlob("image/png")
                                       4) navigator.clipboard.write([new ClipboardItem({"image/png": <pngBlob promise>})])
                                                            │ (success / error)
                                                            ▼
                                       呼び出し側で toast (成功 = info / 失敗 = error) + 失敗時 logger.error
```

ポイント:
- **画像のデコードは WebView に委ねる** (#118 と同方針)。Go 側に新規ネイティブコード / IPC を
  足さない。これが triage で方式 A (フロント) を選んだ理由。
- クリップボード書き込みは「メニュー項目クリック」という **ユーザージェスチャ起点**で行う
  (Clipboard API の transient activation 要件、§5.4 / D7)。

---

## 4. データモデル

| 項目 | 変更 |
|------|------|
| state schema | **変更なし** (v6 のまま) |
| settings schema | **変更なし** (v1 のまま) |
| 新規 IPC | **無し** (既存 `ReadImage` を流用) |
| 新規 Go コード | **無し** |
| 新規 hook | **無し** (共有ユーティリティ関数 1 本のみ) |

---

## 5. 画面 / 操作

### 5.1 共有ユーティリティ `copyImageToClipboard` (新規)

`frontend/src/shared/utils/clipboard.ts` を新規作成:

```ts
import { ReadImage } from "../../../wailsjs/go/main/App";
import { toBytes } from "./base64";

// PNG ならそのまま、それ以外は WebView デコード + canvas 再エンコードで image/png Blob を得る。
export async function toPngBlob(src: Blob): Promise<Blob> {
  if (src.type === "image/png") return src; // fast-path (D2)
  const bitmap = await createImageBitmap(src);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}

export async function copyImageToClipboard(absPath: string): Promise<void> {
  // ClipboardItem に Promise<Blob> を渡し、IPC + デコードの間も user-gesture を保つ (D7)。
  const pngPromise = (async () => {
    const res = await ReadImage(absPath);
    const src = new Blob([toBytes(res.data)], { type: res.mimeType });
    return toPngBlob(src);
  })();
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngPromise }),
  ]);
}
```

- Blob 構築は `toBytes(res.data)` + `new Blob([...], {type})` の既存パターン
  (`SampleModal.tsx` / `useGridThumbnail.ts` / `ImageView.tsx` と同一) を踏襲。
- クリップボード形式は **`image/png` のみ** (D4)。Chromium 系 `ClipboardItem` は実用上
  png が最も安定して貼り付け先で解釈されるため。
- `copyImageToClipboard` 冒頭で `navigator.clipboard` / `ClipboardItem` の存在を
  **feature-detect** し、未サポート環境 (dev = WebKitGTK 等, D9) では明示的な Error を投げる。
  呼び出し側はこれを catch して読みやすいログ + error トーストに落とす (生の TypeError /
  ReferenceError を避ける。PR #128 Copilot レビュー対応)。

### 5.2 ビューア側 (`TabContextMenu` / `ViewerGrid`)

- `TabContextMenu` に「コピー」メニュー項目を追加。`onCopy: () => void` prop を新設。
- 配置案 (§12 D8): **「コピー」を先頭**に置き、divider で既存のタブ/レイアウト操作群と分ける:
  - コピー
  - --- divider ---
  - 閉じる
  - --- divider ---
  - 右に分割 / 下に分割
  - (--- divider --- + {name} へ移動 × N)  ← 既存
- `ViewerGrid` は `ctx.leafId` / `ctx.tabIndex` から対象タブの `path` を `props.layout` の
  leaf を引いて解決し (`layout/` の leaf 探索ヘルパを利用)、`copyImageToClipboard(path)` を呼ぶ。
  非アクティブタブを直接右クリックした場合もその `tabIndex` の画像をコピーする (自然な挙動)。
- `useToastFn()` で結果を通知。`ViewerGrid` 内で `toast` を取得 (現状未使用なら追加)。

> 実装注意: `TabContextMenu` の `itemsRef` 採番 (`refIdx`) と初期位置 seed
> (`itemCount` / `dividerCount` / `approxHeight`) を新項目に合わせて更新する。
> キーボードナビ (ArrowUp/Down/Home/End) に新項目を含めること (AGENTS.md H-1 / H-7)。

### 5.3 一覧側 (`CardContextMenu` / `ClassificationView`)

- `CardContextMenu` の **単一モード** に「コピー」項目を追加 (§5.3 of `spec-card-context-menu.md`)。
  `onCopy: () => void` prop を新設。配置:
  - ビューア「{name}」で開く × N
  - **コピー**  ← 新規 (open 群と同じ「この画像に対する操作」グループ)
  - --- divider ---
  - 選択モードに切り替え
  - --- divider ---
  - 削除
- **バルクモードには追加しない** (D5。クリップボードは 1 画像のみ載るため。削除が単一専用なのと同じ)。
- `ClassificationView` に `onContextMenuCopy` を新設し、`` `${folderPath}/${filename}` `` で
  absPath を構築 (削除の `onAfterDelete` と同じパス構築) → `copyImageToClipboard` → toast。

### 5.4 ユーザージェスチャ / transient activation

- クリップボード書き込みはメニュー項目 `onClick` (= ユーザージェスチャ) から呼ぶ。
- `ReadImage` (IPC) + デコード/再エンコードの非同期処理を挟むため、`ClipboardItem` には
  解決済み Blob ではなく **`Promise<Blob>` を渡す** (Chromium は対応)。これにより数百 ms の
  非同期処理でも transient activation を消費しにくくする (D7)。
- WebView2 (本番) は `https://wails.localhost` 相当の secure context で動くため Clipboard API
  が使え、書き込み権限はジェスチャ時に自動付与 (プロンプトなし)。

### 5.5 結果フィードバック (トースト)

| 結果 | toast | severity |
|------|-------|----------|
| 成功 | `"画像をクリップボードにコピーしました"` | info |
| 失敗 | `"クリップボードへのコピーに失敗しました (詳細はログ)"` | error |

失敗時は `logger.error("clipboard copy failed", { path, detail })` 相当を残す
(削除フローの固定文言トースト + ログ方針と統一)。

### 5.6 UI 文字列

- 新規ラベル「コピー」と上記トースト文言は、周辺コード (`TabContextMenu` / `CardContextMenu` /
  既存 toast) が **ハードコード ja のまま** (#83 の `t()` 移行対象外) なので、それに揃えて
  ハードコードする。`t()` 移行は #83 / #16 の範囲で別途。

---

## 6. IPC

**変更なし**。既存の以下を流用:

- `ReadImage(path) → {data, mimeType, width, height}` (原寸バイト取得)。

新規 Go バインディング / Windows ネイティブコードは **無し** (方式 A の主旨)。

---

## 7. 永続化 / マイグレーション

- state / settings schema **変更なし** → マイグレーション不要。
- クリップボード状態は OS 管理。アプリ側で保持しない。

---

## 8. エラーハンドリング

| ケース | 挙動 |
|--------|------|
| `ReadImage` 失敗 (不在 / 権限) | error toast (§5.5) + ログ。クリップボードは不変。 |
| `createImageBitmap` / `toBlob` 失敗 (デコード不可フォーマット等) | error toast + ログ。 |
| `navigator.clipboard.write` 失敗 (権限 / secure context / WebView 非対応) | error toast + ログ。 |
| dev (WebKitGTK) で画像クリップボード未サポート | 上と同じ error 経路。**実クリップボード検証は Windows 実機で行う** (§11 / D9)。 |

`copyImageToClipboard` は呼び出し側で `try/catch` し、例外は全て上記 error トーストへ集約する。

---

## 9. テスト

### 9.1 vitest

- `toPngBlob` の **PNG fast-path** (`type === "image/png"` で同一 Blob を返す) を検証。
  - 再エンコード経路 (`createImageBitmap` / `canvas.toBlob`) は happy-dom が未実装のため
    **ユニットテストしない** (実検証は手動 = §9.3)。テスト容易性のため fast-path 判定だけ
    純関数的に切り出す。
- メニュー項目組み立て (コピー項目の有無) は component-light テストを **書かない** 方針
  (`spec-card-context-menu.md` §8 の buildEntries 同様、private helper として実装)。

### 9.2 Go

- **追加なし** (Go / IPC 変更なし)。既存 `go test ./...` が回帰しないことのみ確認。

### 9.3 手動 (Windows 実機 = 本番 WebView2)

- ビューアで画像表示中に右クリック → 「コピー」→ ペイント / Slack に貼り付けできる。
- ビューアのタブ (非アクティブ含む) を右クリック → 「コピー」→ そのタブの画像が貼れる。
- 一覧で Card 右クリック (単一モード) → 「コピー」→ 原寸画像が貼れる (サムネ寸法ではない)。
- フォーマット別: png / jpg / gif / webp / **avif** をそれぞれコピー → 貼り付け確認。
- 一覧でバルク選択中 (≥1) に選択中 Card を右クリック → バルクメニューに「コピー」が **出ない**。
- コピー失敗時 (例: 直前にファイルを外部削除) に error トーストが出る。
- キーボード: メニューを開いて ArrowDown/Up で「コピー」項目にフォーカスでき、Enter で実行。
- UI scale 90/115/130%: 項目追加後もメニュー位置クランプが崩れない (#72 と整合)。

### 9.4 手動 (dev = WSL / WebKitGTK)

- メニューに「コピー」が出てクリックでき、成功 or 失敗トーストのどちらかが必ず出る
  (実クリップボード内容の確認は環境依存のため必須としない)。

---

## 10. Out of scope

- **バルクコピー** (複数画像をまとめてクリップボードへ): クリップボードは 1 画像のみ。将来要望が出たら別 issue。
- **ファイルとしてのコピー** (CF_HDROP / エクスプローラに貼り付けできる「ファイルコピー」): 本仕様は画像データ (CF_DIB 相当) のコピーのみ。
- **テキスト (ファイルパス) のコピー**: 別操作として要望が出たら別 issue。
- **Go ネイティブ CF_DIB 実装** (方式 B): triage で不採用。`trash_windows.go` 流の実装が必要になった場合に再検討。
- **クリップボードからの貼り付け (取り込み)**: 本アプリはビューアであり対象外。
- i18n (#16 / #83 で別途)。

---

## 11. Phase 分割

単一フェーズ (本 spec のスコープで完結):

- 共有 `copyImageToClipboard` / `toPngBlob`
- `TabContextMenu` + `ViewerGrid` への「コピー」追加 (ビューア)
- `CardContextMenu` + `ClassificationView` への「コピー」追加 (一覧、単一モードのみ)
- 成功/失敗トースト + ログ

将来 (別 issue 化候補): バルクコピー / ファイルとしてのコピー / パスのテキストコピー。

---

## 12. 決定事項

| § | 論点 | 採用 (推奨) |
|---|------|------------|
| D1 | 実装方式 | **フロント Clipboard API** (`navigator.clipboard.write`)。triage 合意済み。Go/IPC/ネイティブ追加なし。 |
| D2 | PNG 化 | **fast-path**: 元が `image/png` ならそのまま、それ以外のみ canvas で再エンコード。 |
| D3 | コピー対象 | **常に原寸** (`ReadImage`)。一覧でもサムネではなく原寸。 |
| D4 | クリップボード形式 | **`image/png` のみ**。Chromium `ClipboardItem` で最も互換性が高い。 |
| D5 | 一覧バルクモード | **コピー項目を出さない** (単一モードのみ、削除と同じ整理)。 |
| D6 | フィードバック | 成功 = info / 失敗 = error トースト + 失敗時ログ (削除フローと統一)。 |
| D7 | user-gesture | `ClipboardItem` に **`Promise<Blob>` を渡す** (非同期処理中も transient activation を保つ)。 |
| D8 | ビューアの項目順 | 「コピー」を **先頭**、divider で既存タブ/レイアウト操作と分離 (§5.2)。一覧は open 群の直後 (§5.3)。 |
| D9 | dev 検証 | WebKitGTK で実クリップボード未サポートの可能性。**実検証は Windows 実機** (delete spec の Windows 手動確認と同方針)。 |

レビュー確認事項 (合意済み):
- D4: png だけで十分か (透過/巨大画像で問題が出ないか) → ひとまず png のみで OK。問題が出たら再検討。
- D8: 「コピー」の配置 (先頭 vs 末尾、divider 有無) → divider あり。コピーを先頭に置き、閉じる / 分割の上に出す (実装も同様)。
- D2: 巨大 PNG をそのまま渡す fast-path で問題ないか (常時再エンコードに倒すか) → そのままで問題なし。

---

## 13. 実装スコープ予測

| ファイル | 変更内容 |
|---------|---------|
| `frontend/src/shared/utils/clipboard.ts` (新規) | `copyImageToClipboard(absPath)` / `toPngBlob(src)` |
| `frontend/src/shared/utils/clipboard.test.ts` (新規) | `toPngBlob` の PNG fast-path 純関数テスト |
| `frontend/src/features/viewer-grid/TabContextMenu.tsx` | 「コピー」項目 + `onCopy` prop + itemsRef 採番 / 位置 seed 更新 |
| `frontend/src/features/viewer-grid/ViewerGrid.tsx` | `ctx` から path 解決 → `copyImageToClipboard` + toast |
| `frontend/src/features/classification/CardContextMenu.tsx` | 単一モードに「コピー」項目 + `onCopy` prop |
| `frontend/src/features/classification/ClassificationView.tsx` | `onContextMenuCopy` (absPath 構築 → `copyImageToClipboard` + toast) |

- 新規 Go コード / IPC / CSS クラス: **なし** (既存 `.ctx-item` を再利用)。
- `.claude/context.md` / `docs/todo.md`: 機能追加に伴い 1 行ずつ追従 (H 節 / context.md §2)。

---

## 14. 参考 (実装着手時に必ず読む)

- [AGENTS.md](../AGENTS.md) H 章:
  - H-1: 新規メニュー項目 (`<button role="menuitem">`) の `:focus-visible` / キーボードナビ
  - H-2: 右クリックメニューのバブリング / pointerdown 設計 (既存 `TabContextMenu` を崩さない)
  - H-4: 新規 className なし (既存 `.ctx-item` 再利用) — grep で確認
  - H-6: ドキュメント追従 (context.md / todo.md / 本 spec の最終形一致)
  - H-7: 波及 — 「コピー」を **両メニュー**に入れ、キーボードナビ / 位置 seed も両方更新したか grep
- [docs/spec-card-context-menu.md](spec-card-context-menu.md): 一覧 `CardContextMenu` のモード / 項目構成
- [docs/spec-image-delete.md](spec-image-delete.md): 右クリック → 操作 → トースト の先行フロー
- [docs/spec-avif-support.md](spec-avif-support.md): #118 「Go で decode せず WebView に委ねる」方針 (本仕様の PNG 化が依存)
- 既存 base64 util: `frontend/src/shared/utils/base64.ts` (`toBytes`)
- 関連 issue: [#127](https://github.com/maretol/image-observer/issues/127)
