import { t } from "../../shared/messages";
import { getKnownTagColors } from "../classification/colors";
import { DEFAULT_PALETTE } from "../classification/defaultPalette";

// TagColorsView is read-only in v1. It always displays the effective merged
// palette (DEFAULT_PALETTE + settings.tagColors overrides) via
// getKnownTagColors(), so "what's shown here" matches "what tagColor()
// actually renders" — including for tags the user has not overridden. Each
// row carries an "上書き" pill when its color is actually different from the
// seed default (or it's a tag name that isn't in DEFAULT_PALETTE at all).
//
// Note on "is override": we compare values against DEFAULT_PALETTE rather
// than checking `name in colors`, because Go-side DefaultSettings() /
// applyFieldDefaults populate `colors` with the full seed palette by default
// — so a key-presence check would label every row as an override after a
// fresh load or `既定値に戻す`. Value comparison is robust to that and also
// correctly leaves "user set X to the same color as default" as non-override.
//
// `colors` is the raw settings payload, used here only to decide which rows
// to badge as overrides and to drive the summary hint.
//
// Editing today happens by editing settings.json directly and restarting the
// app (useSettings calls GetSettings only on mount). Full in-app editing is
// a follow-up issue.
export function TagColorsView({ colors }: { colors: Record<string, string> }) {
  const effective = getKnownTagColors();
  const entries = Object.entries(effective).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const overrideCount = entries.reduce(
    (n, [name, hex]) => (isOverrideValue(name, hex, colors) ? n + 1 : n),
    0,
  );
  return (
    <div className="settings-tag-colors">
      <div className="settings-field-hint">
        {overrideCount > 0
          ? t("settings.tagColors.summary.override", { count: overrideCount })
          : t("settings.tagColors.summary.default")}
      </div>
      {entries.length > 0 ? (
        <ul className="settings-tag-colors-list">
          {entries.map(([name, hex]) => {
            const isOverride = isOverrideValue(name, hex, colors);
            return (
              <li key={name} className="settings-tag-colors-item">
                <span
                  className="settings-tag-swatch"
                  style={{ backgroundColor: hex }}
                  title={hex}
                />
                <span className="settings-tag-name">{name}</span>
                <code className="settings-tag-hex">{hex}</code>
                {isOverride ? (
                  <span
                    className="settings-tag-override-pill"
                    title={t("settings.tagColors.override.title")}
                  >
                    {t("settings.tagColors.override.pill")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* Mixed-markup sentence (embeds two <code> spans) — left inline; a flat
          string catalog can't represent the <code> spans. Deferred to Phase 2 (#83). */}
      <div className="settings-field-hint">
        編集は <code>settings.json</code> の <code>tagColors</code> を直接書き換えてください
        (アプリ再起動後に反映 / 不正な値は読み込み時に除外されます)。指定したタグだけが既定パレットに重ね書きされ、未指定のタグは既定色のまま残ります。「既定値に戻す」で全上書きをクリアします。
      </div>
    </div>
  );
}

// isOverrideValue: true when settings.tagColors has `name` with a value
// different from the seed default. Names not in DEFAULT_PALETTE are always
// considered overrides (the user added a brand-new tag). Names whose stored
// value happens to equal the seed are NOT marked as overrides — that lets
// the pill mean "this row diverges from the bundled defaults", which is the
// signal the user actually wants when scanning the table.
function isOverrideValue(
  name: string,
  effectiveHex: string,
  colors: Record<string, string>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(colors, name)) return false;
  const seed = DEFAULT_PALETTE[name];
  return seed === undefined || seed !== effectiveHex;
}
