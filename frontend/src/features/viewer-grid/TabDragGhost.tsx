import { basename } from "../../shared/utils/path";
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
