// @vitest-environment happy-dom
// useTaskbarViewerSwitch の配線テスト (#149, spec-taskbar-viewer-switch.md §8 経路 4/5)。
// 巡回計算そのものは viewers.test.ts の cycleViewerId が持ち、ここでは EventsOn の
// 1 回登録 + render-time ref sync + gate (settingsOpen / listReorderMode / list タブ) を pin する。
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const eventsOnMock = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  unsub: vi.fn(),
  register: vi.fn(),
}));

vi.mock("../wailsjs/runtime/runtime", () => ({
  EventsOn: (event: string, cb: (payload: unknown) => void) => {
    eventsOnMock.register(event);
    eventsOnMock.handlers.set(event, cb);
    return eventsOnMock.unsub;
  },
}));

import { TASKBAR_VIEWER_SWITCH_EVENT } from "./taskbarEvents";
import {
  useTaskbarViewerSwitch,
  type TaskbarSwitchViewer,
} from "./useTaskbarViewerSwitch";
import type { TopTab } from "./topTab";

type HookProps = {
  topTab: TopTab;
  settingsOpen?: boolean;
  listReorderMode?: boolean;
  activeViewerId?: string;
  viewerIds?: string[];
};

function setup(initial: HookProps) {
  const setTopTab = vi.fn();
  const setActiveViewer = vi.fn();
  const build = (p: HookProps) => {
    const viewer: TaskbarSwitchViewer = {
      viewers: (p.viewerIds ?? ["a", "b", "c"]).map((id) => ({ id })),
      activeViewerId: p.activeViewerId ?? "a",
      setActiveViewer,
    };
    return {
      topTab: p.topTab,
      setTopTab,
      viewer,
      settingsOpen: p.settingsOpen ?? false,
      listReorderMode: p.listReorderMode ?? false,
    };
  };
  const hook = renderHook((p: HookProps) => useTaskbarViewerSwitch(build(p)), {
    initialProps: initial,
  });
  return { ...hook, setTopTab, setActiveViewer };
}

function fire(payload: unknown) {
  const handler = eventsOnMock.handlers.get(TASKBAR_VIEWER_SWITCH_EVENT);
  expect(handler).toBeDefined();
  handler!(payload);
}

beforeEach(() => {
  eventsOnMock.handlers.clear();
  eventsOnMock.unsub.mockClear();
  eventsOnMock.register.mockClear();
});

describe("useTaskbarViewerSwitch", () => {
  it("viewer タブ表示中の next/prev は activeViewer を巡回させる", () => {
    const { setActiveViewer, setTopTab } = setup({
      topTab: "viewer",
      activeViewerId: "b",
    });
    fire("next");
    expect(setActiveViewer).toHaveBeenLastCalledWith("c");
    fire("prev");
    expect(setActiveViewer).toHaveBeenLastCalledWith("a");
    expect(setTopTab).not.toHaveBeenCalled();
  });

  it("list タブ表示中は viewer タブへ切り替えるだけで巡回しない (D2)", () => {
    const { setActiveViewer, setTopTab } = setup({ topTab: "list" });
    fire("next");
    expect(setTopTab).toHaveBeenCalledWith("viewer");
    expect(setActiveViewer).not.toHaveBeenCalled();
  });

  it("設定ダイアログ表示中 / 並べ替えモード中は無視する", () => {
    const { setActiveViewer, setTopTab, rerender } = setup({
      topTab: "viewer",
      settingsOpen: true,
    });
    fire("next");
    rerender({ topTab: "viewer", listReorderMode: true });
    fire("next");
    expect(setActiveViewer).not.toHaveBeenCalled();
    expect(setTopTab).not.toHaveBeenCalled();
  });

  it("viewer 1 個は no-op (same-id guard)", () => {
    const { setActiveViewer } = setup({
      topTab: "viewer",
      viewerIds: ["only"],
      activeViewerId: "only",
    });
    fire("next");
    expect(setActiveViewer).not.toHaveBeenCalled();
  });

  it("契約外 payload は捨てる", () => {
    const { setActiveViewer, setTopTab } = setup({ topTab: "viewer" });
    fire("up");
    fire(undefined);
    fire({ direction: "next" });
    expect(setActiveViewer).not.toHaveBeenCalled();
    expect(setTopTab).not.toHaveBeenCalled();
  });

  it("EventsOn は 1 回だけ登録し、rerender 後も ref 経由で最新 state を読む (経路 4)", () => {
    const { setActiveViewer, rerender } = setup({
      topTab: "viewer",
      activeViewerId: "a",
    });
    fire("next");
    expect(setActiveViewer).toHaveBeenLastCalledWith("b");
    // 親が activeViewerId を進めた後も、同じ handler が最新値から巡回する。
    rerender({ topTab: "viewer", activeViewerId: "b" });
    fire("next");
    expect(setActiveViewer).toHaveBeenLastCalledWith("c");
    expect(eventsOnMock.register).toHaveBeenCalledTimes(1);
  });

  it("unmount で購読を解除する (経路 5)", () => {
    const { unmount } = setup({ topTab: "viewer" });
    unmount();
    expect(eventsOnMock.unsub).toHaveBeenCalledTimes(1);
  });
});
