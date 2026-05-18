# 画像削除機能 実装仕様書 (#47)

一覧タブの Card から **右クリック → 削除** で画像ファイルを 1 件ずつディスク上で削除
できるようにする。Phase 1 ではゴミ箱送り (Windows Recycle Bin) を既定動作とする。

> **ステータス**: Phase 1 実装完了 (PR #74、`internal/imgfile/trash_*.go` + `app.go::DeleteImage`)。§12 の決定事項は確定済み。Phase 2 は §14 を参照。

---

## 0. 改訂履歴

- 2026-05-16 初版ドラフト。Card 右クリック / バルクツールバー / Delete キーの 3 エントリー
  ポイント + `useConfirm` の `variant: "danger"` 拡張を含む。
- 2026-05-16 **スコープ縮小**: Phase 1 を **Card 右クリック単一削除のみ** に絞る。
  バルク削除 / Delete キー / `useConfirm` の danger variant 拡張は **Phase 2 へ後ろ倒し**。
  これに伴い IPC を `DeleteImage` (単一) に簡素化し、`DeleteImagesResult` / `DeleteError`
  型を撤去。Linux dev fallback は `os.Remove` で確定。

---

## 1. ゴール (DoD)

- 一覧タブの Card に対して **右クリック → 「削除」** で 1 件ずつ削除できる。
- 削除前に `useConfirm()` で確認ダイアログが出る。文言: `"<filename> をゴミ箱に送りますか?"`。
- Windows では Recycle Bin に入り、ユーザーは Recycle Bin から復元できる。Linux dev では
  `os.Remove` での即時削除 (Phase 1 では Linux 配布物を出さないため、dev での挙動確認用)。
- 削除後:
  - 一覧の `entries` から該当 filename を除去し、既存 `SaveClassification` で sidecar を再保存。
  - ビューアに開いているタブで削除されたファイルを参照していたものは **自動 close**。
    複数ビューア × 複数タブに跨って同じパスが開かれていれば全 close。
- 削除に失敗した場合はトーストでユーザー通知 + ログに詳細。一覧の entries / 開いているタブは不変。
- `wails build` 通過、`go test ./...` 全通過、`tsc --noEmit` クリア、vitest 全通過。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **削除** | 本仕様で扱う「ディスク上のファイルを取り除く操作」の総称。Phase 1 では Trash 送り固定。 |
| **Trash 送り** | Windows の Recycle Bin にファイルを移動する操作。ユーザーは Recycle Bin から復元できる。 |
| **ハード削除** | `os.Remove` 相当で復元不可。**Phase 1 では本番 Windows 配布では使わない**。Linux dev fallback のみ。 |
| **sidecar** | `_classification.json`。一覧タブが filename → 分類メタデータを保存するファイル。 |

## 3. アーキテクチャ概観

```
[Card 右クリック → 「削除」]
       │
       ▼
  useConfirm() ("<filename> をゴミ箱に送りますか?")
       │
       ▼
  DeleteImage(folderPath, filename) ── Wails IPC
       │
       ▼ (Go)
  internal/imgfile.Trash(absPath) → SHFileOperationW (FO_DELETE | FOF_ALLOWUNDO)
       │
       ▼ (success / error)
  フロント側:
  1) entries から filename を除去
  2) SaveClassification で sidecar を再保存 (競合検出経路は既存)
  3) useViewerSet に削除パスを通知 → 該当タブを自動 close
  4) トーストで成功 / 失敗を通知
```

ファイルシステム操作は **Go 側に集約**。フロントは「削除依頼 → 結果反映」のみ担当。
Trash の OS 依存ロジックは `internal/imgfile` (新規 or 既存パッケージ拡張) に隔離する。

## 4. データモデル

state schema 変更は **無し**。settings.json への新規キー追加なし (Phase 1)。
新規型なし — IPC は `error` を返すだけ。

## 5. 画面 / 操作

### 5.1 Card コンテキストメニュー (新規)

Card 上で右クリック → 単一項目のコンテキストメニュー。Phase 1 では以下のみ:

| 項目 | 動作 |
|------|------|
| 削除 | 単一削除フローへ (§3) |

コンテキストメニュー UI は既存のビューアタブ右クリックメニュー
(`features/viewer-grid/TabBar.tsx` 相当) を参考実装にする。

実装ポイント:
- `onContextMenu` で標準コンテキストメニュー (`preventDefault()`) を抑止
- 配置は AGENTS.md H-2 (バブリング二重発火) と F-1 (focus 表示) に従う
- メニュー外クリック / Esc キーで close
- メニュー項目 (`<button>`) には `:focus-visible` を必ず付ける (AGENTS.md F-1)
- 関連: issue #52 でも一覧の右クリック動作の整理が議論されているので、本 spec の右クリック
  メニュー実装が #52 の前提を作る形になる。命名 / 動作スタイルは #52 で他項目を足したと
  きに自然に拡張できるよう設計する (= 「単一項目専用メニュー」と決め打ちしない)。

### 5.2 確認ダイアログ

既存の `useConfirm()` をそのまま使う。**API 拡張なし**。

| 文言 | message |
|------|---------|
| 単一削除 | `"<filename> をゴミ箱に送りますか?"` |

confirm ボタンの danger スタイル化は Phase 2 で複数削除と合わせて検討。Phase 1 では
既存のニュートラルな OK / Cancel ボタンのまま (= filename 1 件の削除なので誤操作の
影響範囲は限定的)。

### 5.3 削除進行中の UI

- 単一 Trash 送りは IPC 1 往復で即完了するため進捗 UI は不要。
- 直後にトーストで結果を出す (§5.4)。

### 5.4 削除後のフィードバック

トースト (`useToastFn`) で 1 個出す:

| 結果 | toast |
|------|-------|
| 成功 | `"<filename> をゴミ箱に送りました"` (severity = info) |
| 失敗 | `"削除に失敗しました (詳細はログ)"` (severity = error) |

## 6. IPC (Go バインディング)

### 6.1 新規 API

```go
// app.go
func (a *App) DeleteImage(folderPath string, filename string) error
```

| 引数 | 意味 |
|------|------|
| `folderPath` | 絶対パス。一覧タブが開いている folder。 |
| `filename` | folder からの POSIX 相対パス (`child1/foo.png` のような subdir 入りもあり得る)。 |

戻り値:
- `nil`: 削除成功 (Trash 送り完了)
- `error`: 失敗 (ファイル不在 / 権限なし / Trash 非対応ドライブ / その他)。エラー文字列は
  ログに残すが、ユーザー向けトーストは固定文言 (§5.4) で済ます。

### 6.2 サイドカー再保存

削除 IPC とは **別 IPC** として既存の `SaveClassification` を呼ぶ。理由:

- mtime 競合検出 (`expectedMtime`) は既存ロジックで安定している。これを削除 IPC と統合
  すると重複実装になる。
- 削除成功 / sidecar 保存成功は独立に扱える方が、エラー回復が明示的に追える
  (例: ファイル削除は成功したのに JSON 保存が conflict した、を分けてハンドリングできる)。

フロント実装 (`useClassification`) で `DeleteImage` → entries から該当 filename を除去 →
`SaveClassification(folderPath, newEntries, expectedMtime)` を逐次実行する。

### 6.3 Trash 実装 (Go)

`internal/imgfile` パッケージ (新規 or 既存拡張) に `Trash(absPath string) error` を追加。

Windows 実装 (`trash_windows.go`): `SHFileOperationW` を `FO_DELETE | FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT` で呼ぶ。非 Windows (`trash_other.go`): `os.Remove` + warn ログで開発機 fallback。go.mod 新規依存なし (`golang.org/x/sys/windows` は既存)。

see `internal/imgfile/trash_windows.go` / `trash_other.go`

## 7. 永続化 (sidecar 同期)

`_classification.json` の entries 配列から、削除した filename を除去 → 既存
`SaveClassification` を呼ぶ。**ファイル削除 → sidecar 保存** の順で、間に競合検出
ダイアログ (既存) が割り込む可能性がある:

- 削除成功 → sidecar 保存で `ErrConflict` → 既存パターンの `conflict` state で
  「再読み込み / 強制上書き / キャンセル」ダイアログを出す。
  - **強制上書き**: 削除済み状態を反映した entries で `SaveClassification(expectedMtime=0)`。
  - **再読み込み**: ディスクから JSON を読み直す (= 削除した entry が JSON にまだ残って
    いるが、実ファイルは無い状態になる)。`LoadClassification` 側で「該当ファイル不在」を
    検出する既存ロジックがあれば自然に整う (実装時に確認、無ければ別途対応)。
  - **キャンセル**: sidecar は更新しない。entries とディスク状態が不整合のまま残る。
    次回 reload で正される (UX としては許容)。

## 8. マイグレーション

state schema 変更なし。マイグレーション無し。

## 9. 削除後の整合 (ビューアタブ自動 close)

`useViewerSet` (もしくは上位の App.tsx) に **削除通知ハンドラ** を追加:

```ts
// useViewerSet 拡張 (擬似コード)
const closeTabsForPath = (deletedAbsPath: string) => {
  // 全 viewer × 全 layout leaf × 全 tab を走査し、tab.path === deletedAbsPath
  // のものを close。close 後にパネル / レイアウトが空になる扱いは既存の closeTab
  // ロジックを流用。同じ画像が複数 viewer / 複数タブに開かれている可能性があるので
  // 「最初に見つかった 1 個」ではなく **全件 close** する。
};
```

呼び出し側 (`ClassificationView` 経由) は filename を絶対パス
(`filepath.Join(folderPath, filename)` 相当) に変換してから渡す。

タブ close は **確認なし** で実行 (= 削除確認ダイアログで既に意思確認済みのため)。
削除確認ダイアログの文面には「タブも閉じます」を **含めない** (§12.6)。ファイルを
削除したのにタブだけ残しても missing file エラーになるだけなので、自動 close が
ユーザー期待に最も近いと判断。

## 10. エラーハンドリング

### 10.1 削除失敗

`DeleteImage` が `error` を返したら:
- トースト: `"削除に失敗しました (詳細はログ)"` (severity = error)
- ログ: 原因テキスト + folderPath / filename
- entries / ビューアタブは **不変** (= 削除しなかった扱い)

### 10.2 Trash 非対応ドライブ

`SHFileOperationW` が非ゼロを返す。Phase 1 では「失敗扱い」とし、ハード削除への
自動フォールバックは **行わない** (誤削除リスクが高い)。トースト + ログのみ。
Phase 2 で「設定でハード削除を許可する」「Trash 失敗時に個別確認してハード削除する」の
フロー追加を検討 (§12.10 / §14)。

### 10.3 sidecar 保存失敗 (ErrConflict 以外)

ファイルは削除できたが JSON 保存に失敗 (権限など) したケース。トーストで通知 + ログ。
entries はメモリ上で除去済み (= UI 上は削除済み状態)、次回 reload でディスク状態と
同期される。

### 10.4 ログ

`logger.error("delete failed", { path, detail })` を失敗時に記録。
削除成功も `logger.info("deleted", { path, mode: "trash" })` で 1 行残す
(監査目的、UX には出さない)。

## 11. テスト

### 11.1 Go

`internal/imgfile/trash_test.go` を新規:

| ケース | 期待 |
|--------|------|
| 存在するファイルを Trash → Linux fallback で `os.Remove` → ファイルが消える | `nil` |
| 存在しないパス | non-nil error |
| 権限なし (`chmod 0` した親ディレクトリ配下) | non-nil error |

Windows 専用ロジック (`SHFileOperationW`) は **単体テストしない**。WSL/Ubuntu CI で
実行不可能なため。代わりに `wails build` の Windows 実機での手動確認を test plan に含める。

`app.go` レイヤのテストは既存のテーブルテスト構成に合わせて追加。`DeleteImage` の
正常系 / 不在ファイル / フォルダパス不正 の 3 ケース。

### 11.2 フロント

vitest:

| ケース | 期待 |
|--------|------|
| `useClassification.deleteOne(filename)` (新規) 成功時に entries から該当 filename が消える | OK |
| 失敗時に entries が不変 | OK |
| 確認ダイアログ cancel → IPC 呼ばれない | OK |
| `useViewerSet.closeTabsForPath` の純関数部分: 同パスのタブを全件抽出する | OK |

### 11.3 手動 (Windows 実機)

- Card 右クリック → 削除メニュー → 確認ダイアログ → OK → Recycle Bin に入っている
- Recycle Bin から元の場所に復元できる
- 開いているタブで参照していた画像を一覧から削除 → タブが自動 close
- 同じ画像を 2 viewer で開いた状態で削除 → 両方の viewer のタブが close
- Trash 非対応の領域 (network 共有 / SD カード) で削除を試して失敗トーストが出る
- 確認ダイアログを Esc / Cancel でキャンセル → ファイルは消えない

## 12. 決定事項 (Phase 1 確定済み)

| § | 論点 | 採用 |
|---|------|------|
| 12.1 | 削除方式 | Phase 1 は Trash 送り固定 (SHFileOperationW 直叩き、Linux dev は `os.Remove`) |
| 12.2 | エントリーポイント | Card 右クリックのみ |
| 12.3 | 確認ダイアログ | 常に表示。`useConfirm()` 既存 API をそのまま使う |
| 12.4 | 確認文言 | `"<filename> をゴミ箱に送りますか?"` |
| 12.5 | sidecar 整合 | 削除 IPC と SaveClassification を分離、フロントで逐次実行 |
| 12.6 | 開いているタブ | 削除成功後に自動 close (確認なし、ダイアログ文面に追記しない) |
| 12.7 | 削除エラー | 単一 error 返却、固定文言トースト、entries / タブは不変 |
| 12.8 | Delete キー | Phase 1 では実装しない |
| 12.9 | サムネキャッシュ | 触らない (mtime/size ベースで自動 orphan) |
| 12.10 | settings | Phase 1 では追加なし |
| 12.11 | ビューア側からの削除 | Phase 1 では実装しない (一覧タブのみ) |
| 12.12 | フォルダ削除 | 対象外 (画像ファイル削除のみ) |

代替案 (バルク削除 / `useConfirm` の danger variant / 設定 UI 等) は §14 / `git log` 参照。

## 13. Out of scope

完全に範囲外 (Phase 2 でも対応しない、または別 issue 化が必要なもの):

- 削除した画像の Undo (アプリ内で「元に戻す」ボタン) — Recycle Bin からの復元で代替
- フォルダ単位の削除
- サムネキャッシュの orphan GC
- 削除前の追加メタデータ確認 (例: 「タグが付いている画像です。本当に削除しますか?」)
- i18n (#16 で別途)

## 14. Phase 分割

### Phase 1 (本 spec のスコープ)

- Card 右クリックメニュー (削除のみ)
- 確認ダイアログ (既存 useConfirm そのまま)
- `DeleteImage` IPC + `internal/imgfile.Trash`
- sidecar 再保存 (既存 SaveClassification 経由)
- ビューアタブ自動 close
- 失敗時トースト + ログ

state schema / settings.json 変更なし。

### Phase 2 (将来 issue 化)

- **バルク削除**: 複数選択 (`selectedFilenames`) のバルクツールバーに「削除」ボタン
- **Delete キー**: 一覧 focus 時に Delete キーで削除確認
- **ConfirmDialog の `variant: "danger"`**: 複数削除時に赤系強調 (バルク削除と同時導入)
- **設定 `image.deleteMode = "trash" | "hard"`** + **`image.deleteConfirm = true | false`**
- ハード削除モードの確認ダイアログ文面強調 (赤系背景、`元に戻せません` 強調)
- Trash 非対応ドライブで失敗したときに「ハード削除しますか?」フォールバック確認
- ビューアタブ側 (画像表示中) からの削除エントリーポイント

Phase 2 着手判断は Phase 1 の実運用でユーザー (= 自分) が「Card 右クリック単体で足りるか」を
見極めてから。

---

## 15. 参考 (実装着手時に必ず読む)

- [AGENTS.md](../AGENTS.md):
  - A-2 / A-3: 識別子リネーム時のコメント / context.md 同期
  - B-1: 参照型データ (entries) を直接 mutate しない
  - F-1: 新規ボタン / メニュー項目に `:focus-visible` を必ず付ける
  - H-1: ConfirmDialog の accessible name (既存実装を崩さない)
  - H-2: 右クリックメニュー外クリック / Esc close のバブリング設計
  - H-7: 既存の右クリックメニュー (ビューアタブ) と同じ非バブリング設計か grep で確認
- [docs/spec-classification.md](spec-classification.md): 一覧タブの設計、sidecar 競合検出
- [docs/spec-multi-viewer.md](spec-multi-viewer.md): ビューアタブ自動 close を実装する `useViewerSet` の構造
- 関連 issue: [#52](https://github.com/maretol/image-observer/issues/52) (一覧の右クリック動作整理) — 本 spec の右クリックメニューが #52 着手時の前提になる
