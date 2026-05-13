import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type ToastSeverity = "info" | "warn" | "error";
export type ToastFn = (message: string, severity?: ToastSeverity) => void;

type ToastItem = {
  id: number;
  message: string;
  severity: ToastSeverity;
  timeoutHandle: number;
  exiting: boolean;
};

const MAX_TOASTS = 5;
const EXIT_DURATION_MS = 200;
const DURATIONS: Record<ToastSeverity, number> = {
  info: 3000,
  warn: 5000,
  error: 7000,
};

const ToastContext = createContext<ToastFn>(() => {});

export function useToastFn(): ToastFn {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const itemsRef = useRef<ToastItem[]>([]);
  itemsRef.current = items;
  const counterRef = useRef(0);

  useEffect(() => {
    return () => {
      for (const it of itemsRef.current) window.clearTimeout(it.timeoutHandle);
    };
  }, []);

  const startExit = useCallback((id: number) => {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, exiting: true } : i))
    );
    window.setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.id !== id));
    }, EXIT_DURATION_MS);
  }, []);

  const toast = useCallback<ToastFn>(
    (message, severity = "info") => {
      const cur = itemsRef.current;
      const dup = cur.find(
        (i) => !i.exiting && i.message === message && i.severity === severity
      );
      if (dup) {
        window.clearTimeout(dup.timeoutHandle);
        const newHandle = window.setTimeout(
          () => startExit(dup.id),
          DURATIONS[severity]
        );
        setItems((prev) =>
          prev.map((i) =>
            i.id === dup.id ? { ...i, timeoutHandle: newHandle } : i
          )
        );
        return;
      }
      counterRef.current += 1;
      const id = counterRef.current;
      const handle = window.setTimeout(
        () => startExit(id),
        DURATIONS[severity]
      );
      setItems((prev) => {
        let next: ToastItem[] = [
          ...prev,
          { id, message, severity, timeoutHandle: handle, exiting: false },
        ];
        // Cap at MAX_TOASTS live items by dropping the oldest non-exiting one immediately.
        const liveCount = next.filter((i) => !i.exiting).length;
        if (liveCount > MAX_TOASTS) {
          const oldestIdx = next.findIndex((i) => !i.exiting);
          if (oldestIdx >= 0) {
            window.clearTimeout(next[oldestIdx].timeoutHandle);
            next = next.filter((_, idx) => idx !== oldestIdx);
          }
        }
        return next;
      });
    },
    [startExit]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {createPortal(
        // Portals to <body>, outside .app-toplevel — read --ui-scale (set on
        // <html> in App.tsx) directly so toasts scale with the rest of the
        // chrome. See App.css "UI scale" block.
        <div className="toast-host" style={{ zoom: "var(--ui-scale, 1)" }}>
          {items.map((item) => (
            <ToastView
              key={item.id}
              item={item}
              onClose={() => {
                window.clearTimeout(item.timeoutHandle);
                startExit(item.id);
              }}
            />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

type ToastViewProps = {
  item: ToastItem;
  onClose: () => void;
};

function ToastView({ item, onClose }: ToastViewProps) {
  const role = item.severity === "error" ? "alert" : "status";
  const ariaLive = item.severity === "error" ? "assertive" : "polite";
  return (
    <div
      className={`toast toast-${item.severity}${item.exiting ? " toast-exiting" : ""}`}
      role={role}
      aria-live={ariaLive}
    >
      <span className="toast-message">{item.message}</span>
      {item.severity === "error" && (
        <button
          type="button"
          className="toast-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          ×
        </button>
      )}
    </div>
  );
}
