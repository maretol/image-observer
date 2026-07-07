// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckDuplicates,
  DismissDuplicatePair,
} from "../../../wailsjs/go/main/App";
import { classification, imghash } from "../../../wailsjs/go/models";
import { useDuplicateCheck } from "./useDuplicateCheck";

// Wails binding を mock し、kick の有無 / 引数 / gate (gen / folder / mode) を Go なしで検証する
// (useClassificationEdit.test.ts と同じ流儀, #110 B)。
vi.mock("../../../wailsjs/go/main/App", () => ({
  CheckDuplicates: vi.fn(),
  DismissDuplicatePair: vi.fn(),
  // logger.warn/error は LogEvent を fire-and-forget するので resolved promise を返す。
  LogEvent: vi.fn(() => Promise.resolve()),
}));
const mockCheck = vi.mocked(CheckDuplicates);
const mockDismiss = vi.mocked(DismissDuplicatePair);

function loadResultOf(folder: string, filenames: string[]) {
  return classification.LoadResult.createFrom({
    folderPath: folder,
    entries: filenames.map((f) => ({
      filename: f,
      folder: "",
      confidence: "",
      note: "",
    })),
    orphans: [],
    hasSidecar: true,
    source: "json",
    mtime: 1,
  });
}

function reportOf(
  folder: string,
  pairs: Array<[string, string, number]>,
): imghash.DuplicateReport {
  return imghash.DuplicateReport.createFrom({
    folderPath: folder,
    pairs: pairs.map(([fileA, fileB, distance]) => ({
      fileA,
      fileB,
      distance,
    })),
    skipped: [],
  });
}

// 解決タイミングを手動制御する deferred (stale-gen / folder-switch の窓を作る)。
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeProps(folder = "/A", filenames = ["a.png", "b.png"]) {
  return {
    folderPath: folder,
    folderRef: { current: folder },
    loadResult: loadResultOf(folder, filenames),
    duplicateDetectMode: "auto" as string | undefined,
    duplicateThreshold: 5 as number | undefined,
    toast: vi.fn(),
  };
}

beforeEach(() => {
  mockCheck.mockReset();
  mockDismiss.mockReset();
});

describe("useDuplicateCheck kick", () => {
  it("mode=auto で entries が 2 件以上なら Check を kick し pairs を commit する", async () => {
    mockCheck.mockResolvedValue(reportOf("/A", [["a.png", "b.png", 2]]));
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: makeProps(),
    });
    await waitFor(() => {
      expect(result.current.duplicatePairs).toHaveLength(1);
    });
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(mockCheck).toHaveBeenCalledWith("/A", ["a.png", "b.png"]);
  });

  it("settings ロード中 (mode undefined) は kick しない", () => {
    const props = makeProps();
    props.duplicateDetectMode = undefined;
    renderHook((p) => useDuplicateCheck(p), { initialProps: props });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("mode=off は kick せず report をクリアする", async () => {
    mockCheck.mockResolvedValue(reportOf("/A", [["a.png", "b.png", 2]]));
    const props = makeProps();
    const { result, rerender } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    await waitFor(() => {
      expect(result.current.duplicatePairs).toHaveLength(1);
    });
    rerender({ ...props, duplicateDetectMode: "off" });
    expect(result.current.duplicatePairs).toBeNull();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("entries が 1 件以下なら IPC を出さず空 report にする", () => {
    const props = makeProps("/A", ["only.png"]);
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(result.current.duplicatePairs).toEqual([]);
  });

  it("loadResult が旧 folder のもの (切替直後の残留) の間は kick しない", () => {
    const props = makeProps();
    props.folderPath = "/B";
    props.folderRef.current = "/B";
    // loadResult は /A のまま (新 Load 未着)。
    renderHook((p) => useDuplicateCheck(p), { initialProps: props });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("filename 集合が同じならメタデータ編集 (entries identity 変化) で再 kick しない", async () => {
    mockCheck.mockResolvedValue(reportOf("/A", []));
    const props = makeProps();
    const { rerender } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
    rerender({ ...props, loadResult: loadResultOf("/A", ["a.png", "b.png"]) });
    await Promise.resolve();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("notifyContentChanged (同名上書き) は filename 集合が不変でも再 kick する", async () => {
    mockCheck.mockResolvedValue(reportOf("/A", []));
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: makeProps(),
    });
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.notifyContentChanged();
    });
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(2));
    expect(mockCheck).toHaveBeenLastCalledWith("/A", ["a.png", "b.png"]);
  });

  it("区切り文字を含む filename も分解されず配列のまま IPC に渡る", async () => {
    mockCheck.mockResolvedValue(reportOf("/A", []));
    renderHook((p) => useDuplicateCheck(p), {
      initialProps: makeProps("/A", ["a\nb.png", "c.png"]),
    });
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
    expect(mockCheck).toHaveBeenCalledWith("/A", ["a\nb.png", "c.png"]);
  });
});

describe("useDuplicateCheck gates (AGENTS.md H-8)", () => {
  it("stale gen: 後発 kick が in-flight の先発結果を破棄する", async () => {
    const first = deferred<imghash.DuplicateReport>();
    const second = deferred<imghash.DuplicateReport>();
    mockCheck
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const props = makeProps();
    const { result, rerender } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    // entries 追加で 2 回目の kick (gen bump)。
    rerender({
      ...props,
      loadResult: loadResultOf("/A", ["a.png", "b.png", "c.png"]),
    });
    expect(mockCheck).toHaveBeenCalledTimes(2);
    // 先発 (stale) が後着で resolve しても commit されない。
    await act(async () => {
      first.resolve(reportOf("/A", [["stale.png", "x.png", 0]]));
    });
    expect(result.current.duplicatePairs).toBeNull();
    await act(async () => {
      second.resolve(reportOf("/A", [["a.png", "c.png", 1]]));
    });
    expect(result.current.duplicatePairs).toEqual([
      expect.objectContaining({ fileA: "a.png", fileB: "c.png" }),
    ]);
  });

  it("folder check: await 中に folderRef が変わったら結果を捨てる", async () => {
    const d = deferred<imghash.DuplicateReport>();
    mockCheck.mockReturnValueOnce(d.promise);
    const props = makeProps();
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    props.folderRef.current = "/B"; // openFolder の render-time sync を模す
    await act(async () => {
      d.resolve(reportOf("/A", [["a.png", "b.png", 0]]));
    });
    expect(result.current.duplicatePairs).toBeNull();
  });

  it("post-await mode check: await 中に off へ切り替えたら結果を捨てる", async () => {
    const d = deferred<imghash.DuplicateReport>();
    mockCheck.mockReturnValueOnce(d.promise);
    const props = makeProps();
    const { result, rerender } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    rerender({ ...props, duplicateDetectMode: "off" });
    await act(async () => {
      d.resolve(reportOf("/A", [["a.png", "b.png", 0]]));
    });
    expect(result.current.duplicatePairs).toBeNull();
  });

  it("Check 失敗はログのみ (toast なし) で前回 report を保持する", async () => {
    mockCheck.mockResolvedValueOnce(reportOf("/A", [["a.png", "b.png", 2]]));
    const props = makeProps();
    const { result, rerender } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    await waitFor(() => {
      expect(result.current.duplicatePairs).toHaveLength(1);
    });
    mockCheck.mockRejectedValueOnce(new Error("boom"));
    rerender({
      ...props,
      loadResult: loadResultOf("/A", ["a.png", "b.png", "c.png"]),
    });
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current.duplicatePairs).toHaveLength(1);
    expect(props.toast).not.toHaveBeenCalled();
  });

  it("resetDuplicates は report をクリアし in-flight を stale 化する", async () => {
    const d = deferred<imghash.DuplicateReport>();
    mockCheck.mockReturnValueOnce(d.promise);
    const props = makeProps();
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    act(() => {
      result.current.resetDuplicates();
    });
    await act(async () => {
      d.resolve(reportOf("/A", [["a.png", "b.png", 0]]));
    });
    expect(result.current.duplicatePairs).toBeNull();
  });
});

describe("dismissDuplicatePair", () => {
  it("成功でペアを local 除去する (gen は据え置き)", async () => {
    mockCheck.mockResolvedValue(
      reportOf("/A", [
        ["a.png", "b.png", 2],
        ["b.png", "c.png", 3],
      ]),
    );
    mockDismiss.mockResolvedValue(undefined);
    const props = makeProps("/A", ["a.png", "b.png", "c.png"]);
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    await waitFor(() => {
      expect(result.current.duplicatePairs).toHaveLength(2);
    });
    await act(async () => {
      await result.current.dismissDuplicatePair("a.png", "b.png");
    });
    expect(mockDismiss).toHaveBeenCalledWith("/A", "a.png", "b.png");
    expect(result.current.duplicatePairs).toEqual([
      expect.objectContaining({ fileA: "b.png", fileB: "c.png" }),
    ]);
  });

  it("失敗は error toast + report 据え置き", async () => {
    mockCheck.mockResolvedValue(reportOf("/A", [["a.png", "b.png", 2]]));
    mockDismiss.mockRejectedValue(new Error("disk full"));
    const props = makeProps();
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    await waitFor(() => {
      expect(result.current.duplicatePairs).toHaveLength(1);
    });
    await act(async () => {
      await result.current.dismissDuplicatePair("a.png", "b.png");
    });
    expect(props.toast).toHaveBeenCalledWith(
      "ダブり除外の保存に失敗しました (詳細はログ)",
      "error",
    );
    expect(result.current.duplicatePairs).toHaveLength(1);
  });

  it("await 中の folder 切替では現 report を触らない", async () => {
    mockCheck.mockResolvedValue(reportOf("/A", [["a.png", "b.png", 2]]));
    const dismissDeferred = deferred<void>();
    mockDismiss.mockReturnValueOnce(dismissDeferred.promise);
    const props = makeProps();
    const { result } = renderHook((p) => useDuplicateCheck(p), {
      initialProps: props,
    });
    await waitFor(() => {
      expect(result.current.duplicatePairs).toHaveLength(1);
    });
    const dismissing = result.current.dismissDuplicatePair("a.png", "b.png");
    props.folderRef.current = "/B";
    await act(async () => {
      dismissDeferred.resolve();
      await dismissing;
    });
    expect(result.current.duplicatePairs).toHaveLength(1);
  });
});
