/**
 * `@lesto/env/server` — the server-only surface. Identical to the package root, named
 * so the boundary is legible at the import site: a module importing from here declares
 * "I run on the server" (it may hold secrets), the mirror of `@lesto/env/client`.
 *
 * Importing this from an `app/islands/*` component is the smell the leak guard +
 * bundler refusal exist to catch — keep server schemas behind this surface and read
 * only `@lesto/env/client` from island code.
 */

export { defineEnv } from "./define";
export type { EnvSchema, InferEnv } from "./define";

export { defineSplitEnv, isPublicName, isServerContext, PUBLIC_PREFIX } from "./split";
export type { EnvHalf, InferSplit, SplitEnvSchema } from "./split";

export { defineClientEnv, PUBLIC_ENV_GLOBAL } from "./client";
export type { ClientSchema } from "./client";
export { clientDefineMap, PUBLIC_ENV_DEFINE_KEY } from "./inline";
export type { DefineMap } from "./inline";

export { EnvField, envField } from "./fields";
export type { EnvSource } from "./fields";

export { EnvError, LestoError } from "./errors";
export type { EnvErrorCode } from "./errors";
