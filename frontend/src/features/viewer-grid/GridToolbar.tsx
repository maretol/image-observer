import { PlusIcon } from "../../shared/icons/PlusIcon";
import { MinusIcon } from "../../shared/icons/MinusIcon";

type Props = {
  canAddRow: boolean;
  canAddCol: boolean;
  canRemoveRow: boolean;
  canRemoveCol: boolean;
  onAddRow: () => void;
  onAddCol: () => void;
  onRemoveRow: () => void;
  onRemoveCol: () => void;
};

export function GridToolbar({
  canAddRow,
  canAddCol,
  canRemoveRow,
  canRemoveCol,
  onAddRow,
  onAddCol,
  onRemoveRow,
  onRemoveCol,
}: Props) {
  return (
    <div className="grid-toolbar">
      <button
        className="grid-toolbar-btn"
        onClick={onAddRow}
        disabled={!canAddRow}
        title="行を追加"
      >
        <PlusIcon />
        <span>行</span>
      </button>
      <button
        className="grid-toolbar-btn"
        onClick={onAddCol}
        disabled={!canAddCol}
        title="列を追加"
      >
        <PlusIcon />
        <span>列</span>
      </button>
      <button
        className="grid-toolbar-btn"
        onClick={onRemoveRow}
        disabled={!canRemoveRow}
        title="行を削除"
      >
        <MinusIcon />
        <span>行</span>
      </button>
      <button
        className="grid-toolbar-btn"
        onClick={onRemoveCol}
        disabled={!canRemoveCol}
        title="列を削除"
      >
        <MinusIcon />
        <span>列</span>
      </button>
    </div>
  );
}
