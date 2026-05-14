// Token stack for `document.body.style.cursor` / `userSelect` so that
// concurrent claimants (DnD, GridSplitter, ImageView pan, …) compose
// instead of overwriting one another and leaking "" to whatever the
// user had set before the first claim.
//
// Usage:
//   const release = pushBodyStyle({ cursor: "grabbing", userSelect: "none" });
//   // ...drag interaction...
//   release();
//
// The last unreleased claim wins per property. On release the stack is
// re-applied from the bottom up, falling back to the baseline value
// captured on the first push.

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
    // Stack drained — drop our cached baseline so the next push re-captures
    // whatever document.body.style looks like at that point. Without this,
    // any cursor/userSelect change made by other code in between two drag
    // sessions would be silently reverted to the old baseline on release.
    if (stack.length === 0) {
      baseCursor = null;
      baseUserSelect = null;
    }
  };
}
