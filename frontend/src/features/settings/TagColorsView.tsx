import { t } from "../../shared/messages";
import { getKnownTagColors } from "../classification/colors";
import { DEFAULT_PALETTE } from "../classification/defaultPalette";

// v1 は read-only。getKnownTagColors() で effective な merged palette (DEFAULT_PALETTE +
// settings.tagColors override) を表示し、ここの表示が tagColor() の実描画と一致する。
//
// override 判定は `name in colors` でなく DEFAULT_PALETTE との値比較で行う。Go の
// DefaultSettings() / applyFieldDefaults が colors に seed palette 全体を埋めるので、key 有無
// チェックだと fresh load や「既定値に戻す」後に全 row が override 扱いになるため。値比較なら
// 「default と同じ色に設定」も正しく非 override になる。
//
// 編集は settings.json を直接書き換えて再起動 (useSettings は mount 時のみ GetSettings)。
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

// settings.tagColors の name の値が seed default と違えば true。DEFAULT_PALETTE に無い name は
// 常に override (ユーザーが新規追加)。seed と同値なら override 扱いしない (pill が「同梱既定と
// 相違」を意味するように)。
function isOverrideValue(
  name: string,
  effectiveHex: string,
  colors: Record<string, string>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(colors, name)) return false;
  const seed = DEFAULT_PALETTE[name];
  return seed === undefined || seed !== effectiveHex;
}
