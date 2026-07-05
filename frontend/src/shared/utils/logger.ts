// Go 側の internal/logging をミラーするフロントエンドロガー。INFO/WARN/ERROR は
// 即 IPC、DEBUG は ring buffer のみ。

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

  // wails dev で見えるよう常に console へ echo (パッケージ版では no-op コスト)。
  const consoleArgs: unknown[] = [`[${cat}] ${msg}`];
  if (data !== undefined) consoleArgs.push(data);
  switch (level) {
    case "debug":
      console.debug(...consoleArgs);
      // DEBUG は ring のみ、IPC は消費しない (pointermove 等の高頻度向け)。
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
      // ロギング自体を失敗させない — IPC が欠けてもこの 1 件を失うだけ (ring には残る)。
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

  // error 発火時などに直近の高頻度コンテキストを吐くため、ring 全体を 1 本の
  // INFO 行で送る。
  flushAll(reason: string = "manual"): void {
    const snapshot = ring.slice();
    void LogEvent(
      "info",
      "js.flush",
      `ring buffer dump (${snapshot.length} entries, reason=${reason})`,
      safeStringify(snapshot),
    ).catch(() => {});
  },

  _ringSnapshot(): readonly LogEntry[] {
    return ring.slice();
  },
  _resetForTests(): void {
    ring.length = 0;
  },
};

// 起動時に一度だけ設置。捕捉した error / rejection をログし、ring を flush して
// 失敗と一緒に直近の UI コンテキスト (DnD 等) を残す。
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
