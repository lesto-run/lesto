/**
 * The vocabulary of the hooks system.
 *
 * Two kinds of extension point, mirroring WordPress:
 *   - an *action* is a side effect — it runs and returns nothing of value;
 *   - a *filter* threads a value through a chain, each link returning the next.
 *
 * Both are deliberately untyped at the boundary (`unknown`): the framework knows
 * nothing about what a given hook carries, so callers narrow at the edges.
 */

/** A side-effect listener. Its return is ignored; only a Promise is awaited. */
export type ActionListener = (...args: unknown[]) => void | Promise<void>;

/** A value transformer. Receives the running value plus extra context, returns the next value. */
export type FilterListener = (value: unknown, ...args: unknown[]) => unknown | Promise<unknown>;
