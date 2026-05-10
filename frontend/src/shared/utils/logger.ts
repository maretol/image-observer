// Frontend logger that mirrors the Go-side `internal/logging` API.
//
// - INFO/WARN/ERROR are sent immediately to Go via `LogEvent` (1 IPC per call).
//   The viewer is low-traffic so this is fine.
// - DEBUG goes to a 200-entry in-memory ring buffer and console.debug only.
//   Use `logger.flushAll()` to force-send the ring to Go (e.g., when an
//   error is caught and we want recent context).
// - `installGlobalErrorHandlers()` wires `window.onerror` and
//   `unhandledrejection` to the logger and flushes the ring on each fire.
//
// `data` is a structured object that gets serialized to JSON before being
// passed to Go as the LogEvent's `data` argument.

import { LogEvent } from "../../../wailsjs/go/main/App";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  cat: string;
  msg: string;
  data?: unknown;
};

const RING_SIZE = 200;
const ring: LogEntry[] = [];

function pushRing(entry: LogEntry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

function emit(
  level: LogLevel,
  cat: string,
  msg: string,
  data?: unknown,
): void {
  const entry: LogEntry = { ts: Date.now(), level, cat, msg, data };
  pushRing(entry);

  // Always echo to the dev console so `wails dev` users see things in
  // realtime. In packaged builds the console isn't visible but this is
  // a no-op cost.
  const consoleArgs: unknown[] = [`[${cat}] ${msg}`];
  if (data !== undefined) consoleArgs.push(data);
  switch (level) {
    case "debug":
      console.debug(...consoleArgs);
      // DEBUG stays in the ring only; we don't burn an IPC call per entry
      // (DEBUG is meant for high-frequency events like pointermove).
      return;
    case "info":
      console.info(...consoleArgs);
      break;
    case "warn":
      console.warn(...consoleArgs);
      break;
    case "error":
      console.error(...consoleArgs);
      break;
  }

  void LogEvent(level, cat, msg, data === undefined ? "" : safeStringify(data))
    .catch(() => {
      // Don't make logging itself fail loudly; a missing IPC just means we
      // lose this entry from the file (the ring still has it).
    });
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return "<unserializable>";
    }
  }
}

export const logger = {
  debug(cat: string, msg: string, data?: unknown): void {
    emit("debug", cat, msg, data);
  },
  info(cat: string, msg: string, data?: unknown): void {
    emit("info", cat, msg, data);
  },
  warn(cat: string, msg: string, data?: unknown): void {
    emit("warn", cat, msg, data);
  },
  error(cat: string, msg: string, data?: unknown): void {
    emit("error", cat, msg, data);
  },

  // Forward the entire ring buffer to Go as a single INFO line carrying a
  // JSON snapshot. Used to dump recent high-frequency context when an
  // error fires, or (later) on a debug hotkey.
  flushAll(reason: string = "manual"): void {
    const snapshot = ring.slice();
    void LogEvent(
      "info",
      "js.flush",
      `ring buffer dump (${snapshot.length} entries, reason=${reason})`,
      safeStringify(snapshot),
    ).catch(() => {});
  },

  // Inspect for tests / debug.
  _ringSnapshot(): readonly LogEntry[] {
    return ring.slice();
  },
  _resetForTests(): void {
    ring.length = 0;
  },
};

// Install once at app startup. Catches synchronous JS errors and unhandled
// promise rejections, logs them, and flushes the ring buffer so we have
// the recent UI context (DnD events, etc.) alongside the failure.
export function installGlobalErrorHandlers(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    logger.error("js.error", e.message || "uncaught error", {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
    logger.flushAll("window.error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason =
      e.reason instanceof Error
        ? { message: e.reason.message, stack: e.reason.stack }
        : e.reason;
    logger.error("js.unhandled-rejection", "promise rejected", { reason });
    logger.flushAll("unhandledrejection");
  });
}
