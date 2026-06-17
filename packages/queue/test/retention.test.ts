/**
 * `RetentionScheduler` — the retention recipe that runs sweeps on cadences.
 *
 * Every deciding path lives in `tick(now)`, a pure function of an epoch-ms clock,
 * so the cadence rule is proven with no real timers; the `start()` wire (the
 * no-overlap guard, fault routing) is driven with a fake `setInterval` whose
 * callback we invoke by hand.
 */

import { describe, expect, it } from "vitest";

import { QueueError, RetentionScheduler } from "../src/index";

import type { RetentionTask } from "../src/index";

/** Flush the microtask queue several times so a chained .then/.catch/.finally settles. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** A task that records every `now` it was run at and reports a fixed delete count. */
function recordingTask(
  name: string,
  everyMs: number,
  deleted = 0,
): RetentionTask & { runs: number[] } {
  const runs: number[] = [];

  return {
    name,
    everyMs,
    runs,
    run: async (now) => {
      runs.push(now);

      return deleted;
    },
  };
}

describe("RetentionScheduler.tick", () => {
  it("runs every task on its first tick and sums the deleted counts", async () => {
    const a = recordingTask("a", 1000, 3);
    const b = recordingTask("b", 5000, 4);
    const scheduler = new RetentionScheduler({ tasks: [a, b], clock: () => 0 });

    const result = await scheduler.tick(0);

    expect(result).toEqual({ ran: 2, deleted: 7 });
    expect(a.runs).toEqual([0]);
    expect(b.runs).toEqual([0]);
  });

  it("re-runs a task only after its everyMs has elapsed", async () => {
    const a = recordingTask("a", 1000);
    const b = recordingTask("b", 5000);
    const scheduler = new RetentionScheduler({ tasks: [a, b] });

    await scheduler.tick(0); // both run (first tick)
    expect(await scheduler.tick(999)).toEqual({ ran: 0, deleted: 0 }); // neither due
    expect(await scheduler.tick(1000)).toEqual({ ran: 1, deleted: 0 }); // only `a` (1000ms)
    expect(await scheduler.tick(5000)).toEqual({ ran: 2, deleted: 0 }); // `a` again + `b`

    expect(a.runs).toEqual([0, 1000, 5000]);
    expect(b.runs).toEqual([0, 5000]);
  });

  it("defaults `now` to the injected clock", async () => {
    const a = recordingTask("a", 1000);
    let nowMs = 42;
    const scheduler = new RetentionScheduler({ tasks: [a], clock: () => nowMs });

    await scheduler.tick(); // uses clock() → 42
    nowMs = 2000;
    await scheduler.tick(); // uses clock() → 2000, due again

    expect(a.runs).toEqual([42, 2000]);
  });

  it("defaults to Date.now when no clock is given", async () => {
    const a = recordingTask("a", 1000);
    const scheduler = new RetentionScheduler({ tasks: [a] });

    const before = Date.now();
    await scheduler.tick();
    const after = Date.now();

    expect(a.runs).toHaveLength(1);
    const stamped = a.runs[0] as number;
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

// A hand-driven fake timer: capture the cadence callback and fire it on demand.
function fakeTimer(): {
  fire: () => void;
  cleared: () => boolean;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
} {
  let callback: (() => void) | undefined;
  let wasCleared = false;

  return {
    fire: () => callback?.(),
    cleared: () => wasCleared,
    setInterval: (cb) => {
      callback = cb;

      return 1;
    },
    clearInterval: () => {
      wasCleared = true;
    },
  };
}

describe("RetentionScheduler.start", () => {
  it("fires the cadence and stops via the handle", async () => {
    const a = recordingTask("a", 0);
    const timer = fakeTimer();
    const scheduler = new RetentionScheduler({ tasks: [a], clock: () => Date.now() });

    const handle = scheduler.start({
      intervalMs: 10,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });

    timer.fire();
    await Promise.resolve(); // let the async tick settle
    await Promise.resolve();

    expect(a.runs).toHaveLength(1);

    handle.stop();
    expect(timer.cleared()).toBe(true);
  });

  it("skips an overlapping fire while a tick is still in flight", async () => {
    // A task whose run we hold open, so a second `fire()` lands mid-tick.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slow: RetentionTask = {
      name: "slow",
      everyMs: 0,
      run: async () => {
        calls += 1;
        await gate;

        return 0;
      },
    };

    const timer = fakeTimer();
    const scheduler = new RetentionScheduler({ tasks: [slow], clock: () => Date.now() });
    scheduler.start({ setInterval: timer.setInterval, clearInterval: timer.clearInterval });

    timer.fire(); // tick 1 starts and parks on the gate
    await flush();
    timer.fire(); // tick 2 must be SKIPPED (ticking guard)
    await flush();

    expect(calls).toBe(1);

    release(); // tick 1 completes, clearing the guard
    await flush();

    timer.fire(); // now a fresh tick is allowed
    await flush();
    expect(calls).toBe(2);
  });

  it("routes a task fault to onError as a coded QueueError and keeps ticking", async () => {
    const boom: RetentionTask = {
      name: "boom",
      everyMs: 0,
      run: async () => {
        throw new Error("delete failed");
      },
    };

    const reported: QueueError[] = [];
    const timer = fakeTimer();
    const scheduler = new RetentionScheduler({ tasks: [boom], clock: () => Date.now() });
    scheduler.start({
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      onError: (error) => reported.push(error),
    });

    timer.fire();
    await flush();

    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("RETENTION_TASK_FAILED");
    expect(reported[0]?.details).toMatchObject({ cause: "delete failed" });
  });

  it("passes an already-coded QueueError through onError unchanged", async () => {
    const coded = new QueueError("RETENTION_TASK_FAILED", "already coded", { task: "x" });
    const boom: RetentionTask = {
      name: "boom",
      everyMs: 0,
      run: async () => {
        throw coded;
      },
    };

    const reported: QueueError[] = [];
    const timer = fakeTimer();
    const scheduler = new RetentionScheduler({ tasks: [boom], clock: () => Date.now() });
    scheduler.start({
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      onError: (error) => reported.push(error),
    });

    timer.fire();
    await flush();

    expect(reported[0]).toBe(coded);
  });

  it("stringifies a non-Error task fault for onError", async () => {
    const boom: RetentionTask = {
      name: "boom",
      everyMs: 0,
      run: async () => {
        throw "stringy"; // eslint-disable-line -- exercising the non-Error branch
      },
    };

    const reported: QueueError[] = [];
    const timer = fakeTimer();
    const scheduler = new RetentionScheduler({ tasks: [boom], clock: () => Date.now() });
    scheduler.start({
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      onError: (error) => reported.push(error),
    });

    timer.fire();
    await flush();

    expect(reported[0]?.details).toMatchObject({ cause: "stringy" });
  });

  it("swallows a fault when no onError is wired (and survives a throwing reporter)", async () => {
    const boom: RetentionTask = {
      name: "boom",
      everyMs: 0,
      run: async () => {
        throw new Error("blip");
      },
    };

    const timer = fakeTimer();
    const scheduler = new RetentionScheduler({ tasks: [boom], clock: () => Date.now() });

    // No onError: the early-return branch — must not throw out of the timer.
    const handle = scheduler.start({
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    timer.fire();
    await flush();
    handle.stop();

    // A throwing reporter must not escape either.
    const timer2 = fakeTimer();
    const scheduler2 = new RetentionScheduler({ tasks: [boom], clock: () => Date.now() });
    scheduler2.start({
      setInterval: timer2.setInterval,
      clearInterval: timer2.clearInterval,
      onError: () => {
        throw new Error("reporter exploded");
      },
    });

    expect(() => timer2.fire()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("uses real setInterval/clearInterval by default", () => {
    const a = recordingTask("a", 1000);
    const scheduler = new RetentionScheduler({ tasks: [a], clock: () => Date.now() });

    // No timer injected → the default `setInterval`/`clearInterval` branch. Stop
    // immediately so no real cadence fires during the test.
    const handle = scheduler.start({ intervalMs: 100_000 });

    expect(() => handle.stop()).not.toThrow();
  });
});
