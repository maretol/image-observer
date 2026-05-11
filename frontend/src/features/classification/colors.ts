import { DEFAULT_PALETTE } from "./defaultPalette";

// KNOWN_TAG_COLORS is the active mapping consulted first. Phase H plans to
// replace this with a settings-driven map; we keep the indirection so the
// rest of the code does not need to change later.
export const KNOWN_TAG_COLORS: Readonly<Record<string, string>> = DEFAULT_PALETTE;

// Fallback palette for unknown tags. 16 visually-distinct colors at a similar
// saturation/lightness so adjacent badges remain readable.
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

// FNV-1a 32-bit. Deterministic, fast, short. Same input always returns the
// same color, which matters because users should not see a tag's color
// shift between sessions.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// tagColor returns a deterministic CSS color string for a tag.
// - Empty string → grey (unclassified).
// - Known tag (in KNOWN_TAG_COLORS) → that color.
// - Otherwise → hash-derived pick from HASH_PALETTE.
export function tagColor(tag: string): string {
  if (tag === "") return UNCLASSIFIED_COLOR;
  const known = KNOWN_TAG_COLORS[tag];
  if (known) return known;
  return HASH_PALETTE[hashString(tag) % HASH_PALETTE.length];
}

// readableTextColor picks black or white text for a given background color
// using a luminance threshold. Important for yellow / pale palette entries
// where white text would be illegible.
export function readableTextColor(bgHex: string): "#fff" | "#222" {
  if (!bgHex.startsWith("#") || bgHex.length !== 7) return "#fff";
  const r = parseInt(bgHex.slice(1, 3), 16);
  const g = parseInt(bgHex.slice(3, 5), 16);
  const b = parseInt(bgHex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#222" : "#fff";
}

// tagBadgeClass returns a CSS-friendly class fragment for a single tag —
// lowercased and stripped to alphanumerics. Used only for opt-in CSS
// targeting; tagColor is the canonical source for badge background.
export function tagBadgeClass(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "unclassified";
}
