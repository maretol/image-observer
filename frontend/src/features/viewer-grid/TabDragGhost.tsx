import type { DnDState } from "./useDnD";

type Props = {
  dnd: DnDState | null;
};

export function TabDragGhost({ dnd }: Props) {
  if (!dnd || !dnd.active) return null;
  const name = basename(dnd.tabPath);
  const style = {
    "--ghost-x": `${dnd.ghost.x + 8}px`,
    "--ghost-y": `${dnd.ghost.y + 8}px`,
  } as React.CSSProperties;
  return (
    <div className="tab-drag-ghost" style={style}>
      {name}
    </div>
  );
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
