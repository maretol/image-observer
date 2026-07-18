// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateClassificationEntry } from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import { useClassificationEdit } from "./useClassificationEdit";

// Mock the Wails binding so saveEdit's folder gate (#110 C) can be exercised
// without a Go backend. We assert *whether* the IPC fired and with which
// folder/mtime, plus whether the local state commit ran.
vi.mock("../../../wailsjs/go/main/App", () => ({
  UpdateClassificationEntry: vi.fn(),
  // logger.warn/error (hit on the conflict/error paths) fire LogEvent and
  // .catch() its result, so the mock must return a resolved promise.
  LogEvent: vi.fn(() => Promise.resolve()),
}));
const mockUpdate = vi.mocked(UpdateClassificationEntry);

function makeEntry(filename = "a.png") {
  return classification.Entry.createFrom({
    filename,
    folder: "alice",
    confidence: "high",
    note: "",
  });
}

function makeLoadResult(mtime = 1) {
  return classification.LoadResult.createFrom({
    folderPath: "A",
    entries: [makeEntry()],
    orphans: [],
    hasSidecar: true,
    source: "sidecar",
    mtime,
  });
}

// Build the hook props with controllable refs + spy setters. Cast to the hook's
// (un-exported) Props shape — vi.fn()s stand in for the dispatch/toast fns.
function setup(currentFolder = "A", baselineMtime = 1) {
  const folderRef = { current: currentFolder };
  const loadResultRef = { current: makeLoadResult(baselineMtime) };
  const requestGenRef = { current: 0 };
  const editSaveInFlightRef = { current: 0 };
  const setLoadResult = vi.fn();
  const setEditing = vi.fn();
  const setConflict = vi.fn();
  const reload = vi.fn(async () => {});
  const toast = vi.fn();
  const props = {
    conflict: null,
    loadResultRef,
    folderRef,
    requestGenRef,
    editSaveInFlightRef,
    setLoadResult,
    setEditing,
    setConflict,
    reload,
    toast,
  } as unknown as Parameters<typeof useClassificationEdit>[0];
  const { result } = renderHook(() => useClassificationEdit(props));
  return {
    result,
    folderRef,
    requestGenRef,
    editSaveInFlightRef,
    setLoadResult,
    setEditing,
    setConflict,
  };
}

beforeEach(() => {
  mockUpdate.mockReset();
});

describe("useClassificationEdit.saveEdit — folder gate (#110 C)", () => {
  it("writes to ctx.folder with the fresh mtime and commits when still on it", async () => {
    mockUpdate.mockResolvedValue({ mtime: 2 } as classification.SaveOutput);
    const t = setup("A", 1);
    await t.result.current.saveEdit(makeEntry(), { folder: "A" });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // folder arg = ctx.folder; mtime arg = loadResultRef.current.mtime (fresh).
    expect(mockUpdate).toHaveBeenCalledWith("A", expect.anything(), 1);
    expect(t.setLoadResult).toHaveBeenCalledTimes(1);
    expect(t.setEditing).toHaveBeenCalledWith({ open: false, filename: null });
    expect(t.requestGenRef.current).toBe(1); // generation bumped on commit
  });

  it("pre-IPC skip: no IPC when the user already switched away from ctx.folder", async () => {
    const t = setup("B", 1); // current folder is B
    await t.result.current.saveEdit(makeEntry(), { folder: "A" }); // save belongs to A
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(t.setLoadResult).not.toHaveBeenCalled();
    expect(t.requestGenRef.current).toBe(0);
  });

  it("pre-IPC skip: an empty ctx.folder is never saved", async () => {
    const t = setup("", 1);
    await t.result.current.saveEdit(makeEntry(), { folder: "" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("post-IPC skip: a mid-await folder switch suppresses the local commit (but the disk write happened)", async () => {
    let resolveUpdate!: (v: classification.SaveOutput) => void;
    mockUpdate.mockReturnValue(
      new Promise<classification.SaveOutput>((r) => {
        resolveUpdate = r;
      }),
    );
    const t = setup("A", 1);
    const pending = t.result.current.saveEdit(makeEntry(), { folder: "A" });
    // user switches folders while the IPC is in flight
    t.folderRef.current = "B";
    resolveUpdate({ mtime: 2 } as classification.SaveOutput);
    await pending;
    expect(mockUpdate).toHaveBeenCalledTimes(1); // OLD folder's disk write is fine
    expect(t.setLoadResult).not.toHaveBeenCalled(); // but local commit is skipped
    expect(t.setEditing).not.toHaveBeenCalled();
  });

  it("routes a CONFLICT: response to setConflict while still on ctx.folder", async () => {
    mockUpdate.mockRejectedValue(new Error("CONFLICT: mtime mismatch"));
    const t = setup("A", 1);
    await t.result.current.saveEdit(makeEntry("x.png"), { folder: "A" });
    expect(t.setConflict).toHaveBeenCalledWith({
      filename: "x.png",
      draft: expect.anything(),
    });
  });
});
