import { classification } from "../../../wailsjs/go/models";
import { extractTags, serializeTags } from "./filters";

// SampleEditPane が「local フォームを最後に突き合わせた entry 状態」として覚える
// tuple。per-field sync 判定を unit-test できるよう SampleEditPane から分離 (#110 B)。
export type Baseline = {
  filename: string | null;
  folder: string;
  confidence: string;
  note: string;
};

export type LocalEdit = {
  tags: string[];
  confidence: string;
  note: string;
};

// 直近 baseline 観測以降、フィールドが touch されたかのフラグ。
export type Touched = {
  tags: boolean;
  confidence: boolean;
  note: boolean;
};

// entry 非アクティブ時の baseline。freeze するのは共有インスタンスの mutation を防ぐ
// ため (AGENTS B-1 — `EMPTY_BASELINE.folder = ...` が後続の baseline reset を汚す)。
// touched フラグは field ごとに mutate するのであえて共有定数を持たず、reset 側で
// 毎回新リテラルを確保する。
export const EMPTY_BASELINE: Readonly<Baseline> = Object.freeze({
  filename: null,
  folder: "",
  confidence: "",
  note: "",
});

export function baselineOf(entry: classification.Entry): Baseline {
  return {
    filename: entry.filename,
    folder: entry.folder,
    confidence: entry.confidence,
    note: entry.note,
  };
}

export type BaselineSyncAction =
  // filename 変化 = 別 entry (prev/next nav)。3 フィールドを新 baseline に reset
  // する (前の local 編集はこの entry のものではない; dirty 中 nav は禁止, #93 §5.4)。
  | { kind: "resetAll" }
  // 同一 entry で baseline が patch された (subset を触る auto-save 成功、または
  // 外部 sidecar 編集)。前 baseline と一致し、かつ未 touch のフィールドだけ sync。
  | {
      kind: "perField";
      syncTags: boolean;
      syncConfidence: boolean;
      syncNote: boolean;
    };

// 新しい (非 null) entry baseline 観測に local フォームがどう反応すべきか決める。
// entry === null (EMPTY_BASELINE へクリア) は呼び出し側が別扱いする。
//
// per-field ルール: local フィールドを新 baseline で上書きするのは
//   (a) local 値が *前の* baseline 値とまだ一致し、かつ
//   (b) 直近 baseline 以降そのフィールドを touch していない
// の両方が成り立つときだけ。(a) だけだと partial save が「本当に差分のある未 touch
// フィールド」を潰す。(b) が無いと「touch して元に戻した」値がたまたま前 baseline と
// 一致するとき、save 後の baseline patch がユーザーの revert を握り潰す。
export function computeBaselineSync(
  prev: Baseline,
  entry: classification.Entry,
  local: LocalEdit,
  touched: Touched,
): BaselineSyncAction {
  if (prev.filename !== entry.filename) return { kind: "resetAll" };
  const syncTags =
    prev.folder !== entry.folder &&
    serializeTags(local.tags) === serializeTags(extractTags(prev.folder)) &&
    !touched.tags;
  const syncConfidence =
    prev.confidence !== entry.confidence &&
    local.confidence === prev.confidence &&
    !touched.confidence;
  const syncNote =
    prev.note !== entry.note &&
    local.note === prev.note &&
    !touched.note;
  return { kind: "perField", syncTags, syncConfidence, syncNote };
}
