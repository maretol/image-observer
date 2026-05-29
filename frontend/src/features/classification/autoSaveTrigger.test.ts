import { describe, expect, it } from "vitest";
import { classification } from "../../../wailsjs/go/models";
import { shouldAutoSave } from "./autoSaveTrigger";

const sampleEntry = classification.Entry.createFrom({
  filename: "a.png",
  folder: "alice",
  confidence: "high",
  note: "",
});

describe("shouldAutoSave", () => {
  it("fires only when autoSave + entry + dirty all hold", () => {
    expect(shouldAutoSave(true, sampleEntry, true)).toBe(true);
  });

  it("skips when autoSave is off (manual mode)", () => {
    expect(shouldAutoSave(false, sampleEntry, true)).toBe(false);
  });

  it("skips when entry is null (no baseline to save against)", () => {
    expect(shouldAutoSave(true, null, true)).toBe(false);
  });

  it("skips when not dirty (avoids burning IPC on refocus)", () => {
    expect(shouldAutoSave(true, sampleEntry, false)).toBe(false);
  });
});
