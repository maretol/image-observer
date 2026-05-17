import { describe, expect, it } from "vitest";
import {
  decideAutoMerge,
  formatChangeSummary,
  type AutoMergeContext,
  type ChangedPayload,
} from "./watcherPolicy";

const baseCtx = (over: Partial<AutoMergeContext> = {}): AutoMergeContext => ({
  editingOpen: false,
  editingFilename: null,
  conflictOpen: false,
  mergePromptOpen: false,
  freshFilenames: new Set(["a.png", "b.jpg"]),
  ...over,
});

const payload = (over: Partial<ChangedPayload> = {}): ChangedPayload => ({
  folder: "/test",
  addedFiles: 0,
  removedFiles: 0,
  renamedFiles: 0,
  sidecarChanged: false,
  ...over,
});

describe("formatChangeSummary", () => {
  it("returns files-only message when sidecar untouched", () => {
    const msg = formatChangeSummary(payload({ addedFiles: 3, removedFiles: 1 }));
    expect(msg).toMatch(/フォルダの変更を検出/);
    expect(msg).toContain("+3");
    expect(msg).toContain("-1");
    expect(msg).not.toMatch(/分類データ/);
  });

  it("returns sidecar-only message when files untouched", () => {
    const msg = formatChangeSummary(payload({ sidecarChanged: true }));
    expect(msg).toBe("分類データが外部で更新されました");
  });

  it("returns combined message when both changed", () => {
    const msg = formatChangeSummary(
      payload({ addedFiles: 2, removedFiles: 0, sidecarChanged: true }),
    );
    expect(msg).toMatch(/フォルダと分類データ/);
    expect(msg).toContain("+2");
    expect(msg).toContain("-0");
  });

  it("returns null on a fully empty payload (defensive)", () => {
    expect(formatChangeSummary(payload())).toBeNull();
  });
});

describe("decideAutoMerge", () => {
  it("commits when no defer state is active", () => {
    const out = decideAutoMerge(baseCtx());
    expect(out).toEqual({ kind: "commit" });
  });

  it("defers when mergePrompt is open", () => {
    const out = decideAutoMerge(baseCtx({ mergePromptOpen: true }));
    expect(out).toEqual({ kind: "defer" });
  });

  it("defers when conflict dialog is open", () => {
    const out = decideAutoMerge(baseCtx({ conflictOpen: true }));
    expect(out).toEqual({ kind: "defer" });
  });

  it("defers when editing is open and the target still exists", () => {
    // Per spec-folder-watch.md §13.8 we must defer rather than commit here:
    // committing would refresh loadResult.mtime to the just-bumped external
    // value, and the user's next save (still based on their pre-edit mtime
    // snapshot) would slip past the conflict-detection check.
    const out = decideAutoMerge(
      baseCtx({
        editingOpen: true,
        editingFilename: "a.png",
        freshFilenames: new Set(["a.png", "b.jpg"]),
      }),
    );
    expect(out).toEqual({ kind: "defer" });
  });

  it("commit-editing-removed when editing target is gone", () => {
    const out = decideAutoMerge(
      baseCtx({
        editingOpen: true,
        editingFilename: "a.png",
        freshFilenames: new Set(["b.jpg"]),
      }),
    );
    expect(out).toEqual({ kind: "commit-editing-removed", filename: "a.png" });
  });

  it("editing-removed yields to mergePrompt deferral (defer wins)", () => {
    const out = decideAutoMerge(
      baseCtx({
        editingOpen: true,
        editingFilename: "gone.png",
        mergePromptOpen: true,
        freshFilenames: new Set(["b.jpg"]),
      }),
    );
    expect(out).toEqual({ kind: "defer" });
  });

  it("editing-removed yields to conflict deferral (defer wins)", () => {
    const out = decideAutoMerge(
      baseCtx({
        editingOpen: true,
        editingFilename: "gone.png",
        conflictOpen: true,
        freshFilenames: new Set(["b.jpg"]),
      }),
    );
    expect(out).toEqual({ kind: "defer" });
  });
});
