// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SaveClassification } from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import { useClassificationReorder } from "./useClassificationReorder";
import { SORT_MANUAL, SORT_NAME_ASC } from "./sortMode";

vi.mock("../../../wailsjs/go/main/App", () => ({
  SaveClassification: vi.fn(),
  // logger 経由の LogEvent は .catch() されるので resolved promise を返す。
  LogEvent: vi.fn(() => Promise.resolve()),
}));
const mockSave = vi.mocked(SaveClassification);

const entry = (filename: string) =>
  classification.Entry.createFrom({
    filename,
    folder: "",
    confidence: "",
    note: "",
  });

function makeLoadResult(mtime = 100) {
  return classification.LoadResult.createFrom({
    folderPath: "A",
    entries: [entry("a.png"), entry("b.png")],
    orphans: [],
    hasSidecar: true,
    source: "json",
    mtime,
    fileTimes: {},
  });
}

const emptyFilter = {
  tags: [] as string[],
  untaggedOnly: false,
  confidence: "all" as const,
  query: "",
};

function setup(
  over: Partial<{
    sortMode: typeof SORT_MANUAL | typeof SORT_NAME_ASC;
    filter: typeof emptyFilter;
    folder: string;
    reorderMode: boolean;
    editSaveInFlight: number;
  }> = {},
) {
  const folderRef = { current: over.folder ?? "A" };
  const requestGenRef = { current: 0 };
  const loadResultRef = { current: makeLoadResult() };
  const reorderModeRef = { current: over.reorderMode ?? true };
  const editSaveInFlightRef = { current: over.editSaveInFlight ?? 0 };
  const setReorderMode = vi.fn();
  const setLoadResult = vi.fn();
  const clearSelected = vi.fn();
  const reload = vi.fn(async () => {});
  const toast = vi.fn();
  const props = {
    sortMode: over.sortMode ?? SORT_MANUAL,
    filter: over.filter ?? emptyFilter,
    folderRef,
    requestGenRef,
    loadResultRef,
    reorderModeRef,
    editSaveInFlightRef,
    setReorderMode,
    setLoadResult,
    clearSelected,
    reload,
    toast,
  } as unknown as Parameters<typeof useClassificationReorder>[0];
  const { result } = renderHook(() => useClassificationReorder(props));
  return {
    result,
    folderRef,
    requestGenRef,
    loadResultRef,
    reorderModeRef,
    setReorderMode,
    setLoadResult,
    clearSelected,
    reload,
    toast,
  };
}

beforeEach(() => {
  mockSave.mockReset();
});

describe("enterReorderMode", () => {
  it("enters only when manual sort + no filter, clearing selection", () => {
    const s = setup();
    act(() => s.result.current.enterReorderMode());
    expect(s.clearSelected).toHaveBeenCalledTimes(1);
    expect(s.setReorderMode).toHaveBeenCalledWith(true);
  });

  it("refuses when the entry condition fails (double defense vs disabled UI)", () => {
    const bySort = setup({ sortMode: SORT_NAME_ASC });
    act(() => bySort.result.current.enterReorderMode());
    expect(bySort.setReorderMode).not.toHaveBeenCalled();

    const byFilter = setup({ filter: { ...emptyFilter, query: "x" } });
    act(() => byFilter.result.current.enterReorderMode());
    expect(byFilter.setReorderMode).not.toHaveBeenCalled();
  });
});

describe("commitReorder", () => {
  const newEntries = [entry("b.png"), entry("a.png")];

  it("optimistically commits then saves with the captured mtime", async () => {
    mockSave.mockResolvedValue(
      classification.SaveOutput.createFrom({ mtime: 200 }),
    );
    const s = setup();
    await act(() => s.result.current.commitReorder(newEntries));
    expect(mockSave).toHaveBeenCalledWith("A", newEntries, 100);
    // 楽観 commit (entries) + 成功後の mtime patch で setLoadResult は 2 回。
    expect(s.setLoadResult).toHaveBeenCalledTimes(2);
    // 楽観 commit 前 + mtime patch 前の 2 回 gen bump (in-flight Load の stale 化)。
    expect(s.requestGenRef.current).toBe(2);
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("skips entirely when reorder mode is already off (late drop)", async () => {
    const s = setup({ reorderMode: false });
    await act(() => s.result.current.commitReorder(newEntries));
    expect(mockSave).not.toHaveBeenCalled();
    expect(s.setLoadResult).not.toHaveBeenCalled();
  });

  it("skips (no optimistic commit) while an edit save is in flight", async () => {
    const s = setup({ editSaveInFlight: 1 });
    await act(() => s.result.current.commitReorder(newEntries));
    expect(mockSave).not.toHaveBeenCalled();
    expect(s.setLoadResult).not.toHaveBeenCalled();
  });

  it("reloads and warns on CONFLICT (no conflict dialog for reorder)", async () => {
    mockSave.mockRejectedValue(new Error("CONFLICT: mtime mismatch"));
    const s = setup();
    await act(() => s.result.current.commitReorder(newEntries));
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining("競合"), "warn");
  });

  it("reloads and errors on other failures", async () => {
    mockSave.mockRejectedValue(new Error("disk full"));
    const s = setup();
    await act(() => s.result.current.commitReorder(newEntries));
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.toast).toHaveBeenCalledWith(
      expect.stringContaining("保存に失敗"),
      "error",
    );
  });

  it("drops the post-save commit when the folder changed during await", async () => {
    let resolveSave: (v: classification.SaveOutput) => void = () => {};
    mockSave.mockImplementation(
      () =>
        new Promise<classification.SaveOutput>((res) => {
          resolveSave = res;
        }),
    );
    const s = setup();
    let done: Promise<void> | null = null;
    act(() => {
      done = s.result.current.commitReorder(newEntries);
    });
    // 楽観 commit は走っている。
    expect(s.setLoadResult).toHaveBeenCalledTimes(1);
    s.folderRef.current = "B";
    await act(async () => {
      resolveSave(classification.SaveOutput.createFrom({ mtime: 200 }));
      await done;
    });
    // folder gate により mtime patch (2 回目の setLoadResult) は走らない。
    expect(s.setLoadResult).toHaveBeenCalledTimes(1);
  });
});
