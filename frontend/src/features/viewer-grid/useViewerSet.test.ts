// @vitest-environment happy-dom
// useViewerSet の maxViewers 配線テスト (#148, spec-viewer-max-count.md §13.4)。
// 純関数 addViewer(set, max) は viewers.test.ts が持つが、settings live 値が
// maxViewersRef + effect 経由で追加 gate に届く hook 側の配線はここで pin する
// (maxPixelsRef と同型ブロックゆえのコピペ事故 — 例えば opts.maxImagePixels からの
// 同期 — を将来検知するのが狙い)。
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useViewerSet } from "./useViewerSet";
import {
  addViewer,
  initialViewerSet,
  MAX_VIEWERS,
  MAX_VIEWERS_HARD,
  type ViewerSet,
} from "./viewers";

vi.mock("../../../wailsjs/go/main/App", () => ({
  GetImageInfo: vi.fn(),
  // logger が LogEvent を fire して .catch() するので resolved promise を返す。
  LogEvent: vi.fn(() => Promise.resolve()),
}));

function setN(n: number): ViewerSet {
  let s = initialViewerSet();
  for (let i = 1; i < n; i++) s = addViewer(s, MAX_VIEWERS_HARD);
  return s;
}

describe("useViewerSet — opts.maxViewers gate (#148)", () => {
  it("refuses addViewer at the configured max (below the default 8)", () => {
    const { result } = renderHook(
      (props: { maxViewers: number }) =>
        useViewerSet({ initialSet: setN(3), maxViewers: props.maxViewers }),
      { initialProps: { maxViewers: 3 } },
    );
    act(() => result.current.addViewer());
    expect(result.current.viewers).toHaveLength(3);
  });

  it("follows a live increase of maxViewers via rerender (settings 反映、再起動不要)", () => {
    const { result, rerender } = renderHook(
      (props: { maxViewers: number }) =>
        useViewerSet({ initialSet: setN(3), maxViewers: props.maxViewers }),
      { initialProps: { maxViewers: 3 } },
    );
    rerender({ maxViewers: 4 });
    act(() => result.current.addViewer());
    expect(result.current.viewers).toHaveLength(4);
    // 新しい上限 (4) でまた gate される。
    act(() => result.current.addViewer());
    expect(result.current.viewers).toHaveLength(4);
  });

  it("refuses without truncating when max drops below the current count (D2)", () => {
    const { result, rerender } = renderHook(
      (props: { maxViewers: number }) =>
        useViewerSet({ initialSet: setN(5), maxViewers: props.maxViewers }),
      { initialProps: { maxViewers: 8 } },
    );
    rerender({ maxViewers: 3 });
    act(() => result.current.addViewer());
    expect(result.current.viewers).toHaveLength(5); // 既存 viewer は削らず追加だけ拒否
  });

  it("falls back to MAX_VIEWERS when opts.maxViewers is omitted (settings ロード中)", () => {
    const { result } = renderHook(() =>
      useViewerSet({ initialSet: setN(MAX_VIEWERS) }),
    );
    act(() => result.current.addViewer());
    expect(result.current.viewers).toHaveLength(MAX_VIEWERS);
  });
});
