/**
 * bfcache-safe page lifecycle.
 *
 * The back/forward cache (bfcache) keeps a fully-formed page in memory when the
 * user navigates away, so Back/Forward is instant. A page is DISQUALIFIED the
 * moment it registers an `unload` or `beforeunload` listener — those handlers
 * were the historical way to "clean up on leave," and they are exactly what this
 * module refuses to let a Lesto client runtime use.
 *
 * The bfcache-friendly lifecycle is:
 *   - `pagehide` — the page is being hidden, possibly to enter the bfcache; check
 *     `event.persisted` to know which. The place to flush/persist, NOT to tear
 *     down listeners.
 *   - `pageshow` — the page is shown; `event.persisted === true` means it was
 *     restored FROM the bfcache (no fresh load fired), the cue to refresh
 *     per-visitor state (a live island may need to re-resolve the session).
 *   - `visibilitychange` — finer-grained hidden/visible, the modern signal for
 *     "save now, the user may not come back."
 *
 * This is the one place the framework's client code attaches lifecycle handlers,
 * so the invariant ("never unload/beforeunload") lives in one auditable spot. The
 * `target` (defaults to `window`) is injected so the whole thing is testable
 * under jsdom against a fake event target — no real navigation needed.
 */

/** The lifecycle moments a Lesto client runtime may react to. All bfcache-safe. */
export interface PageLifecycleHandlers {
  /** The page is being hidden. `persisted` is true iff it is entering the bfcache. */
  onPageHide?: (persisted: boolean) => void;

  /** The page is being shown. `persisted` is true iff it was RESTORED from bfcache. */
  onPageShow?: (persisted: boolean) => void;

  /** Visibility flipped. `visible` is true for "visible", false for "hidden". */
  onVisibilityChange?: (visible: boolean) => void;
}

/** The minimal event-target surface we attach to — `window` satisfies it. */
export interface LifecycleTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Detach every listener `observePageLifecycle` attached. Idempotent. */
export type StopLifecycle = () => void;

/** Options: where to listen, and how to read document visibility (both injectable). */
export interface ObserveOptions {
  target?: LifecycleTarget;
  /** Reads the current visibility state; defaults to `document.visibilityState`. */
  visibilityState?: () => string;
}

/**
 * Attach bfcache-safe lifecycle listeners and return a `stop()` that removes them.
 *
 * Only the handlers you provide are wired — an absent handler attaches no
 * listener at all. The function attaches NOTHING to `unload`/`beforeunload`,
 * which is the property that keeps the page bfcache-eligible.
 *
 * `pageshow`/`pagehide` carry a `persisted` flag on the native `PageTransitionEvent`;
 * we read it defensively (treating a missing flag as `false`) so the helper holds
 * up under a bare fake target whose events do not carry it.
 */
export function observePageLifecycle(
  handlers: PageLifecycleHandlers,
  options: ObserveOptions = {},
): StopLifecycle {
  const target: LifecycleTarget = options.target ?? window;

  const readVisibility: () => string = options.visibilityState ?? (() => document.visibilityState);

  // Every (type, listener) we attach, recorded so `stop()` can remove exactly
  // these and nothing else — a clean teardown with no global state.
  const attached: Array<[string, (event: Event) => void]> = [];

  const listen = (type: string, listener: (event: Event) => void): void => {
    target.addEventListener(type, listener);

    attached.push([type, listener]);
  };

  if (handlers.onPageHide !== undefined) {
    const handler = handlers.onPageHide;

    listen("pagehide", (event) => handler(isPersisted(event)));
  }

  if (handlers.onPageShow !== undefined) {
    const handler = handlers.onPageShow;

    listen("pageshow", (event) => handler(isPersisted(event)));
  }

  if (handlers.onVisibilityChange !== undefined) {
    const handler = handlers.onVisibilityChange;

    listen("visibilitychange", () => handler(readVisibility() === "visible"));
  }

  return () => {
    for (const [type, listener] of attached) {
      target.removeEventListener(type, listener);
    }

    // Drop our references so a second stop() is a harmless no-op.
    attached.length = 0;
  };
}

/**
 * Read a `pageshow`/`pagehide` event's `persisted` flag, defaulting to `false`.
 *
 * The native event is a `PageTransitionEvent` carrying `persisted: boolean`; a
 * plain `Event` (or a test double) has no such field, and "not persisted" is the
 * safe assumption — it means "treat this as a normal hide/show," never "restored
 * from cache."
 */
function isPersisted(event: Event): boolean {
  return (event as { persisted?: boolean }).persisted === true;
}
