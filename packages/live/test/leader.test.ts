import { describe, expect, it, vi } from "vitest";

import { electLeader } from "../src/index";
import type { RequestLock } from "../src/index";

/** Drain the pending microtask/timer queue so a granted callback and a promotion settle. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An `AbortError`-shaped rejection, like a real aborted `locks.request`. */
const abortError = (): Error =>
  Object.assign(new Error("The request was aborted."), { name: "AbortError" });

/** A lock request that rejects with an unsolicited `AbortError` — one the caller never asked for. */
const rejectWithAbort: RequestLock = () => Promise.reject(abortError());

/** A lock request that rejects with no reason at all — the `?.name` nullish-cursor path. */
// eslint-disable-next-line prefer-promise-reject-errors
const rejectWithNoReason: RequestLock = () => Promise.reject(undefined);

/**
 * An in-process `LockManager.request` fake modeling the Web Locks contract the real browser gives
 * us: one holder per name, the rest queued FIFO, the held lock released when its callback's promise
 * settles (which promotes the next waiter), and a still-QUEUED request abortable via its signal.
 */
function fakeLocks(): { requestLock: RequestLock } {
  interface Waiter {
    readonly run: () => void;
    readonly reject: (error: unknown) => void;
  }

  const held = new Map<string, boolean>();
  const queues = new Map<string, Waiter[]>();

  const promote = (name: string): void => {
    const next = queues.get(name)?.shift();

    if (next === undefined) {
      held.set(name, false);

      return;
    }

    held.set(name, true);
    next.run();
  };

  const requestLock: RequestLock = (name, options, callback) =>
    new Promise((resolve, reject) => {
      const waiter: Waiter = {
        run: () => {
          // Hold the lock for the lifetime of `callback`'s promise, then promote the next waiter —
          // the exact browser semantics. Resolve/reject the request as the callback settles.
          void (async () => {
            try {
              const value = await callback();

              promote(name);
              resolve(value);
            } catch (error) {
              promote(name);
              reject(error);
            }
          })();
        },
        reject,
      };

      const signal = options.signal;

      if (signal?.aborted === true) {
        reject(abortError());

        return;
      }

      signal?.addEventListener("abort", () => {
        // Only a still-queued waiter can be aborted — a granted (holding) one is inert to the signal.
        const queue = queues.get(name);
        const index = queue?.indexOf(waiter) ?? -1;

        if (queue !== undefined && index >= 0) {
          queue.splice(index, 1);
          waiter.reject(abortError());
        }
      });

      if (held.get(name) !== true) {
        held.set(name, true);
        waiter.run();
      } else {
        (queues.get(name) ?? queues.set(name, []).get(name)!).push(waiter);
      }
    });

  return { requestLock };
}

describe("electLeader", () => {
  it("elects a single leader and runs onLeadership on the win", async () => {
    const { requestLock } = fakeLocks();
    const onLeadership = vi.fn(() => () => {});

    const election = electLeader({ requestLock, name: "L", onLeadership });

    // The fake grants synchronously, and `onLeadership` runs to its first await synchronously.
    expect(election.isLeader()).toBe(true);
    expect(onLeadership).toHaveBeenCalledTimes(1);
  });

  it("queues a second bid and promotes it when the leader releases, running the cleanup", async () => {
    const { requestLock } = fakeLocks();
    const cleanupA = vi.fn();

    const a = electLeader({ requestLock, name: "L", onLeadership: () => cleanupA });
    const b = electLeader({ requestLock, name: "L", onLeadership: () => () => {} });

    // A holds; B is queued behind it.
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);

    a.release();
    await tick();

    // A stepped down (its cleanup ran) and B was promoted.
    expect(cleanupA).toHaveBeenCalledTimes(1);
    expect(a.isLeader()).toBe(false);
    expect(b.isLeader()).toBe(true);
  });

  it("aborts a still-pending bid on release without ever becoming leader", async () => {
    const { requestLock } = fakeLocks();
    const onErrorB = vi.fn();
    const onLeadershipB = vi.fn();

    const a = electLeader({ requestLock, name: "L", onLeadership: () => () => {} });
    const b = electLeader({
      requestLock,
      name: "L",
      onLeadership: onLeadershipB,
      onError: onErrorB,
    });

    // B is queued; releasing before the grant cancels the bid silently (an expected AbortError).
    b.release();
    await tick();

    expect(onLeadershipB).not.toHaveBeenCalled();
    expect(onErrorB).not.toHaveBeenCalled();
    expect(b.isLeader()).toBe(false);
    expect(a.isLeader()).toBe(true);
  });

  it("tolerates an onLeadership that returns no cleanup", async () => {
    const { requestLock } = fakeLocks();

    const election = electLeader({ requestLock, name: "L", onLeadership: () => {} });

    expect(election.isLeader()).toBe(true);

    // Releasing with no cleanup to run must not throw.
    election.release();
    await tick();

    expect(election.isLeader()).toBe(false);
  });

  it("reports an onLeadership throw to onError and frees the lock for the next tab", async () => {
    const { requestLock } = fakeLocks();
    const onError = vi.fn();
    const boom = new Error("setup failed");

    const a = electLeader({
      requestLock,
      name: "L",
      onLeadership: () => {
        throw boom;
      },
      onError,
    });

    await tick();

    expect(onError).toHaveBeenCalledWith(boom);
    expect(a.isLeader()).toBe(false);

    // The failed leader gave the lock back, so a later bid still wins it.
    const b = electLeader({ requestLock, name: "L", onLeadership: () => () => {} });

    expect(b.isLeader()).toBe(true);
  });

  it("swallows an onLeadership throw when no onError is given", async () => {
    const { requestLock } = fakeLocks();

    const election = electLeader({
      requestLock,
      name: "L",
      onLeadership: () => {
        throw new Error("setup failed");
      },
    });

    await tick();

    expect(election.isLeader()).toBe(false);
  });

  it("resolves a release issued during async onLeadership setup without hanging", async () => {
    const { requestLock } = fakeLocks();
    const cleanup = vi.fn();

    let finishSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });

    const election = electLeader({
      requestLock,
      name: "L",
      onLeadership: async () => {
        await setupGate;

        return cleanup;
      },
    });

    // Release while setup is still pending — before the hold promise is even created.
    election.release();
    finishSetup();
    await tick();

    // The `if (released) resolve()` fast-path steps leadership straight back down and runs cleanup.
    expect(election.isLeader()).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on repeated release", async () => {
    const { requestLock } = fakeLocks();
    const cleanup = vi.fn();

    const election = electLeader({ requestLock, name: "L", onLeadership: () => cleanup });

    election.release();
    election.release();
    await tick();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(election.isLeader()).toBe(false);
  });

  it("reports a non-abort request rejection to onError", async () => {
    const boom = new Error("lock manager blew up");
    const onError = vi.fn();
    const requestLock: RequestLock = () => Promise.reject(boom);

    electLeader({ requestLock, name: "L", onLeadership: () => () => {}, onError });
    await tick();

    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("reports a rejection with no reason (undefined) to onError", async () => {
    const onError = vi.fn();

    electLeader({
      requestLock: rejectWithNoReason,
      name: "L",
      onLeadership: () => () => {},
      onError,
    });
    await tick();

    expect(onError).toHaveBeenCalledWith(undefined);
  });

  it("reports an unexpected AbortError (not from release) to onError", async () => {
    const onError = vi.fn();

    // No `release()` here, so `released` is false — the abort is unexpected and is surfaced.
    electLeader({ requestLock: rejectWithAbort, name: "L", onLeadership: () => () => {}, onError });
    await tick();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).name).toBe("AbortError");
  });
});
