/**
 * The Cloudflare Worker entry — the estate site on the edge.
 *
 *   wrangler deploy
 *
 * Keel's dispatcher is pure, so the Worker is a thin adapter (ADR 0002):
 * `toFetchHandler` turns the app's `handle` into `fetch(Request) => Response`,
 * and `withAssets` serves the prerendered marketing files from the Static Assets
 * binding first, falling through to the live app for `/mls`. The session is a
 * stateless signed token, so auth works across ephemeral isolates with no store.
 *
 * `env.SESSION_SECRET` is a wrangler secret (`wrangler secret put SESSION_SECRET`),
 * never committed — it is the trust root for every signed session.
 *
 * This is also the canonical OTLP-on-Workers reference (edge-deploy #3). Tracing
 * is constructed the SAME env-driven way the node entry (`serve.ts`) uses —
 * `tracesFromEnv`, off unless `KEEL_OTLP_URL` is set — but off the Worker `env`
 * binding, not `process.env`, and with the platform `fetch` injected. The edge
 * has no steady process to flush spans on an interval, so each request schedules
 * the exporter's `flush()` through `ctx.waitUntil` (see `fetch` below): the spans
 * drain AFTER the `Response` returns, never on its critical path and never lost
 * when the isolate would otherwise freeze at `return`.
 */

import { toFetchHandler, withAssets } from "@keel/cloudflare";
import type { AssetExecutionContext, AssetFetcher } from "@keel/cloudflare";

import { parseTraceparent, tracesFromEnv } from "@keel/observability";
import type { CurrentSpan, Traces } from "@keel/observability";

import { currentRequestSpan } from "@keel/web";

// The Preact server dialect. This import is only honest because wrangler bundles
// this worker with the react→preact/compat alias block (wrangler.jsonc): inside
// that bundle, every element @keel/ui builds is a Preact vnode, which is exactly
// what preact-render-to-string consumes. The matched pair — Preact server markup
// + the Preact client bundle `build.ts` ships — is ADR 0008's invariant.
import { preactServerRenderer } from "@keel/ui/server";

import { buildEdgeApp, edgeSecret, isDemoMode } from "./src/edge";
import { d1ContentStore, hyperdriveContentStore } from "./src/content";
import type { ContentStore } from "./src/content";
import type { D1Database, Hyperdrive, HyperdriveConnection } from "@keel/cloudflare";
import postgres from "postgres";

/** The bindings this Worker is configured with (see wrangler.jsonc). */
interface Env {
  readonly ASSETS: AssetFetcher;
  readonly SESSION_SECRET?: string;
  readonly KEEL_DEMO?: string;
  /** The Cloudflare D1 database backing the DB-driven `/lab/content` page. */
  readonly DB?: D1Database;

  /**
   * An optional Cloudflare Hyperdrive binding fronting a real Postgres — the
   * flagship-tier substrate for the DB-driven `/lab/content` page. When present it
   * takes PRECEDENCE over D1: the content store runs over `hyperdriveToSqlDatabase`
   * (Postgres at scale, same `SqlDatabase` surface) instead of D1's edge SQLite.
   * Absent, the page uses D1 exactly as before. To exercise it, add a
   * `[[hyperdrive]]` binding named `HYPERDRIVE` to wrangler.jsonc; this example
   * ships D1-only by default.
   */
  readonly HYPERDRIVE?: Hyperdrive;

  /**
   * OTLP tracing knobs, off the Worker `env` binding (NOT `process.env` — there
   * is none on the edge). `KEEL_OTLP_URL` is the on switch: absent, tracing is
   * off and the Worker pays nothing. The same two-env-var setup the node entry
   * reads, so one deployment configures both tiers identically.
   */
  readonly KEEL_OTLP_URL?: string;
  readonly KEEL_OTLP_SERVICE?: string;
  readonly KEEL_OTLP_HEADERS?: string;
}

/** A Cloudflare Worker fetch handler — what both `toFetchHandler` and `withAssets` produce. */
type FetchHandler = (request: Request, ctx?: AssetExecutionContext) => Promise<Response>;

/**
 * The app/handler is built once per isolate and reused across requests, not
 * rebuilt on every `fetch`. Constructing the `keel()` app and its
 * `SignedSessions` is pure CPU that depends on nothing but the signing secret,
 * so doing it per request burned cycles on the edge for an identical result
 * (research finding 11: keep work out of the per-request path). We memoize the
 * `toFetchHandler` closure at module scope, keyed by the resolved secret.
 *
 * Keying by secret is the correctness guard: a Worker's secret is fixed for an
 * isolate's lifetime, so the cache hits every time in production — but if the
 * resolved secret ever differs (a rotation, or a test that drives two secrets
 * through the same module), we rebuild rather than serve a handler signing with
 * the wrong key. There is no cross-secret leakage: a different secret is a miss.
 *
 * `env.ASSETS` is deliberately NOT part of what we cache. It is a per-request
 * binding the runtime hands us fresh on each `fetch`, so `withAssets` is rewrapped
 * every request around the cached handler — cheap composition, no rebuild.
 */
let cachedSecret: string | undefined;
let cachedDemo: boolean | undefined;
let cachedHandler: FetchHandler | undefined;
let cachedStore: ContentStore | undefined;

/**
 * The tracing handle, built once per isolate off the `env` binding.
 *
 * `undefined` means tracing is off (no `KEEL_OTLP_URL`) OR not yet built. The
 * `built` flag distinguishes the two so we construct exactly once per isolate:
 * `tracesFromEnv` legitimately returns `undefined` when tracing is off, and we
 * must not re-run construction every request chasing a handle that will always
 * be absent.
 */
let cachedTraces: Traces | undefined;
let tracesBuilt = false;

/**
 * Build (once per isolate) the OTLP tracing handle from the Worker `env`.
 *
 * The SAME `tracesFromEnv` call the node entry makes — off unless `KEEL_OTLP_URL`
 * is set — but reading the Worker `env` binding (there is no `process.env` on the
 * edge) and injecting the platform `fetch` as the exporter's HTTP seam. The
 * `currentSpan` seam reads the request span the adapter publishes on the context,
 * so a db query / auth event fired during a request parents on it.
 */
function tracesFor(env: Env): Traces | undefined {
  if (!tracesBuilt) {
    cachedTraces = tracesFromEnv(env, {
      currentSpan: currentRequestSpan as CurrentSpan,
      fetchFn: fetch,
    });

    tracesBuilt = true;
  }

  return cachedTraces;
}

/**
 * A structured JSON access log — one line per served request, machine-readable.
 *
 * The deployed prod target logged errors only; this gives the edge the per-request
 * access log the node server has, as JSON (not the adapter's default human line)
 * so a log pipeline can index method/path/status/latency/request-id directly. The
 * canonical OTLP-on-Workers reference logs traces AND a structured access line.
 */
function logEdgeRequest(entry: {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly requestId: string;
}): void {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "request",
      method: entry.method,
      path: entry.path,
      status: entry.status,
      ms: entry.ms,
      request_id: entry.requestId,
    }),
  );
}

/**
 * Adapt the Hyperdrive binding's postgres connection to the `HyperdriveConnection`
 * the content store consumes — `query(text, values) => { rows, rowCount }`.
 *
 * The Worker speaks to Hyperdrive's `connectionString` with postgres-js (`postgres`),
 * a Workers-compatible client. `sql.unsafe(text, params)` runs an already-`$n`-bound
 * statement (the adapter translates `?`→`$n` before it gets here) and returns a
 * result array whose `.count` is the affected/returned row count — mapped to the
 * `{ rows, rowCount }` node-postgres shape `hyperdriveToSqlDatabase` reads.
 */
function hyperdriveConnection(hyperdrive: Hyperdrive): HyperdriveConnection {
  // Pin to ONE connection: the adapter runs a transaction as three separate
  // queries (BEGIN, body, COMMIT), and postgres-js's default pool would scatter
  // them across connections — silently voiding `db.transaction()` atomicity.
  const sql = postgres(hyperdrive.connectionString, { max: 1 });

  return {
    query: async (text, values = []) => {
      const result = await sql.unsafe(text, values as never[]);

      return { rows: [...result], rowCount: result.count };
    },
  };
}

/**
 * Build the DB-driven content store from the per-isolate bindings, preferring
 * Hyperdrive (real Postgres at scale) over D1 (edge SQLite) when its binding is
 * present. Absent both, `undefined` — the content page renders its "configure a
 * binding" view rather than 404ing. Either way the page runs the IDENTICAL query
 * path; only the substrate (and dialect) differs (ADR 0006's same-surface promise).
 */
function contentStoreFor(
  d1: D1Database | undefined,
  hyperdrive: Hyperdrive | undefined,
): ContentStore | undefined {
  if (hyperdrive !== undefined) return hyperdriveContentStore(hyperdriveConnection(hyperdrive));

  return d1 === undefined ? undefined : d1ContentStore(d1);
}

/**
 * The fetch handler for `secret` + `demo`, built once per isolate and reused.
 *
 * Keyed by both the secret and the demo flag: the demo flag changes whether the
 * passwordless `?as=` sign-in is reachable, so a flag change must rebuild rather
 * than serve a handler with the wrong auth posture. The content store is derived
 * from the per-isolate bindings (Hyperdrive preferred over D1, both stable for the
 * isolate's lifetime), so it is built inside the rebuild and reused across requests
 * — never re-opened (which would re-run its seed check) per request.
 *
 * The tracing handle (`traces`) is isolate-stable too, so it is folded into the
 * handler here: when tracing is on, every request mints a span (joined to an
 * inbound `traceparent`, published on the context for child spans) and the
 * exporter's `flush` is wired so `fetch` can drain it through `ctx.waitUntil`.
 */
function handlerFor(
  secret: string,
  demo: boolean,
  d1: D1Database | undefined,
  hyperdrive: Hyperdrive | undefined,
  traces: Traces | undefined,
): FetchHandler {
  // The d1/hyperdrive bindings are deliberately NOT part of the rebuild key: they
  // are isolate-stable for the isolate's lifetime, and keying on their identity
  // would risk spurious per-request rebuilds that re-run the store's seed check.
  if (cachedHandler === undefined || cachedSecret !== secret || cachedDemo !== demo) {
    cachedStore = contentStoreFor(d1, hyperdrive);

    const app = buildEdgeApp(secret, {
      serverRenderer: preactServerRenderer,
      demo,
      ...(cachedStore === undefined ? {} : { contentStore: cachedStore }),
    });

    cachedHandler = toFetchHandler((method, path, options) => app.handle(method, path, options), {
      logRequest: logEdgeRequest,
      // When tracing is off these are absent and the adapter mints no spans and
      // schedules no flush — the zero-overhead default. When on, the request span
      // joins an inbound `traceparent` and `flush` drains the buffer per request.
      ...(traces === undefined
        ? {}
        : { tracer: traces.requestTracer, parseTraceparent, flush: () => traces.flush() }),
    });
    cachedSecret = secret;
    cachedDemo = demo;
  }

  return cachedHandler;
}

export default {
  fetch(request: Request, env: Env, ctx: AssetExecutionContext): Promise<Response> {
    // The tracer is built once per isolate off `env` (off unless KEEL_OTLP_URL).
    const traces = tracesFor(env);

    // edgeSecret FAILS CLOSED: an unset SESSION_SECRET outside demo mode throws
    // here, so the Worker refuses to serve rather than sign with a public secret.
    const handler = handlerFor(edgeSecret(env), isDemoMode(env), env.DB, env.HYPERDRIVE, traces);

    // Static marketing files first (cached at the PoP); the live app for the rest.
    // `env.ASSETS` is per-request, so this thin wrap happens every time; the
    // handler it wraps is the cached, isolate-lifetime one built above. `ctx` is
    // forwarded so the dynamic handler can flush its spans via `ctx.waitUntil`
    // AFTER the response returns — the edge's no-span-loss contract.
    return withAssets(env.ASSETS, handler)(request, ctx);
  },
};
