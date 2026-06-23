/**
 * @lesto/env — typed, validated environment.
 *
 *   import { defineEnv, envField } from "@lesto/env";
 *
 *   const env = defineEnv({
 *     PORT: envField.port().default(3000),
 *     NODE_ENV: envField.oneOf(["development", "production", "test"]).default("development"),
 *     DATABASE_URL: envField.string(),          // required — boot throws if unset
 *     LESTO_DEMO: envField.boolean().default(false),
 *   });
 *
 *   env.PORT;      // number    env.NODE_ENV;  // "development" | "production" | "test"
 *   env.DATABASE_URL;  // string     env.LESTO_DEMO;   // boolean
 *
 * `defineEnv` validates ONCE at boot and freezes the result; a missing or malformed
 * var throws a coded {@link EnvError} listing every problem. Reads `process.env` by
 * default; pass the Worker `env` binding as the second argument on the edge.
 *
 * SERVER/CLIENT SPLIT — for an app with both secrets and public island config, use the
 * two-sided shape (or the `@lesto/env/client` surface in an island):
 *
 *   const env = defineEnv({
 *     server: { DATABASE_URL: envField.string(), SESSION_SECRET: envField.string() },
 *     client: { PUBLIC_API_BASE: envField.string() },   // every client key is PUBLIC_*
 *   });
 *   env.DATABASE_URL;     // string on the server; in a browser island this THROWS
 *                         // ENV_SERVER_LEAK rather than leaking the secret.
 *   env.PUBLIC_API_BASE;  // readable everywhere — it is, by name, public.
 */

export { defineEnv } from "./define";
export type { EnvSchema, InferEnv } from "./define";

// The server/client split: the two-sided schema, the PUBLIC_ convention, and the
// browser-leak guard. `defineEnv` accepts the split shape directly (see `define.ts`);
// these are the building blocks + the explicitly-named entry for the split form.
export { defineSplitEnv, isPublicName, isServerContext, PUBLIC_PREFIX } from "./split";
export type { EnvHalf, InferSplit, SplitEnvSchema } from "./split";

// The browser-safe reader + the bundler-injection map (also re-exported from
// `@lesto/env/client` for an import surface an island can trust holds no secret).
export { defineClientEnv, PUBLIC_ENV_GLOBAL } from "./client";
export type { ClientSchema } from "./client";
export { clientDefineMap, PUBLIC_ENV_DEFINE_KEY } from "./inline";
export type { DefineMap } from "./inline";

export { EnvField, envField } from "./fields";
export type { EnvSource } from "./fields";

export { EnvError, LestoError } from "./errors";
export type { EnvErrorCode } from "./errors";
