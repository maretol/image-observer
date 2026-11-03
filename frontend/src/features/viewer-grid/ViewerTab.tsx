import { useEffect, useRef } from "react";
import { CloseIcon } from "../../shared/icons/CloseIcon";
import { blurActiveElement, preventMouseFocus } from "../../shared/utils/focus";
import { DATA_VIEWER_TAB } from "./useViewerTabReorder";
import type { Viewer } from "./viewers";

// ViewerTab — 1 viewer 分のトップタブ chip。インライン rename 入力と並べ替え DnD (#50) の
// pointer 配線を持つ。state は親 (TopTabsBar) が持ち props で渡す。
// 非自明な分岐の理由 (rename の細部、一覧タブとの click/dblclick/close 当たり判定調整 #53) は
// インラインコメント参照。

export type ViewerTabProps = {
  // viewer.viewers 内での位置 — reorder hook が moveViewer の fromIdx を計算するのに渡す (#50)。
  index: number;
  viewer: Viewer;
  isActive: boolean;
  isEditing: boolean;
  // *どれか* の viewer タブが rename 入力を開いている間 true。その間は全タブで drag 開始を
  // 止め、rename エディタが focus 中に兄弟タブを drag できないようにする (#50)。
  anyRenaming: boolean;
  // このタブを drag 中 true。source を淡色化 (.dragging) して掴んだ位置を分かるようにする。
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
  // Esc cancel / Enter commit は、isEditing が false になり input が focus 中に unmount され、
  // React が unmount ノードに同期 blur を dispatch して onCommitRename を (冗長な) draft 値で
  // 呼ぶのを抑止する。フラグは各 keydown 分岐で unmount を起こす前に立てる。
  const suppressBlurRef = useRef(false);

  // 編集モード開始時に input を focus + select。遷移時のみ (isEditing が true になったとき)。
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
              // Esc cancel / Enter commit が既に処理済み — unmount-blur を飲んで二重処理を防ぐ。
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
        // drag 開始 guard (spec §5.2)。click / dblclick / close へ通すべきものはここで弾く。
        if (e.button !== 0) return; // 主ボタンのみ
        // isEditing は anyRenaming に技術的に含まれる (自分の rename は any-rename でもある) が、
        // 下の early-return 対との対称のため残す。
        if (isEditing) return;
        // *どれか* のタブが rename 中は drag を止める。でないと pointerdown の preventDefault で
        // rename 入力が focus を保ったまま、開いたエディタの裏で兄弟タブを並べ替えられてしまう。
        if (anyRenaming) return;
        if (isFromClose(e)) return; // close ボタンは自前の onClick を持つ
        // wrapper span の text 選択を抑止。wrapper は focus 不可なので、drag が active になった
        // ときの I-beam カーソル + user-select の副作用を消すだけ。ただし mousedown の既定動作
        // (= 直前の focus 要素の blur) も一緒に止まるので、native と同じく明示的に blur する
        // (#150: 直前 focus を残さない。タブ chrome 自体には focus を乗せない)。
        blurActiveElement();
        e.preventDefault();
        onStartDrag(index, {
          clientX: e.clientX,
          clientY: e.clientY,
          pointerId: e.pointerId,
        });
      }}
      onClick={(e) => {
        if (isFromClose(e)) return;
        // drag commit/cancel は pointerup 直後に合成 click を出す。並べ替え成功後に source タブが
        // 再アクティブ化しないよう、その trailing click 1 回を抑止 (#50)。
        if (shouldSuppressClick()) return;
        onActivate();
        // マウス click でタブ名に focus は寄せない (#150)。かつて #53 で一覧タブ (全体が
        // <button>) に合わせて name button を focus していたが、focus が残ると次のキー操作
        // (Ctrl+Tab / Shift+ホイールの Shift 等) で :focus-visible が点灯し「変な枠」になる。
        // 一覧タブ側も onMouseDown で focus を受けないようにして、揃え方を逆転させた。
        // keyboard (Tab → Enter) は mousedown を経ず native focus のまま → リングは出る。
      }}
      onDoubleClick={(e) => {
        if (isFromClose(e)) return;
        e.preventDefault();
        onStartRename();
      }}
    >
      <button
        type="button"
        role="tab"
        // #150: pointerdown が drag guard で早期 return する経路 (rename 中 / 副ボタン) でも
        // mousedown の native focus を name button に乗せない。rename 入力の blur-commit は
        // preventMouseFocus 内の明示 blur で維持される。
        onMouseDown={preventMouseFocus}
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
          // #150: close 確認ダイアログ (ModalShell) が「直前 focus」として × を捕まえ、
          // キャンセル後に focus を戻してリングを点灯させないように。
          onMouseDown={preventMouseFocus}
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
