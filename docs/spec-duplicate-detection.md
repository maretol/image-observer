# 保存画像のダブり警告 実装仕様書 (#136)

一覧 (分類) タブで、**知覚的ハッシュ (perceptual hash) がしきい値以内で近い画像ペア**を
「ダブり候補」として検出し、該当 Card に caution バッジを表示する。誤検出だったペアは
ユーザーが「ダブりではない」として **恒久的に dismiss** できる。ハッシュアルゴリズムは
**dHash / pHash の両方を実装**し、設定で切り替えられる (D1)。実装は 2 段階に分け、
**Phase 1 (本 PR) = dHash のみ**、pHash + 切替設定は別ブランチの Phase 2 (§12)。

> **ステータス**: ユーザー合意済み (2026-07-05)。Phase 1 (dHash) を本ブランチで実装。
> データ形式 (キャッシュ algo 別パス / dismiss の algo フィールド) は Phase 1 から
> pHash 前提で敷いておく。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-07-05 | 初版ドラフト | issue #136 + コメント (しきい値判定 / dismiss 要件) を受けて起案。dHash + フォルダ単位検出 + `_duplicates.json` dismiss 永続化 + H-8 同期モデル表。 |
| 2026-07-05 | レビュー反映 (1) | ユーザー指示で D1 を「dHash / pHash 両実装 + 設定切替」に変更。キャッシュを algo 別パスに分離 (§7.3)、dismiss は両 algo のハッシュペアを同時記録 (§7.2)、settings に `duplicateHashAlgo` 追加 (§7.1)。 |
| 2026-07-05 | レビュー反映 (2) → 着手 | ユーザー指示で Phase 分割: **Phase 1 (本 PR) = dHash のみ** / Phase 2 (別ブランチ) = pHash + `duplicateHashAlgo` 設定 + 切替 UI。dismiss の「両 algo 同時記録」は Phase 2 開始時から (Phase 1 の dismiss は dhash エントリのみ。Phase 2 で legacy 単 algo 記録ペアの cross-algo 照合を入れる、§7.2)。 |

---

## 1. ゴール (DoD)

- 一覧タブで、現在フォルダの表示 entry 同士に **ハッシュ距離 ≤ しきい値** のペアがあるとき、
  該当 Card のサムネ上に caution バッジ (⚠ インライン SVG) が出る。
- バッジ hover / Card から **どのファイルとダブり候補か** が分かる (§5.3 確認モーダル)。
- ペア単位で「ダブりではない」を実行でき、**再読み込み / 再起動 / 再検出後も** そのペアには
  バッジが出ない (dismiss の永続化)。
- しきい値は設定ダイアログから変更でき、変更後は現在フォルダで再判定される。
- (Phase 2) ハッシュアルゴリズム (dHash / pHash) を設定ダイアログから切り替えられ、切替後は
  現在フォルダで再判定される。**切替で dismiss 済みペアが復活しない** (§7.2)。
- 検出を `off` にする設定があり、off 中はハッシュ計算も IPC も走らない。
- ハッシュはファイル単位でディスクキャッシュされ、2 回目以降のフォルダオープンでは
  未変更ファイルの再デコードが起きない。
- AVIF / デコード失敗ファイルは判定対象外として **エラーにせず skip** する (#118 と整合)。
- 検出は Load / watcher / 削除 / フォルダ切替と競合しない (§8 同期モデル表の gate を実装)。
- `go test ./...` / `go vet` / `tsc --noEmit` / vitest 全通過。

---

## 2. 用語

| 用語 | 意味 |
|------|------|
| **知覚的ハッシュ** | 画像の見た目から計算する 64bit ハッシュ。近い見た目 → 近いビット列。本仕様では dHash / pHash の 2 実装を持ち設定で選択 (D1)。 |
| **dHash** | difference hash。9×8 グレースケール縮小 → 横方向の隣接輝度比較で 64bit。リサイズ / 再エンコード耐性が高く実装が小さい。既定。 |
| **pHash** | perceptual hash (DCT 版)。32×32 グレースケール縮小 → 2 次元 DCT-II → 低周波 8×8 成分 (DC 除く) を中央値としきい値比較で 64bit。ノイズ / ぼかし / 局所的な書き込みに dHash より強い。純 Go で実装 (依存追加なし)。 |
| **ハッシュ距離** | 2 つの 64bit ハッシュのハミング距離 (0〜64)。0 = 知覚的に同一。 |
| **しきい値** | 距離がこの値以下ならダブり候補とみなす整数。既定 5 (D2)。 |
| **ダブり候補ペア** | `距離(A,B) ≤ しきい値` かつ dismiss されていないファイルペア。 |
| **dismiss** | 「このペアはダブりではない」というユーザー判定。ハッシュ値ペアをキーに `_duplicates.json` へ永続化 (D5)。 |
| **ハッシュキャッシュ** | フォルダ単位の JSON インデックス (`<UserCacheDir>` 配下)。`mtime/size` 一致ならデコードせずハッシュ再利用 (D7)。 |

---

## 3. アーキテクチャ概観

```
[一覧タブ: Load 成功 / watcher 反映 / しきい値変更]
        │ (frontend: useDuplicateCheck が entries の filename 一覧を capture)
        ▼
 CheckDuplicates(folderPath, filenames)  ── 新規 Wails IPC
        │ (Go: internal/imghash)
        ▼
 1) ハッシュキャッシュ読込 (選択中 algo のフォルダ index JSON)
 2) 未計算 / mtime・size 不一致ファイルのみ decode → 選択中 algo でハッシュ (worker pool 並行)
 3) index を atomic write で更新
 4) 全ペア総当たりで 距離 ≤ しきい値 (settings.Load() から取得) を抽出
 5) _duplicates.json の dismiss 済みハッシュペアを除外
        │
        ▼
 DuplicateReport { pairs: [{fileA, fileB, distance}], skipped: [...] }
        │ (frontend: gen / folder / mode gate を通して commit)
        ▼
 Card バッジ表示 (pair に含まれる filename の集合) + 確認モーダル (dismiss 操作)
        │ dismiss 実行
        ▼
 DismissDuplicatePair(folderPath, fileA, fileB) ── ハッシュペアを _duplicates.json へ追記
```

ポイント:

- **判定は Go 側で完結** (デコード / ハッシュ / 距離 / dismiss 除外)。フロントは表示と gate のみ。
- デコードは既存 `internal/thumb/decode.go` を新パッケージ `internal/imgdecode` に移設して共用
  (thumb / imghash の双方から import。重複実装を作らない)。
- AVIF は Go でデコードできない (#118 の確定方針) ため **skip** し、`skipped` で報告する。
- 全ペア総当たりは 64bit XOR + popcount なので、数千枚オーダーでも実用速度 (10,000 枚で
  約 5×10^7 回比較)。ボトルネックは初回のデコードで、これはキャッシュで 1 回きりにする。

---

## 4. データモデル

| 項目 | 変更 |
|------|------|
| state schema | **変更なし** (v6 のまま) |
| settings schema | **v1 のまま additive 追加** (§7.1、per-field fallback 方針に従い version bump しない) |
| classification sidecar | **変更なし** (`_classification.json` は触らない) |
| 新規フォルダ sidecar | `_duplicates.json` (dismiss 永続化、§7.2) |
| 新規キャッシュ | フォルダ単位ハッシュ index (§7.3) |
| 新規 Go パッケージ | `internal/imghash` + `internal/imgdecode` (thumb から decode 移設) |
| 新規 IPC | `CheckDuplicates` / `DismissDuplicatePair` (§6) |

### 4.1 Go 型 (Wails 公開形)

```go
// internal/imghash

// DuplicatePair は距離がしきい値以内で dismiss されていない 1 ペア。FileA/FileB は
// classification entry と同じ POSIX 相対 path ("child1/foo.png")。FileA < FileB (辞書順) に正規化。
type DuplicatePair struct {
    FileA    string `json:"fileA"`
    FileB    string `json:"fileB"`
    Distance int    `json:"distance"`
}

// DuplicateReport は 1 フォルダ分の検出結果。
type DuplicateReport struct {
    FolderPath string          `json:"folderPath"`
    Pairs      []DuplicatePair `json:"pairs"`
    // Skipped は判定対象外 (AVIF / デコード失敗 / 読み取り不可)。バッジは出さない。
    Skipped    []string        `json:"skipped"`
}
```

---

## 5. 画面 / 操作

### 5.1 Card の caution バッジ

- `DuplicateReport.pairs` のいずれかに filename が含まれる Card のサムネ右上
  (既存 `.cls-card-edit` = 左上系と重ならない位置) に ⚠ バッジを表示。
- 新規 CSS クラス `.cls-card-dup-warn` (App.css に定義、H-4 で grep 確認)。
- インライン SVG アイコン (`shared/icons/` に `WarnIcon` 新設。外部ライブラリなし)。
- `title` / `aria-label` = 「ダブりの可能性があります (クリックで確認)」。
- バッジは `<button>` とし、クリックで §5.3 確認モーダルを開く。`tabIndex={-1}`
  (thumb が `role="button"` のため、内側 interactive 要素は Tab 巡回から除外 = H-1 既存方針)。
  `stopPropagation()` で thumb クリック (プレビュー / 選択) と分離 (H-2)。

### 5.2 CardContextMenu (単一モード)

- 項目「ダブり候補を確認…」を追加 (バッジ表示中の Card のみ)。クリックで §5.3 を開く。
- バルクモードには追加しない (#127 D5 と同じ整理)。

### 5.3 ダブり確認モーダル

`ModalShell` ベースの新規モーダル `DuplicatePairsModal`:

- 起点 Card を含む **候補ペアの一覧** を表示。1 行 = 1 ペア:
  - 両ファイルのサムネイル (既存 `GetThumbnail` 流用) + filename + 距離
  - ボタン「ダブりではない」→ `DismissDuplicatePair` 実行 → 成功で行を消し、
    ペアが尽きたらモーダルを閉じてバッジも消す
- `closeOnBackdrop = true` / `closeOnEscape = true` (閲覧系モーダルなので既定通り。H-5)。
- `aria-label` = 「ダブり候補の確認」(H-1)。
- 目視比較を丁寧にやりたい場合は既存機能 (ビューアで両方開く) を使う。並べて拡大比較する
  専用 UI は Out of scope (§11)。

### 5.4 設定ダイアログ

「一覧」セクションに追加:

- **ダブり検出**: segment `auto` (フォルダを開いたら自動判定) / `off` (判定しない)。既定 `auto` (D9)。
- (Phase 2) **ダブり判定アルゴリズム**: segment `dHash` (標準・高速) / `pHash` (ノイズ・加工に
  強い)。既定 `dHash` (D1)。切替時は現在フォルダで再判定 (§8)。Phase 1 では出さない。
- **ダブり判定しきい値**: 数値入力 0〜16、既定 5。blur / Enter で commit + clamp (AGENTS.md C-2)。
  補足文言「小さいほど厳密 (0 = 知覚的に同一のみ)」。しきい値は両アルゴリズム共通 (D2)。

### 5.5 トースト / 文言

- 検出はバックグラウンド動作なので **成功トーストは出さない** (バッジ表示が結果)。
- `CheckDuplicates` 失敗時は error トーストを出さず **ログのみ** (D6。検出は補助機能であり、
  Load のたびに失敗トーストが出ると本来機能の邪魔になる)。dismiss 失敗のみ error トースト
  (ユーザー操作への直接応答のため)。
- 新規文言は周辺 (CardContextMenu / モーダル) がハードコード ja のままなので同様にハードコード
  (#83 の `t()` 移行対象外、#127 §5.6 と同じ整理)。

---

## 6. IPC

### 6.1 `CheckDuplicates(folderPath string, filenames []string) (imghash.DuplicateReport, error)`

- `filenames` は一覧が表示している entry の POSIX 相対 path 一覧 (orphans は含めない)。
  Go 側で再スキャンせず **フロントの表示と同じ集合** を判定対象にする (D3)。
- しきい値と mode は Go 側で `settings.Load()` から読む (フロントから渡さない = 値の二重管理回避)。
  mode = off なら空 report を返す (フロント gate と二重防御)。
- `DeleteImage` と同じ入力検証 (絶対 path / 相対 filename / traversal 拒否) を行う。
- 内部で per-folder mutex を取り、同一フォルダへの並行 Check を直列化 (キャッシュ index の
  read-modify-write を単純化)。

### 6.2 `DismissDuplicatePair(folderPath, fileA, fileB string) error`

- 両ファイルの **現在のハッシュ値ペア** (ソート済み hex) を `_duplicates.json` に追記。
- ハッシュはキャッシュ index から引く (Check 済みでなければ計算)。
- 冪等 (既に dismiss 済みなら no-op で成功)。

### 6.3 バインディング (app.go)

```go
// app.go — 薄い委譲のみ (§11 パッケージ境界)
func (a *App) CheckDuplicates(folderPath string, filenames []string) (imghash.DuplicateReport, error)
func (a *App) DismissDuplicatePair(folderPath, fileA, fileB string) error
```

---

## 7. 永続化 / マイグレーション

### 7.1 settings.json (additive、version bump なし)

| field | 型 | 既定 | 検証 |
|-------|----|------|------|
| `duplicateDetectMode` | string | `"auto"` | `"auto" \| "off"` 以外は既定へ per-field fallback |
| `duplicateHashAlgo` (**Phase 2**) | string | `"dhash"` | `"dhash" \| "phash"` 以外は既定へ per-field fallback。Phase 1 では field 自体を追加せず、Go 内部の algo 定数 = dhash 固定 |
| `duplicateThreshold` | int | 5 | 0〜16 に clamp (範囲外は既定へ fallback) |

既定値定数は Go を一次ソースにし、フロントは AGENTS.md D-1 に従い共通定数モジュール +
同値テストで pin する (`watchMode.ts` と同じ流儀で `duplicateDetect.ts` を新設)。

### 7.2 `_duplicates.json` (フォルダ sidecar、新規)

保存先: 対象フォルダ直下 (`_classification.json` の隣)。dismiss は分類と同じく
「そのフォルダの画像に対するユーザー判定」なので、キャッシュ消去に巻き込まれず
フォルダとともに移動する場所に置く (D5)。

```json
{
  "version": 1,
  "dismissed": [
    { "algo": "dhash", "a": "c3f0a1...", "b": "c3f0a9..." },
    { "algo": "phash", "a": "8a21ef...", "b": "8a21e7..." }
  ]
}
```

- `a` / `b` は 64bit ハッシュの hex (16 文字)。`a <= b` に正規化した無順序ペア。
- **ハッシュ値をキーにする理由 (D5)**: ファイル名 rename / 同一画像の再追加でも dismiss が
  生き続ける。ファイル名キーだと rename で復活してしまう。
- **dismiss 1 回につき実装済み全 algo のエントリを同時に記録する** (D1)。上の例は Phase 2
  以降の 1 回の dismiss で書かれた 2 行。片方の algo でしか記録しないと、設定でアルゴリズムを
  切り替えた瞬間に dismiss 済みペアが全部復活する。dismiss 時に対象 2 ファイルの各 algo
  ハッシュを計算 (キャッシュに無い側は 2 ファイルだけ追計算 = 軽微) して記録する。
  **Phase 1 は dhash のみ実装のため dhash エントリ 1 行**。
- Check 時の除外は **選択中 algo のエントリのみ** を参照する。
- **Phase 2 の宿題 (legacy 単 algo 記録)**: Phase 1 の間に書かれた dismiss は dhash エントリ
  しか持たないため、そのままでは phash 切替時に復活する。Phase 2 では候補ペア (少数) に
  対して **対象 2 ファイルの dhash 値でも dismiss 照合する cross-algo チェック**を入れる
  (dhash キャッシュから引く / 無ければ追計算。候補ペアは高々数件なのでコストは無視できる)。
  詳細は Phase 2 の spec 改訂で確定する。
- 書き込みは既存 sidecar と同じ tmp + rename の atomic write。
- **mtime 楽観ロックは導入しない** (D5)。書き込みは dismiss 操作時のみで競合機会が実質なく、
  last-write-wins で十分。`_classification.json` の conflict 機構は持ち込まない。
- ファイルが無い = dismiss ゼロ。壊れた JSON は「dismiss ゼロ」として扱い warn ログ
  (per-field fallback と同じ寛容方針)。
- **watcher が `_duplicates.json` に反応しないこと** を実装時に必ず確認する。反応すると
  dismiss → watcher event → 再 Load → 再 Check の self-echo ループになる。watcher の
  対象判定が「画像 + `_classification.json`」の whitelist であることをコードで確認し、
  そうでなければ ignore を追加する (実装チェック項目)。

### 7.3 ハッシュキャッシュ (UserCacheDir、新規)

保存先: `<UserCacheDir>/image-observer/cache/duphash/<algo>/<2>/<30>.json`
(`<algo>` = `dhash` / `phash`。キー = `sha256(フォルダ絶対 path)` の先頭 32 hex をサムネと
同じ形式でシャーディング)。

```json
{
  "version": 1,
  "algo": "dhash-v1",
  "files": {
    "child1/foo.png": { "mtime": 1730000000, "size": 123456, "hash": "c3f0a1..." }
  }
}
```

- **algo をパスセグメントで分離**するので、アルゴリズムを切り替えても両方のキャッシュが
  温存され、行き来しても再計算が走らない (dismiss の追計算 §7.2 も安くなる)。
- `mtime` (Unix 秒) / `size` 一致ならハッシュ再利用、不一致なら再計算 (サムネキャッシュ D 節と
  同じ無効化方針)。消えた filename の行は Check 時に落とす (孤児を溜めない)。
- index 内の `algo` は **アルゴリズム実装のリビジョンタグ** (`dhash-v1` / `phash-v1`)。
  ビット順やパラメータを変えたら `-v2` に bump し、不一致なら index 全体を捨てて再計算
  (パスセグメントは algo 種別、タグは実装版数、と役割を分ける)。
- キャッシュ消去はサムネと同じく「手動でフォルダ削除」(README 記載の既存手順に含まれる)。
  消えても dismiss (`_duplicates.json`) は失われない。

### 7.4 マイグレーション

- state / classification schema 変更なし → マイグレーション不要。
- settings は additive + per-field fallback → 旧 settings.json はそのまま読める。

---

## 8. 同期モデル (AGENTS.md H-8 / CLAUDE.md 着手前ルール)

フロントの新規 state は `duplicateReport: DuplicateReport | null` (classification feature 内、
新規子フック `useDuplicateCheck` が所有) と `dupGenRef` (検出世代)。**duplicateReport は
entries 依存 state** なので、既存 `resetEntriesDependentState` に clear を追加する
(PR #75 Round 13/14 の教訓)。

### 8.1 event source 5 列表 (着手前マトリクス)

| event source | trigger | capture したい値 | stale 化リスク | gate 方針 |
|---|---|---|---|---|
| Load 成功後の検出 kick | `loadResult` commit (openFolder / autoLoad / reload) | folderPath + entries filename 一覧 | folder / gen / mode(off) | `dupGenRef` bump + await 後 `folderRef.current === captured` + mode を entry / post-await 両方で check |
| watcher 反映後の検出 kick | watcher handler の setLoadResult 成功 | 同上 (新 entries) | folder / gen / mode | 同上 (bump = 旧 in-flight Check を stale 化) |
| CheckDuplicates 完了 | IPC resolve | report | gen (新 kick に supersede) / folder / mode(off に切替) / entries 変化 | `myGen !== dupGenRef.current` なら破棄。entries 変化は「変化経路が必ず bump する」ことで担保 (別軸の比較はしない) |
| CheckDuplicates 失敗 | IPC reject | — | gen / folder | 同 gate 後、report は据え置かず null 化はしない (前回結果を保持、D6)。ログのみ |
| dismiss 成功 | モーダルのボタン → IPC resolve | 対象ペア | folder (await 中に切替) / report が別世代に差替 | `folderRef.current === captured` check → 現 report から該当ペアを **filename ペアで** local 除去 (再 Check しない。hash ペアは Go 側で永続除外済みなので次回 Check とも整合) |
| dismiss 失敗 | IPC reject | — | folder | folder check 後 error トースト。report 不変 |
| 削除成功 (deleteOne) | 既存削除フロー | 削除 filename | in-flight Check が削除済みファイルを含む | 削除後の Load 再取得経路が検出 kick (bump) を通るため専用処理なし。加えて report から該当 filename を含むペアを local 除去 (次の report 到着までのバッジ残留を防ぐ) |
| 設定変更 (threshold / algo / mode) | 設定ダイアログの UpdateSettings 成功 | 新 threshold / algo / mode | in-flight Check が旧 threshold / 旧 algo | mode=off → bump + report を null 化。mode=auto / threshold / algo 変更 → bump + 再 kick (threshold・algo は Go が settings.Load() で読むため、bump 後の再 kick で新値が自然に効く) |
| フォルダ切替 / Load 失敗 | openFolder / loadInternal catch | — | 旧フォルダの report 残留 | `resetEntriesDependentState` 内で report null 化 + bump (in-flight Check を stale 化)。folder 切替は既存フローが同ヘルパを呼ぶ (PR #75 Round 14) |
| unmount | ClassificationView unmount | — | 該当軸なし | state は hook と共に破棄。IPC 結果は gen gate で自然に無視 |

- **dirty / touched / inflight 軸**: duplicateReport はユーザー編集を持たない読み取り専用
  state なので dirty / touched は該当なし (検討済み)。inflight は gen gate で処理。
- **spinner**: 検出中インジケータは Phase 1 では出さない (該当軸なし)。将来出すなら
  loading token 分離 (H-8) を適用。

### 8.2 詳細マトリクス

| 経路 | gen check (snapshot/bump) | folder check | mode (entry) | mode (post-await) | error clear | pending gen check |
|------|:--:|:--:|:--:|:--:|:--:|:--:|
| Load 成功 kick → Check 完了 | bump | ✓ | ✓ | ✓ | – (エラー state 持たない) | – |
| watcher 反映 kick → Check 完了 | bump | ✓ | ✓ | ✓ | – | – |
| Check 失敗 | (bump 済み世代で判定) | ✓ | – | ✓ | – | – |
| dismiss 成功 | – (report を local patch) | ✓ | – | – | – | – |
| dismiss 失敗 | – | ✓ | – | – | – | – |
| 設定変更 → 再 kick | bump | ✓ | ✓ | ✓ | – | – |
| フォルダ切替 / Load 失敗 (clear) | bump | – (clear 自体は無条件) | – | – | – | – |

- gen bump は「entries または判定条件が変わった」経路のみに置く。dismiss は判定条件を
  変えない (永続側で除外済み) ので bump しない = in-flight Check の結果とも矛盾しない
  (Check は Go 側で dismiss 除外済みの report を返すため、後着 report に dismiss 済み
  ペアが載ることは Go 保証。万一 dismiss IPC と Check が交差した場合も次回 kick で収束)。
- `useDuplicateCheck` は `useClassificationWatcher` 等と同様、orchestrator
  (`useClassification`) から folderRef / requestGenRef 相当を props で受ける。既存の
  `requestGenRef` とは **独立した** `dupGenRef` を持つ (Load の世代管理を汚染しない)。

---

## 9. エラーハンドリング

| ケース | 挙動 |
|--------|------|
| デコード失敗 / AVIF / 対象外拡張子 | 該当ファイルを `skipped` に入れ判定から除外。warn ログ。エラーにしない。 |
| キャッシュ index 読込失敗 (壊れた JSON) | index を捨てて全再計算。warn ログ。 |
| キャッシュ index 書込失敗 | 判定は続行 (report は返す)。warn ログ (次回また計算するだけ)。 |
| `CheckDuplicates` 自体の失敗 (フォルダ消失等) | フロントはログのみ、前回 report 保持 (D6)。 |
| `_duplicates.json` 読込失敗 | dismiss ゼロ扱い + warn ログ。 |
| `DismissDuplicatePair` 失敗 | error トースト「ダブり除外の保存に失敗しました (詳細はログ)」+ ログ。report 不変。 |

---

## 10. テスト

### 10.1 Go (`internal/imghash`)

- dHash 純関数: 生成画像 (単色 / グラデーション / 同一画像のリサイズ・JPEG 再エンコード
  相当) で「同一系は距離小 / 別画像は距離大」を pin。ビット順の回帰 pin
  (golden hash 値、algo リビジョンタグの実質的な守り)。
- (Phase 2) pHash 純関数: 同上の観点 + DCT を小さい既知行列に対する素朴実装
  (テスト内の別実装) と突き合わせ。
- ハミング距離: 既知ビットパターンで検証。
- ペア抽出: しきい値境界 (=, +1) / FileA < FileB 正規化 / dismiss 除外。
- キャッシュ: mtime/size 一致で decode が呼ばれない (decode 関数を DI してカウント) /
  不一致で再計算 / algo リビジョンタグ不一致で全捨て / algo 別パス分離 (dhash index が
  phash Check に使われない) / 消えた filename の drop。
- dismiss repository: 追記 / 冪等 / 壊れ JSON 寛容 / atomic write / 無順序ペア正規化 /
  **1 dismiss で両 algo エントリが書かれる** / Check の除外が選択中 algo のみ参照する。
- 入力検証: `DeleteImage` と同等の traversal 拒否。
- `internal/imgdecode` 移設: thumb の既存テストが回帰しないこと + 移設後の export 面のテスト。
- settings: 新 field の per-field fallback / clamp (既存 settings_test.go の流儀)。

### 10.2 vitest

- バッジ対象集合の純関数 (`report.pairs` → `Set<filename>`): 空 / 複数ペア / 同一ファイルが
  複数ペアに出るケース。
- dismiss 後の local 除去純関数 (ペア除去 + バッジ集合再計算 + 「ペアが尽きたらモーダル閉」判定)。
- `useDuplicateCheck` を renderHook + IPC mock で: gen gate (後着 stale report 破棄) /
  folder gate / mode off で kick しない / `resetEntriesDependentState` 相当で clear
  (#110 B の `useAutoSaveQueue` テストと同じ流儀)。
- D-1 同値テスト: `duplicateDetect.ts` の定数 ("auto"/"off" / 既定しきい値。Phase 2 で "dhash"/"phash" 追加) が Go 側と一致。

### 10.3 手動 (wails dev / 可能なら Windows 実機)

- 同一画像をコピー + リサイズ版 + JPEG 再保存版を置いたフォルダでバッジが出る。
- 無関係な画像同士にバッジが出ない (既定しきい値 5)。
- 確認モーダルでペアと距離が見え、「ダブりではない」でバッジが消える。
- 再読み込み / アプリ再起動 / ファイル rename 後も dismiss が維持される。
- しきい値を 0 に下げると再エンコード版が候補から外れる / 上げると復活する。
- (Phase 2) アルゴリズムを pHash に切り替えると再判定が走り、dismiss 済みペアが **復活しない**。
  dHash に戻しても再計算が走らない (キャッシュ温存の確認、ログで確認)。
- `off` にするとバッジが消え、フォルダを開き直しても Check IPC が走らない (ログで確認)。
- 大きめフォルダ (数百枚) で初回オープンが操作をブロックしない / 2 回目が速い。
- watcher on で外部から画像追加 → 自動反映後にバッジが追従する。dismiss 実行で
  watcher の再読み込みループが **起きない** (`_duplicates.json` 無反応の確認)。

---

## 11. Out of scope

- **フォルダ横断のダブり検出** (別フォルダ間の比較): v1 は一覧タブの現在フォルダ内のみ。
- **回転 / 反転 / クロップ耐性** (回転正規化等): dHash / pHash とも素の耐性のみ (両者共通の弱点)。
- **並べて拡大比較する専用 UI**: 確認モーダルはサムネ + ファイル名まで。詳細比較はビューアで。
- **自動削除 / 自動整理**: 警告表示のみ。削除は既存の削除フローで。
- **検出進捗のバナー / スピナー UI**: Phase 1 はバックグラウンド完結。
- **ビューアタブへのバッジ表示**: 一覧タブのみ。
- **orphans の判定**: disk に無いファイルはハッシュを計算できない。
- i18n (#16 / #83 で別途)。

---

## 12. Phase 分割

### Phase 1 (本 PR、dHash のみ)

1. `internal/imgdecode` 移設 (thumb リファクタ、単独 commit)
2. `internal/imghash` (dHash / 距離 / algo 別キャッシュ / dismiss repo / Service) +
   settings 追加 (`duplicateDetectMode` / `duplicateThreshold`)
3. IPC 2 本 + `useDuplicateCheck` (同期モデル実装) + Card バッジ + 確認モーダル + 設定 UI
   (mode / しきい値)

Phase 1 の内部 algo は dhash 固定だが、**キャッシュパス / dismiss スキーマ / Service の
シグネチャは algo をパラメータとして敷いておく** (Phase 2 が additive で乗るように)。

### Phase 2 (別ブランチ / 別 PR、pHash + 切替)

- pHash 実装 (32×32 → DCT-II → 低周波 8×8) + golden テスト
- settings `duplicateHashAlgo` + 設定 UI segment
- dismiss の全 algo 同時記録 + legacy 単 algo 記録ペアの cross-algo 照合 (§7.2)
- 着手時に本 spec を改訂 (改訂履歴に追記) してから実装

将来 (別 issue 化候補): フォルダ横断 / 進捗 UI / バルク dismiss / 回転・反転正規化。

---

## 13. 決定事項 (レビューで合意を取る論点)

| § | 論点 | 推奨案 |
|---|------|--------|
| D1 | ハッシュアルゴリズム | **dHash / pHash の両実装 + 設定 `duplicateHashAlgo` で切替** (ユーザー指示で確定)。既定は **dHash**。実装は **Phase 1 = dHash のみ (本 PR) / Phase 2 = pHash + 切替 (別ブランチ)** に分割 (ユーザー指示、§12)。キャッシュは algo 別パス (§7.3)、dismiss は algo フィールド付き記録 (§7.2) で Phase 1 から切替前提の形式にしておく。 |
| D2 | しきい値 | 既定 **5** (0〜16 clamp)。設定で変更可 (issue コメント要件)。**両 algo 共通の 1 値** (algo 別しきい値は複雑さに見合わず。感度が合わなければユーザーが調整)。 |
| D3 | 判定対象 | **一覧の表示 entry と同じ集合** (フロントが filename 一覧を渡す)。orphans / AVIF / デコード失敗は対象外。 |
| D4 | 検出タイミング | Load 成功後 + watcher 反映後 + しきい値 / mode 変更後に自動 (mode=auto 時)。手動トリガボタンは設けない。 |
| D5 | dismiss の保存先とキー | フォルダ直下 `_duplicates.json`、**ハッシュ値の無順序ペア** キー (rename 耐性)。mtime 楽観ロックなし (last-write-wins)。 |
| D6 | 検出失敗時の UX | トーストなし・ログのみ (補助機能のため)。dismiss 失敗のみ error トースト。 |
| D7 | ハッシュキャッシュ | フォルダ単位 JSON index (`cache/duphash/`)、`mtime+size` 無効化、`algo` バンプで全捨て。 |
| D8 | 並行数 | 既定 `runtime.NumCPU()/2` (最低 1) の専用 worker pool。サムネの pool とは独立 (相互にブロックしない)。専用設定は設けず thumb と同じ auto 式を使う。 |
| D9 | 既定 mode | **`auto`**。初回オープンのデコードコストはキャッシュで 1 回きりのため。重いと感じたら off にできる。 |

レビュー確認事項:

- D1: 両実装は確定 (ユーザー指示)。**既定を dHash とする**ことの確認のみ。
- D2: 既定しきい値 5 / 上限 16 / 両 algo 共通 1 値の感覚が合うか。
- D5: フォルダ直下に `_duplicates.json` が増えることの許容 (sidecar が 2 ファイルになる)。
  嫌なら UserConfigDir 案に倒すが、キャッシュ消去・フォルダ移動で dismiss が迷子になる。
- D9: 既定 auto / off どちらにするか。

---

## 14. 実装スコープ予測

| ファイル | 変更内容 |
|---------|---------|
| `internal/imgdecode/decode.go` (新規、thumb から移設) | `Decode(path, ext) (image.Image, error)` |
| `internal/thumb/` | decode.go 削除 + imgdecode 参照へ差し替え |
| `internal/imghash/` (新規) | dHash / 距離 / キャッシュ index / dismiss repo / `Service.Check` / `Service.Dismiss` / worker pool (pHash は Phase 2) |
| `internal/settings/settings.go` | `DuplicateDetectMode` / `DuplicateThreshold` (additive + 検証) |
| `app.go` | `CheckDuplicates` / `DismissDuplicatePair` 薄い委譲 |
| `frontend/src/features/classification/useDuplicateCheck.ts` (新規) | 検出 kick / gate / report state / dismiss (§8) |
| `frontend/src/features/classification/duplicateBadge.ts` (新規) | バッジ集合 / dismiss 除去の純関数 (vitest 対象) |
| `frontend/src/features/classification/DuplicatePairsModal.tsx` (新規) | 確認モーダル |
| `frontend/src/features/classification/Card.tsx` | ⚠ バッジ (`.cls-card-dup-warn`) |
| `frontend/src/features/classification/CardContextMenu.tsx` | 「ダブり候補を確認…」項目 |
| `frontend/src/features/classification/useClassification.ts` | `resetEntriesDependentState` に report clear 追加 + 子フック配線 |
| `frontend/src/features/settings/` | 一覧セクションに mode segment + しきい値入力 (algo segment は Phase 2) |
| `frontend/src/features/settings/duplicateDetect.ts` (新規) | D-1 共通定数 (mode / 既定しきい値、watchMode.ts と同流儀。algo 定数は Phase 2) |
| `frontend/src/shared/icons/WarnIcon.tsx` (新規) | ⚠ インライン SVG |
| `frontend/src/App.css` | `.cls-card-dup-warn` ほか新規クラス |

- `.claude/context.md` / `docs/todo.md`: パッケージ境界 (§11) / H 節に追従 1 行ずつ。

---

## 15. 参考 (実装着手時に必ず読む)

- [AGENTS.md](../AGENTS.md): H-8 (本 spec §8 が着手前マトリクス) / H-1 (バッジ・モーダルの a11y) /
  H-2 (バッジ click の stopPropagation) / H-4 (`.cls-card-dup-warn` の実在確認) /
  D-1 (mode 文字列・既定値の Go/TS pin) / B-1 (参照型 export 禁止)
- [docs/spec-folder-watch.md](spec-folder-watch.md): watcher の対象判定 (`_duplicates.json`
  無反応の確認に必要) + gen/folder gate の先行実装
- [docs/spec-thumbnail.md](spec-thumbnail.md): キャッシュキー / シャーディング / worker pool の先行流儀
- [docs/spec-classification.md](spec-classification.md): sidecar atomic write の先行流儀
- [docs/spec-avif-support.md](spec-avif-support.md): AVIF を Go でデコードしない確定方針 (skip の根拠)
- 関連 issue: [#136](https://github.com/maretol/image-observer/issues/136)
