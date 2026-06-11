/**
 * Render-time data resolution — the canonical island's machinery (ADR 0012).
 *
 * The static delivery tier (`dataPrimerScript`, see `data.ts`) hands the client
 * an unresolved `bind` + a parse-time primer: correct on a shared-cacheable
 * document, but it arrives too late to feed an `ssr: true` island's SERVER
 * markup. This module is the DYNAMIC tier: a per-request resolver that runs each
 * bound source's loader DURING the render, so `defineIsland` can read the value
 * with React's `use()` and render the island's real component with the data
 * inlined — server markup is the per-user truth, the client hydrates it, zero
 * extra requests.
 *
 * It supersedes and deletes ADR 0010's `resolveIslandData`, whose post-walk
 * manifest mutation could never reach an `ssr: true` island's server render.
 *
 * Two pieces:
 *   - {@link createSourceResolver} — wraps a `load(name)` in a per-name memo, so
 *     one loader runs per distinct source per request, its promise shared by
 *     every island that binds it (ADR 0010 §2's parallel-batch/no-chaining
 *     semantics, now compatible with streaming: one run, started on first use).
 *   - {@link IslandDataProvider} / {@link IslandDataContext} — carry the resolver
 *     down the server React tree; `defineIsland` reads it. Absent context means a
 *     static/prerender emission (the primer tier, or a loud refusal for
 *     `ssr: true` + `data`).
 */

import { createContext } from "react";
import type { FC, ReactNode } from "react";

/** Resolve a bound data source by name, memoized — one loader run per source per request. */
export interface SourceResolver {
  resolve(source: string): PromiseLike<unknown>;
}

/**
 * A thenable React's `use()` can read SYNCHRONOUSLY when its value is already
 * known. React tracks a thenable's `status`/`value`; a pre-fulfilled one lets
 * `use()` return without suspending, so a synchronous loader (estate's pure-HMAC
 * session) renders under the non-streaming renderers (`renderToString`,
 * `renderToStaticMarkup`) too, not only under Suspense.
 */
interface FulfilledThenable<T> extends PromiseLike<T> {
  status: "fulfilled";
  value: T;
}

/**
 * Wrap an already-known value as a fulfilled tracked thenable React reads
 * synchronously. The `then` is deliberate — this IS a thenable React's `use()`
 * consumes (it reads `status`/`value` for the sync return, and `then` is the
 * promise contract for any async consumer) — so the no-thenable rule is silenced
 * here on purpose.
 */
function fulfilled<T>(value: T): FulfilledThenable<T> {
  return {
    status: "fulfilled",
    value,
    // eslint-disable-next-line unicorn/no-thenable
    then(onFulfilled) {
      return Promise.resolve(onFulfilled ? onFulfilled(value) : (value as never));
    },
  };
}

/**
 * Build a memoized {@link SourceResolver} over a `load(name)` function.
 *
 * The first `resolve(name)` runs `load(name)` and caches the result keyed by
 * name; every later `resolve(name)` returns the same thenable, so two islands
 * binding one source share a single loader run. Chaining still has no API — the
 * loader receives only `name`, never another source's value (whatever request
 * context it needs, the caller closed over when building `load`).
 *
 * A loader that returns a real promise is memoized as-is and `use()` instruments
 * it the way React expects. A loader that returns a plain VALUE is stored as a
 * pre-fulfilled tracked thenable so `use()` reads it synchronously — keeping sync
 * loaders compatible with the buffered renderers and the tests simple.
 */
export function createSourceResolver(
  load: (source: string) => Promise<unknown> | unknown,
): SourceResolver {
  const memo = new Map<string, PromiseLike<unknown>>();

  return {
    resolve(source) {
      const cached = memo.get(source);

      if (cached !== undefined) return cached;

      const loaded = load(source);

      const thenable: PromiseLike<unknown> =
        typeof (loaded as { then?: unknown } | null)?.then === "function"
          ? (loaded as PromiseLike<unknown>)
          : fulfilled(loaded);

      memo.set(source, thenable);

      return thenable;
    },
  };
}

/**
 * The server-side context carrying the per-request {@link SourceResolver} to
 * every `defineIsland` in the tree. `null` by default — its absence is the
 * signal that this is a static/prerender emission (no render-time resolution),
 * which `defineIsland`'s resolution rule branches on.
 */
export const IslandDataContext = createContext<SourceResolver | null>(null);

/**
 * Provide a {@link SourceResolver} to the page subtree it wraps (dynamic render
 * only). `children` is optional so the provider may be created with positional
 * children via `createElement` (the `.page` renderer's form) as well as JSX.
 */
export const IslandDataProvider: FC<{ resolver: SourceResolver; children?: ReactNode }> = ({
  resolver,
  children,
}) => <IslandDataContext.Provider value={resolver}>{children}</IslandDataContext.Provider>;
