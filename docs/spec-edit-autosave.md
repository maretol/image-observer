# タグ・note 入力のフォーカス離脱時 auto-save 実装仕様書 (#105)

統合モーダル (SampleModal + SampleEditPane, #93) の編集ペインで、タグ入力 / note 入力 / confidence radio の変更を **フォーカス離脱 (blur) のタイミングで自動保存** できるようにする。現状の明示保存 (保存ボタン / Cmd+Ctrl+Enter) も設定で残せるようにし、ユーザーが切り替え可能にする。

> **ステータス**: §10 ユーザー合意済み (2026-05-29)、PR #109 で Phase 1 実装済み。

---

## 0. 改訂履歴

| 日付 | ラウンド | 主な変更 |
|------|---------|---------|
| 2026-05-29 | 初版 | issue #105 の要件整理 + 設計判断 (§10-A〜E) を提示。Phase 1 は新 settings フィールド + SampleEditPane の auto-save 経路 + ListSection UI 追加。 |
| 2026-05-29 | ユーザー合意 | §10-A〜E すべて推奨案 (A 案) で確定。実装着手 (PR #109)。 |
| 2026-05-29 | PR #109 レビュー対応 | runSave の dequeue を `onSaveRef` + `setTimeout(0)` で stale closure / batched render を回避 (§5.3 更新)。save-on-unmount cleanup を unmount 限定 + refs 参照に変更し entry オブジェクト churn での重複保存を回避 (§5.6 更新)。 |
| 2026-05-29 | PR #109 レビュー対応 round 2 | baseline reset useEffect を per-field 化し、partial save (entry.folder のみ変化) で未 blur の note / confidence 入力が消える問題を修正 (§6 追記)。`useClassificationEdit.saveEdit` を `loadResultRef.current.mtime` ベースに変更し、unmount 後の queue replay でも最新 mtime で IPC 発火するようにした (§5.3 / §5.6 補足)。 |

---

## 1. ゴール (DoD)

- 統合モーダル (SampleModal) 内の編集ペインで、以下のいずれかが発生したら自動保存される (auto モード時、§3):
  - タグ入力 (chip-input の `<input>`) が blur した
  - note 入力 (`<textarea>`) が blur した
  - confidence radio の選択が変化した (radio は blur 概念なし、change で即時)
- 設定値で auto / manual を切り替えられる:
  - `settings.editAutoSave: boolean`、**デフォルト `true`**
  - manual モードは現状仕様 (明示保存 = 保存ボタン or Cmd/Ctrl+Enter) と完全一致
- auto モードでは編集ペインの **「保存」「キャンセル」ボタンを非表示**
- 既存の保存失敗経路 (conflict / mergePrompt / `CONFLICT:` プレフィクス) と prev/next nav 抑止 (#93 spec §5.4) は **そのまま機能**
- `tsc --noEmit` クリア、`go test ./...` 通過、`vitest` 全通過、`wails dev` で手動動作確認

## 2. 用語

| 用語 | 意味 |
|------|------|
| **auto モード** | `settings.editAutoSave === true`。本仕様で追加する自動保存モード。 |
| **manual モード** | `settings.editAutoSave === false`。現状仕様 (明示保存) を温存。 |
| **blur 単位** | 個別入力 (`TagInput` の chip-input `<input>` / `<textarea>`) が個別に blur した瞬間。pane 全体 (group) からのフォーカス離脱では**ない**。 |
| **dirty** | `computeEditDirty` (既存) が true を返す状態 = フォームが entry の baseline と差分を持つ。 |

## 3. アーキテクチャ概観

```
[Settings: editAutoSave true/false]
       │
       ▼
ClassificationView ─ useSettings → SampleModal → SampleEditPane
                                                       │
       ┌───────────────────────────────────────────────┴──┐
       ▼ (auto)                                           ▼ (manual)
タグ blur / note blur / radio change                  保存ボタン / Cmd+Enter
   → if dirty → onSave(entry)                            → if dirty → onSave(entry)
   保存/キャンセルボタン非表示                             保存/キャンセルボタン表示 (現状)
```

state ownership は #93 spec §3 を継承:
- フォーム値 (tags / confidence / note) は `SampleEditPane` の local state
- baseline / mtime は `useClassification.loadResult` を一次ソース
- 保存処理は `useClassificationEdit.saveEdit` (既存) で gen bump + folder check 含む

## 4. データモデル

### 4.1 settings schema 拡張

`internal/settings/settings.go` の `SettingsData` に **1 フィールド追加**。schema version は **v1 のまま** (per-field fallback で対応、§7)。

```go
type SettingsData struct {
    // 既存フィールド ...
    EditAutoSave bool `json:"editAutoSave"`
}
```

- 既定値: `true` (issue #105 の要件「デフォルトは auto」)
- 検証: bool に対する Validate は無し。`applyFieldDefaults` も bool の不正値 (json 上で boolean 以外) は decoder が弾くので明示処理は不要。**ただし JSON にフィールド自体が無い (旧 build からのアップグレード) ケースは Go の zero value で `false` になる** → これだと「旧 build からの移行で勝手に manual モードになる」UX バグを生むので、§7.2 の仕掛けで「フィールド欠落 = true」を実装する。

bool ではなく enum (`"auto" | "manual"`) にする選択肢もあるが、現状の要件が binary であること / D-1 ドリフトのリスクが無いこと / TS 側で `boolean` がそのまま使える簡潔さから **bool 採用**。将来的に「debounced auto / on-close auto」のような第 3 モードが出てきたら enum 化を検討 (§10-A 代替案)。

### 4.2 state schema / IPC

変更なし。saveEdit の signature / loadResult の形状ともに既存通り。

## 5. UI / 操作

### 5.1 編集ペインの分岐 (SampleEditPane)

SampleEditPane に `autoSave: boolean` prop を追加。`SampleModal` 経由で `useSettings().data.editAutoSave` を渡す。

#### 5.1.1 auto モード時の挙動

- **保存ボタン / キャンセルボタンを非表示** (DOM から外す、disabled では不可 — 矛盾する UI を見せない)
- **タグ入力 blur**: TagInput の内部 `commit(draft)` 実行後に親へ onBlur 通知 → SampleEditPane は dirty なら `onSave(entry)`
- **note 入力 blur**: textarea の onBlur で dirty なら `onSave(entry)`
- **confidence radio change**: onChange で新しい value をローカル state に反映 → 直後に dirty なら `onSave(entry)`
- **Cmd/Ctrl+Enter ショートカット**: 残す (auto モードで無効化しても害がないが、`dirty && entry` 条件は既存ロジックで満たさなくなる場合が多い)

#### 5.1.2 manual モード時の挙動

現状仕様と完全一致 (§9 で何も変更しない):
- 保存ボタン / キャンセルボタン表示
- Cmd/Ctrl+Enter で保存
- blur / change では何もしない

### 5.2 タグ入力 blur と draft commit の順序

`TagInput` は現状 `<input onBlur={() => commit(draft)}>` で draft 文字列を chip にコミットしている。auto-save はこの commit の **後** に発火する必要がある (commit で確定したタグも含めて保存したい)。

設計:

```ts
// TagInput.tsx: 新 prop onBlur を追加し、内部 commit 後に呼ぶ
type TagInputProps = {
  // 既存 ...
  onBlur?: () => void;  // 内部 commit(draft) の後に同期で呼ばれる
};

const onInputBlur = () => {
  commit(draft);  // 既存: setDraft("") + onChange([...tags, v])
  onBlur?.();
};
```

- `commit()` は synchronous で `onChange(next)` を呼ぶ。
- React の `setState` は batch されるが、関数の引数値 `next` は同期的に親へ渡る。
- 親 (SampleEditPane) で `onChange` を wrap して `tagsRef.current = next` を同期更新すれば、続く `onBlur` callback 内で `tagsRef.current` を読んで最新タグを得られる。

SampleEditPane 側:

```ts
const tagsRef = useRef<string[]>(tags);
const handleTagsChange = useCallback((next: string[]) => {
  tagsRef.current = next;
  setTags(next);
}, []);

const handleTagInputBlur = useCallback(() => {
  if (!autoSave || !entry) return;
  // dirty 判定は最新値で。tagsRef.current は commit 後の最終値。
  if (!computeEditDirty(entry, tagsRef.current, confidence, note)) return;
  performAutoSave(tagsRef.current, confidence, note);
}, [autoSave, entry, confidence, note]);

<TagInput
  tags={tags}
  onChange={handleTagsChange}
  onBlur={handleTagInputBlur}
  // ...
/>
```

### 5.3 保存の直列化 (in-flight queue)

タグ blur → note blur のように **連続して blur が発生**すると、1 回目の保存 IPC が in-flight の間に 2 回目が呼ばれ、2 回目は古い `loadResult.mtime` を読んでしまう (saveEdit 内で `await UpdateClassificationEntry(cur, entry, loadResult.mtime)` の `loadResult.mtime` は call 時点で capture される)。これは mtime 不一致 → `CONFLICT:` プレフィクスのエラーになる。

対策: SampleEditPane に in-flight 直列化を入れる。

```ts
const saveInFlightRef = useRef(false);
const queuedSnapshotRef = useRef<Snapshot | null>(null);

const performAutoSave = (tags, confidence, note) => {
  const snap = { tags, confidence, note };
  if (saveInFlightRef.current) {
    queuedSnapshotRef.current = snap;  // 最新の snapshot で上書き
    return;
  }
  saveInFlightRef.current = true;
  const entryOut = classification.Entry.createFrom({
    filename: entry.filename,
    folder: serializeTags(snap.tags),
    confidence: snap.confidence,
    note: snap.note,
  });
  Promise.resolve(onSave(entryOut)).finally(() => {
    saveInFlightRef.current = false;
    if (queuedSnapshotRef.current) {
      const next = queuedSnapshotRef.current;
      queuedSnapshotRef.current = null;
      performAutoSave(next.tags, next.confidence, next.note);
    }
  });
};
```

- `onSave` (= `ClassificationView.handleSave`) は `async` で Promise を返すが、現状の型定義上は `(next: Entry) => void`。**`onSave` の戻り値を `void | Promise<void>` に緩めて** SampleEditPane 側で `Promise.resolve(...).finally(...)` する。non-Promise を返した場合も `Promise.resolve(undefined)` が即解決して同じ流れに乗る。
- queue は 1 段 (最新で上書き)。3 連続 blur でも IPC は最大 2 回 (in-flight 1 + queued 1)。
- entry が switch (prev/next) した場合は queue を破棄する経路を `useEffect` で挟む (`entry?.filename` change → `queuedSnapshotRef.current = null`)。

**stale closure 回避** (PR #109 round 1 で訂正):

上の素朴な再帰では、`runSave` の `useCallback` 依存に `onSave` を入れても、**`finally` の closure が握っているのは "前回 commit 時点の `onSave`"** で、1 回目の save の `setLoadResult` がまだ commit されていないタイミングで dequeue → 2 回目の `onSave` 経由 `saveEdit` が古い `loadResult.mtime` を読む → CONFLICT。対策は 2 段:

1. **`onSaveRef` を render-time sync** (`onSaveRef.current = onSave` を render 中に書く、useEffect 経由は遅すぎる)。`runSave` は依存から `onSave` を外し、内部で `onSaveRef.current(...)` を呼ぶ。
2. **dequeue を `setTimeout(0)` でマクロタスクに defer**。`finally` は in-flight save の resolution と同じマイクロタスクで走るため、`setLoadResult` の commit がまだ。マクロタスクまで遅らせれば commit → re-render → render-time sync → `onSaveRef.current` 最新化 → 次の save が最新 mtime を読める。

AGENTS.md H-8「state ref の同期タイミング」と同じ理屈で、ref を render-time に書き、async path はその ref を読む。

**round 2 補強** (`saveEdit` 側の mtime 参照): SampleEditPane が **unmount** 済みのとき、cleanup から queue に積まれた snapshot が後で setTimeout でリプレイされる経路では、unmount 後に再 render は走らないため `onSaveRef.current` が更新されない。`onSaveRef.current` が握っている `handleSave` → `saveEdit` の closure はどちらも save が in-flight だった時点のもので、`saveEdit` の `loadResult.mtime` は古い (= save 前の値)。これだと unmount 時の追加 save がまた CONFLICT を踏む。

対策: `useClassificationEdit.saveEdit` を `loadResult` prop 直参照ではなく `loadResultRef.current` 経由に変更。`loadResultRef` は `useClassification.ts:338` で render-time sync されており、ClassificationView が re-render するたびに最新 mtime を保持する (SampleEditPane が unmount しても ClassificationView は生きているので、ref は更新され続ける)。OLD `saveEdit` クロージャでも call 時に最新 mtime を読めるので、unmount 後の replay でも CONFLICT を踏まない。

### 5.4 manual モードでの merge prompt / conflict との関係

saveEdit が conflict を返したら既存の ConflictDialog が出る (= `useClassificationEdit` の経路は同じ)。auto モードでも:

- conflict 検知 → ConflictDialog 表示
- ユーザーが「再読込」「強制上書き」「キャンセル」を選ぶ
- 強制上書き選択時は `resolveConflictForce` 経由で再保存 (既存)
- 再保存中に新たな blur が発生しても in-flight queue で直列化される

### 5.5 prev/next nav 抑止 (#93 §5.4) との関係

SampleModal の `editDirty` 経由 nav 抑止は **そのまま機能**。auto モードでは:

- typing 中 → dirty=true → nav 抑止
- blur 直後 → save IPC 発火 → 楽観的に setLoadResult が走り baseline 更新 → dirty=false → nav 復帰

ただし save が in-flight の間も dirty 状態の見え方は実装による:
- `dirty` は entry.folder 等の baseline と local tags の比較で算出
- save 完了で `setLoadResult` が patched entry に更新 → 次の render で `entry.folder` が新 baseline → `dirty=false`

つまり save in-flight 中は **dirty=true のまま** で nav 抑止が継続する。これは正しい挙動 (まだディスクに反映されていない)。

### 5.6 モーダル close 時の未保存ハンドリング

§10-B 決定事項参照。**推奨案 = 「auto モードでは閉じる前に最終 save を試みる」**。具体的には:

- × ボタン / Esc / バックドロップクリックで close が起きた時、auto モードかつ dirty なら `onSave(entry)` を 1 回発火してから close する
- IPC は fire-and-forget (close 動作はブロックしない)
- 失敗時の conflict ダイアログは modal close 後の親階層で表示される (既存経路がそのまま動く)

manual モードは現状通り「未保存破棄 (確認なし)」。

**実装上の落とし穴** (PR #109 round 1 で訂正): SampleEditPane の cleanup を `useEffect(..., [autoSave, entry, runSave])` で書くと、prop が変わる**たび** (典型的には save 成功 → 親 `setLoadResult` → `entry` オブジェクト再生成 → SampleEditPane に新 prop) に cleanup が発火する。cleanup 内の `entry` クロージャは古いまま (前回 effect 起動時の `entry`) なので、refs (= ユーザー最新入力) と古い baseline を比較して **dirty 判定が常に立ち**、保存成功直後にもう 1 回 save が走る。

対策: cleanup は **unmount 限定** (`useEffect(..., [])`) にして、内部で参照する `autoSave` / `entry` / `runSave` をすべて render-time sync の ref 経由 (`autoSaveRef.current` / `entryRef.current`) で読む。これで:

- prev/next nav は SampleModal の nav-block invariant により dirty=false 時しか発生しない → unmount せず entry switch する経路では cleanup が発火しないので問題なし。
- 実 unmount (Esc / × / 親の list タブ unmount) でのみ cleanup が走り、その時点での最新 entryRef + refs を比較。直前に save 成功していれば refs == baseline で `computeEditDirty=false` → 余計な save なし。
- 入力中の unmount (Esc で typing 途中 close) は dirty=true なので save 発火、ユーザー編集を救う本来の意図が動く。

### 5.7 アクセシビリティ

- 保存ボタン非表示の状態でも、編集ペイン全体の `role="group"` + `aria-label="編集"` は維持
- 「未保存の変更があります」バッジ (`sample-modal-dirty-badge`) は auto モードでも残す:
  - typing 中の短時間だが、blur で消える視覚フィードバックとして有用
- Cmd/Ctrl+Enter ショートカットの hint は manual モードでのみ「保存」ボタン tooltip に出る (auto モードは button 自体が無い)

## 6. 状態管理 / フック

### 6.0 baseline reset の per-field 化 (PR #109 round 2)

`SampleEditPane` 内の baseline reset useEffect (deps `[entry]`) は、初版では「baseline の **いずれかのフィールド** が変わったら **全フィールド** を新 baseline に reset」していた。これだと auto-save 成功 → 親 `setLoadResult` → 新 `entry` (タグだけ patched、note / confidence は不変) → effect 再発火 → note / confidence も「同値の」新 baseline に reset、というだけなら問題なく見える。

しかし「タグの save が in-flight の間に user が note を入力する」と:

1. user タグ入力 → blur → save IPC 発火 (`saveEdit({...tags: ["alice", "bob"]})`)
2. save 完了前に user が note 欄に "メモ" と入力 → `noteRef.current = "メモ"`, `setNote("メモ")` 反映
3. save 完了 → 親 `setLoadResult` (新 entry.folder = serialize(["alice", "bob"])、entry.note = "" のまま)
4. 新 `entry` オブジェクト → SampleEditPane の baseline reset effect が再発火
5. 旧版実装: 全フィールド reset → `setNote("")`, `noteRef.current = ""` で **user の "メモ" 入力が消失**

対策: per-field 同期に変更。

- **filename 変化 (prev/next nav)**: 全フィールド reset (これは別 entry なので local 編集は持ち越し対象外)。nav は dirty=false 時しか許されないので、未保存 local edits が失われる経路は実質発生しない。
- **同一 filename 下の baseline patch**: 各フィールド独立に「local が **旧** baseline と一致しているか」をチェック:
  - 一致: user は当該フィールドをまだ触っていない → 新 baseline に同期 (= disk truth に追従)
  - 不一致: user が当該フィールドを編集中 → local を保持 (in-flight typing を尊重)
- どちらの分岐でも `lastBaselineRef` は **新 baseline で更新** する。これを忘れると、user が後で偶然 *元の* baseline に戻したときに再び per-field 同期が走ってしまう。

### 6.1 useSettings の利用

ClassificationView で既に `useSettings` を消費している (multiSelectMode / watchMode 等)。`data.editAutoSave` を SampleModal に渡す。

### 6.2 SampleModal の props 拡張

```ts
type SampleModalProps = {
  // 既存 ...
  autoSave: boolean;
};
```

子の SampleEditPane にそのまま forward。

### 6.3 SampleEditPane の props 拡張

```ts
type SampleEditPaneProps = {
  // 既存 ...
  autoSave: boolean;
};
```

### 6.4 ClassificationView の handleSave

現状:
```ts
const handleSave = useCallback(
  async (entry: classification.Entry) => {
    await saveEdit(entry);
    openEdit(entry.filename);  // legacy EditPopover の close→open blink 用
  },
  [saveEdit, openEdit],
);
```

`openEdit(entry.filename)` の意図 (#93 spec §6.1) は「保存後もモーダルを開いたまま」を実現するためのもの。auto モードでは save が頻発するので、これが毎回呼ばれても問題ない (`setEditing({open:true, filename:...})` は冪等)。**変更不要**。

ただし `onSave` の型定義を `(entry) => void | Promise<void>` に緩め、SampleEditPane が `.finally()` で in-flight ref を下ろせるようにする (§5.3)。

## 7. 永続化 / マイグレーション

### 7.1 settings.json 形式

```json
{
  "version": 1,
  "editAutoSave": true,
  ...
}
```

### 7.2 旧 build からのアップグレード時のフィールド欠落対策

Go の `encoding/json` は欠落フィールドを zero value (`false` for bool) で埋める。**これだと旧 build から上書きした際に勝手に manual モードになる**。対策:

`SettingsData` の bool フィールドを **`*bool` (ポインタ) ではなく**、`applyFieldDefaults` 側で「JSON マーシャル前にラップ済み bool かどうか」を区別する仕掛けを使う。

具体実装としては、デコード時に **`map[string]json.RawMessage` で 1 段中継してフィールド存在を判定**するのは大袈裟。Go の慣用句で対応:

```go
// settings.go
type rawSettings struct {
    Version       int   `json:"version"`
    EditAutoSave  *bool `json:"editAutoSave,omitempty"`  // ポインタで nil = 欠落判定
    // 他は SettingsData と同じ
}

func Load() SettingsData {
    // ...
    var raw rawSettings
    json.Unmarshal(data, &raw)
    s := SettingsData{
        Version:      raw.Version,
        EditAutoSave: derefBoolOr(raw.EditAutoSave, true),  // nil → true
        // ...
    }
}
```

ただしこれだと既存全フィールドの decoding ロジックが重複する。**より簡潔な選択肢**:

`SettingsData.EditAutoSave` を bool のまま保ち、Load の処理を `map[string]json.RawMessage` 経由に変えずに、**JSON にこのキーが含まれるかだけ別途チェック**:

```go
func Load() SettingsData {
    // ... 既存
    var s SettingsData
    if err := json.Unmarshal(data, &s); err != nil { ... }

    // Per-field fallback: editAutoSave がキーとして存在するかを raw な map で確認
    var probe map[string]json.RawMessage
    json.Unmarshal(data, &probe)
    if _, ok := probe["editAutoSave"]; !ok {
        s.EditAutoSave = true  // missing → default true
    }
    // ...
}
```

**最終案**: 上記の probe 方式を採用。`SettingsData` は bool のまま、Load 内に `editAutoSave` キー存在チェックを足す。コストは Unmarshal 2 回だがファイル数 KB なので無視できる。Save 側は `omitempty` 無しの普通の `bool` を書く (= 常に key が存在 → 次回 Load では default 補填経路に乗らない)。

§10-D に「ポインタ方式 vs probe 方式」の判断を残す。

### 7.3 マイグレーション

schema version v1 のまま (= 既存 settings.json をそのまま read)。フィールド欠落は §7.2 の仕掛けで `true` (auto) として扱う。

## 8. テスト

### 8.1 Go 側 (`internal/settings/settings_test.go`)

新規ケース追加:

1. `TestEditAutoSave_DefaultIsTrue`: `DefaultSettings().EditAutoSave == true`
2. `TestEditAutoSave_RoundTrip`: Save(false) → Load → false が返る
3. `TestEditAutoSave_MissingFieldDefaultsToTrue`: 旧 settings.json (フィールド無し) を書いて Load、editAutoSave が true
4. `TestEditAutoSave_ExplicitFalse_Preserved`: `{"editAutoSave": false}` を含む settings を Load して false が保持される

`Validate` は bool に対しては何もしないので追加テストなし。

### 8.2 TS 側

#### 8.2.1 既存純関数のテスト (変更なし)

- `sampleEditDirty.test.ts`: `computeEditDirty` ロジックは不変

#### 8.2.2 新規ヘルパ (推奨抽出)

SampleEditPane 内の「auto-save 発火判定」をテストしやすくするため、純関数として抽出する案:

```ts
// autoSaveTrigger.ts
// 引数: autoSave モード / dirty / entry の有無
// 戻り値: 保存を実行するべきか
export function shouldAutoSave(
  autoSave: boolean,
  entry: classification.Entry | null,
  dirty: boolean,
): boolean {
  return autoSave && entry !== null && dirty;
}
```

`autoSaveTrigger.test.ts` で truth table を網羅 (4 ケース)。

#### 8.2.3 SampleEditPane 統合テスト

vitest + Testing Library を使う場合に限り (現状リポジトリは DOM テスト未導入。CLAUDE.md §5 参照)。

**今回は導入しない方針**: 既存と同様、純関数 (`shouldAutoSave` / `computeEditDirty`) をユニットテストで担保し、UI 統合は手動確認に任せる。DOM テスト基盤 (happy-dom / RTL) の追加は別 issue で扱う。

### 8.3 手動確認 (wails dev)

- 設定ダイアログを開き、一覧タブセクションに「タグ・note の保存方法」が表示される
- デフォルトで「自動 (フォーカス離脱時)」が選択されている
- auto モードで:
  - タグを入力 → Tab → 即保存される (一覧の Card にも反映)
  - note を入力 → クリック outside → 即保存される
  - confidence radio を選択 → 即保存される
  - 保存ボタン / キャンセルボタンが表示されない
  - 保存中バッジ (`●`) が短時間表示される
  - prev/next ナビは保存完了後すぐ復帰
  - Esc / × / バックドロップで close した時に未保存ぶんも保存される
- manual モードに切り替え → 保存ボタン / キャンセルボタンが表示される / blur で保存されない / Cmd+Ctrl+Enter で保存される
- 外部から sidecar を書き換えて conflict 経路を発火 → ConflictDialog が出る (auto / manual いずれでも)

## 9. Out of scope (Phase 1)

- debounce による「タイピング中の自動保存」(blur のみで発火する案を維持)
- 「N 秒触っていなければ自動保存」のような idle timer
- 編集ペインの hover / focus に応じた UI ヒント (「保存中…」「保存済み」アイコン)
- 設定 UI に「auto モード時の Esc 時挙動」サブオプション (現状は §10-B 案で確定)
- enum 化 (`"auto" | "debounced" | "manual"`) — bool で実装し、必要になったら別 issue

## 10. 決定事項 (要合意)

ユーザー合意後に各項目を確定する。**推奨案**を A 案として記載するが、redirect 可能。

### 10-A. setting の型 (bool vs enum)

- **A 案 (推奨)**: bool `editAutoSave`, デフォルト true。binary な要件に対し最小。D-1 ドリフトリスクなし。
- B 案: enum `editSaveMode: "auto" | "manual"`, デフォルト "auto"。既存の watchMode / multiSelectMode と一貫。D-1 用 pinning test (`editSaveMode.ts`) 必要。
- 結論: 将来「debounced 3rd モード」が出るかどうかが分岐点。出る可能性が高ければ B 案で始めた方が後で楽。出る可能性が低ければ A 案で十分。

### 10-B. モーダル close 時の auto-save

- **A 案 (推奨)**: auto モードかつ dirty なら × / Esc / バックドロップで close する直前に save を 1 回発火 (fire-and-forget)。タイピング途中で誤って閉じた時のロスを防ぐ。
- B 案: close = 現状通り未保存破棄。auto モードでも blur 経由でしか保存しない。実装はシンプルだが、Esc で閉じたユーザーは「タイピング中のぶんは消える」前提を理解する必要あり。

### 10-C. confidence radio 変更時の保存タイミング

ユーザー合意済み (issue triage Q3 で「対象にする」):
- radio change → 即保存

実装上の細部:
- 保存ペイロードに含める confidence は `setConfidence(opt.value)` 前の `confidence` ではなく **新しい value** (`opt.value`) を使う必要がある。React の `setState` は async なので `setConfidence(opt.value); performAutoSave(tags, confidence, note);` だと古い値が渡る → `performAutoSave(tagsRef.current, opt.value, note)` のように引数で渡す。

### 10-D. 旧 settings.json アップグレード時の欠落対策

- **A 案 (推奨)**: probe 方式 (Load 内で `map[string]json.RawMessage` を別途 decode してキー存在判定)。`SettingsData` は普通の bool で保ち、他フィールドの decoding と整合する。
- B 案: `SettingsData.EditAutoSave` を `*bool` に。zero value 問題は消えるが、参照型になるため B-1 (mutable export) は問題なし (struct field なので) も、TS 側で `boolean | undefined` になり消費側で `?? true` の D-2 違反を引き起こす可能性。
- C 案: schema version を v2 に bump して旧 v1 はデフォルト (= auto モード) にリセット。他のフィールドも一緒に失われるので過剰。

### 10-E. SampleEditPane 内のヘルパ抽出

- **A 案 (推奨)**: `shouldAutoSave(autoSave, entry, dirty)` を `autoSaveTrigger.ts` として抽出してユニットテスト対象に。`computeEditDirty` と並べる。
- B 案: SampleEditPane 内に inline で残す。ロジックが trivial で抽出 overkill。

---

## 11. Phase 分割

### Phase 1 (本 spec)

- `internal/settings` に `EditAutoSave bool` 追加 + per-field fallback (§7.2) + テスト 4 ケース
- `SampleEditPane.tsx` の auto-save 経路実装 + ボタン非表示分岐 + in-flight 直列化
- `TagInput.tsx` に `onBlur` prop 追加 (commit 後発火)
- `SampleModal.tsx` で `autoSave` prop を forward
- `ClassificationView.tsx` で `useSettings().data.editAutoSave` を読み出して SampleModal に渡す
- `ListSection.tsx` に「タグ・note の保存方法」segment を追加
- `shouldAutoSave` 純関数抽出 + `autoSaveTrigger.test.ts`
- 既存 spec `spec-sample-modal-edit.md` の §11 Phase 2 リストから "autosave" を除外し、本 spec への参照を追加 (改訂履歴 +1 行)
- `docs/todo.md` H 章に 1 行追記

### Phase 2 (別 issue で扱う場合)

- debounce 付き auto-save (typing 中も保存)
- 「保存中…」「保存済み」マイクロインジケータ
- 入力中の Esc に対する確認ダイアログ (auto モード)

## 12. 関連

- [docs/spec-sample-modal-edit.md](spec-sample-modal-edit.md) §10-C / §11: 統合モーダル Phase 1 で「明示保存固定」とした方針を本 spec で覆す
- [docs/todo.md](todo.md) §H: 1 行追記済み (Phase 1 着手前提)
- [AGENTS.md](../AGENTS.md) D-1: bool フィールドはドリフト無し / C-1: setState 直後の同期 DOM 操作は要注意 (§5.2 の commit→onBlur 順序が該当)
- 関連 issue: #93 (#102 マージ済み、SampleModal 統合 / SampleEditPane 新設) — 本 spec はその直接の続編
