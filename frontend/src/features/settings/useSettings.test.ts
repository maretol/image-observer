// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetSettings,
  ResetSettings,
  UpdateSettings,
} from "../../../wailsjs/go/main/App";
import { settings } from "../../../wailsjs/go/models";
import { useSettings } from "./useSettings";

vi.mock("../../../wailsjs/go/main/App", () => ({
  GetSettings: vi.fn(),
  UpdateSettings: vi.fn(),
  ResetSettings: vi.fn(),
  // logger が LogEvent を fire して .catch() するので resolved promise を返す。
  LogEvent: vi.fn(() => Promise.resolve()),
}));
const mockGet = vi.mocked(GetSettings);
const mockUpdate = vi.mocked(UpdateSettings);
const mockReset = vi.mocked(ResetSettings);

function baseSettings(): settings.SettingsData {
  return settings.SettingsData.createFrom({
    version: 1,
    logLevel: "info",
    multiSelectMode: "checkbox",
    wheelMode: "zoom",
    maxImagePixelsMP: 200,
    thumbnailSize: 256,
    thumbnailMode: "letterbox",
    thumbnailWorkerCount: 0,
    tagColors: {},
    uiScalePercent: 100,
    watchMode: "auto",
    editAutoSave: true,
    duplicateDetectMode: "auto",
    duplicateThreshold: 5,
    maxViewers: 8,
  });
}

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue(baseSettings());
  mockUpdate.mockReset();
  mockReset.mockReset();
});

async function setupLoaded() {
  const rendered = renderHook(() => useSettings());
  await waitFor(() => expect(rendered.result.current.data).not.toBeNull());
  return rendered;
}

describe("useSettings.update — 直列化 (spec-viewer-max-count.md §13.2)", () => {
  it("merges a second update onto the first save's result, not the stale snapshot", async () => {
    // 1 発目 (maxViewers 8→3) を in-flight のまま保持し、その間に 2 発目 (wheelMode) を発行。
    // 旧実装 (closure の data から merge + 直列化なし) だと 2 発目の payload は maxViewers=8 の
    // ままになり、後着応答が 1 発目の変更を silent に上書きしていた (lost update)。
    let releaseFirst!: () => void;
    mockUpdate
      .mockImplementationOnce(
        (s) =>
          new Promise((res) => {
            releaseFirst = () => res(s);
          }),
      )
      .mockImplementation((s) => Promise.resolve(s));

    const { result } = await setupLoaded();
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.update({ maxViewers: 3 });
      p2 = result.current.update({ wheelMode: "shift-zoom" });
    });
    // 直列化: 1 発目が未解決の間、2 発目の IPC は発火しない。
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    act(() => releaseFirst());
    await act(async () => {
      await Promise.all([p1, p2]);
    });

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    const second = mockUpdate.mock.calls[1][0];
    expect(second.maxViewers).toBe(3); // 1 発目の保存結果を引き継ぐ
    expect(second.wheelMode).toBe("shift-zoom");
    expect(result.current.data?.maxViewers).toBe(3);
    expect(result.current.data?.wheelMode).toBe("shift-zoom");
  });

  it("a failed update does not kill the queue for subsequent updates", async () => {
    mockUpdate
      .mockRejectedValueOnce(new Error("validate: out of range"))
      .mockImplementation((s) => Promise.resolve(s));

    const { result } = await setupLoaded();
    await act(async () => {
      await result.current.update({ maxViewers: 99 });
    });
    expect(result.current.error).not.toBeNull();
    await act(async () => {
      await result.current.update({ maxViewers: 16 });
    });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.data?.maxViewers).toBe(16);
  });

  it("reset goes through the same queue and updates the merge base", async () => {
    mockUpdate.mockImplementation((s) => Promise.resolve(s));
    mockReset.mockResolvedValue(baseSettings());

    const { result } = await setupLoaded();
    await act(async () => {
      await result.current.update({ maxViewers: 3 });
      await result.current.reset();
      await result.current.update({ wheelMode: "shift-zoom" });
    });
    // reset 後の update は defaults (maxViewers 8) を base に merge する。
    const last = mockUpdate.mock.calls[1][0];
    expect(last.maxViewers).toBe(8);
    expect(last.wheelMode).toBe("shift-zoom");
  });
});
