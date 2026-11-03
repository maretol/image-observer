// focus.ts — マウス操作で focus を受け取らせたくない chrome (トップタブ列など) 用のヘルパ (#150)。
//
// mousedown の既定動作は「直前の focus 要素を blur し、クリック先 (focusable なら) を focus する」
// の 2 段。preventMouseFocus は後半だけを止めたい: 前半 (直前要素の blur) まで止めてしまうと、
// ビューア名 rename 入力の blur-commit のように「focus が離れること」に乗った処理が走らなくなる。
// そこで明示的に blur してから preventDefault する。
//
// keyboard 操作 (Tab → Enter / Space) は mousedown を経ないので影響せず、:focus-visible のリングは
// 従来どおり出る。focus をタブ chrome に残すと、次のキー操作 (Ctrl+Tab / Shift+ホイールの Shift 等)
// で Chromium のヒューリスティックが :focus-visible を点灯させ「変な枠」として見えるのが #150。

export function blurActiveElement(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement) el.blur();
}

export function preventMouseFocus(e: { preventDefault(): void }): void {
  blurActiveElement();
  e.preventDefault();
}
