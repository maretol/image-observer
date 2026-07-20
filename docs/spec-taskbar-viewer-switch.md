# タスクバーからのビューアタブ切り替え (サムネイルツールバー) 実装仕様書 (#149)

Windows タスクバーのアプリアイコンにマウスオーバーすると出るサムネイルプレビュー上に、
`ITaskbarList3` の**サムネイルツールバー** (thumbnail toolbar) で「前のビューア / 次のビューア」
2 ボタンを置き、**ウィンドウにフォーカスを移さずに**ビューアタブ (トップタブの viewer × N) を
巡回できるようにする。issue 本文の「液タブから操作したいのでクリックよりマウスオーバーで
動かせるサムネイルツールバーがいいか」に対応。ジャンプリスト (タブ名の直接選択) は
実装コストが別次元 (起動引数 + 単一インスタンス転送が必要) のため **Phase 2 に分離**する (§14)。

> **ステータス**: ユーザーレビュー合意 (2026-07-20) → 本 PR で実装。§12 の決定事項
> (D1〜D8) は確定。Win32 syscall / COM の動作検証は **Windows 実機** で行う (§11.3)。
> 開発機 (WSL2/Linux) では `taskbar_other.go` の no-op スタブ経路のみ通る
> (#129 winplacement と同じ流儀)。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-07-20 | 初版ドラフト | issue #149 triage。サムネイルツールバー (prev/next 2 ボタン) を Phase 1、ジャンプリストを Phase 2 に分割する提案。`internal/wintaskbar` 新設 + `winplacement.findMainWindow` の共有化 (`internal/winhwnd` 抽出)。永続化 / schema 変更なし。 |
| 2026-07-20 | ユーザー合意 → 実装 | レビュー合意 (D1〜D8 確定、修正指摘なし) を受けて実装。Phase 1 の commit 1〜7 を本 PR で着手。 |

---

## 1. ゴール (DoD)

- **Windows 実機**: タスクバーのアプリアイコンにマウスオーバー → サムネイルプレビュー下部に
  ◀ / ▶ の 2 ボタンが出る。クリックで:
  - ビューアタブ表示中 → アクティブビューアが前 / 次に巡回 (wrap-around)
  - 一覧タブ表示中 → ビューアタブへ切り替え (アクティブビューアは据え置き)
  - いずれも**メインウィンドウが非アクティブのまま**動く (サムネイルツールバーの標準挙動)
- **explorer.exe 再起動後もボタンが復活する** (`TaskbarButtonCreated` メッセージで再登録)。
- **非 Windows (dev)**: 完全 no-op。既存挙動 / ビルド / Linux CI が壊れない。
- **永続化変更なし**: `state.json` (v6) / `settings.json` (v1) とも schema・値の変更なし。
- 新規 Wails バインディング (FE→Go) なし。Go→FE の EventsEmit 1 本のみ追加。

## 2. 用語

| 用語 | 意味 |
|------|------|
| サムネイルツールバー | タスクバーのサムネイルプレビュー下部に最大 7 個のボタンを置ける Win32 機能 (`ITaskbarList3::ThumbBarAddButtons`)。メディアプレイヤーの再生/停止ボタンが代表例。 |
| ジャンプリスト | タスクバーアイコン右クリックで出るメニュー (`ICustomDestinationList`)。項目クリックは**新プロセス起動 + 引数**で伝わるため単一インスタンス転送が必要。Phase 2。 |
| `ITaskbarList3` | タスクバー拡張の COM インターフェイス。**本リポジトリ初の COM 呼び出し** (vtable を syscall で直叩き)。 |
| `THUMBBUTTON` | ボタン定義構造体 (iId / hIcon / szTip[260] / dwFlags)。 |
| `TaskbarButtonCreated` | `RegisterWindowMessageW` で ID を取る登録メッセージ。タスクバーボタン生成時 (起動時 + explorer 再起動時) にウィンドウへ届く。**これを受けてからボタン登録する**のが公式手順。 |
| subclass | 既存ウィンドウの wndproc を差し替えて (`SetWindowLongPtrW(GWLP_WNDPROC)`) メッセージを横取りし、残りを `CallWindowProcW` で元に流すこと。ボタンクリック (`WM_COMMAND`) の受信に必須。 |
| ビューアタブ | トップタブ列 (`TopTabsBar`) の viewer × N。issue の切り替え対象。BSP パネル内の画像タブでは**ない**。 |

## 3. アーキテクチャ概観

### 3.1 全体像

```
[起動 (Windows)]
 main.go OnStartup:
   app.startup(ctx)
   wintaskbar.Setup(onSwitch)          // onSwitch = EventsEmit へのクロージャ
     ├ winhwnd.FindMainWindow()        // #129 と同じ EnumWindows + PID マッチ (共有化, §3.3)
     ├ SetWindowLongPtrW で subclass 装着
     └ PostMessageW(hwnd, WM_APP+1)    // 初期登録を UI スレッドへ委譲 (§3.2)

[UI スレッド (subclass wndproc)]
   WM_APP+1 / TaskbarButtonCreated:
     lazy: CoCreateInstance(ITaskbarList3) → HrInit → ThumbBarAddButtons(◀ ▶)
   WM_COMMAND (HIWORD == THBN_CLICKED):
     iId → "prev" | "next" → onSwitch(direction)
   その他: CallWindowProcW で元 wndproc へ

[Go → FE]
   onSwitch → runtime.EventsEmit(ctx, wintaskbar.ViewerSwitchEvent, {direction})

[FE (App.tsx)]
   EventsOn(ViewerSwitchEvent) →
     gate (settingsOpen / listReorderMode) →
     topTab === "list" → setTopTab("viewer")
     topTab === "viewer" → cycleViewerId(viewers, activeViewerId, direction) → setActiveViewer

[非 Windows]
   wintaskbar.Setup = no-op (taskbar_other.go)。FE リスナは登録されるがイベントが来ない。
```

### 3.2 window subclass (本機能の核心リスク)

サムネイルツールバーのボタンクリックは**メインウィンドウへの `WM_COMMAND`** で届くため、
Wails が所有する wndproc に割り込む必要がある。Wails v2 はこの拡張点を公開していない。

- 採用案: `SetWindowLongPtrW(hwnd, GWLP_WNDPROC, newProc)` で subclass し、
  自分宛て (WM_APP+1 / TaskbarButtonCreated / THBN_CLICKED の WM_COMMAND) 以外は
  **すべて `CallWindowProcW(origProc, ...)` に素通し**する。THBN_CLICKED のみ 0 を返して完結。
- **スレッド制約**: `Setup` は `OnStartup` から呼ばれ、UI スレッドである保証がない。
  - `SetWindowLongPtrW` 自体はカーネル側で直列化されるためクロススレッドで装着する
    (lxn/walk 等の Go GUI 実装で実績のあるパターン)。
  - **COM (`CoCreateInstance` / `ThumbBarAddButtons`) は必ず wndproc 内 = UI スレッドで実行**する。
    そのために Setup 直後に `PostMessageW(WM_APP+1)` で初期登録を UI スレッドへ委譲する
    (TaskbarButtonCreated が subclass 装着**前**に発火済みだった場合の取りこぼし対策も兼ねる)。
    UI スレッドは WebView2 が STA 初期化済みのため `CoInitialize` の追加呼び出しは不要
    (失敗時のみ warn、§10)。
  - 万一クロススレッド subclass が実機で問題を起こした場合の**フォールバック**:
    `SetWindowsHookEx(WH_GETMESSAGE / WH_CALLWNDPROC, threadId)` による同一プロセス内
    メッセージフック (観測のみで足りる。実装時に切り替え判断、D5)。
- wndproc の Go コールバックは `syscall.NewCallback` で作る (winplacement の EnumWindows
  コールバックと同じ)。**プロセス生存中は解放しない** (NewCallback は解放不能仕様)。

### 3.3 Go パッケージ境界

```
internal/winhwnd/                  // #129 の findMainWindow を共有化 (新設)
├── doc.go                         // build-tag なし: package コメントのみ (Linux go build ./... を通すため)
└── hwnd_windows.go                // //go:build windows : FindMainWindow() (uintptr, bool)

internal/wintaskbar/               // 新設
├── wintaskbar.go                  // build-tag なし: ViewerSwitchEvent / DirectionPrev / DirectionNext 定数
├── taskbar_windows.go             // //go:build windows : subclass + ITaskbarList3 + アイコン読み込み
├── taskbar_other.go               // //go:build !windows: Setup no-op
├── taskbar_other_test.go          // //go:build !windows: no-op 契約 + 契約定数値を Linux CI で pin (#133 流儀)
└── assets/                        // go:embed するボタンアイコン prev.ico / next.ico + 再生成手順 README (§5.3)
```

- `winplacement` の `findMainWindow` は `winhwnd.FindMainWindow` へ**移設**し、winplacement は
  それを import する (ロジック複製は AGENTS.md D-1 のドリフト源になるため。純リファクタ commit)。
- `wintaskbar` は **Wails を import しない**。切り替え通知は `Setup(onSwitch func(direction string))`
  のコールバック注入で受け、`main.go` 側で `runtime.EventsEmit` に写す (watcher の `EmitFunc` と同じ
  依存方向)。
- 依存: `wintaskbar` → `winhwnd` + `logging` (windows ビルドのみ)、`winplacement` → `winhwnd` +
  `state` (型) + `logging`。循環なし。

エクスポート (案):

```go
// wintaskbar.go (全 OS 共通)
//   ViewerSwitchEvent = "taskbar:viewer-switch"   // EventsEmit のイベント名
//   DirectionPrev     = "prev"
//   DirectionNext     = "next"
//
// taskbar_windows.go / taskbar_other.go
//   Setup(onSwitch func(direction string)) (ok bool)  // windows: subclass 装着 / other: false
```

## 4. データモデル

**永続化 (`state.json` / `settings.json`) は変更しない。**

追加はイベント payload のみ:

```
Go:  EventsEmit(ctx, wintaskbar.ViewerSwitchEvent, direction string)  // "prev" | "next"
FE:  type TaskbarViewerSwitchDirection = "prev" | "next"
     // Go 側 wintaskbar.DirectionPrev/Next の hand-mirror (context.md §4 A の
     // watcherPolicy.ChangedPayload と同じ流儀、docstring で Go 定数と紐付け)
```

FE 側の定数 / 型は App-level のため `frontend/src/taskbarEvents.ts` (新規、`topTab.ts` と同居の
`src/` 直下) に置き、Go 定数との同値は vitest の D-1 pin テストで固定する (§11.2)。

## 5. 画面 / 操作

### 5.1 アプリ内 UI の変更

**なし**。設定 UI への項目追加もなし (常時有効。無効化トグルは Out of scope §13)。

### 5.2 タスクバー上の挙動

| 操作 | 挙動 |
|------|------|
| ◀ (前のビューア) クリック | `topTab === "viewer"`: アクティブビューアを 1 つ前へ (先頭なら末尾へ wrap)。`topTab === "list"`: ビューアタブへ切り替えのみ (巡回しない) |
| ▶ (次のビューア) クリック | 同上の逆方向 |
| ビューアが 1 個のとき | `list` からの切り替えのみ機能。`viewer` 中は no-op (ボタンは常時有効のまま、D3) |
| 設定ダイアログ表示中 / 一覧の並べ替えモード中 | **no-op** (`useGlobalKeybindings` のタブ切替 gate と同一方針) |
| ウィンドウ最小化中 | 動作する (WM_COMMAND は最小化中も届く)。ただし画面は見えないので実用上は復元後に反映を確認 |

- ボタンの tooltip は Go 側ハードコードの日本語固定文字列 (「前のビューア」「次のビューア」)。
  FE の `messages/ja.ts` カタログは FE 専用のため対象外 (i18n は #16、§13)。
- ビューア**名**の表示 / 直接選択はサムネイルツールバーでは実現できない (ボタンはアイコンのみ)。
  それはジャンプリストの守備範囲 = Phase 2。

### 5.3 ボタンアイコン

`THUMBBUTTON` は `HICON` 必須。方針 (D6):

- ◀ / ▶ の矢印 2 個を **.ico ファイル (16/20/24/32px マルチサイズ、HiDPI スケール対応) として
  commit** し
  (`internal/wintaskbar/assets/`)、`go:embed` → `LookupIconIdFromDirectoryEx` +
  `CreateIconFromResourceEx` でメモリから `HICON` 化する。
- ico は実装時にスクリプトで一度だけ生成 (フロントのインライン SVG と同モチーフの単純矢印、
  ライト / ダーク両タスクバーで視認できる中間グレー)。生成スクリプト自体は commit しない
  (使い捨て。再生成手順を assets の README 1 行で残す)。
- GDI で実行時に描画する案は却下 (コード量が ico 読み込みより膨らむ)。

## 6. IPC (Go バインディング)

**新規 Wails バインディング (FE→Go) は追加しない。**

- Go→FE は `runtime.EventsEmit(ctx, wintaskbar.ViewerSwitchEvent, direction)` 1 本のみ。
  `main.go` の `OnStartup` 内で `wintaskbar.Setup` にクロージャ注入する (§9)。
- FE は `EventsOn(ViewerSwitchEvent)` を `App.tsx` で 1 回だけ登録 (§8 経路 4)。

## 7. 永続化

**変更なし**。アクティブビューアの切り替えは既存の `useSessionSave` が従来どおり
(キーボード / クリックで切り替えた場合と同じ経路で) 保存する。本機能は「切り替えのトリガ」を
1 個増やすだけで、保存経路には触れない。

## 8. 同期モデル (CLAUDE.md 非同期ルール / AGENTS.md H-8)

新規 async event source と gate 方針。**実装の最初の commit はこの表 (spec) とする**。

| # | event source | trigger | capture したい値 | stale 化リスク | gate 方針 |
|---|--------------|---------|----------------|----------------|-----------|
| 1 | Go `Setup` (OnStartup) | 起動時 1 回 | HWND (`winhwnd.FindMainWindow`) | window 未生成なら見つからない | `ok=false` で warn + 機能無効 (リトライしない、D7)。subclass 装着後の初期登録は PostMessage で経路 2 へ委譲 (Setup 自身は COM を触らない) |
| 2 | wndproc: `WM_APP+1` / `TaskbarButtonCreated` (UI スレッド) | 起動時 + explorer 再起動時 (回数不定) | ITaskbarList3 instance (module state, lazy init) | explorer 再起動でタスクバー側の登録が消える = 「登録済み flag」は stale になる | flag で抑止**しない** — 受信のたびに `ThumbBarAddButtons` を再実行 (冪等化)。既登録での E_FAIL は debug log で無視 (§10) |
| 3 | wndproc: `WM_COMMAND` THBN_CLICKED (UI スレッド) | ボタンクリック | iId → direction | FE 未 ready (EventsOn 登録前) だとイベントは消える | 消失を**許容** (再クリックで回復。起動直後数秒の話で実害なし)。Go 側に mutate する state が無いため直列化不要 |
| 4 | FE `EventsOn(ViewerSwitchEvent)` handler | 経路 3 の emit | viewers / activeViewerId / topTab / settingsOpen / listReorderMode | handler closure の stale 化 (viewer 増減・gate 状態変化) | `useGlobalKeybindings` と同じ **render-time ref sync** (空 deps で 1 回登録 + ref 経由で最新値を読む)。gate: settingsOpen / listReorderMode で無視 |
| 5 | FE unmount / HMR | App unmount | — | リスナ二重登録 | `EventsOn` の戻り値 (解除関数) を effect cleanup で呼ぶ |

- **Go module state** (subclass の origProc / ITaskbarList3 ポインタ / HICON × 2): プロセス生存中
  1 回だけ初期化され、**リセット経路は意図的に持たない** (AGENTS.md H-3 の「空になったときの
  リセット」が存在しない一方向 state。ウィンドウ破棄 = プロセス終了のため解除不要。
  `syscall.NewCallback` も解放不能仕様)。この旨をコードコメントに明記する。
- 経路 4 が mutate する state (activeViewerId / topTab) は既存のクリック / キーボード経路と
  同一の setter を使うため、新しい競合軸は増えない (mtime / folder / dirty / inflight: 該当なし)。

## 9. main.go の変更点

```go
OnStartup: func(ctx context.Context) {
    app.startup(ctx)
    // タスクバーのサムネイルツールバー (#149)。非 Windows は no-op (ok=false)。
    // 失敗しても本体機能に影響しないため best-effort (winrestart.Register と同じ扱い)。
    if !wintaskbar.Setup(func(direction string) {
        runtime.EventsEmit(ctx, wintaskbar.ViewerSwitchEvent, direction)
    }) {
        // 非 Windows は静かに、Windows での失敗は Setup 内部で warn 済み
    }
    // ... 既存の winplacement.Restore / #86 フォールバック (変更なし)
},
```

- `app.go` への追加なし (バインディング不要のため。watcher が app.go 配線なのは Start/Stop の
  バインディングを持つため。本機能はライフサイクルのみ = winplacement/winrestart と同じ main.go 所属)。
- `OnBeforeClose` / `OnShutdown` への追加なし (解除不要、§8)。

## 10. エラーハンドリング

| 事象 | 挙動 |
|------|------|
| HWND が見つからない | `Setup` は `ok=false` + warn。機能無効のまま起動継続 (best-effort) |
| `SetWindowLongPtrW` 失敗 (戻り値 0) | 同上。subclass 未装着なので以降のメッセージ処理も発生しない |
| `CoCreateInstance` / `HrInit` 失敗 | warn + ITaskbarList3 を nil のまま (次の TaskbarButtonCreated で再試行) |
| `ThumbBarAddButtons` が既登録で失敗 (E_FAIL 等) | debug log のみ (経路 2 の冪等化の正常系) |
| ico デコード (`CreateIconFromResourceEx`) 失敗 | warn + ボタン登録をスキップ (壊れた ico を embed した場合のみ。CI では通らないので実機手動で検知) |
| 管理者権限で実行された場合 (UIPI で TaskbarButtonCreated が遮断されうる) | 対処しない (通常インストールで管理者実行は想定外。必要になったら `ChangeWindowMessageFilterEx` を将来 issue) |

ログは既存 `internal/logging` (`app` カテゴリ)。

## 11. テスト

### 11.1 Go (Linux CI で動く範囲)

- `taskbar_other.go`: `Setup` が `false` を返し callback を呼ばないことを pin
  (`taskbar_other_test.go`, `//go:build !windows`。#133 `restart_other_test.go` 流儀)。
- 定数 (`ViewerSwitchEvent` / `DirectionPrev` / `DirectionNext`) の値を pin (FE 側 D-1 テストの対)。
- `winhwnd` 抽出は挙動同一の純リファクタ (windows ビルド専用のため Linux CI ではコンパイル対象外。
  §11.4 のクロスコンパイル check が唯一の CI 検証)。

### 11.2 フロント (vitest)

- `cycleViewerId(viewers, activeId, direction)` 純関数 (viewers.ts に追加): wrap-around /
  ビューア 1 個で不変 / activeId 不明時は先頭へフォールバック、を検証。
- `taskbarEvents.ts` の direction 定数が Go 側と同値であることの D-1 pin テスト。
- `App.tsx` のイベント配線 (gate 含む) は renderHook 化しない (App 全体のマウントが要るため
  過剰)。gate 判定 + 切り替え先計算を純関数 / 小フックに寄せ、そこを単体で検証する
  (実装時に `useTaskbarViewerSwitch.ts` として切り出し、renderHook + EventsOn mock で
  経路 4 の ref 同期と gate を検証する)。

### 11.3 手動 (Windows 実機 — syscall / COM は CI で検証不可)

- [ ] マウスオーバーでサムネイルプレビューに ◀ ▶ が出る
- [ ] ▶ 連打でビューアが順に巡回し、末尾から先頭へ wrap する (◀ は逆順)
- [ ] 一覧タブ表示中に ▶ → ビューアタブに切り替わる (アクティブビューア据え置き)
- [ ] ウィンドウ非アクティブのままタブが切り替わる (フォーカスが奪われない)
- [ ] 設定ダイアログ表示中 / 並べ替えモード中はクリックしても何も起きない
- [ ] `taskkill /f /im explorer.exe` → explorer 再起動後もボタンが復活する
- [ ] 最小化 → クリック → 復元でタブが切り替わっている
- [ ] ウィンドウを閉じて再起動してもボタンが出る (TaskbarButtonCreated 経路の確認)

### 11.4 クロスコンパイル check (D8)

windows build-tag のコンパイルエラーが現状 `v*` tag の release.yml まで検出されない問題への
対策として、ci.yml に `GOOS=windows go build ./...` step を追加する (cgo 不使用のため
ubuntu runner でクロスコンパイル可能。winplacement / winrestart / imgfile の既存 windows
ファイルもカバーされるようになる)。

## 12. 決定事項 (ドラフト — ユーザー合意待ち)

- **D1 — 実装方式**: Phase 1 は**サムネイルツールバー** (prev/next 2 ボタン)。ジャンプリスト
  (タブ名直接選択) は起動引数 + 単一インスタンス転送 (`options.SingleInstanceLock`) が必要で
  規模が別物のため Phase 2 の別 issue に分離。issue 本文の「マウスオーバーで動かせる方が良い」
  に整合。
- **D2 — 切り替えセマンティクス**: 巡回対象は**ビューアのみ** (一覧タブは巡回リングに含めない)。
  一覧表示中のクリックは「ビューアタブへ入る」だけ (巡回しない)。`Ctrl+Shift+2..9` が
  ビューア直接選択であるのに対し、こちらは相対移動。wrap-around あり。
- **D3 — ボタンは常時有効 (静的登録)**: ビューア数や topTab に応じた enable/disable の動的更新は
  **しない** (FE→Go の状態同期 IPC が新設になり、H-8 の競合軸が一気に増えるため)。無効時は
  FE 側で no-op。動的化は必要を感じてから Phase 2。
- **D4 — HWND 取得の共有化**: `winplacement.findMainWindow` を `internal/winhwnd.FindMainWindow`
  に抽出し両パッケージで共用 (複製は D-1 ドリフト源)。純リファクタとして独立 commit。
- **D5 — メッセージ受信は subclass**: `SetWindowLongPtrW(GWLP_WNDPROC)` + `CallWindowProcW`
  素通し。COM 操作は wndproc 内 (UI スレッド) に限定し、初期登録は `PostMessageW(WM_APP+1)` で
  委譲。実機で問題が出た場合のフォールバックは `SetWindowsHookEx` (§3.2)。
- **D6 — アイコン**: ◀▶ の .ico 2 個を commit + `go:embed` + `CreateIconFromResourceEx`。
  実行時 GDI 描画はしない。
- **D7 — best-effort**: HWND 不明 / subclass 失敗 / COM 失敗は warn して機能無効で起動継続。
  リトライループは持たない (winrestart.Register と同じ扱い)。
- **D8 — CI にクロスコンパイル check 追加**: `GOOS=windows go build ./...` を ci.yml に追加
  (§11.4)。本 issue のスコープ外の既存 windows ファイルも守られる。ci.yml を触るため明示合意を
  取る。

## 13. Out of scope

- **ジャンプリスト** (タブ名の直接選択、`ICustomDestinationList` + `SingleInstanceLock` +
  起動引数転送) — Phase 2 として別 issue 化。
- ボタンの動的 enable/disable / tooltip へのビューア名反映 (FE→Go 状態同期が必要、D3)。
- BSP パネル内の**画像タブ**の切り替え (issue の対象はトップレベルのビューアタブ)。
- 設定 UI での有効 / 無効トグル (常時有効)。
- tooltip の i18n (#16 の locale 切替に追従する時に Go 側文字列も扱いを決める)。
- タスクバー progress / overlay icon 等、ITaskbarList3 の他機能。
- 管理者実行時の UIPI 対策 (`ChangeWindowMessageFilterEx`)。

## 14. Phase 分割

### Phase 1 (本 spec のスコープ、単一 PR)

1. **commit 1**: 本 spec + todo.md 1 行 (同期モデル §8 を先に確定)
2. **commit 2**: `internal/winhwnd` 抽出 + `winplacement` 追従 (純リファクタ)
3. **commit 3**: `internal/wintaskbar` の定数 + `taskbar_other.go` no-op + Linux pin テスト
4. **commit 4**: `taskbar_windows.go` (subclass + ITaskbarList3 + ico assets)
5. **commit 5**: `main.go` の OnStartup 配線
6. **commit 6**: FE — `taskbarEvents.ts` + `cycleViewerId` 純関数 + `useTaskbarViewerSwitch` +
   App.tsx 配線 + vitest
7. **commit 7**: ci.yml に `GOOS=windows go build ./...` (D8 合意時)

### Phase 2 (別 issue 化、Out of scope)

- ジャンプリスト (タブ名直接選択)
- ボタン動的 enable/disable / ビューア名 tooltip

## 15. 参考 (実装着手時に必ず読む)

- [internal/winplacement/placement_windows.go](../internal/winplacement/placement_windows.go) —
  syscall.NewCallback / LazyDLL の手本 (`findMainWindow` は commit 2 で
  [internal/winhwnd](../internal/winhwnd/hwnd_windows.go) の `FindMainWindow` へ移設済み)
- [internal/winrestart/](../internal/winrestart/) — best-effort 登録 + other no-op pin テストの手本
- [internal/watcher/](../internal/watcher/) — コールバック注入 (EmitFunc) で Wails 非依存を保つ手本
- [useGlobalKeybindings.ts](../frontend/src/useGlobalKeybindings.ts) — render-time ref sync +
  gate (settingsOpen / listReorderMode) の流儀。経路 4 はこれに合わせる
- [docs/spec-window-placement.md](spec-window-placement.md) — Windows syscall spec の構成手本
- Microsoft Docs: ITaskbarList3 (ThumbBarAddButtons / THUMBBUTTON / THBN_CLICKED /
  TaskbarButtonCreated)
