import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { classification } from "../../../wailsjs/go/models";
import { shouldAutoSave } from "./autoSaveTrigger";
import { extractTags, serializeTags } from "./filters";
import {
  baselineOf,
  computeBaselineSync,
  EMPTY_BASELINE,
  type Baseline,
  type Touched,
} from "./sampleEditBaselineSync";
import { computeEditDirty } from "./sampleEditDirty";
import { editShortcutField, isTextEntryTarget } from "./modalEditShortcuts";
import { useAutoSaveQueue, type Snapshot } from "./useAutoSaveQueue";
import type { SaveContext } from "./useClassificationEdit";
import { TagInput } from "./TagInput";

const CONF_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "none" },
  { value: "high", label: "high" },
  { value: "mid", label: "mid" },
  { value: "low", label: "low" },
];

// TagInput 内の chip-input <input> を <label htmlFor> で指す。pane は modal 内で常に
// 単一 instance なので固定 global id で足りる。
const TAG_INPUT_ID = "sample-edit-pane-tags";

// confidence 見出し <div> の id。radiogroup の aria-labelledby から参照して SR に
// "confidence" を読ませる (radio は option ごとの <label> で包まれ単一 htmlFor で全部を
// 指せないので、見出しは <label htmlFor> にしていない)。
const CONF_GROUP_LABEL_ID = "sample-edit-pane-confidence-label";

export type SampleEditPaneProps = {
  // entry 非アクティブ時は null (preview 閉じ等)。pane は空 placeholder を出して layout を保つ。
  entry: classification.Entry | null;
  knownTags: string[];
  // SampleModal が openSource === "edit" 時の initialFocusRef として ModalShell に渡すため
  // 吸い上げる tag <input> ref (無いと最初の focusable = chip × / 閉じるアイコンに当たる)。
  tagInputRef?: RefObject<HTMLInputElement | null>;
  // 現在の folder (#110 C)。folderPropRef に render 同期され、save wrapper が dispatch 時に
  // 読んで各 save の SaveContext.folder にする。folder 切替は pane を unmount する (= この
  // prop が旧 folder のまま止まる) ので、save-on-unmount cleanup が旧 folder を刻み saveEdit
  // が skip できる (spec §6.2 / §4.2)。
  folder: string;
  // Promise を返せば pane が in-flight save を直列化し、tag-blur → note-blur の連鎖が
  // 同じ stale loadResult.mtime で IPC を 2 本積むのを防ぐ (spec-edit-autosave.md §5.3)。
  // ctx は save を capture した folder を運ぶ (#110 C)。
  onSave: (
    next: classification.Entry,
    ctx: SaveContext,
  ) => void | Promise<void>;
  // 未保存中に親 (SampleModal) が prev/next を無効化できるよう dirty を上げる (spec §5.4)。
  onDirtyChange?: (dirty: boolean) => void;
  // true で各 input の blur / radio 変更が auto-save し、保存/キャンセルボタンを隠す (#105)。
  autoSave: boolean;
};

export function SampleEditPane({
  entry,
  knownTags,
  tagInputRef,
  folder,
  onSave,
  onDirtyChange,
  autoSave,
}: SampleEditPaneProps) {
  const [tags, setTags] = useState<string[]>(() =>
    entry ? extractTags(entry.folder) : [],
  );
  const [confidence, setConfidence] = useState<string>(entry?.confidence ?? "");
  const [note, setNote] = useState<string>(entry?.note ?? "");

  // local state を ref にミラー (§5.2)。同期的な TagInput.onBlur が setState flush を待たず
  // commit 後のタグを読めるように。note blur も同様に noteRef を使う。
  const tagsRef = useRef<string[]>(tags);
  const confidenceRef = useRef<string>(confidence);
  const noteRef = useRef<string>(note);

  // 単キー focus ショートカット (#115) 用の DOM ref。confidenceGroupRef は radiogroup で、
  // checked radio (無ければ先頭) に focus する。上の string の noteRef (値保持) とは別物。
  const confidenceGroupRef = useRef<HTMLDivElement>(null);
  const noteFieldRef = useRef<HTMLTextAreaElement>(null);

  // render 時同期の prop ref (AGENTS.md H-8)。queue の finally (§5.3) と save-on-unmount
  // cleanup (§5.6) はトリガした render の *外* で発火するので、これらを useEffect deps 経由で
  // 読むと stale な onSave (= 古い saveEdit → 古い mtime → 2 本目 IPC で CONFLICT) を掴む。
  // render 時ミラーで、発火時には ref が最新 prop を反映していることを保証する。
  const onSaveRef = useRef(onSave);
  const autoSaveRef = useRef(autoSave);
  const entryRef = useRef(entry);
  // save wrapper が dispatch 時に読んで SaveContext.folder に刻む (#110 C)。render 時同期 —
  // folder 切替で pane が unmount し ref が旧 folder のまま止まるので、stale cleanup save が
  // 旧 folder を運ぶ。
  const folderPropRef = useRef(folder);
  onSaveRef.current = onSave;
  autoSaveRef.current = autoSave;
  entryRef.current = entry;
  folderPropRef.current = folder;

  // entry の *baseline* (filename, folder, confidence, note) が変わったら local フォームを
  // reset。前 baseline を lastBaselineRef に持って mismatch 時だけ reset することで、watcher
  // 由来の loadResult 更新 (フィールド不変の新 Entry オブジェクト) の churn を吸収し、
  // in-pane 入力を潰さない。
  const lastBaselineRef = useRef<Baseline>(EMPTY_BASELINE);

  // per-field の「直近 baseline 以降 touch したか」フラグ。in-flight save 中に touch した
  // フィールドは、最終値がたまたま *前* baseline と一致しても上書きしないようにする。
  // 例: baseline tags=[]、"abc" 入力して blur → save IPC in-flight → 戻る前に [] に戻す →
  // save 成功が folder="abc" で届く → touched 無しだと等価チェック (local [] == 旧 baseline [])
  // が local を ["abc"] に resync して revert を握り潰す。「未 touch」と「touch して revert」を区別。
  const touchedAfterBaselineRef = useRef<Touched>({
    tags: false,
    confidence: false,
    note: false,
  });

  useEffect(() => {
    if (!entry) {
      lastBaselineRef.current = EMPTY_BASELINE;
      setTags([]);
      tagsRef.current = [];
      setConfidence("");
      confidenceRef.current = "";
      setNote("");
      noteRef.current = "";
      touchedAfterBaselineRef.current = {
        tags: false,
        confidence: false,
        note: false,
      };
      return;
    }
    // entry あり: resetAll (別 filename = prev/next nav) vs per-field sync (同一 entry、
    // partial auto-save 成功や外部 sidecar 編集で baseline patch)。ルールは computeBaselineSync。
    const action = computeBaselineSync(
      lastBaselineRef.current,
      entry,
      {
        tags: tagsRef.current,
        confidence: confidenceRef.current,
        note: noteRef.current,
      },
      touchedAfterBaselineRef.current,
    );
    if (action.kind === "resetAll" || action.syncTags) {
      const nextTags = extractTags(entry.folder);
      setTags(nextTags);
      tagsRef.current = nextTags;
    }
    if (action.kind === "resetAll" || action.syncConfidence) {
      setConfidence(entry.confidence);
      confidenceRef.current = entry.confidence;
    }
    if (action.kind === "resetAll" || action.syncNote) {
      setNote(entry.note);
      noteRef.current = entry.note;
    }
    // local に保ったフィールドも含め baseline pointer は常に進める (次の diff を最新 entry と
    // 取るため)。touched も reset — touched 窓は連続する baseline 観測の間に限る。
    lastBaselineRef.current = baselineOf(entry);
    touchedAfterBaselineRef.current = {
      tags: false,
      confidence: false,
      note: false,
    };
  }, [entry]);

  // 最新 baseline との dirty 判定。タグ正規化の詳細は computeEditDirty (sampleEditDirty.ts) 参照。
  const dirty = useMemo(
    () => computeEditDirty(entry, tags, confidence, note),
    [entry, tags, confidence, note],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // in-flight save の直列化 (§5.3) は useAutoSaveQueue (#110 B)。buildEntry は Entry payload を
  // 形作るのでここに残す (queue は opaque な Snapshot しか見ない)。
  const buildEntry = useCallback((snap: Snapshot): classification.Entry => {
    return classification.Entry.createFrom({
      filename: snap.filename,
      folder: serializeTags(snap.tags),
      confidence: snap.confidence,
      note: snap.note,
    });
  }, []);

  // useAutoSaveQueue に渡す save wrapper。onSave を呼び出し時に ref 経由で読み、queue の
  // 再帰 dequeue が最新 handleSave (と最新 mtime) を拾う。静的キャプチャだと mtime が固まり
  // 2 本目 save が stale mtime → CONFLICT になる。
  const save = useCallback(
    (snap: Snapshot) =>
      Promise.resolve(
        onSaveRef.current(buildEntry(snap), { folder: folderPropRef.current }),
      ),
    [buildEntry],
  );

  const { runSave, resetQueue } = useAutoSaveQueue({ save });

  useEffect(() => {
    // active entry が変わったら queue 済み snapshot を捨てる — 旧 filename の snapshot を新 entry に
    // replay すると別レコードを潰す。in-flight save は旧 filename 用で旧 folder で完走させてよい
    // (saveEdit の folderRef check が state commit を gate する)。
    resetQueue();
  }, [entry?.filename, resetQueue]);

  // #105 の blur / radio ハンドラ用ゲート。最新値を ref から読み (commit 後タグ、override で
  // 渡された radio 値) React の batched setState と race しない。トリガしたフィールドは
  // override で明示、他は ref から。
  const performAutoSave = useCallback(
    (overrides: Partial<Omit<Snapshot, "filename">>) => {
      if (!entry) return;
      const snap: Snapshot = {
        filename: entry.filename,
        tags: overrides.tags ?? tagsRef.current,
        confidence: overrides.confidence ?? confidenceRef.current,
        note: overrides.note ?? noteRef.current,
      };
      // merged snapshot で dirty を再計算 (stale な dirty memo は radio 変更で 1 render 遅れる)。
      // 変更なし refocus で IPC を焼かない。
      const isDirty = computeEditDirty(
        entry,
        snap.tags,
        snap.confidence,
        snap.note,
      );
      if (!shouldAutoSave(autoSave, entry, isDirty)) return;
      runSave(snap);
    },
    [autoSave, entry, runSave],
  );

  const handleTagsChange = useCallback((next: string[]) => {
    tagsRef.current = next;
    touchedAfterBaselineRef.current.tags = true;
    setTags(next);
  }, []);

  const handleNoteChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      noteRef.current = v;
      touchedAfterBaselineRef.current.note = true;
      setNote(v);
    },
    [],
  );

  const handleConfidenceChange = useCallback(
    (value: string) => {
      confidenceRef.current = value;
      touchedAfterBaselineRef.current.confidence = true;
      setConfidence(value);
      // radio に blur は無いので change 自体で auto-save。confidenceRef は書いたばかりだが
      // performAutoSave 内の snapshot 読みに見せるため新値を明示的に渡す。
      performAutoSave({ confidence: value });
    },
    [performAutoSave],
  );

  const handleTagInputBlur = useCallback(() => {
    // TagInput.commit が先に走る (chip-input onBlur 順序) ので tagsRef は commit 後のリスト。
    performAutoSave({ tags: tagsRef.current });
  }, [performAutoSave]);

  // save-on-unmount (#105 §5.6)。auto-save モードは modal close (Esc / backdrop で field blur が
  // 走らない) を、未 blur フィールドの暗黙 blur として扱う。cleanup は *unmount 時のみ* 発火する
  // (deps 空 + 発火時に ref 読み): [autoSave, entry, runSave] deps だと entry の参照変化ごとに
  // 発火し、save 成功が setLoadResult で新 entry を作るので、cleanup が stale-closure baseline に
  // replay して二重保存する。発火時 ref で最新 entry / autoSave を得て、dirty check は最新 baseline
  // 相手なので直後保存済み entry は ref == baseline → false → 余計な save なし。runSave は pane
  // instance ごとの queue ref を閉じ込むので unmount 後も呼べる。
  useEffect(() => {
    return () => {
      if (!autoSaveRef.current) return;
      const cur = entryRef.current;
      if (!cur) return;
      if (
        !computeEditDirty(
          cur,
          tagsRef.current,
          confidenceRef.current,
          noteRef.current,
        )
      ) {
        return;
      }
      runSave({
        filename: cur.filename,
        tags: tagsRef.current,
        confidence: confidenceRef.current,
        note: noteRef.current,
      });
    };
    // deps は意図的に空 (上のコメント参照)。autoSave / entry / runSave は render 同期 ref 経由。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNoteBlur = useCallback(() => {
    performAutoSave({ note: noteRef.current });
  }, [performAutoSave]);

  // 単キー focus ショートカット (#115): text field 外で t/c/n が各入力へ focus を飛ばす。
  // window バインドで modal のどこに focus があっても効く。ガード順: 修飾キー除外 / entry 必須 /
  // text 入力中は除外 (isTextEntryTarget は radio/checkbox を非 text 扱いにするので radio 上でも
  // "n" が効く)。preventDefault で発火文字が focus 先に入るのを防ぐ。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!entryRef.current) return;
      if (isTextEntryTarget(e.target)) return;
      const field = editShortcutField(e.key);
      if (!field) return;
      e.preventDefault();
      if (field === "tags") {
        tagInputRef?.current?.focus();
      } else if (field === "confidence") {
        const group = confidenceGroupRef.current;
        const radio =
          group?.querySelector<HTMLInputElement>(
            'input[type="radio"]:checked',
          ) ?? group?.querySelector<HTMLInputElement>('input[type="radio"]');
        radio?.focus();
      } else {
        noteFieldRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tagInputRef]);

  const handleSave = useCallback(() => {
    // dirty で gate し Cmd/Ctrl+Enter ショートカットを保存ボタンの disabled 状態に合わせる
    // (無いと変更なしでも saveEdit が走り editing.open の blip が出る)。
    if (!entry || !dirty) return;
    runSave({
      filename: entry.filename,
      tags: tagsRef.current,
      confidence: confidenceRef.current,
      note: noteRef.current,
    });
  }, [entry, dirty, runSave]);

  // Cmd/Ctrl+Enter で保存。window バインドで pane のどの入力に focus があっても効く。
  // preventDefault の *前* に entry && dirty で gate するので、非 dirty の Ctrl+Enter は
  // platform 既定 (textarea 改行等) に落ちる。Esc はここで扱わない — ModalShell が Esc で
  // modal を閉じる (spec §5.3: close は未保存を確認なく破棄)。auto モードでも残す (変更なしなら冪等)。
  useEffect(() => {
    if (!entry || !dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, dirty, handleSave]);

  const handleCancel = useCallback(() => {
    if (!entry) return;
    const baselineTags = extractTags(entry.folder);
    setTags(baselineTags);
    tagsRef.current = baselineTags;
    setConfidence(entry.confidence);
    confidenceRef.current = entry.confidence;
    setNote(entry.note);
    noteRef.current = entry.note;
    // local == baseline になったので touched をクリアし、次の外部 baseline patch が re-sync
    // できるように (でないと cancel 前の touched フラグが次の per-field sync を抑止する)。
    touchedAfterBaselineRef.current = {
      tags: false,
      confidence: false,
      note: false,
    };
  }, [entry]);

  if (!entry) {
    return (
      <div className="sample-edit-pane sample-edit-pane-empty" aria-hidden="true" />
    );
  }

  return (
    <div className="sample-edit-pane" role="group" aria-label="編集">
      <div className="cls-edit-row">
        <label className="cls-edit-label" htmlFor={TAG_INPUT_ID}>
          タグ
        </label>
        <TagInput
          ref={tagInputRef}
          tags={tags}
          knownTags={knownTags}
          onChange={handleTagsChange}
          onBlur={handleTagInputBlur}
          inputId={TAG_INPUT_ID}
          ariaLabel="タグ"
        />
      </div>
      <div className="cls-edit-row">
        <div id={CONF_GROUP_LABEL_ID} className="cls-edit-label">
          confidence
        </div>
        <div
          className="cls-edit-radios"
          role="radiogroup"
          aria-labelledby={CONF_GROUP_LABEL_ID}
          ref={confidenceGroupRef}
        >
          {CONF_OPTIONS.map((opt) => (
            <label key={opt.value} className="cls-edit-radio">
              <input
                type="radio"
                name="cls-edit-confidence"
                value={opt.value}
                checked={confidence === opt.value}
                onChange={() => handleConfidenceChange(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
      <div className="cls-edit-row sample-edit-pane-note-row">
        <label className="cls-edit-label" htmlFor="sample-edit-pane-note">
          note
        </label>
        <textarea
          ref={noteFieldRef}
          id="sample-edit-pane-note"
          className="cls-edit-textarea sample-edit-pane-note"
          value={note}
          onChange={handleNoteChange}
          onBlur={handleNoteBlur}
        />
      </div>
      {autoSave ? null : (
        <div className="sample-edit-pane-buttons">
          <button
            type="button"
            className="confirm-dialog-btn"
            onClick={handleCancel}
            disabled={!dirty}
            title={dirty ? "編集をキャンセルして元に戻す" : "変更なし"}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-ok"
            onClick={handleSave}
            disabled={!dirty}
            title={dirty ? "編集を保存 (Cmd/Ctrl+Enter)" : "変更なし"}
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}
