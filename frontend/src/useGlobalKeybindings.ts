import { useEffect, useRef } from "react";
import { findLeaf } from "./features/viewer-grid/layout";
import type { useViewerSet } from "./features/viewer-grid/useViewerSet";
import {
  isEditableTarget,
  isPrimaryModifier,
  zoomCommandBus,
} from "./shared/utils/keybindings";
import type { TopTab } from "./topTab";

// useGlobalKeybindings は App レベルのキーボードショートカットを配線する
// (Phase H4 + #7 + #11):
//
//   Ctrl+Shift+1     → "一覧" トップタブへ切替
//   Ctrl+Shift+2..9 → (N-1) 番目のビューアへ切替
//   Ctrl+W           → アクティブパネルのアクティブタブを閉じる
//   Ctrl+Tab / Ctrl+Shift+Tab → アクティブパネル内でタブを巡回
//   Ctrl+0 / Ctrl+1  → フィット / 実寸 (zoomCommandBus 経由)
//   Ctrl+= / Ctrl+- → ズームイン / アウト
//
// window の keydown リスナは空 deps で一度だけ登録し、生きた state は render 時に
// 同期する ref 経由で読む。state 変更のたびにリスナを再生成すると、
// unmount/remount の隙にキーを取りこぼす恐れがある。

type Opts = {
  topTab: TopTab;
  setTopTab: (t: TopTab) => void;
  viewer: ReturnType<typeof useViewerSet>;
  settingsOpen: boolean;
  // 一覧タブの並べ替えモード (#144 Phase 2)。true の間はタブ切替 / タブ操作系の
  // キーバインドを丸ごと gate する (並べ替え途中の文脈を失わせない, spec-image-sort §5.2)。
  // Esc は useCardReorder 側が受け持つ。
  listReorderMode: boolean;
};

export function useGlobalKeybindings({
  topTab,
  setTopTab,
  viewer,
  settingsOpen,
  listReorderMode,
}: Opts): void {
  const topTabRef = useRef(topTab);
  const settingsOpenRef = useRef(settingsOpen);
  const viewerRef = useRef(viewer);
  const listReorderModeRef = useRef(listReorderMode);
  // keydown ハンドラは ref 経由で読むので、毎 render で最新 state を反映する
  // (useEffect の遅延を挟まないため)。
  topTabRef.current = topTab;
  settingsOpenRef.current = settingsOpen;
  viewerRef.current = viewer;
  listReorderModeRef.current = listReorderMode;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (settingsOpenRef.current) return; // ダイアログ側に Esc ハンドラがある
      if (listReorderModeRef.current) return; // 並べ替えモード中はタブ操作を封じる (#144)

      // (N-1) オフセットは Ctrl+Shift+2 が従来の単一ビューア時代と同じ「最初の
      // ビューア」を指すように (#7 + #11)。e.code を使うのはレイアウト非依存に
      // するため (e.key だと shift 後の文字になる)。
      if (isPrimaryModifier(e) && e.shiftKey) {
        if (e.code === "Digit1") {
          e.preventDefault();
          setTopTab("list");
          return;
        }
        const digitMatch = /^Digit([2-9])$/.exec(e.code);
        if (digitMatch) {
          const idx = Number(digitMatch[1]) - 2; // Digit2 → ビューア index 0
          const viewerLive = viewerRef.current;
          if (idx >= 0 && idx < viewerLive.viewers.length) {
            e.preventDefault();
            viewerLive.setActiveViewer(viewerLive.viewers[idx].id);
            setTopTab("viewer");
          }
          return;
        }
      }

      if (topTabRef.current !== "viewer") return;

      const viewerLive = viewerRef.current;
      const layout = viewerLive.layout;
      const activeLeaf = findLeaf(layout.root, layout.activeId);
      if (!activeLeaf) return;

      if (!isPrimaryModifier(e)) return;

      if ((e.key === "w" || e.key === "W") && !e.shiftKey) {
        e.preventDefault();
        if (activeLeaf.activeIndex >= 0) {
          viewerLive.closeTab(activeLeaf.id, activeLeaf.activeIndex);
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const n = activeLeaf.tabs.length;
        if (n <= 1) return;
        const dir = e.shiftKey ? -1 : 1;
        const next = (((activeLeaf.activeIndex + dir) % n) + n) % n;
        viewerLive.setActiveTab(activeLeaf.id, next);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        zoomCommandBus.emit("fit");
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        zoomCommandBus.emit("actualSize");
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomCommandBus.emit("in");
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        zoomCommandBus.emit("out");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
