import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Wails binding before importing logger so logger picks up the mock.
const logEventMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../../wailsjs/go/main/App", () => ({
  LogEvent: (level: string, cat: string, msg: string, data: string) =>
    logEventMock(level, cat, msg, data),
}));

// Import after the mock is registered.
const { logger } = await import("./logger");

beforeEach(() => {
  logger._resetForTests();
  logEventMock.mockClear();
});

afterEach(() => {
  logger._resetForTests();
});

describe("logger", () => {
  it("pushes every level to the ring buffer", () => {
    logger.debug("cat", "d");
    logger.info("cat", "i");
    logger.warn("cat", "w");
    logger.error("cat", "e");
    const snap = logger._ringSnapshot();
    expect(snap.map((s) => s.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("forwards INFO/WARN/ERROR to Go but skips DEBUG", () => {
    logger.debug("cat", "d");
    logger.info("cat", "i");
    logger.warn("cat", "w");
    logger.error("cat", "e");
    const calls = logEventMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["info", "warn", "error"]);
  });

  it("serializes structured data as JSON", () => {
    logger.warn("dnd", "panel limit", { panels: 16 });
    expect(logEventMock).toHaveBeenCalledWith(
      "warn",
      "dnd",
      "panel limit",
      JSON.stringify({ panels: 16 }),
    );
  });

  it("passes empty data when omitted", () => {
    logger.info("app", "starting");
    expect(logEventMock).toHaveBeenCalledWith("info", "app", "starting", "");
  });

  it("ring buffer caps entries (oldest evicted)", () => {
    for (let i = 0; i < 250; i++) logger.debug("c", `m${i}`);
    const snap = logger._ringSnapshot();
    expect(snap.length).toBe(200);
    expect(snap[0].msg).toBe("m50"); // 0..49 evicted
    expect(snap[snap.length - 1].msg).toBe("m249");
  });

  it("flushAll sends the ring as one INFO line tagged js.flush", () => {
    logger.debug("c", "x");
    logger.debug("c", "y");
    logger.flushAll("test");
    const last = logEventMock.mock.calls.at(-1);
    expect(last?.[0]).toBe("info");
    expect(last?.[1]).toBe("js.flush");
    expect(last?.[2]).toContain("ring buffer dump");
    expect(last?.[2]).toContain("reason=test");
    // The JSON payload should be parseable and contain the entries we pushed.
    const parsed = JSON.parse(last?.[3] as string);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].msg).toBe("x");
  });

  it("survives unserializable data (no throw)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logger.warn("cat", "msg", cyclic)).not.toThrow();
    // The IPC call still fires with some string fallback.
    expect(logEventMock).toHaveBeenCalled();
  });
});
