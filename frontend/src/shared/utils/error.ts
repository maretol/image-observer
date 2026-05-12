// errorMessage: Error / string / それ以外の throw 値から表示用メッセージを取り出す。
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
