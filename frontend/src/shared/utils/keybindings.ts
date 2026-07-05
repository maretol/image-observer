// zoomCommandBus: アクティブ ImageView へズーム命令を中継する単一リスナ pubsub。
// Set でなく単一なのは、アクティブは常に 1 つで切替時にクリーンに引き継ぎたいため。

export type ZoomCommand = "fit" | "actualSize" | "in" | "out";

type Listener = (cmd: ZoomCommand) => void;

let zoomListener: Listener | null = null;

export const zoomCommandBus = {
  setListener(fn: Listener | null): void {
    zoomListener = fn;
  },
  emit(cmd: ZoomCommand): boolean {
    if (!zoomListener) return false;
    zoomListener(cmd);
    return true;
  },
  hasListener(): boolean {
    return zoomListener !== null;
  },
};

export function isEditableTarget(target: EventTarget | null): boolean {
  // 非 DOM のテスト環境でも module load 時に ReferenceError にならないようガード。
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

// macOS の Cmd と Linux/Windows の Ctrl の両方を受け付ける (移植性のため)。
export function isPrimaryModifier(e: KeyboardEvent): boolean {
  return Boolean(e.ctrlKey || e.metaKey);
}
