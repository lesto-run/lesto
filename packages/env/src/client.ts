/**
 * `@lesto/env/client` — the browser-safe surface: read ONLY `PUBLIC_*` config, and
 * (for the bundler) compute the exact public subset to inline into island code.
 *
 *   // In an island (app/islands/*.tsx) — never import the server schema here:
 *   import { defineClientEnv, envField } from "@lesto/env/client";
 *   const env = defineClientEnv({ PUBLIC_API_BASE: envField.string() });
 *   fetch(`${env.PUBLIC_API_BASE}/posts`);
 *
 * A browser has no `process.env`, so the framework INLINES the public subset at build
 * time: `lesto build`/`dev` read the project's `env.client.ts` schema and hand
 * `@lesto/assets`'s `buildClient` the inject map, so the island bundle carries a single
 * global, `globalThis.{@link PUBLIC_ENV_GLOBAL}`, holding the frozen `PUBLIC_*` literals,
 * and `defineClientEnv` reads it. On the server (dev/SSR) that global is absent, so it
 * falls back to `process.env` — so the SAME call works in both places.
 *
 * This module imports NOTHING server-side: no secrets, no `defineEnv` over a server
 * schema. That is the boundary — an island that imports from here can only ever see
 * public values, by construction.
 */

import { defineEnv } from "./define";
import { EnvError } from "./errors";
import { envField } from "./fields";
import type { EnvField } from "./fields";
import { isPublicName, PUBLIC_PREFIX } from "./split";

// Re-export the field builders so an island has ONE import surface that is, by
// construction, free of any server schema or secret.
export { envField };
export type { EnvField };

/** A schema of public (`PUBLIC_*`) fields — the only shape a client may validate. */
export type ClientSchema = Record<string, EnvField<unknown>>;

/**
 * The global the island bundler writes the inlined public bag to. A single, namespaced
 * name (not a bare `process`/`import.meta` shim) so the bundler injects it with ONE
 * `define`, and `defineClientEnv` reads it without a dynamic-property dance.
 */
export const PUBLIC_ENV_GLOBAL = "__LESTO_PUBLIC_ENV__";

/** The shape of the injected public bag on `globalThis`. */
type PublicEnvHolder = { [PUBLIC_ENV_GLOBAL]?: Record<string, string | undefined> };

/**
 * The public-env bag, read browser/edge-safely.
 *
 * Prefer the bundler-injected `globalThis.__LESTO_PUBLIC_ENV__` (present in a built
 * island bundle); outside a bundle (server dev/SSR) it is absent, so fall back to
 * `process.env`, and to `{}` where there is no `process` either (a Worker). Only the
 * `PUBLIC_*` names a client schema declares are ever read, so a server secret sitting
 * in `process.env` is never surfaced here.
 */
function publicSource(): Record<string, string | undefined> {
  const injected = (globalThis as PublicEnvHolder)[PUBLIC_ENV_GLOBAL];

  if (injected !== undefined) return injected;

  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/**
 * Validate a PUBLIC-only schema into frozen, typed values — the island/browser reader.
 *
 * Every key MUST be `PUBLIC_*` (the same convention `defineEnv({ client })` enforces);
 * a non-public key throws `ENV_CLIENT_NOT_PUBLIC` as the schema is built, so a secret
 * can never be smuggled through the client surface. Reads the bundler-injected public
 * bag in the browser, `process.env` on the server — pass `source` to override either.
 */
export function defineClientEnv<S extends ClientSchema>(
  schema: S,
  source?: object,
): Readonly<{ [K in keyof S]: S[K] extends EnvField<infer T> ? T : never }> {
  const misnamed = Object.keys(schema).filter((name) => !isPublicName(name));

  if (misnamed.length > 0) {
    const noun = misnamed.length === 1 ? "key" : "keys";

    throw new EnvError(
      "ENV_CLIENT_NOT_PUBLIC",
      `client env ${noun} ${misnamed.map((n) => `"${n}"`).join(", ")} must be named ` +
        `"${PUBLIC_PREFIX}*" — only public vars may be read on the client.`,
      { keys: misnamed },
    );
  }

  return defineEnv(schema, source ?? publicSource()) as Readonly<{
    [K in keyof S]: S[K] extends EnvField<infer T> ? T : never;
  }>;
}
