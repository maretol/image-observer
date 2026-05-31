import { ja } from "./ja"

// MessageKey is the literal union of every catalog key. Call sites are typed
// against it, so a typo or a removed key is a compile error rather than a
// runtime blank.
export type MessageKey = keyof typeof ja

type Params = Record<string, string | number>

/**
 * Look up a UI message by key and interpolate `{placeholder}` tokens.
 *
 * Catalog: shared/messages/ja.ts (ja-only for now — #83 is the i18n precursor;
 * locale switching is #16). `t` is a plain module-level function, not a hook or
 * context, because there is a single fixed locale: threading a provider through
 * every render would cost more than it buys (spec-ui-string-catalog.md D-2).
 *
 * Interpolation replaces `{name}` with `String(params.name)`. Two defensive
 * fallbacks keep a wiring mistake visible-but-harmless instead of crashing:
 *   - an unknown key (only reachable via a force-cast, since MessageKey guards
 *     callers) returns `__MISSING:<key>__` and warns;
 *   - a `{placeholder}` with no matching param is left verbatim as `{name}`.
 */
export function t(key: MessageKey, params?: Params): string {
  // Widen the index type so the force-cast "missing key" path is reachable at
  // runtime; with the literal type, `ja[key]` is `string` and tsc would reject
  // an `=== undefined` check as a no-overlap comparison.
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
