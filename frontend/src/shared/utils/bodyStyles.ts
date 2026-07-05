// document.body.style の cursor / userSelect を token stack で管理する。並行する
// 要求元 (DnD / GridSplitter / ImageView pan …) が互いに上書きせず合成でき、最初の
// 要求前の値へ "" を漏らさないため。戻り値の release() で自分の要求を取り下げる。

type BodyStyleClaim = {
  cursor?: string;
  userSelect?: string;
};

type StackEntry = {
  id: symbol;
  claim: BodyStyleClaim;
};

const stack: StackEntry[] = [];
let baseCursor: string | null = null;
let baseUserSelect: string | null = null;

function apply(): void {
  let cursor = baseCursor ?? "";
  let userSelect = baseUserSelect ?? "";
  for (const entry of stack) {
    if (entry.claim.cursor !== undefined) cursor = entry.claim.cursor;
    if (entry.claim.userSelect !== undefined) userSelect = entry.claim.userSelect;
  }
  document.body.style.cursor = cursor;
  document.body.style.userSelect = userSelect;
}

export function pushBodyStyle(claim: BodyStyleClaim): () => void {
  if (baseCursor === null) baseCursor = document.body.style.cursor;
  if (baseUserSelect === null) baseUserSelect = document.body.style.userSelect;
  const entry: StackEntry = { id: Symbol("body-style"), claim };
  stack.push(entry);
  apply();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const idx = stack.findIndex((e) => e.id === entry.id);
    if (idx >= 0) stack.splice(idx, 1);
    apply();
    // これがないと、ドラッグ間に他コードが変えた cursor/userSelect が次の release で
    // 古い baseline に戻ってしまうため、空になったら baseline を破棄する。
    if (stack.length === 0) {
      baseCursor = null;
      baseUserSelect = null;
    }
  };
}
