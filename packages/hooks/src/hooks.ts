/**
 * The extensibility core: a registry of named actions and filters.
 *
 * Instance-based on purpose — a `Hooks` is a plain object you construct, inject,
 * and throw away. No global singleton, so tests never bleed into one another.
 *
 * Ordering invariant for both actions and filters:
 *   - listeners run in ascending `priority` (LOWER priority runs FIRST);
 *   - ties break by insertion order (a stable sort preserves it).
 */

import type { ActionListener, FilterListener } from "./types";

/** The default slot every listener lands in unless it asks for another. */
const DEFAULT_PRIORITY = 10;

/** One registered listener, tagged with the priority that orders it. */
interface Registration<Listener> {
  readonly listener: Listener;
  readonly priority: number;
}

/**
 * Insert a registration into a bucket, keeping the bucket sorted by priority.
 *
 * A fresh-sorted array per add is fine: hook lists are short and registration
 * happens at wiring time, not in the hot path. Sorting on insert means the
 * dispatch path (`doAction` / `applyFilters`) can simply iterate.
 */
const register = <Listener>(
  bucket: Map<string, Registration<Listener>[]>,
  name: string,
  listener: Listener,
  priority: number,
): void => {
  const existing = bucket.get(name) ?? [];

  const next = [...existing, { listener, priority }];

  // Stable sort by priority; equal priorities keep their insertion order.
  next.sort((a, b) => a.priority - b.priority);

  bucket.set(name, next);
};

/**
 * Remove the first registration matching `listener` from a bucket.
 *
 * When a name's last listener leaves, we drop the key entirely so that
 * `hasAction` / `hasFilter` answer honestly without an empty-array false positive.
 */
const unregister = <Listener>(
  bucket: Map<string, Registration<Listener>[]>,
  name: string,
  listener: Listener,
): void => {
  const existing = bucket.get(name);

  if (existing === undefined) return;

  const next = existing.filter((registration) => registration.listener !== listener);

  if (next.length === 0) {
    bucket.delete(name);

    return;
  }

  bucket.set(name, next);
};

export class Hooks {
  private readonly actions = new Map<string, Registration<ActionListener>[]>();

  private readonly filters = new Map<string, Registration<FilterListener>[]>();

  // ---- actions: side effects ----

  addAction(name: string, listener: ActionListener, priority: number = DEFAULT_PRIORITY): this {
    register(this.actions, name, listener, priority);

    return this;
  }

  removeAction(name: string, listener: ActionListener): this {
    unregister(this.actions, name, listener);

    return this;
  }

  /** Run every listener for `name` in priority order, awaiting each in turn. */
  async doAction(name: string, ...args: unknown[]): Promise<void> {
    const registrations = this.actions.get(name);

    // No listeners is a no-op, not an error — the whole point of an extension point.
    if (registrations === undefined) return;

    for (const { listener } of registrations) {
      await listener(...args);
    }
  }

  hasAction(name: string): boolean {
    return this.actions.has(name);
  }

  // ---- filters: value transforms ----

  addFilter(name: string, listener: FilterListener, priority: number = DEFAULT_PRIORITY): this {
    register(this.filters, name, listener, priority);

    return this;
  }

  removeFilter(name: string, listener: FilterListener): this {
    unregister(this.filters, name, listener);

    return this;
  }

  /**
   * Thread `value` through each filter in priority order, each returning the next.
   *
   * With no filters registered the input passes through untouched. The `<T>`
   * names the caller's expected type; filters are free-form internally and the
   * contract is that the chain preserves it.
   */
  async applyFilters<T>(name: string, value: T, ...args: unknown[]): Promise<T> {
    const registrations = this.filters.get(name);

    if (registrations === undefined) return value;

    let current: unknown = value;

    for (const { listener } of registrations) {
      current = await listener(current, ...args);
    }

    // The chain is contracted to preserve T; the cast is that contract made explicit.
    return current as T;
  }

  hasFilter(name: string): boolean {
    return this.filters.has(name);
  }
}
