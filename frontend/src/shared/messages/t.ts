import { ja } from "./ja"

// カタログ全キーのリテラル union。タイポや削除済みキーが実行時の空文字ではなく
// コンパイルエラーになる。
export type MessageKey = keyof typeof ja

type Params = Record<string, string | number>

/**
 * hook でも context でもない module レベル関数なのは、locale が単一固定で provider
 * を全 render に通すコストが見合わないため (#83 は i18n 前段 / locale 切替は #16,
 * spec-ui-string-catalog.md D-2)。
 *
 * フォールバックは配線ミスを「見えるが無害」に留める用: 未知キー →
 * `__MISSING:<key>__` + warn、param 欠けの `{placeholder}` は素通し。
 */
export function t(key: MessageKey, params?: Params): string {
  // index 型を広げるのは、リテラル型のままだと ja[key] が string になり tsc が
  // === undefined を no-overlap で弾くため (missing key 経路を実行時に残す)。
  const template = (ja as Record<string, string | undefined>)[key]
  if (template === undefined) {
    console.warn(`[messages] missing key: ${key}`)
    return `__MISSING:${key}__`
  }
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : whole,
  )
}
