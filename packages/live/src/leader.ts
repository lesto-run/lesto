/**
 * `electLeader` — single-leader election over the **Web Locks API** (ADR 0042 Tier 4, v1 Inc7).
 *
 * Multiple tabs of one origin must not each open a sync connection (the HTTP/1.1 6-connection
 * cap, the server fan-out cost). Web Locks give us exactly one winner for free: `locks.request`
 * grants a named lock to one caller and queues the rest, and — the property the whole design
 * rests on — **the browser releases a held lock when its tab is destroyed**, even on a hard close
 * or crash where no cleanup code runs. So the next waiter is promoted automatically: leadership
 * failover with no heartbeat, no lease, no zombie detection.
 *
 * The `navigator.locks.request(name, { signal }, callback)` shape is idiomatic but inverted from
 * what a long-lived leader wants: the lock is held for exactly as long as the callback's returned
 * promise is pending. So to *hold* leadership we return a promise that resolves only when
 * {@link LeaderElection.release} is called (or the tab is torn down, which rejects the whole
 * request out from under us). This module wraps that inversion behind a plain
 * `{ isLeader, release }` handle, and takes the `LockManager` as an injected {@link RequestLock}
 * seam — exactly as `connectLiveData` takes the `EventSource` seam — so importing it stays
 * SSR-safe (the global `navigator.locks` is touched only inside the browser default in
 * `./cross-tab`, never here or at import) and the whole election is test-fakeable without a real
 * browser lock manager.
 *
 * It knows nothing of stores, shapes, or the wire — a reusable single-writer primitive that
 * `createCrossTabLiveQuery` (`./cross-tab`) composes with a BroadcastChannel fan-out.
 */

/**
 * The injected slice of the Web Locks `LockManager.request` this module drives — request the
 * named lock, holding it for the lifetime of `callback`'s returned promise, and abort a *pending*
 * (not-yet-granted) request via `options.signal`. The browser's `navigator.locks.request`
 * satisfies it (see `browserCrossTabEnvironment` in `./cross-tab`); a test injects a fake queue.
 *
 * The returned promise resolves when `callback` settles (the lock released cleanly) and rejects
 * with an `AbortError` if the pending request was aborted before it was ever granted.
 */
export type RequestLock = (
  name: string,
  options: { readonly signal?: AbortSignal },
  callback: () => Promise<void>,
) => Promise<unknown>;

/** What {@link electLeader} accepts. */
export interface ElectLeaderOptions {
  /** The lock-request seam — `navigator.locks.request`, or a test fake. */
  readonly requestLock: RequestLock;

  /**
   * The lock name to contend for. Every tab electing the SAME resource must pass the SAME name;
   * `createCrossTabLiveQuery` derives it from the shape id so tabs of one shape share one leader.
   */
  readonly name: string;

  /**
   * Called once when THIS caller wins the lock and becomes leader. May run async setup (open the
   * durable store, the sync connection) and return a cleanup thunk run when leadership is later
   * relinquished ({@link LeaderElection.release}) — NOT on tab close, where the browser reclaims
   * the lock with no JS running. A throw here surfaces to {@link onError} and the lock is released
   * so another tab can take over, rather than leaving a wedged leader holding it.
   */
  readonly onLeadership: () => void | (() => void) | Promise<void | (() => void)>;

  /**
   * Notified when leadership setup ({@link onLeadership}) throws, or when the underlying request
   * rejects for a reason other than the expected abort-on-release. Absent → both are swallowed
   * (the failed bid simply yields no leadership).
   */
  readonly onError?: (error: unknown) => void;
}

/** A running leadership bid: read whether this caller currently holds the lock, and relinquish it. */
export interface LeaderElection {
  /** True while this caller holds the lock (is the leader); false before the grant and after release. */
  isLeader(): boolean;

  /**
   * Relinquish leadership — resolve the held lock so the next waiter is promoted — or, if the grant
   * has not landed yet, abort the pending bid so this caller never becomes leader. Idempotent: a
   * second call is a no-op, so a caller can release unconditionally on teardown.
   */
  release(): void;
}

/** A DOMException/`AbortError` from aborting a still-pending lock request — the expected release path. */
function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

/**
 * Contend for the named lock, running {@link ElectLeaderOptions.onLeadership} on the win and holding
 * leadership until {@link LeaderElection.release} (or the tab is destroyed). Returns synchronously
 * with the handle — the request runs in the background and the grant lands later, so `isLeader()`
 * is false until then.
 */
export function electLeader(options: ElectLeaderOptions): LeaderElection {
  const { requestLock, name, onLeadership, onError } = options;

  let leader = false;
  let released = false;

  // Resolves the "hold" promise the granted callback awaits — set only once we ARE the leader.
  // `release()` before the grant leaves this undefined and instead aborts the pending request.
  let releaseHold: (() => void) | undefined;

  // Aborts a still-PENDING request (queued, not yet granted). Once granted the signal is inert — a
  // held lock is released by resolving the hold, not by aborting — so calling `abort()` while
  // leader is a harmless no-op, which is why `release()` can call it unconditionally.
  const controller = new AbortController();

  const request = requestLock(name, { signal: controller.signal }, async () => {
    // Granted: we are the leader. Run setup; a throw gives the lock back (return) rather than
    // holding a broken leadership, after reporting it.
    leader = true;

    let cleanup: void | (() => void);

    try {
      cleanup = await onLeadership();
    } catch (error) {
      leader = false;
      onError?.(error);

      return;
    }

    // Hold the lock — and thus leadership — until `release()` resolves this. If `release()` already
    // ran during the async setup above, `released` is set, so resolve at once rather than hanging.
    await new Promise<void>((resolve) => {
      releaseHold = resolve;

      if (released) resolve();
    });

    leader = false;
    cleanup?.();
  });

  request.catch((error) => {
    // Aborting a pending bid on `release()` rejects the request with an AbortError — the expected,
    // silent path. Anything else (or an abort we did not initiate) is a real failure to report.
    if (isAbortError(error) && released) return;

    onError?.(error);
  });

  return {
    isLeader: () => leader,

    release: () => {
      if (released) return;

      released = true;

      // Cancel a still-pending bid (no-op once granted) AND drop a held lock (no-op if not yet
      // granted) — one of the two applies depending on whether the grant has landed.
      controller.abort();
      releaseHold?.();
    },
  };
}
