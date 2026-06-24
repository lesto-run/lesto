/**
 * Compute the bundler `define`/replace map for the PUBLIC subset — the mechanism that
 * inlines `PUBLIC_*` config into island bundles (the missing third leg from the task:
 * "no import.meta.env / PUBLIC_* inlining, so an island has no framework way to read a
 * public API base URL").
 *
 * A browser has no `process.env`, so a public value an island reads must be SUBSTITUTED
 * at build time. This builds the `define` a bundler applies: a SINGLE entry mapping the
 * runtime global `defineClientEnv` reads ({@link PUBLIC_ENV_GLOBAL}) to a frozen JSON
 * object of the validated `PUBLIC_*` literals. `@lesto/assets`'s `buildClient` applies
 * it; `lesto build`/`dev` wire it by resolving the project's `env.client.ts` schema and
 * computing this map (see `@lesto/cli`'s `resolvePublicEnvDefine`). This stays pure so
 * the substitution is unit-tested without a bundler.
 *
 * Only `PUBLIC_*` names enter the bag — a server secret cannot, by construction, be
 * inlined (it is never in a client schema, and a misnamed client key was already
 * refused at schema-build time). That is the leak prevention, expressed as data.
 */

import type { ClientSchema } from "./client";
import { defineClientEnv, PUBLIC_ENV_GLOBAL } from "./client";

/** A bundler `define` map: `code expression` → `replacement source` (a JSON literal). */
export type DefineMap = Record<string, string>;

/**
 * The `define`-map KEY the island bundler replaces — the global read `defineClientEnv`
 * performs in the browser (`globalThis.__LESTO_PUBLIC_ENV__`). One key, so the public
 * bag is inlined with a single substitution.
 */
export const PUBLIC_ENV_DEFINE_KEY = `globalThis.${PUBLIC_ENV_GLOBAL}`;

/**
 * Build the `define` map that inlines a client schema's validated values into browser
 * code: `{ "globalThis.__LESTO_PUBLIC_ENV__": "{\"PUBLIC_X\":\"…\"}" }`. The island
 * bundler applies it, so `defineClientEnv`'s read of that global resolves to the frozen
 * literals — an island reaches its public config with no `process.env` in the browser.
 *
 * `source` is where the values are read from at BUILD time (the building process's
 * `process.env`, by default) — NOT injected wholesale into the browser; only the
 * resolved PUBLIC literals are. Validation runs first (via {@link defineClientEnv}), so
 * a build with a missing/malformed PUBLIC var fails the same coded way a boot does.
 */
export function clientDefineMap(schema: ClientSchema, source?: object): DefineMap {
  const values = defineClientEnv(schema, source) as Record<string, unknown>;

  // A frozen object literal of the public values — the bag the global resolves to.
  return { [PUBLIC_ENV_DEFINE_KEY]: JSON.stringify(values) };
}
