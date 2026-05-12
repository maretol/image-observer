// basename: 末尾の path セパレータを取り除いたうえで、最後の "/" または "\" 以降を返す。
export function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
