import { useEffect, useRef } from "react";
import { EventsOn } from "../wailsjs/runtime/runtime";
import { cycleViewerId } from "./features/viewer-grid/viewers";
import {
  isTaskbarSwitchDirection,
  TASKBAR_VIEWER_SWITCH_EVENT,
} from "./taskbarEvents";
import type { TopTab } from "./topTab";

// useTaskbarViewerSwitch はタスクバーサムネイルツールバーの ◀▶ クリック (Go の
// wintaskbar → EventsEmit, #149) を App state に配線する
// (spec-taskbar-viewer-switch.md §5.2 / §8 経路 4):
//
//   一覧タブ表示中     → ビューアタブへ切替のみ (巡回しない, D2)
//   ビューアタブ表示中 → activeViewer を前 / 次に wrap-around 巡回
//   gated (設定ダイアログ / 一覧の並べ替えモード中) → 無視
//
// gate 条件は App.tsx の tabSwitchGated を useGlobalKeybindings と共有する (spec §5.2 の
// 「キーバインドのタブ切替 gate と同一」を単一の出所で保証)。EventsOn は空 deps で 1 回だけ
// 登録し、生きた state は render 時に同期する ref 経由で読む (useGlobalKeybindings と同じ
// 流儀 — state 変更のたびに re-bind すると unbind/re-bind の隙にイベントを取りこぼす恐れがある)。

// useViewerSet の戻りのうち本 hook が読む最小面。テストが hook 全体を組み立てずに済む。
export type TaskbarSwitchViewer = {
  viewers: ReadonlyArray<{ id: string }>;
  activeViewerId: string;
  setActiveViewer: (id: string) => void;
};

type Opts = {
  topTab: TopTab;
  setTopTab: (t: TopTab) => void;
  viewer: TaskbarSwitchViewer;
  // App.tsx の tabSwitchGated (useGlobalKeybindings と共通)。
  gated: boolean;
};

export function useTaskbarViewerSwitch({
  topTab,
  setTopTab,
  viewer,
  gated,
}: Opts): void {
  const topTabRef = useRef(topTab);
  const viewerRef = useRef(viewer);
  const gatedRef = useRef(gated);
  // handler は ref 経由で読むので、毎 render で最新 state を反映する (useEffect の遅延を挟まないため)。
  topTabRef.current = topTab;
  viewerRef.current = viewer;
  gatedRef.current = gated;

  useEffect(() => {
    const unsub = EventsOn(TASKBAR_VIEWER_SWITCH_EVENT, (payload: unknown) => {
      if (!isTaskbarSwitchDirection(payload)) return;
      if (gatedRef.current) return;
      if (topTabRef.current !== "viewer") {
        setTopTab("viewer");
        return;
      }
      const v = viewerRef.current;
      // cycleViewerId は「切り替え不要」(空 / 1 個 / 同一 id) を null で返す。
      const next = cycleViewerId(v.viewers, v.activeViewerId, payload);
      if (next !== null) {
        v.setActiveViewer(next);
      }
    });
    return unsub;
    // setTopTab は useState setter で identity 安定 (useGlobalKeybindings と同じ前提)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
