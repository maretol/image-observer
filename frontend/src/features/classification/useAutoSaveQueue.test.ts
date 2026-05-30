// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  snapshotsEqual,
  useAutoSaveQueue,
  type Snapshot,
} from "./useAutoSaveQueue";

// Distinct snapshots used across the queue tests (pairwise unequal by
// snapshotsEqual): A→B differ in tags, B→C differ in confidence.
const A: Snapshot = { filename: "a.png", tags: ["alice"], confidence: "high", note: "" };
const B: Snapshot = { filename: "a.png", tags: ["alice", "bob"], confidence: "high", note: "" };
const C: Snapshot = { filename: "a.png", tags: ["alice", "bob"], confidence: "low", note: "" };

// clone makes a structurally-equal but referentially-distinct snapshot, so
// dedup tests prove snapshotsEqual is by-value not by-reference.
const clone = (s: Snapshot): Snapshot => ({ ...s, tags: [...s.tags] });

// A real macrotask drains the .finally() microtask of the in-flight save so we
// can observe the queue state *after* completion but *before* the (manually
// scheduled) dequeue runs. The hook's own dequeue uses the injected
// scheduleDequeue, never setTimeout, so this timer only drains microtasks.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// makeSave records each save call and hands back a manually-resolvable promise
// per call (deferred), so the test controls exactly when each save settles.
function makeSave() {
  const calls: Snapshot[] = [];
  const resolvers: Array<() => void> = [];
  const save = (snap: Snapshot): Promise<void> => {
    calls.push(snap);
    return new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });
  };
  return {
    save,
    calls,
    resolveAt: (i: number) => resolvers[i](),
  };
}

// makeScheduler captures dequeue callbacks instead of scheduling them on a real
// timer, so the test flushes the replay step deterministically.
function makeScheduler() {
  const pending: Array<() => void> = [];
  return {
    scheduleDequeue: (cb: () => void) => {
      pending.push(cb);
    },
    flush: () => {
      const cbs = pending.splice(0);
      for (const cb of cbs) cb();
    },
    pendingCount: () => pending.length,
  };
}

function setup() {
  const saveCtl = makeSave();
  const sched = makeScheduler();
  const { result } = renderHook(() =>
    useAutoSaveQueue({
      save: saveCtl.save,
      scheduleDequeue: sched.scheduleDequeue,
    }),
  );
  return { ...saveCtl, ...sched, result };
}

describe("snapshotsEqual", () => {
  it("compares by value (filename / tags / confidence / note)", () => {
    expect(snapshotsEqual(A, clone(A))).toBe(true);
    expect(snapshotsEqual(A, B)).toBe(false); // tags differ
    expect(snapshotsEqual(B, C)).toBe(false); // confidence differs
    expect(
      snapshotsEqual(A, { ...A, note: "x" }),
    ).toBe(false);
    expect(
      snapshotsEqual(A, { ...A, filename: "b.png" }),
    ).toBe(false);
  });
});

describe("useAutoSaveQueue", () => {
  it("dispatches a single save immediately", () => {
    const t = setup();
    t.result.current.runSave(A);
    expect(t.calls).toEqual([A]);
  });

  it("serializes: a second save while one is in-flight does not fire yet", () => {
    const t = setup();
    t.result.current.runSave(A);
    t.result.current.runSave(B);
    expect(t.calls).toEqual([A]); // B queued, not dispatched
  });

  it("replays the queued snapshot only after a macrotask hop", async () => {
    const t = setup();
    t.result.current.runSave(A);
    t.result.current.runSave(B);
    t.resolveAt(0);
    await tick(); // in-flight save's finally has run
    // Dequeue is deferred to the scheduler — not replayed synchronously.
    expect(t.calls).toEqual([A]);
    expect(t.pendingCount()).toBe(1);
    t.flush();
    expect(t.calls).toEqual([A, B]);
  });

  it("skips queuing a snapshot identical to the in-flight one (round 3)", async () => {
    const t = setup();
    t.result.current.runSave(A);
    t.result.current.runSave(clone(A)); // same content as in-flight
    expect(t.calls).toEqual([A]);
    t.resolveAt(0);
    await tick();
    expect(t.pendingCount()).toBe(0); // nothing queued → no replay scheduled
    expect(t.calls).toEqual([A]);
  });

  it("drops a stale queued snapshot when a later save reverts to the in-flight one (round 5, queue level)", async () => {
    const t = setup();
    t.result.current.runSave(A); // A in-flight
    t.result.current.runSave(B); // B queued
    t.result.current.runSave(clone(A)); // user reverted to A (== in-flight)
    t.resolveAt(0);
    await tick();
    // The revert means A (already in-flight) is the final desired state, so the
    // now-stale queued B must be dropped — replaying it would clobber the revert.
    expect(t.pendingCount()).toBe(0);
    expect(t.calls).toEqual([A]);
  });

  it("does not double-queue a snapshot identical to the queued one (round 3)", async () => {
    const t = setup();
    t.result.current.runSave(A);
    t.result.current.runSave(B);
    t.result.current.runSave(clone(B)); // same as queued → no-op
    t.resolveAt(0);
    await tick();
    t.flush();
    expect(t.calls).toEqual([A, B]); // single replay, not [A, B, B]
    t.resolveAt(1);
    await tick();
    expect(t.calls).toEqual([A, B]); // queue drained, no further replay
  });

  it("keeps at most 2 IPCs for 3 rapid distinct saves (latest wins)", async () => {
    const t = setup();
    t.result.current.runSave(A); // in-flight
    t.result.current.runSave(B); // queued
    t.result.current.runSave(C); // overwrites queue → B dropped
    expect(t.calls).toEqual([A]);
    t.resolveAt(0);
    await tick();
    t.flush();
    expect(t.calls).toEqual([A, C]); // B never dispatched
  });

  it("resetQueue drops the queued snapshot so it never replays", async () => {
    const t = setup();
    t.result.current.runSave(A); // in-flight
    t.result.current.runSave(B); // queued
    t.result.current.resetQueue(); // entry switched → drop queue
    t.resolveAt(0);
    await tick();
    expect(t.pendingCount()).toBe(0); // finally saw empty queue → no schedule
    expect(t.calls).toEqual([A]); // in-flight A still completed; B dropped
  });
});
