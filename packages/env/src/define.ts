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
import { EnvField } from "./fields";
import type { EnvSource } from "./fields";
import { defineSplitEnv } from "./split";
import type { InferSplit, SplitEnvSchema } from "./split";

/** A schema: a {@link EnvField} per variable name. */
export type EnvSchema = Record<string, EnvField<unknown>>;

/** The validated, fully-typed result of a {@link defineEnv} schema. */
export type InferEnv<S extends EnvSchema> = {
  [K in keyof S]: S[K] extends EnvField<infer T> ? T : never;
};

/**
 * Whether `schema` is the two-sided split shape (`{ server?, client? }`) rather than a
 * flat field map. A split half is a plain RECORD of fields, never an {@link EnvField};
 * a flat schema's values are all `EnvField`s. So a `server`/`client` key whose value is
 * not an `EnvField` is the unambiguous split signal — a flat schema with a literal var
 * named `server` would carry an `EnvField` there, and is (correctly) read as flat.
 */
function isSplitSchema(schema: object): schema is SplitEnvSchema {
  const candidate = schema as { server?: unknown; client?: unknown };

  return (
    (candidate.server !== undefined && !(candidate.server instanceof EnvField)) ||
    (candidate.client !== undefined && !(candidate.client instanceof EnvField))
  );
}

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
 * problem at once.
 *
 * `source` is typed `object`, not `EnvSource`, on purpose: a Cloudflare Worker `env`
 * binding is a generated `interface Env` carrying NON-string members (an `ASSETS`
 * fetcher, KV/DO bindings), and a TS `interface` is assignable to `object` but not to
 * a `Record<string, string>`. So `defineEnv(schema, workerEnv)` typechecks on the edge
 * exactly as on Node. Only the keys NAMED in the schema are read, and a value that is
 * not a string (a binding, or an unset var) reads as "not set" — so a non-string
 * binding never pollutes a validated value.
 *
 * Two shapes:
 *   - FLAT (`{ NAME: envField.… }`) — every var is server-side, returned as a flat
 *     frozen object. The original surface; unchanged.
 *   - SPLIT (`{ server: {…}, client: {…} }`) — delegates to {@link defineSplitEnv}: the
 *     `PUBLIC_` convention is enforced on the client half and the result is leak-guarded
 *     (a server key read in a browser throws `ENV_SERVER_LEAK`).
 */
export function defineEnv<S extends SplitEnvSchema>(
  schema: S,
  source?: object,
): Readonly<InferSplit<S>>;
export function defineEnv<S extends EnvSchema>(schema: S, source?: object): Readonly<InferEnv<S>>;
export function defineEnv(schema: object, source?: object): Readonly<Record<string, unknown>> {
  // The split shape (`{ server?, client? }`) carries its own convention + leak guard.
  if (isSplitSchema(schema)) {
    return defineSplitEnv(schema, source) as Readonly<Record<string, unknown>>;
  }

  const from = (source ?? processEnv()) as Record<string, unknown>;

  const values: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [key, field] of Object.entries(schema as EnvSchema)) {
    // Read defensively: only a string is a real env value. A non-string (a Worker
    // binding) or a missing key both read as unset, so the field applies its
    // required/optional/default rule rather than coercing a binding object.
    const raw = from[key];
    const result = field.parse(typeof raw === "string" ? raw : undefined);

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

  return Object.freeze(values);
}
