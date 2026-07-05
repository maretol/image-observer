// SampleModal 編集ペインの単キー focus ショートカット (#115): モーダル表示中に text
// field 外で t/c/n を押すと各入力へ focus を飛ばす。純粋部分だけここに置き unit-test 可能に。

export type EditField = "tags" | "confidence" | "note";

// 大小無視 (Shift/CapsLock 対応)。呼び出し側は修飾キー (Ctrl+T 等) と text 入力中の
// focus を別途弾くこと。
export function editShortcutField(key: string): EditField | null {
  switch (key.toLowerCase()) {
    case "t":
      return "tags";
    case "c":
      return "confidence";
    case "n":
      return "note";
    default:
      return null;
  }
}

// 素の文字が入力される = free-text な input type。それ以外 (radio/checkbox/…) は
// text 入力でないので t/c/n を生かす。type 未指定/不明の <input> は "text" 扱いになる。
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "email",
  "tel",
  "password",
  "number",
]);

// keybindings.isEditableTarget よりあえて狭い: text 入力だけを対象にして、confidence
// radio 等の非 text コントロール上では t/c/n を生かす。allowlist にするのは意図を
// 明示し将来の input type にも正しくあるため。
export function isTextEntryTarget(target: EventTarget | null): boolean {
  // 非 DOM (node) テスト環境でも import できるようガード。
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    return TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
  }
  return false;
}
