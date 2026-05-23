import { useEffect, useRef } from "react";
import { CloseIcon } from "../../shared/icons/CloseIcon";
import { DATA_VIEWER_TAB } from "./useViewerTabReorder";
import type { Viewer } from "./viewers";

// ViewerTab — one top-tab chip for a single viewer. Owns the inline rename
// input (focus + Esc revert / Enter commit) and the pointer plumbing for tab
// reorder DnD (#50). State lives in the parent: TopTabsBar passes
// isEditing / isDragSource / anyRenaming as props and forwards activate /
// commit / cancel / startDrag callbacks.
//
// Rename ergonomics + the click/dblclick/close target reconciliation with the
// list-tab (#53) explain most of the non-obvious branches inline.

export type ViewerTabProps = {
  // index is the position of this tab in viewer.viewers — passed to the
  // reorder hook so it can compute moveViewer's fromIdx (#50).
  index: number;
  viewer: Viewer;
  isActive: boolean;
  isEditing: boolean;
  // anyRenaming = true while *any* viewer tab has an open rename input.
  // We block drag-start on every tab in that state so a sibling drag can't
  // proceed while the rename editor is still focused (#50).
  anyRenaming: boolean;
  // isDragSource = true while this tab is being dragged. Used to dim the
  // source (.dragging className) so the user can tell where they grabbed
  // from while the indicator shows the drop position.
  isDragSource: boolean;
  canClose: boolean;
  onActivate: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onClose: () => void;
  onStartDrag: (
    idx: number,
    ev: { clientX: number; clientY: number; pointerId: number },
  ) => void;
  shouldSuppressClick: () => boolean;
};

export function ViewerTab({
  index,
  viewer,
  isActive,
  isEditing,
  anyRenaming,
  isDragSource,
  canClose,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onClose,
  onStartDrag,
  shouldSuppressClick,
}: ViewerTabProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // #53: wrapper の padding 領域クリックでも focus を一覧タブ (タブ全体が
  // <button>) と同じく「選択中のタブにフォーカスが乗る」状態に揃えるため、
  // wrapper onClick から内側 name button を focus する用の ref。
  const nameButtonRef = useRef<HTMLButtonElement>(null);
  // Esc cancellation and Enter commit both suppress the blur-commit that
  // would otherwise fire when isEditing flips false → the input unmounts
  // while focused → React dispatches blur synchronously on the unmounting
  // node, calling onCommitRename with the (now-redundant) draft value. The
  // flag is set in the respective keydown branch before we trigger the
  // unmount path. (Enter without the suppress works today because the
  // duplicate call hits useViewerSet.renameViewerCb's silent no-op, but the
  // symmetry with Esc keeps it robust to downstream changes.)
  const suppressBlurRef = useRef(false);

  // On entering edit mode, focus + select the input. Run on transitions only
  // (when isEditing flips true), which is what the dependency array gives us.
  useEffect(() => {
    if (isEditing) {
      suppressBlurRef.current = false; // reset for the new edit session
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <span className={`top-tab top-tab-viewer ${isActive ? "active" : ""}`}>
        <input
          ref={inputRef}
          type="text"
          className="top-tab-rename-input"
          defaultValue={viewer.name}
          maxLength={32}
          onBlur={(e) => {
            if (suppressBlurRef.current) {
              // Esc cancel or Enter commit already handled this edit
              // session — swallow the unmount-blur so we don't double up.
              suppressBlurRef.current = false;
              return;
            }
            onCommitRename(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              suppressBlurRef.current = true;
              onCommitRename((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              suppressBlurRef.current = true;
              onCancelRename();
            }
          }}
          aria-label={`ビューア名を編集: ${viewer.name}`}
        />
      </span>
    );
  }

  // #53: 一覧タブはタブ全体が <button> なのでタブ chrome のどこでも反応するが、
  // ビューアタブは内側の name <button> だけがクリックターゲットなため、
  // wrapper の padding (上下 4px / 左 22px / 右 10px) や close ボタン非表示時の
  // 右側スペースをクリックしても無反応だった。wrapper 側で click / dblclick を
  // 受け、close ボタン由来のイベントだけ除外することで一覧タブと当たり判定を揃える。
  // close 内の CloseIcon は SVG 要素なので e.target は HTMLElement ではなく
  // SVGElement になり得る。closest() は Element の API なので instanceof Element
  // でガードしてから呼ぶ。
  const isFromClose = (e: { target: EventTarget | null }) =>
    e.target instanceof Element &&
    e.target.closest(".top-tab-viewer-close") != null;

  return (
    <span
      className={`top-tab top-tab-viewer ${isActive ? "active" : ""} ${
        isDragSource ? "dragging" : ""
      }`}
      {...{ [DATA_VIEWER_TAB]: String(index) }}
      onPointerDown={(e) => {
        // Drag-start guards (spec §5.2). Anything that should fall through to
        // the existing click / dblclick / close paths is rejected here.
        if (e.button !== 0) return; // primary button only
        // isEditing here is technically subsumed by anyRenaming (own rename
        // implies any-rename) but kept for symmetry with the early-return
        // pair below: own-rename uses the alternate render path, sibling-
        // rename keeps this render path.
        if (isEditing) return;
        // Block drag while *any* tab is in rename mode. preventDefault on
        // this pointerdown would otherwise keep the rename input focused
        // and let the user reorder a sibling tab behind the open editor.
        if (anyRenaming) return;
        if (isFromClose(e)) return; // close button has its own onClick
        // Suppress text selection on the wrapper span. The wrapper isn't
        // focusable, so this is purely about clearing the I-beam cursor +
        // user-select side effects when the drag turns active.
        e.preventDefault();
        onStartDrag(index, {
          clientX: e.clientX,
          clientY: e.clientY,
          pointerId: e.pointerId,
        });
      }}
      onClick={(e) => {
        if (isFromClose(e)) return;
        // Drag commit/cancel fires a synthetic click right after pointerup
        // on most engines; suppress that one trailing click so the source
        // tab doesn't re-activate after a successful reorder (#50).
        if (shouldSuppressClick()) return;
        onActivate();
        // 一覧タブはタブ全体が <button> なので click で自動的にフォーカスが
        // 乗るが、ビューアタブの wrapper は <span> でフォーカス不可。padding
        // 領域クリック時に focus-visible リング含めて一覧タブと挙動を揃える
        // ため、内側 name button へ明示的に focus を寄せる。name button 上の
        // 直接クリックなら既に focus されているので呼んでも no-op。
        nameButtonRef.current?.focus();
      }}
      onDoubleClick={(e) => {
        if (isFromClose(e)) return;
        e.preventDefault();
        onStartRename();
      }}
    >
      <button
        ref={nameButtonRef}
        type="button"
        role="tab"
        aria-selected={isActive}
        className="top-tab-viewer-name"
        title={viewer.name}
      >
        {viewer.name}
      </button>
      {canClose ? (
        <button
          type="button"
          className="top-tab-viewer-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={`ビューア "${viewer.name}" を閉じる`}
          aria-label={`ビューア "${viewer.name}" を閉じる`}
          tabIndex={-1}
        >
          <CloseIcon size={14} />
        </button>
      ) : null}
    </span>
  );
}
