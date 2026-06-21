# ウィンドウ位置復元 (Win32 WINDOWPLACEMENT) 実装仕様書 (#129)

前回終了時のウィンドウ位置 / サイズ / 最大化状態を**正確に**復元して起動する。
現状 (#86) は Wails runtime API (`WindowSetPosition` / `WindowMaximise`) + フロントの
ポーリング保存で実装済みだが、**実機 Windows ではマルチモニタ環境で位置が常にメイン
ディスプレイで開かれる**不具合がある (サイズ / 最大化は機能している)。本 spec は
Windows 経路を Win32 `GetWindowPlacement` / `SetWindowPlacement` ベースに**置き換え**、
非 Windows (Linux dev) は既存 #86 経路をフォールバックとして残す。

> **ステータス**: ユーザーレビュー合意 (2026-06-21) → 本 PR で実装。§12 の決定事項
> (D1〜D7) は確定。Win32 syscall の動作検証は **Windows 実機** で行う (§11.3 / D7)。
> 開発機 (WSL2/Linux) では `placement_other.go` の no-op スタブ経路のみ通る。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-06-21 | 初版ドラフト | triage 合意 (実機で位置のみ不具合 / Win32 で #86 置き換え / 終了時一発取得) を前提に設計。`internal/winplacement` を windows / other build-tag で新設。WindowState schema は据え置き (v6)。フロントのジオメトリポーリングは Windows で gate off。 |
| 2026-06-21 | ユーザー合意 → 実装 | レビュー合意 (D1〜D7 確定) を受けて実装。Phase 1 の commit 1〜6 を本 PR で着手。 |

---

## 1. ゴール (DoD)

- **Windows 実機**: ウィンドウをセカンダリモニタに置いて閉じ、再起動すると**同じモニタの
  同じ位置 / サイズ**で開く。最大化して閉じれば最大化で開き、最大化解除すると前回の
  非最大化ジオメトリに戻る (#86 の挙動を維持しつつ位置不具合を解消)。
- **位置の権威が Win32 に一本化**: Windows では `SetWindowPlacement` で復元、
  `GetWindowPlacement` で保存。フロントのジオメトリポーリング (`useWindowGeometryPolling`)
  は Windows では動作しない (= #86 の「最大化中はジオメトリ凍結」ハックを Windows 経路から
  排除)。
- **非 Windows (dev)**: 既存 #86 経路 (Wails runtime + ポーリング) が**従来どおり**動く。
  ビルド / テストが Linux CI で壊れない。
- **他 OS の土台**: `internal/winplacement` は build-tag で windows / other に分かれ、
  other は `ok=false` を返して呼び出し側が #86 経路にフォールバックする。将来 macOS/Linux に
  ネイティブ実装を足す余地を残す (issue 本文「他 OS は分岐で実装できる土台だけ」に対応)。
- 永続化形式 (`state.json` schema) は**変更しない** (v6 のまま)。マイグレーション不要。

## 2. 用語

| 用語 | 意味 |
|------|------|
| WINDOWPLACEMENT | Win32 の構造体。`rcNormalPosition` (復元用矩形) / `showCmd` (通常/最大化/最小化) / `flags` / `ptMin/MaxPosition` を持つ。 |
| `rcNormalPosition` | 最大化 / 最小化中でも保持される「復元したときの矩形」(left/top/right/bottom)。**ワークエリア座標** (タスクバー等を除いた作業領域基準)。 |
| restore geometry | 非最大化時のウィンドウ矩形。`WindowState{X,Y,Width,Height}` と等価。 |
| HWND | ネイティブウィンドウハンドル。Wails v2.12 は**公開 API で提供していない** (§3.2)。 |
| #86 経路 | 既存実装。`runtime.WindowSetPosition`/`WindowMaximise` 復元 + `useWindowGeometryPolling` 保存。 |

## 3. アーキテクチャ概観

### 3.1 全体像

```
[起動]
 main.go: state.Load() → persisted.Window (v6: X/Y/Width/Height/Maximized)
   ├ Wails options.Width/Height = persisted (初期サイズ。SetWindowPlacement で上書きされる)
   └ OnStartup(ctx):
        app.startup(ctx)
        if winplacement.Restore(persisted.Window) == ok:   // Windows のみ true
            // SetWindowPlacement 済み。#86 経路は実行しない
        else:                                               // 非 Windows
            runtime.WindowSetPosition / WindowMaximise      // 既存 #86 経路

[終了]
 main.go: OnBeforeClose(ctx) bool:
        if wp, ok := winplacement.Capture(); ok:            // Windows のみ true
            state.SaveWindow(wp)                            // Load→merge Window→Save
        return false                                        // close を許可

[フロント]
 useWindowGeometryPolling:
   Environment().platform == "windows" → ポーリングしない (初期値=loaded を保持)
   それ以外 → 従来どおり 2s ポーリング + resize で WindowState 更新 (#86)
```

### 3.2 HWND 取得 (本機能の核心リスク)

Wails v2.12 はネイティブ HWND を**公開していない** (HWND は `internal/frontend/desktop/windows`
に隠蔽)。`Get/SetWindowPlacement` は HWND 必須なので、Windows 側で自力取得する。

採用: **`EnumWindows` + 自プロセス PID マッチ** (D1)。

```
EnumWindows コールバックで各 top-level HWND を走査し、
  GetWindowThreadProcessId(hwnd) の PID == GetCurrentProcessId()
  かつ IsWindowVisible(hwnd)
  かつ GetWindow(hwnd, GW_OWNER) == 0   (オーナーを持たない真の top-level)
  かつ タイトル長 > 0
を満たす最初の HWND を採用する。
```

- タイトル文字列 (`"Imago"`) への依存を避ける (将来 `WindowSetTitle` しても壊れない)。
  ただし複数候補が出た場合のタイブレークとしてタイトル一致を**補助的に**使う (D1)。
- WebView2 は子プロセスを持つが PID が異なるため、メインの Wails ホストウィンドウ
  (メインプロセス所有) のみがマッチする。
- HWND は再探索コストが小さいため**モジュール state にキャッシュしない** (起動時 Restore /
  終了時 Capture で都度 `EnumWindows`)。AGENTS.md H-3 (module state のリセット経路) の論点を
  そもそも作らない。

### 3.3 Go パッケージ境界

新規 `internal/winplacement` を `internal/imgfile` の Trash と同じ build-tag 流儀で作る:

```
internal/winplacement/
├── winplacement.go          // build-tag なし: 純関数のみ (rect ↔ WindowState 変換) + 型
├── placement_windows.go     // //go:build windows : EnumWindows + Get/SetWindowPlacement syscall
└── placement_other.go       // //go:build !windows: Restore/Capture は ok=false の no-op
```

- `winplacement` は **Wails を import しない** (HWND を自力取得、座標変換は純関数)。
  依存方向は `main` → `winplacement` → (`state` の型のみ)。
- `state` への依存は型 (`state.WindowState`) のみ。循環参照なし
  (`state` は引き続き依存ゼロを維持)。

エクスポート (案):

```go
// winplacement.go (全 OS 共通)
//   ToWindowState(left, top, right, bottom int, maximized bool) state.WindowState  // 純関数
//   FromWindowState(s state.WindowState) (left, top, right, bottom int, maximized bool)  // 純関数
//
// placement_windows.go / placement_other.go
//   Restore(s state.WindowState) (ok bool)   // windows: SetWindowPlacement / other: false
//   Capture() (s state.WindowState, ok bool)  // windows: GetWindowPlacement / other: ({}, false)
```

## 4. データモデル

**`state.WindowState` は変更しない** (schema v6 据え置き、D2):

```go
type WindowState struct {
    Width     int  `json:"width"`
    Height    int  `json:"height"`
    X         int  `json:"x"`
    Y         int  `json:"y"`
    Maximized bool `json:"maximized,omitempty"`
}
```

WINDOWPLACEMENT ↔ WindowState の対応:

| WindowState | WINDOWPLACEMENT |
|-------------|----------------|
| `X` | `rcNormalPosition.left` |
| `Y` | `rcNormalPosition.top` |
| `Width` | `rcNormalPosition.right - left` |
| `Height` | `rcNormalPosition.bottom - top` |
| `Maximized` | `showCmd == SW_SHOWMAXIMIZED` |

- 最小化中に閉じた場合 (`showCmd == SW_SHOWMINIMIZED`): `rcNormalPosition` は復元矩形を
  保持しているのでそれを使い、`Maximized=false` 扱い (最小化では再起動しない、D6)。
- `flags` / `ptMin/MaxPosition` は保存しない (復元には rcNormalPosition + showCmd で十分)。

**座標系の注意** (D2 で受容): 既存の `state.json` に保存済みの X/Y は #86 のポーリングが
`WindowGetPosition` で取得した**スクリーン座標**。一方 `rcNormalPosition` は**ワークエリア
座標**。アップグレード後の初回起動だけ両者の差 (タスクバー高さ程度) のオフセットが出る
可能性があるが、初回の `SetWindowPlacement` でも**正しいモニタ**には載り、次回終了時に
`GetWindowPlacement` の値で上書きされて自己補正する。新規ユーザーには影響なし。

## 5. 画面 / 操作

UI の追加・変更は**ない**。ユーザーから見える挙動は「閉じた位置で開く」だけ。

- 設定 UI への項目追加なし (常時有効。無効化トグルは Out of scope §13)。
- 復元先がオフスクリーン (モニタ構成変更で画面外) になるケース: `SetWindowPlacement` は
  Windows 側で可視領域へクランプするため、追加のオフスクリーン補正ロジックは持たない
  (D7、必要なら将来 issue)。

## 6. IPC (Go バインディング)

**新規 Wails バインディングは追加しない。**

- Restore / Capture は `main.go` のライフサイクルフック (`OnStartup` / `OnBeforeClose`) 内で
  Go から直接呼ぶ。フロント↔Go の往復不要。
- フロントの Windows 判定は既存 `Environment()` (wailsjs/runtime) を使う。`app.go` への追加なし。

## 7. 永続化 (`state.json` の Window 所有権)

`state.json` の `window` フィールドを書く経路を**プラットフォームごとに単一所有者**にする
(D4)。本機能の核心。詳細な同期モデルは §8。

| プラットフォーム | Window の所有者 | 保存タイミング |
|------------------|----------------|---------------|
| Windows | **Go** (`winplacement.Capture` → `state.SaveWindow`) | `OnBeforeClose` 時に一発 (D3) |
| 非 Windows | **フロント** (`useWindowGeometryPolling` → `useSessionSave`、#86) | 状態変化時 debounce |

`state.SaveWindow(WindowState)` を新設 (案): **最新の `state.json` を Load → `Window` のみ
差し替え → Save** する。フロントの `useSessionSave` が同一ファイルの他フィールド
(viewers/layout/list) を書くため、Go は終了時に最新を読み直してから Window だけ
マージする (= 終了時 Go が最終 writer)。`state.Save` は atomic write (temp+rename) 前提。

## 8. 同期モデル (CLAUDE.md 非同期ルール / AGENTS.md H-8)

`state.json` の `window` を mutate しうる event source と gate 方針。**実装の最初の commit は
この表 (spec) とする** (機能コードより先、CLAUDE.md「非同期処理の着手前ルール」)。

| # | event source | platform | capture する値 | stale 化リスク | gate / 方針 |
|---|--------------|----------|----------------|----------------|-------------|
| 1 | Go `OnStartup` → `winplacement.Restore` | Windows | persisted `Window` を読み `SetWindowPlacement` | アップグレード初回のみ座標系オフセット (§4、自己補正) | `Restore` が `ok` のときのみ。`ok=false` (非 Win) は #86 経路へフォールバック |
| 2 | Go `OnBeforeClose` → `winplacement.Capture` → `state.SaveWindow` | Windows | `GetWindowPlacement` (window は生存中) | なし (終了時=最終 writer。Load→merge で他フィールドの最新を保つ) | Windows のみ (`ok=false` は no-op、保存しない) |
| 3 | FE `useWindowGeometryPolling` | 非 Windows | `WindowGetSize/Position/IsMaximised` | 最大化中の clobber (#86 の凍結ハックで対処済) | `Environment().platform === "windows"` なら**ポーリングしない**。初期値 (=loaded) を保持 |
| 4 | FE `useSessionSave` | 全 OS | StateData 全体 (window 含む) | Windows では window=loaded 値で固定 (経路 3 が動かないため) → 経路 2 が終了時に上書きするので無害 | window 値は経路 3 が更新しない限り loaded のまま。Go (経路 2) が最終 writer |

**整合の要点**:
- Windows では経路 3 を止める (gate) ことで、フロントが書く window は「起動時に load した値」で
  凍結される。セッション中のフロント保存 (経路 4) はその凍結値を書くだけ (= 前回終了時の値、
  正しい)。終了時に Go (経路 2) が `GetWindowPlacement` の最新値で上書き → 最終的に正しい。
- ハードクラッシュ時 (経路 2 が走らない): 次回起動は経路 4 が書いた「前回終了時の値」で復元
  されるため、最悪でも「前々回終了位置」。実害は許容範囲 (D3)。
- 非 Windows は経路 2 が `ok=false` で no-op、経路 1 もフォールバックで従来どおり → #86 と完全に
  同一挙動。

## 9. main.go の変更点

```go
// OnStartup: Restore を試み、ダメなら従来経路
OnStartup: func(ctx context.Context) {
    app.startup(ctx)
    if winplacement.Restore(persisted.Window) {
        // Windows: SetWindowPlacement で位置/サイズ/最大化を一括復元済み
        return
    }
    // 非 Windows フォールバック (既存 #86 経路をそのまま)
    if persisted.Window.X >= 0 && persisted.Window.Y >= 0 {
        runtime.WindowSetPosition(ctx, persisted.Window.X, persisted.Window.Y)
    }
    if persisted.Window.Maximized {
        runtime.WindowMaximise(ctx)
    }
},

// OnBeforeClose: 終了直前に Capture (window 生存中)
OnBeforeClose: func(ctx context.Context) bool {
    if wp, ok := winplacement.Capture(); ok {
        if err := state.SaveWindow(wp); err != nil {
            logging.Warn("app", "save window placement failed", "err", err.Error())
        }
    }
    return false // close を許可
},
```

- 初期 `options.Width/Height` は据え置き (非 Windows の初期サイズ + Windows でも
  `SetWindowPlacement` 前の一瞬のサイズ。最終的に上書きされる)。
- `OnShutdown` は現状どおり `app.shutdown(ctx)` のみ (window はここでは破棄済みの可能性が
  あるため Capture はしない、D3)。

## 10. エラーハンドリング

| 事象 | 挙動 |
|------|------|
| HWND が見つからない (`EnumWindows` 該当なし) | `Restore`/`Capture` は `ok=false` を返す。Restore は #86 フォールバック、Capture は保存スキップ。`logging.Warn` |
| `GetWindowPlacement` が失敗 (戻り値 0) | `Capture` は `ok=false`、保存スキップ + Warn |
| `SetWindowPlacement` が失敗 | Restore は `false` を返し #86 フォールバックへ + Warn (位置だけでも従来経路で復元を試みる) |
| `state.SaveWindow` の Load 失敗 | Warn してスキップ (次回は前回値で起動)。state パッケージの既存 per-field fallback に委ねる |
| 復元先がオフスクリーン | `SetWindowPlacement` の OS 側クランプに委ねる (D7) |

ログは既存 `internal/logging` を使用 (`app` カテゴリ)。

## 11. テスト

### 11.1 Go (Linux CI で動く範囲)

- `winplacement.go` の純関数 (`ToWindowState` / `FromWindowState`) の往復テスト:
  rcNormalPosition (l/t/r/b) ↔ WindowState (X/Y/W/H) の相互変換、最大化フラグ、
  最小化 (showCmd→Maximized=false) のケース。**build-tag なしなので Linux CI で実行可能**。
- `placement_other.go`: `Restore` が `false`、`Capture` が `({}, false)` を返すことを検証
  (非 Windows ビルドで実行)。
- `state.SaveWindow`: Load→merge→Save で**他フィールド (viewers/layout/list) が保持**され、
  Window だけ差し替わることを検証 (一時ファイルベース、既存 state テストの流儀)。

### 11.2 フロント (vitest)

- `useWindowGeometryPolling`: `Environment()` mock で `platform: "windows"` のとき
  **ポーリングが走らず初期値 (loaded) を保持**することを renderHook で検証。
  `platform: "linux"` では従来どおりポーリングが動くことも検証 (#86 回帰防止)。
  `Environment()` 解決前 (初回) はポーリングしない安全側で待つ。

### 11.3 手動 (Windows 実機 — syscall は CI で検証不可、D7)

`trash_windows.go` (#47) と同じく Win32 syscall は Linux CI で実行できないため、
以下を Windows 実機で確認 (PR description の test plan に明記):

- [ ] セカンダリモニタに置いて閉じ → 同じモニタの同じ位置/サイズで開く (本不具合の解消確認)
- [ ] 最大化して閉じ → 最大化で開く / 最大化解除 → 前回の非最大化ジオメトリに戻る
- [ ] ウィンドウを移動 → 即クラッシュ(タスクキル) → 前回終了位置で開く (経路 4 のフォールバック)
- [ ] HiDPI (150%/200% スケール) のモニタ間移動でも位置がズレない

## 12. 決定事項 (ユーザー合意前のドラフト)

- **D1 — HWND 取得**: `EnumWindows` + 自プロセス PID マッチ (+ 可視 + owner==0 + 非空タイトル)。
  タイトル文字列依存を避ける。`FindWindowW("Imago")` は採らない (将来のタイトル変更に弱い)。
- **D2 — 永続化形式**: `WindowState` (schema v6) を据え置き、`rcNormalPosition`↔X/Y/W/H +
  `showCmd`↔Maximized で変換。schema bump / マイグレーションなし。座標系オフセットは初回のみ
  で自己補正するため受容。
- **D3 — 保存タイミング**: `OnBeforeClose` で `GetWindowPlacement` を一発 (window 生存中)。
  定期ポーリング保存はしない。ハードクラッシュ時は「前々回位置」になりうるが受容
  (triage 合意「終了時に一発取得」)。
- **D4 — Window 所有権**: Windows=Go 単一所有 / 非 Windows=フロント単一所有。`useWindowGeometryPolling`
  は Windows で gate off (triage 合意「#86 を置き換え」)。
- **D5 — クロス OS の土台**: `internal/winplacement` を windows/other build-tag で分離。other は
  `ok=false` で #86 フォールバック。将来の macOS/Linux ネイティブ実装の余地を残す
  (issue 本文「他 OS は土台だけ」)。
- **D6 — 最小化**: 最小化状態では再起動しない。`rcNormalPosition` を復元矩形に使い Maximized=false。
- **D7 — オフスクリーン/HiDPI**: `SetWindowPlacement` の OS 側クランプに委ね、独自補正は持たない。
  syscall 検証は Windows 実機 (§11.3)。

## 13. Out of scope

- ウィンドウ位置復元の有効/無効トグル (設定 UI 追加)。常時有効。
- 複数ウィンドウ対応 (本アプリは単一ウィンドウ)。
- モニタを ID で記憶する仕組み (rcNormalPosition の座標が暗黙にモニタを表現するため不要)。
- macOS / Linux の**ネイティブ**位置復元 (土台のみ。非 Windows は #86 経路を維持)。
- オフスクリーン復元の独自補正ロジック (OS クランプに委譲)。
- DPI per-monitor の独自リスケール (SetWindowPlacement の挙動に委ねる)。

## 14. Phase 分割

単一 PR を想定 (規模は medium 相当だが新規 syscall + 同期モデルのため hard 扱い)。

### Phase 1 (本 spec のスコープ)
1. **commit 1**: 本 spec (`docs/spec-window-placement.md`) + todo.md 1 行 (同期モデルを先に確定)
2. **commit 2**: `internal/winplacement` 純関数 (`winplacement.go`) + `placement_other.go` no-op
   + Go テスト (Linux CI で通る範囲)
3. **commit 3**: `placement_windows.go` (EnumWindows + Get/SetWindowPlacement syscall)
4. **commit 4**: `state.SaveWindow` + テスト
5. **commit 5**: `main.go` の OnStartup/OnBeforeClose 配線
6. **commit 6**: フロント `useWindowGeometryPolling` の Windows gate + vitest

### Phase 2 (将来 issue 化、Out of scope)
- 設定 UI に有効/無効トグル
- macOS / Linux ネイティブ位置復元
- オフスクリーン復元の独自補正

## 15. 参考 (実装着手時に必ず読む)

- [trash_windows.go](../internal/imgfile/trash_windows.go) — Win32 syscall の手本
  (`syscall.NewLazyDLL` / 構造体レイアウト / `.Call`)。non-windows フォールバックの build-tag 構成。
- [main.go](../main.go) — 現状の #86 復元 (OnStartup) + state.Load。
- [useWindowGeometryPolling.ts](../frontend/src/features/session/useWindowGeometryPolling.ts)
  — #86 のポーリング + 最大化凍結ハック (Windows で gate off する対象)。
- [internal/state/state.go](../internal/state/state.go) — WindowState (L79-93) / Load / Save。
- [AGENTS.md](../AGENTS.md) — H 章 (PR 前セルフレビュー) / H-8 (同期モデル) / A 節 (Go)。
- [docs/spec-image-delete.md](spec-image-delete.md) — Windows syscall + 非 Win フォールバック +
  「手動 (Windows 実機)」テスト節の構成手本。
