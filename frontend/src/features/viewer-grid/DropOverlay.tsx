import type { DnDState } from "./useDnD";

type Props = {
  leafId: string;
  dnd: DnDState | null;
};

// Rendered inside each Panel. Visualizes which zone the dragged tab will
// land on. The four edges show as thin colored bars; the center as a faint
// translucent fill.
export function DropOverlay({ leafId, dnd }: Props) {
  if (!dnd || !dnd.active) return null;
  const isTarget = dnd.hit?.leafId === leafId;
  // Only show the indicator on the leaf the cursor is actually over, but
  // keep the overlay element present everywhere so its data-attrs can be
  // hit-tested.
  return (
    <div className="drop-overlay" aria-hidden="true">
      {isTarget && dnd.hit?.kind === "panel-center" && (
        <div className="drop-zone-center" />
      )}
      {isTarget && dnd.hit?.kind === "panel-edge" && (
        <div className={`drop-zone-edge drop-zone-edge-${dnd.hit.edge}`} />
      )}
    </div>
  );
}
