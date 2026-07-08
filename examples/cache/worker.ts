/**
 * The cache app on the Cloudflare edge — the SAME read-through journey as the
 * Node `serve.ts`, but backed by Cloudflare D1 instead of a file SQLite.
 *
 *   bun alchemy.run.ts        # deploy → prints the live workers.dev url
 *
 * `buildApp` already takes any `@lesto/cache` `SqlDatabase` handle, so the only
 * difference from the Node leg is the substrate: `d1ToSqlDatabase(env.DB)` wraps
 * the D1 binding in that exact surface (`installCacheSchema` + `sqlStore` run
 * against it unchanged — the SQL cache store uses only `prepare`/`exec`, no
 * interactive transaction, which D1 supports). Because the store is D1 (not
 * per-isolate memory), a warm key survives across ISOLATES: a miss served by one
 * isolate populates D1, and a later GET landing on a different isolate is still a
 * hit with the identical `generatedAt`. `alchemy.run.ts`'s post-deploy smoke
 * asserts the warm **D1-backed** hit (two sequential GETs may share an isolate, so
 * it proves the hit reads through D1 — the cross-isolate case is the same code
 * path, not something two sequential requests can guarantee to exercise).
 *
 * Lesto's dispatcher is pure (ADR 0002), so the Worker is a thin adapter:
 * `toFetchHandler` turns the app's `handle` into `fetch(Request) => Response`.
 * The handler is built ONCE per isolate (module scope) and reused across
 * requests — `installCacheSchema`'s `CREATE TABLE IF NOT EXISTS` is idempotent,
 * so the per-isolate cold build is cheap and safe.
 */

import { systemClock } from "@lesto/cache";
import { d1ToSqlDatabase, toFetchHandler } from "@lesto/cloudflare";
import type { D1Database, EdgeExecutionContext } from "@lesto/cloudflare";

import { buildApp } from "./src/app";

/** The bindings this Worker is configured with (see alchemy.run.ts). */
interface Env {
  /** The Cloudflare D1 database backing the cache table. */
  readonly DB: D1Database;
}

type FetchHandler = (request: Request, ctx?: EdgeExecutionContext) => Promise<Response>;

const TTL_MS = 60_000;

// Built once per isolate, keyed by nothing but the (isolate-stable) D1 binding —
// there is no secret or flag to invalidate on, so a single memoized promise is
// enough. Awaiting the same promise on every request is the correct shape: the
// first request pays the cold build, the rest reuse it.
let handler: Promise<FetchHandler> | undefined;

async function build(env: Env): Promise<FetchHandler> {
  const { app } = await buildApp({
    handle: d1ToSqlDatabase(env.DB),
    clock: systemClock,
    ttlMs: TTL_MS,
  });

  return toFetchHandler((method, path, options) => app.handle(method, path, options));
}

export default {
  async fetch(request: Request, env: Env, ctx?: EdgeExecutionContext): Promise<Response> {
    if (handler === undefined) {
      const building = build(env);

      // Clear the memo if the build rejects (e.g. a transient D1 blip during
      // schema install) so the isolate retries on the next request instead of
      // serving a cached rejected promise for its whole life. A per-request
      // error can't reach here — `toFetchHandler` always resolves a Response.
      void building.catch(() => {
        handler = undefined;
      });

      handler = building;
    }

    return (await handler)(request, ctx);
  },
};
