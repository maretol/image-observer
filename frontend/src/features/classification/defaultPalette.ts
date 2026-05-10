// Sample tag → color map shipped as a starting point. Application logic does
// not reference any of these names directly (the only special case in
// colors.ts is the empty string for "unclassified"). Phase H will let users
// override this map via settings.json.
export const DEFAULT_PALETTE: Readonly<Record<string, string>> = {
  iroha: "#1976d2",
  kaguya: "#f9a825",
  yachiyo: "#c2185b",
  roka: "#388e3c",
  mami: "#fb8c00",
  mikado: "#d32f2f",
  shugo: "#7b1fa2",
  fumei: "#757575",
};
