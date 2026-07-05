import type { DnDState } from "./useDnD";

type Props = {
  leafId: string;
  dnd: DnDState | null;
};

// 各 Panel 内に描画。drag 中の tab がどの zone に落ちるかを可視化する (端は細いバー、中央は淡い塗り)。
export function DropOverlay({ leafId, dnd }: Props) {
  if (!dnd || !dnd.active) return null;
  const isTarget = dnd.hit?.leafId === leafId;
  // indicator はカーソルが乗っている leaf だけに出すが、data 属性を hit-test できるよう
  // overlay 要素自体は全 leaf に残す。
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
