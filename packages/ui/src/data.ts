/**
 * Island data sources — declared data, framework-owned delivery (ADR 0010).
 *
 * An island gets its per-request data through a typed, implementation-free
 * TOKEN shared between server and client. The server binds an implementation to
 * the token (`keel().data(source, loader)`); an island binds a prop to the
 * token (`defineClient({ data: { session: sessionSource } })`); the component
 * receives the value as a prop and is a pure function of it. There is no
 * `fetch`-in-effect for the author to write, and therefore no waterfall to
 * write — the whole point.
 *
 * The token carries only a NAME and a phantom TYPE. It deliberately holds no
 * implementation, so importing the shared token module from the client bundle
 * (as the island registry does) drags no server code across the wire.
 *
 * Delivery is chosen by topology, never by the author (ADR 0010 §3):
 *   - dynamically rendered → {@link resolveIslandData} runs loaders at render
 *     and inlines the values into the manifest props (0 extra requests);
 *   - static / prerendered with a server in the path → the document carries the
 *     unresolved bind plus the {@link dataPrimerScript} primer, which kicks the
 *     fetch at HTML-parse time (parallel with `client.js`), and the client
 *     hydration runtime awaits it (1 RTT, never the serial `doc → js → fetch`).
 */

import { UiError } from "./errors";

import type { IslandMount } from "./island";

/**
 * A typed handle to a named data source — no implementation, just a name and a
 * phantom value type. `defineDataSource<User | null>("session")` names the
 * source and pins what its loader returns / its bound prop receives.
 */
export interface DataSource<T = unknown> {
  readonly name: string;

  /** Phantom: carries the resolved value's type to the binding. Never present at runtime. */
  readonly __value?: T;
}

/**
 * A source name must be a single safe URL/identifier segment: it becomes a path
 * segment (`/__keel/data/<name>`) AND is embedded in the executable primer
 * script, so anything outside this charset could break out of the route or the
 * string literal. Locking the charset is what keeps the primer injection-safe
 * without escaping gymnastics (the primer carries names + hrefs, never data).
 */
const VALID_SOURCE_NAME = /^[a-zA-Z0-9_-]+$/;

/** The route prefix the framework auto-exposes every registered source under. */
export const DATA_ROUTE_PREFIX = "/__keel/data/";

/** The endpoint a source's client fallback fetch hits — `/__keel/data/<name>`. */
export function dataSourceHref(name: string): string {
  return `${DATA_ROUTE_PREFIX}${name}`;
}

/**
 * Declare a data source: a typed token bound to an implementation elsewhere
 * (server) and to a prop elsewhere (island). The name is validated here so an
 * unsafe one fails loudly at declaration, not as a broken route or a malformed
 * primer at request time.
 */
export function defineDataSource<T>(name: string): DataSource<T> {
  if (!VALID_SOURCE_NAME.test(name)) {
    throw new UiError(
      "UI_INVALID_DATA_SOURCE_NAME",
      `data source name "${name}" must match ${String(VALID_SOURCE_NAME)} (it is a URL segment and a script literal)`,
      { name },
    );
  }

  return { name };
}

/** One bound prop on an island: which source feeds it, and where the client fetches it. */
export interface IslandBind {
  source: string;

  href: string;
}

/**
 * Collect the distinct sources every island on the page binds.
 *
 * Shared by the primer (which kicks one fetch per distinct source) and the
 * server resolver (which runs one loader per distinct source) — a source bound
 * by three islands is fetched/run once, not three times.
 */
function distinctSources(manifest: readonly IslandMount[]): Map<string, string> {
  const sources = new Map<string, string>();

  for (const mount of manifest) {
    if (mount.bind === undefined) continue;

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
 * The promise per source lands on `window.__keelData[<name>]`, exactly what the
 * hydration runtime awaits before mounting a bound island. The script embeds
 * only framework-controlled, charset-validated names and hrefs (never data),
 * so the JSON-encoded literals cannot break out of the `<script>`.
 */
export function dataPrimerScript(manifest: readonly IslandMount[]): string {
  const sources = distinctSources(manifest);

  if (sources.size === 0) return "";

  const assignments = [...sources]
    .map(
      ([name, href]) =>
        `w[${JSON.stringify(name)}]=fetch(${JSON.stringify(href)},{credentials:"same-origin"}).then(function(r){return r.json()})`,
    )
    .join(";");

  return `(function(){var w=window.__keelData=window.__keelData||{};${assignments};})()`;
}

/**
 * Resolve every bound source at render time and inline the values into the
 * manifest props — the dynamic-render delivery tier (ADR 0010 §3): the document
 * arrives with the data already in it, zero extra requests.
 *
 * `resolve` runs one loader per DISTINCT source (in parallel), with whatever
 * request context the caller closes over. Each island's bound props are then
 * set to the resolved values and its `bind` removed — so the client sees a
 * fully-propped island with no bind and mounts it synchronously. Mutates the
 * manifest in place (the caller serializes it immediately after). A manifest
 * with no binds is a no-op.
 */
export async function resolveIslandData(
  manifest: readonly IslandMount[],
  resolve: (source: string) => Promise<unknown> | unknown,
): Promise<void> {
  const sources = distinctSources(manifest);

  if (sources.size === 0) return;

  const resolved = new Map(
    await Promise.all(
      [...sources.keys()].map(async (name) => [name, await resolve(name)] as const),
    ),
  );

  for (const mount of manifest) {
    if (mount.bind === undefined) continue;

    for (const [prop, bind] of Object.entries(mount.bind)) {
      (mount.props as Record<string, unknown>)[prop] = resolved.get(bind.source);
    }

    delete mount.bind;
  }
}
