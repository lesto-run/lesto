/**
 * `defineEnv` — validate the environment once, at boot, into frozen typed values.
 *
 *   const env = defineEnv({
 *     PORT: envField.port().default(3000),
 *     DATABASE_URL: envField.string(),
 *     LESTO_DEMO: envField.boolean().default(false),
 *   });
 *   env.PORT;          // number (3000 when unset)
 *   env.DATABASE_URL;  // string (the boot throws if it was missing)
 *
 * A missing or malformed var fails fast with a coded {@link EnvError} that names
 * EVERY problem at once, so one run surfaces the whole list rather than one-then-
 * the-next. The result is `Object.freeze`d — config does not drift after boot.
 */

import { EnvError } from "./errors";
import type { EnvField, EnvSource } from "./fields";

/** A schema: a {@link EnvField} per variable name. */
export type EnvSchema = Record<string, EnvField<unknown>>;

/** The validated, fully-typed result of a {@link defineEnv} schema. */
export type InferEnv<S extends EnvSchema> = {
  [K in keyof S]: S[K] extends EnvField<infer T> ? T : never;
};

/**
 * The ambient process env, read edge-safely: `{}` where there is no `process` (a
 * Cloudflare Worker has none — pass that runtime's `env` binding as `source` there).
 */
function processEnv(): EnvSource {
  return (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};
}

/**
 * Validate `source` (default: `process.env`) against `schema`, returning a frozen,
 * fully-typed env object — or throwing a coded {@link EnvError} that lists EVERY
 * problem at once. Pass `source` explicitly on the edge, where the values live on a
 * Worker `env` binding and there is no `process.env`.
 */
export function defineEnv<S extends EnvSchema>(
  schema: S,
  source?: EnvSource,
): Readonly<InferEnv<S>> {
  const from = source ?? processEnv();

  const values: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [key, field] of Object.entries(schema)) {
    const result = field.parse(from[key]);

    if (result.ok) values[key] = result.value;
    else problems.push(`  ${key} ${result.error}`);
  }

  if (problems.length > 0) {
    const noun = problems.length === 1 ? "problem" : "problems";

    throw new EnvError(
      "ENV_VALIDATION_FAILED",
      `Invalid environment — ${problems.length} ${noun}:\n${problems.join("\n")}`,
      { count: problems.length },
    );
  }

  return Object.freeze(values) as Readonly<InferEnv<S>>;
}
