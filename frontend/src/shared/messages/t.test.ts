import { afterEach, describe, expect, it, vi } from "vitest"
import { ja } from "./ja"
import { t, type MessageKey } from "./t"

describe("t(): interpolation", () => {
  it("fills {placeholder} tokens from params", () => {
    expect(t("settings.tagColors.summary.override", { count: 3 })).toBe(
      "現在のパレット (3 件の上書きを適用済み)。",
    )
  })

  it("coerces number params to string", () => {
    expect(t("dialog.merge.count", { nonEmpty: 2, total: 5 })).toBe("2 / 5 件")
  })

  it("returns the template unchanged when no params are given", () => {
    expect(t("common.cancel")).toBe("キャンセル")
  })

  it("returns a parameterless template verbatim even if params are passed", () => {
    expect(t("common.cancel", { unused: "x" })).toBe("キャンセル")
  })

  it("leaves a placeholder verbatim when its param is missing", () => {
    // params provided but `hint` absent — degrade to visible {hint}, not a throw
    expect(t("settings.logging.level.hint", {})).toBe(
      "現在: {hint}。DEBUG は高頻度イベントも記録するためトラブルシュート時のみ推奨。",
    )
  })

  it("ignores extra params not referenced by the template", () => {
    expect(
      t("settings.appearance.scale.hint.custom", { percent: 105, extra: "ignored" }),
    ).toBe(
      "現在 105% (settings.json で個別指定中)。標準のタイル以外を使いたい場合は settings.json の uiScalePercent を編集してください (範囲外は読み込み時に既定値へ戻ります)。",
    )
  })
})

describe("t(): missing key guard", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns a visible sentinel and warns for an unknown key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // Only reachable via a force-cast; MessageKey normally blocks this.
    expect(t("nope.not.a.key" as MessageKey)).toBe("__MISSING:nope.not.a.key__")
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe("catalog integrity", () => {
  it("has a non-empty string for every key", () => {
    for (const [key, value] of Object.entries(ja)) {
      expect(typeof value, key).toBe("string")
      expect(value.length, key).toBeGreaterThan(0)
    }
  })
})
