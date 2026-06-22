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
 */

export { defineEnv } from "./define";
export type { EnvSchema, InferEnv } from "./define";

export { EnvField, envField } from "./fields";
export type { EnvSource } from "./fields";

export { EnvError, LestoError } from "./errors";
export type { EnvErrorCode } from "./errors";
