import { DEFAULT_PALETTE } from "./defaultPalette";

// live な tag→color map。module レベル mutable なのは、tagColor() が多数の leaf から
// 呼ばれ、この 1 map のために context provider を挟むより軽いため。初期値は
// DEFAULT_PALETTE で、settings ロード後に App.tsx が settings.tagColors を merge する
// (初回描画は seed 色 → ユーザー設定色に切り替わりうるが v1 では許容)。
let activeTagColors: Record<string, string> = { ...DEFAULT_PALETTE };

// override を bundled default に merge する (full replace ではない — full replace だと
// 既知タグが HASH_PALETTE fallback に落ちてしまうため)。null / undefined / 空 {} で
// override を全クリアして default に戻す。
export function setKnownTagColors(map: Record<string, string> | null | undefined) {
  activeTagColors = map && Object.keys(map).length > 0
    ? { ...DEFAULT_PALETTE, ...map }
    : { ...DEFAULT_PALETTE };
}

// shallow copy を返すのは、Readonly 型が compile 時しか守らないので、毎 badge render
// で読まれる live palette を呼び出し側が実行時に mutate できないようにするため。
export function getKnownTagColors(): Readonly<Record<string, string>> {
  return { ...activeTagColors };
}

// 未知タグ用の fallback。隣接 badge が読めるよう彩度/明度を揃えた 16 色。
const HASH_PALETTE = [
  "#5b8def",
  "#e07b5b",
  "#7bb86d",
  "#d36ab6",
  "#c9a23a",
  "#4caea4",
  "#9c6bd9",
  "#d65d5d",
  "#5db8c5",
  "#e08e3a",
  "#7d9b3a",
  "#b15c8e",
  "#3f7fbc",
  "#a26b3a",
  "#6dac68",
  "#7c7c7c",
];

const UNCLASSIFIED_COLOR = "#555";

// FNV-1a 32-bit。決定的なので、同じタグの色がセッション間でぶれない。
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tagColor(tag: string): string {
  if (tag === "") return UNCLASSIFIED_COLOR;
  const known = activeTagColors[tag];
  if (known) return known;
  return HASH_PALETTE[hashString(tag) % HASH_PALETTE.length];
}

// 輝度で黒/白テキストを選ぶ。黄色/淡色の背景で白文字が読めなくなるのを防ぐため。
export function readableTextColor(bgHex: string): "#fff" | "#222" {
  if (!bgHex.startsWith("#") || bgHex.length !== 7) return "#fff";
  const r = parseInt(bgHex.slice(1, 3), 16);
  const g = parseInt(bgHex.slice(3, 5), 16);
  const b = parseInt(bgHex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#222" : "#fff";
}

// opt-in の CSS ターゲティング用の class 片。badge 背景色の正は tagColor 側。
export function tagBadgeClass(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "unclassified";
}
