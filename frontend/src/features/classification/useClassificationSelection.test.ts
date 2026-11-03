// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useClassificationSelection } from "./useClassificationSelection";

// selectedFilenames は「選択した順」を保つ (#167)。bulk open はこの配列順にタブを足すので、
// ファイル名順 / 表示順に並べ替えてしまうとユーザーが選んだ順序が捨てられる。
const DISPLAYED = ["a.png", "b.png", "c.png", "d.png", "e.png"];

describe("useClassificationSelection ordering (#167)", () => {
  it("keeps toggle order instead of sorting by filename", () => {
    const { result } = renderHook(() => useClassificationSelection());
    act(() => result.current.toggleSelected("c.png"));
    act(() => result.current.toggleSelected("a.png"));
    act(() => result.current.toggleSelected("b.png"));
    expect(result.current.selectedFilenames).toEqual(["c.png", "a.png", "b.png"]);
  });

  it("moves a re-selected filename to the end", () => {
    const { result } = renderHook(() => useClassificationSelection());
    act(() => result.current.toggleSelected("a.png"));
    act(() => result.current.toggleSelected("b.png"));
    act(() => result.current.toggleSelected("a.png")); // 解除
    expect(result.current.selectedFilenames).toEqual(["b.png"]);
    act(() => result.current.toggleSelected("a.png")); // 再選択
    expect(result.current.selectedFilenames).toEqual(["b.png", "a.png"]);
  });

  it("appends a shift-range in displayed order after the existing selection", () => {
    const { result } = renderHook(() => useClassificationSelection());
    // anchor = d。b まで Shift 拡張すると範囲 b..d を表示順で追加するが、既に選択済みの
    // d は先頭の位置を保つ (= 選んだ順を壊さない)。
    act(() => result.current.toggleSelected("d.png"));
    act(() => result.current.extendSelectionTo("b.png", DISPLAYED));
    expect(result.current.selectedFilenames).toEqual(["d.png", "b.png", "c.png"]);
  });

  it("falls back to a toggle (appended last) when the anchor is missing", () => {
    const { result } = renderHook(() => useClassificationSelection());
    act(() => result.current.toggleSelected("e.png"));
    // anchor "e.png" が displayedOrder に無い (フィルタで消えた等) → 単純 toggle
    act(() =>
      result.current.extendSelectionTo("a.png", ["a.png", "b.png", "c.png"]),
    );
    expect(result.current.selectedFilenames).toEqual(["e.png", "a.png"]);
  });

  it("clearSelected / resetForFolderSwitch empty the ordered list", () => {
    const { result } = renderHook(() => useClassificationSelection());
    act(() => result.current.toggleSelected("b.png"));
    act(() => result.current.toggleSelected("a.png"));
    act(() => result.current.clearSelected());
    expect(result.current.selectedFilenames).toEqual([]);

    act(() => result.current.toggleSelected("b.png"));
    act(() => result.current.resetForFolderSwitch());
    expect(result.current.selectedFilenames).toEqual([]);
  });
});
