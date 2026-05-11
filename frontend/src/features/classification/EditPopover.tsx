import { useEffect, useState } from "react";
import { classification } from "../../../wailsjs/go/models";
import { extractTags, serializeTags } from "./filters";
import { TagInput } from "./TagInput";

export type EditPopoverProps = {
  open: boolean;
  entry: classification.Entry | null;
  knownTags: string[];
  onSave: (next: classification.Entry) => void;
  onCancel: () => void;
};

const CONF_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "none" },
  { value: "high", label: "high" },
  { value: "mid", label: "mid" },
  { value: "low", label: "low" },
];

// EditPopover edits a single Entry's tags / confidence / note. The save flow
// does NOT optimistically update the parent state; the parent updates its
// loadResult only after the backend acknowledges, per spec §5.7.
//
// Tags are presented as a chip-style multi-input (#8). The on-disk JSON key
// stays "folder" (Entry.folder) for backward compatibility — we serialize the
// chip list to a comma-separated string on save and parse it on load.
export function EditPopover({
  open,
  entry,
  knownTags,
  onSave,
  onCancel,
}: EditPopoverProps) {
  const [tags, setTags] = useState<string[]>([]);
  const [confidence, setConfidence] = useState<string>("");
  const [note, setNote] = useState("");

  // Reset local form whenever a new entry comes in.
  useEffect(() => {
    if (entry) {
      setTags(extractTags(entry.folder));
      setConfidence(entry.confidence);
      setNote(entry.note);
    }
  }, [entry]);

  // Esc to cancel, Cmd/Ctrl+Enter to save.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (entry) {
          onSave(
            classification.Entry.createFrom({
              filename: entry.filename,
              folder: serializeTags(tags),
              confidence,
              note,
            }),
          );
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, entry, tags, confidence, note, onSave, onCancel]);

  if (!open || !entry) return null;

  const handleSave = () => {
    onSave(
      classification.Entry.createFrom({
        filename: entry.filename,
        folder: serializeTags(tags),
        confidence,
        note,
      }),
    );
  };

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog cls-edit-popover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cls-edit-title">編集: {entry.filename}</div>
        <div className="cls-edit-row">
          <label className="cls-edit-label">タグ</label>
          <TagInput
            tags={tags}
            knownTags={knownTags}
            onChange={setTags}
            autoFocus
            ariaLabel="タグ"
          />
        </div>
        <div className="cls-edit-row">
          <label className="cls-edit-label">confidence</label>
          <div className="cls-edit-radios">
            {CONF_OPTIONS.map((opt) => (
              <label key={opt.value} className="cls-edit-radio">
                <input
                  type="radio"
                  name="cls-edit-confidence"
                  value={opt.value}
                  checked={confidence === opt.value}
                  onChange={() => setConfidence(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
        <div className="cls-edit-row">
          <label className="cls-edit-label">note</label>
          <textarea
            className="cls-edit-textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="confirm-dialog-buttons">
          <button
            type="button"
            className="confirm-dialog-btn"
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-ok"
            onClick={handleSave}
          >
            保存 (Cmd/Ctrl+Enter)
          </button>
        </div>
      </div>
    </div>
  );
}
