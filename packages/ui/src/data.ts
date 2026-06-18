/**
 * Island data sources — declared data, framework-owned delivery (ADR 0010).
 *
 * An island gets its per-request data through a typed, implementation-free
 * TOKEN shared between server and client. The server binds an implementation to
 * the token (`lesto().data(source, loader)`); an island binds a prop to the
 * token (`defineClient({ data: { session: sessionSource } })`); the component
 * receives the value as a prop and is a pure function of it. There is no
 * `fetch`-in-effect for the author to write, and therefore no waterfall to
 * write — the whole point.
 *
 * The token carries only a NAME, a SCOPE (per-user vs shared — it picks the auto
 * route's cache header, ADR 0010 §3a), and a phantom TYPE. It deliberately holds
 * no implementation, so importing the shared token module from the client bundle
 * (as the island registry does) drags no server code across the wire.
 *
 * Delivery is chosen by topology, never by the author:
 *   - dynamically rendered → the render-time resolver in `data-resolve.tsx`
 *     (ADR 0012) runs loaders DURING the render and `defineIsland` inlines the
 *     values straight into the island's props — feeding even an `ssr: true`
 *     island's server markup (the canonical island, 0 extra requests). This
 *     module owns only the STATIC tier;
 *   - static / prerendered with a server in the path → the document carries the
 *     unresolved bind plus the {@link dataPrimerScript} primer, which kicks the
 *     fetch at HTML-parse time (parallel with `client.js`), and the client
 *     hydration runtime awaits it (1 RTT, never the serial `doc → js → fetch`).
 *     A `hydrate: "visible"` island is EXCLUDED from the primer — its data is
 *     deferred to first intersection along with its mount, or `"visible"` would
 *     be defeated by a parse-time fetch.
 */

import { UiError } from "./errors";

import type { IslandMount } from "./island";

/**
 * Whether a source's value is per-user (`"private"`) or the same for everyone
 * (`"shared"`). It is a MEANING only the author can know, so it is declared, not
 * inferred — and it drives the cache header on the auto-exposed route (ADR 0010
 * §3a): `private` → `no-store` (a per-user JSON GET with no cache header is a
 * session leak waiting for a CDN), `shared` → revalidated-but-cacheable.
 */
export type DataSourceScope = "private" | "shared";

/**
 * A typed handle to a named data source — no implementation, just a name, a
 * scope, and a phantom value type. `defineDataSource<User | null>("session")`
 * names the source and pins what its loader returns / its bound prop receives.
 */
export interface DataSource<T = unknown> {
  readonly name: string;

  /** Per-user or shared — drives the route's cache header. Defaults to `"private"`. */
  readonly scope: DataSourceScope;

  /** Phantom: carries the resolved value's type to the binding. Never present at runtime. */
  readonly __value?: T;
}

/**
 * A source name must be a single safe URL/identifier segment: it becomes a path
 * segment (`/__lesto/data/<name>`) AND is embedded in the executable primer
 * script, so anything outside this charset could break out of the route or the
 * string literal. Locking the charset is what keeps the primer injection-safe
 * without escaping gymnastics (the primer carries names + hrefs, never data).
 */
const VALID_SOURCE_NAME = /^[a-zA-Z0-9_-]+$/;

/** The route prefix the framework auto-exposes every registered source under. */
export const DATA_ROUTE_PREFIX = "/__lesto/data/";

/** The endpoint a source's client fallback fetch hits — `/__lesto/data/<name>`. */
export function dataSourceHref(name: string): string {
  return `${DATA_ROUTE_PREFIX}${name}`;
}

/**
 * Declare a data source: a typed token bound to an implementation elsewhere
 * (server) and to a prop elsewhere (island). The name is validated here so an
 * unsafe one fails loudly at declaration, not as a broken route or a malformed
 * primer at request time.
 *
 * `scope` declares whether the value is per-user (`"private"`, the default) or
 * the same for every visitor (`"shared"`) — the meaning that picks the auto
 * route's cache header (ADR 0010 §3a). Private-by-default keeps the dangerous
 * configuration (a per-user value heuristically cached by a CDN) unrepresentable
 * without a visible declaration.
 */
export function defineDataSource<T>(
  name: string,
  options?: { scope?: DataSourceScope },
): DataSource<T> {
  if (!VALID_SOURCE_NAME.test(name)) {
    throw new UiError(
      "UI_INVALID_DATA_SOURCE_NAME",
      `data source name "${name}" must match ${String(VALID_SOURCE_NAME)} (it is a URL segment and a script literal)`,
      { name },
    );
  }

  return { name, scope: options?.scope ?? "private" };
}

/** One bound prop on an island: which source feeds it, and where the client fetches it. */
export interface IslandBind {
  source: string;

  href: string;
}

/**
 * Collect the distinct sources every PRIMED island on the page binds.
 *
 * A `hydrate: "visible"` island is excluded: its mount work — and so its data
 * fetch — is deferred to first intersection (resolved then by the client's
 * fallback fetch), or the whole point of `"visible"` is defeated by priming it
 * at parse time (ADR 0010 corrections #4). A source bound by both an eager and a
 * visible island still primes once: the eager mount keeps it in the map.
 *
 * Shared by the primer (which kicks one fetch per distinct source) and the
 * server resolver (which runs one loader per distinct source) — a source bound
 * by three islands is fetched/run once, not three times.
 */
function distinctSources(manifest: readonly IslandMount[]): Map<string, string> {
  const sources = new Map<string, string>();

  for (const mount of manifest) {
    if (mount.bind === undefined) continue;

    if (mount.strategy === "visible") continue;

    for (const bind of Object.values(mount.bind)) {
      sources.set(bind.source, bind.href);
    }
  }

  return sources;
}

/**
 * Build the inline primer that starts every unresolved bind's fetch at
 * HTML-parse time, so the data request runs parallel with `client.js` instead
 * of waiting for it (ADR 0010 §3, the static default). Returns the script body
 * (the caller wraps it in `<script>`); an empty string when the page has no
 * unresolved binds, so a page without data emits no primer at all.
 *
 * The promise per source lands on `window.__lestoData[<name>]`, exactly what the
 * hydration runtime awaits before mounting a bound island. The script embeds
 * only framework-controlled, charset-validated names and hrefs (never data),
 * so the JSON-encoded literals cannot break out of the `<script>`.
 *
 * Three properties the emitted body carries (ADR 0010 corrections #3, Seam 1 §3):
 *   - `w[name]=w[name]||fetch(...)` is IDEMPOTENT: two islands binding one source
 *     (each emitting its own primer) issue a single credentialed fetch, not two.
 *   - the `if(!r.ok)throw` rejects the stored promise on a 401/429 etc., so a
 *     JSON error body never becomes the island's prop value; `hydrateIslands`
 *     routes that rejection to `onMountError`/`failed` and the island keeps its
 *     fallback — correct for an unauthenticated visitor.
 *   - the trailing detached `.catch(function(){})` marks the rejection HANDLED so
 *     a failure that lands before hydration attaches its handler does not fire a
 *     spurious `unhandledrejection`. It does NOT swallow the error for the
 *     hydration runtime, which awaits the ORIGINAL stored promise (`w[name]`),
 *     not this detached branch.
 */
export function dataPrimerScript(manifest: readonly IslandMount[]): string {
  const sources = distinctSources(manifest);

  if (sources.size === 0) return "";

  const assignments = [...sources]
    .map(([name, href]) => {
      const w = `w[${JSON.stringify(name)}]`;

      return (
        `${w}=${w}||fetch(${JSON.stringify(href)},{credentials:"same-origin"})` +
        `.then(function(r){if(!r.ok)throw new Error("lesto data "+r.status);return r.json()});` +
        `${w}.catch(function(){})`
      );
    })
    .join(";");

  return `(function(){var w=window.__lestoData=window.__lestoData||{};${assignments};})()`;
}
