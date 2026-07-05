import { useCallback, useRef } from "react";

// auto-save が対象とする確定フォーム payload。queue の stale-closure / double-save
// race を renderHook で pin できるよう、直列化 queue ごと SampleEditPane から分離 (#110 B)。
export type Snapshot = {
  filename: string;
  tags: string[];
  confidence: string;
  note: string;
};

// 同一内容が in-flight / queue 済みのとき冗長な queue 追加を短絡するための等価判定。
// これが無いと、× / backdrop クリック (blur → in-flight save → unmount cleanup) が
// 同じ snapshot を再 queue し、flush で二重保存して IPC を無駄にし mtime を bump して
// watcher を無駄に起こす。
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.filename !== b.filename) return false;
  if (a.confidence !== b.confidence) return false;
  if (a.note !== b.note) return false;
  if (a.tags.length !== b.tags.length) return false;
  for (let i = 0; i < a.tags.length; i++) {
    if (a.tags[i] !== b.tags[i]) return false;
  }
  return true;
}

// dequeue の既定 macrotask scheduler。module scope なのは runSave の identity を安定
// させるため (per-render arrow だと useCallback deps が churn し再帰自己呼び出しが壊れる)。
// テストは手動 scheduler を注入して実タイマ無しで dequeue を flush する。
const defaultScheduleDequeue = (cb: () => void): void => {
  setTimeout(cb, 0);
};

export type UseAutoSaveQueueArgs = {
  // 実際の save。SampleEditPane は呼び出し時に onSaveRef.current(buildEntry(snap)) を
  // 読む安定ラッパを渡すので、再帰 dequeue が *最新* の handleSave (と最新の
  // loadResult.mtime) を拾う。onSave を静的にキャプチャすると mtime が固定され、queue
  // された 2 度目の save が古い mtime を送って Go の expectedMtime で CONFLICT になる。
  save: (snap: Snapshot) => void | Promise<void>;
  // dequeue の macrotask scheduler (既定 setTimeout(…, 0))。テストが replay を決定的に flush
  // できるよう注入可能。
  scheduleDequeue?: (cb: () => void) => void;
};

export type UseAutoSaveQueueReturn = {
  // save を enqueue。同時実行は最大 1。in-flight 中は最新の *異なる* snapshot を
  // 1 スロット queue に保持し完了時に replay (blur 3 連打 ⇒ IPC は最大 2)。
  runSave: (snap: Snapshot) => void;
  // queue 済み snapshot を捨てる — entry 切替時に呼び、stale snapshot が新 entry に
  // 乗らないように。in-flight save はあえて完走させる (saveEdit の folder check が
  // 旧 folder への commit を gate する)。
  resetQueue: () => void;
};

// in-flight save の直列化 (#105 §5.3, #110 B で分離)。tag blur 直後の note blur (や
// radio 変更) は同じ loadResult.mtime で save を 2 本積み、2 本目は reload まで
// CONFLICT になる。in-flight は最大 1、以降は 1 スロット queue を最新 snapshot で
// 上書きし完了時に replay。
export function useAutoSaveQueue({
  save,
  scheduleDequeue = defaultScheduleDequeue,
}: UseAutoSaveQueueArgs): UseAutoSaveQueueReturn {
  const saveInFlightRef = useRef(false);
  const inFlightSnapshotRef = useRef<Snapshot | null>(null);
  const queuedSnapshotRef = useRef<Snapshot | null>(null);

  const runSave = useCallback(
    (snap: Snapshot) => {
      if (saveInFlightRef.current) {
        // in-flight と同一内容: 実行中の IPC がこの状態を既にカバー。queue 中の中間を
        // 捨てる — in-flight snapshot に戻ったのはユーザーがそこへ revert したという
        // ことなので、stale queue を flush で replay するとその revert を潰す。
        if (
          inFlightSnapshotRef.current &&
          snapshotsEqual(snap, inFlightSnapshotRef.current)
        ) {
          queuedSnapshotRef.current = null;
          return;
        }
        // queue が既に同じ snapshot を持つなら skip (同値上書きは no-op だが in-flight
        // 側チェックと対称に保つ)。
        if (
          queuedSnapshotRef.current &&
          snapshotsEqual(snap, queuedSnapshotRef.current)
        ) {
          return;
        }
        queuedSnapshotRef.current = snap;
        return;
      }
      saveInFlightRef.current = true;
      inFlightSnapshotRef.current = snap;
      Promise.resolve(save(snap)).finally(() => {
        inFlightSnapshotRef.current = null;
        if (!queuedSnapshotRef.current) {
          // queue 無し — in-flight latch を即解放。
          saveInFlightRef.current = false;
          return;
        }
        // dequeue を macrotask に defer し、React が in-flight save の setState 副作用を
        // 先に commit する (parent setLoadResult → new mtime → save ラッパが最新
        // saveEdit を読む)。この hop が無いと再帰 runSave が commit 前の onSave を見て、
        // 上流で解決したはずの mtime 競合を再現する。
        //
        // 重要: この隙間で saveInFlightRef = true を保つ。ここで解放すると、defer した
        // dequeue 発火前に来た runSave() が「not in flight」を見て即 dispatch し、その後
        // dequeue が *古い* queue snapshot を上に replay する — 古いが新しいを上書きする。
        // latch を保持すればその runSave は queue に回り、dequeue は常に最新を drain する。
        scheduleDequeue(() => {
          const next = queuedSnapshotRef.current;
          queuedSnapshotRef.current = null;
          // re-dispatch 直前に latch を解放。同期なので隙間なし (runSave が同じ tick で
          // latch を下げて上げ直す)。
          saveInFlightRef.current = false;
          if (next) runSave(next);
        });
      });
    },
    [save, scheduleDequeue],
  );

  const resetQueue = useCallback(() => {
    queuedSnapshotRef.current = null;
  }, []);

  return { runSave, resetQueue };
}
