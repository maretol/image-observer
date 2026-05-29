import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPreviewCacheForTests,
  evictPreview,
  getCachedPreview,
  PREVIEW_CACHE_CAPACITY,
  setCachedPreview,
} from "./previewCache";
import { PREVIEW_REVOKE_DELAY_MS } from "../../shared/utils/thumbnailDefaults";

// URL.{createObjectURL,revokeObjectURL} は jsdom 未導入のため毎テストで
// stub する。本番コードからは createObjectURL を呼ばないが、念のため両方
// 用意して、revokeObjectURL は spy として呼び出し確認に使う。
let revokeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  revokeSpy = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn((_blob: Blob) => `blob:test-${Math.random()}`),
    revokeObjectURL: revokeSpy,
  });
});

afterEach(() => {
  __resetPreviewCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("previewCache: set / get 基本動作", () => {
  it("setCachedPreview の後 getCachedPreview で hit する", () => {
    const adopted = setCachedPreview("/a.png", "blob:a");
    expect(adopted).toBe(true);
    expect(getCachedPreview("/a.png")).toBe("blob:a");
  });

  it("登録していない path は miss (null) になる", () => {
    expect(getCachedPreview("/missing.png")).toBeNull();
  });
});

describe("previewCache: 同 path 重複登録", () => {
  it("既存があると adopted=false を返し、cache の url は変わらない", () => {
    setCachedPreview("/a.png", "blob:a1");
    const adopted = setCachedPreview("/a.png", "blob:a2");
    expect(adopted).toBe(false);
    expect(getCachedPreview("/a.png")).toBe("blob:a1");
  });

  it("adopted=false 経路で cache 側が新 url を revoke しないことを確認", () => {
    // 呼び出し側が捨てる責任を持つ仕様 (D-9 / D-12) — cache 側は何もしない。
    setCachedPreview("/a.png", "blob:a1");
    setCachedPreview("/a.png", "blob:a2");
    vi.advanceTimersByTime(PREVIEW_REVOKE_DELAY_MS + 10);
    expect(revokeSpy).not.toHaveBeenCalled();
  });
});

describe("previewCache: LRU 容量超過時の evict", () => {
  it("CAPACITY+1 件登録すると最も古い url が遅延 revoke される", () => {
    for (let i = 0; i < PREVIEW_CACHE_CAPACITY; i++) {
      setCachedPreview(`/p${i}.png`, `blob:${i}`);
    }
    // 容量ぴったり: まだ evict なし
    vi.advanceTimersByTime(PREVIEW_REVOKE_DELAY_MS + 10);
    expect(revokeSpy).not.toHaveBeenCalled();

    // 1 件追加 → 最古 (p0) が evict
    setCachedPreview("/p_new.png", "blob:new");
    expect(getCachedPreview("/p0.png")).toBeNull();
    expect(getCachedPreview("/p_new.png")).toBe("blob:new");

    // 遅延 revoke の発火確認
    expect(revokeSpy).not.toHaveBeenCalled(); // まだ delay 経過前
    vi.advanceTimersByTime(PREVIEW_REVOKE_DELAY_MS);
    expect(revokeSpy).toHaveBeenCalledWith("blob:0");
  });

  it("getCachedPreview による touch で evict 対象が変わる (LRU 順序)", () => {
    for (let i = 0; i < PREVIEW_CACHE_CAPACITY; i++) {
      setCachedPreview(`/p${i}.png`, `blob:${i}`);
    }
    // 最古の p0 を touch → 最新位置へ
    expect(getCachedPreview("/p0.png")).toBe("blob:0");

    // CAPACITY+1 件目登録 → 次に古い p1 が evict (p0 は守られる)
    setCachedPreview("/p_new.png", "blob:new");
    expect(getCachedPreview("/p0.png")).toBe("blob:0");
    expect(getCachedPreview("/p1.png")).toBeNull();

    vi.advanceTimersByTime(PREVIEW_REVOKE_DELAY_MS);
    expect(revokeSpy).toHaveBeenCalledWith("blob:1");
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:0");
  });
});

describe("previewCache: 明示 evict", () => {
  it("evictPreview で対象 url が遅延 revoke される + cache から消える", () => {
    setCachedPreview("/a.png", "blob:a");
    setCachedPreview("/b.png", "blob:b");

    evictPreview("/a.png");
    expect(getCachedPreview("/a.png")).toBeNull();
    expect(getCachedPreview("/b.png")).toBe("blob:b");

    vi.advanceTimersByTime(PREVIEW_REVOKE_DELAY_MS);
    expect(revokeSpy).toHaveBeenCalledWith("blob:a");
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:b");
  });

  it("存在しない path への evictPreview は no-op で revoke も呼ばない", () => {
    evictPreview("/missing.png");
    vi.advanceTimersByTime(PREVIEW_REVOKE_DELAY_MS + 10);
    expect(revokeSpy).not.toHaveBeenCalled();
  });
});

describe("previewCache: test reset", () => {
  it("__resetPreviewCacheForTests で cache が空になり、全 url が revoke される (同期)", () => {
    setCachedPreview("/a.png", "blob:a");
    setCachedPreview("/b.png", "blob:b");

    __resetPreviewCacheForTests();
    expect(getCachedPreview("/a.png")).toBeNull();
    expect(getCachedPreview("/b.png")).toBeNull();
    // reset は test 用なので即時 revoke (scheduleRevoke を介さない)
    expect(revokeSpy).toHaveBeenCalledWith("blob:a");
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });
});
