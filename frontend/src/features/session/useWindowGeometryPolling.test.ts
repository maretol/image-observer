// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { state } from "../../../wailsjs/go/models";

// Mock the Wails runtime before importing the hook so it picks up the mocks.
// Environment().platform drives the Windows gate (issue #129); the Window*
// getters back the #86 polling path.
const environmentMock = vi.fn();
const windowGetSizeMock = vi.fn();
const windowGetPositionMock = vi.fn();
const windowIsMaximisedMock = vi.fn();
vi.mock("../../../wailsjs/runtime/runtime", () => ({
  Environment: () => environmentMock(),
  WindowGetSize: () => windowGetSizeMock(),
  WindowGetPosition: () => windowGetPositionMock(),
  WindowIsMaximised: () => windowIsMaximisedMock(),
}));

const { useWindowGeometryPolling } = await import("./useWindowGeometryPolling");

const initial = (): state.WindowState =>
  ({ width: 800, height: 600, x: 50, y: 60, maximized: false }) as unknown as state.WindowState;
const initialShape = { width: 800, height: 600, x: 50, y: 60, maximized: false };

// flush lets pending promise jobs (Environment().then chain) run to completion.
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.clearAllMocks();
});

describe("useWindowGeometryPolling", () => {
  it("does not poll on windows and returns the loaded initial value (issue #129)", async () => {
    environmentMock.mockResolvedValue({ platform: "windows" });

    const { result } = renderHook(() =>
      useWindowGeometryPolling({ initial: initial() }),
    );
    await waitFor(() => expect(environmentMock).toHaveBeenCalled());
    await flush();

    expect(windowIsMaximisedMock).not.toHaveBeenCalled();
    expect(windowGetSizeMock).not.toHaveBeenCalled();
    expect(windowGetPositionMock).not.toHaveBeenCalled();
    expect(result.current).toEqual(initialShape);
  });

  it("polls and updates geometry on non-windows (issue #86 preserved)", async () => {
    environmentMock.mockResolvedValue({ platform: "linux" });
    windowIsMaximisedMock.mockResolvedValue(false);
    windowGetSizeMock.mockResolvedValue({ w: 1280, h: 1024 });
    windowGetPositionMock.mockResolvedValue({ x: 100, y: 200 });

    const { result } = renderHook(() =>
      useWindowGeometryPolling({ initial: initial() }),
    );

    await waitFor(() =>
      expect(result.current).toEqual({
        width: 1280,
        height: 1024,
        x: 100,
        y: 200,
        maximized: false,
      }),
    );
  });

  it("retries Environment() and recovers from a transient failure", async () => {
    // A single early reject must NOT permanently disable #86 polling (issue
    // #129 review): the hook retries until Environment() resolves.
    environmentMock
      .mockRejectedValueOnce(new Error("runtime not ready"))
      .mockResolvedValue({ platform: "linux" });
    windowIsMaximisedMock.mockResolvedValue(false);
    windowGetSizeMock.mockResolvedValue({ w: 1280, h: 1024 });
    windowGetPositionMock.mockResolvedValue({ x: 100, y: 200 });

    const { result } = renderHook(() =>
      useWindowGeometryPolling({ initial: initial() }),
    );

    await waitFor(
      () =>
        expect(result.current).toEqual({
          width: 1280,
          height: 1024,
          x: 100,
          y: 200,
          maximized: false,
        }),
      { timeout: 2000 },
    );
    expect(environmentMock.mock.calls.length).toBeGreaterThanOrEqual(2); // retried
  });

  it("gives up without polling when Environment() never resolves", async () => {
    vi.useFakeTimers();
    try {
      environmentMock.mockRejectedValue(new Error("runtime not ready"));

      const { result } = renderHook(() =>
        useWindowGeometryPolling({ initial: initial() }),
      );
      // Drive every retry + delay to completion (well past the retry budget).
      await vi.advanceTimersByTimeAsync(5000);

      expect(windowGetSizeMock).not.toHaveBeenCalled();
      expect(result.current).toEqual(initialShape);
    } finally {
      vi.useRealTimers();
    }
  });
});
