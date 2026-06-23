/**
 * The server/client split — the boundary that separates `@lesto/env` from a plain
 * "validate process.env" helper and puts it in best-in-class company (t3-env's
 * server/client, astro's `defineSecret`/`defineVariable`, Vite's `VITE_` inlining).
 *
 *   const env = defineSplitEnv({
 *     server: { DATABASE_URL: envField.string(), SESSION_SECRET: envField.string() },
 *     client: { PUBLIC_API_BASE: envField.string(), PUBLIC_ANALYTICS: envField.string().optional() },
 *   });
 *
 *   env.DATABASE_URL;       // string — on the SERVER. In a browser island this THROWS
 *                           // a coded ENV_SERVER_LEAK rather than leaking the secret.
 *   env.PUBLIC_API_BASE;    // string — readable everywhere (it is, by name, public).
 *
 * Two structural guarantees, both LOUD + EARLY:
 *
 *   1. PUBLIC_ convention. Every `client` key MUST be named `PUBLIC_*`. A misnamed
 *      one throws {@link EnvError} `ENV_CLIENT_NOT_PUBLIC` as the schema is built —
 *      the prefix is the leak contract the bundler keys off (only `PUBLIC_*` is
 *      inlined into island code).
 *
 *   2. Server-leak guard. The returned object is a Proxy: reading a SERVER key from a
 *      browser context throws `ENV_SERVER_LEAK` naming the var. So an island that
 *      `import { env }`s a schema holding a secret fails the FIRST time it touches a
 *      server value, instead of silently bundling `undefined` (or, for a literal
 *      `.default()`, the secret itself). Client keys read everywhere.
 */

import { defineEnv } from "./define";
import { EnvError } from "./errors";
import type { EnvField } from "./fields";

/** A flat schema half — a {@link EnvField} per variable name. */
export type EnvHalf = Record<string, EnvField<unknown>>;

/** The two-sided schema: SERVER vars (secrets, never shipped) and `PUBLIC_*` CLIENT vars. */
export interface SplitEnvSchema {
  /** Server-only vars: secrets and config that must NEVER reach a browser bundle. */
  readonly server?: EnvHalf;

  /** Public vars, each named `PUBLIC_*`: safe to inline into island/client code. */
  readonly client?: EnvHalf;
}

/** The validated values of both halves, merged into one typed object. */
export type InferSplit<S extends SplitEnvSchema> = {
  [K in keyof NonNullable<S["server"]>]: NonNullable<S["server"]>[K] extends EnvField<infer T>
    ? T
    : never;
} & {
  [K in keyof NonNullable<S["client"]>]: NonNullable<S["client"]>[K] extends EnvField<infer T>
    ? T
    : never;
};

/** The naming convention a `client` (public) var must follow — the leak contract. */
export const PUBLIC_PREFIX = "PUBLIC_";

/** Whether `name` is a public var by convention (`PUBLIC_*`, and not the bare prefix). */
export function isPublicName(name: string): boolean {
  return name.startsWith(PUBLIC_PREFIX) && name.length > PUBLIC_PREFIX.length;
}

/**
 * Whether this code is running on a SERVER (Node/Bun/Worker), as opposed to a browser.
 *
 * A browser has a `window`/`document`; a server does not. We test for their ABSENCE
 * rather than for `process`, because a Cloudflare Worker is a server yet has no
 * `process` — keying off `process` would mis-flag the edge as a browser and trip the
 * leak guard on every server read there. Injectable (`override`) so the guard is
 * exercised for both contexts under vitest without a real DOM.
 */
export function isServerContext(override?: boolean): boolean {
  if (override !== undefined) return override;

  const g = globalThis as { window?: unknown; document?: unknown };

  return g.window === undefined && g.document === undefined;
}

/**
 * Validate a {@link SplitEnvSchema} into one frozen, leak-guarded, fully-typed object.
 *
 * Build order:
 *   1. Refuse any misnamed `client` key (`ENV_CLIENT_NOT_PUBLIC`) — the PUBLIC_
 *      convention is enforced before anything is read.
 *   2. Validate both halves with the existing {@link defineEnv} (one pass each, so a
 *      bad var in EITHER half still lists every problem in its half).
 *   3. Wrap the merged values in a Proxy whose get-trap throws `ENV_SERVER_LEAK` when a
 *      SERVER key is read from a browser context. Client keys are unguarded.
 *
 * `serverContext` overrides the runtime server/browser detection (for tests and for a
 * host that knows its context); omitted, it auto-detects via {@link isServerContext}.
 */
export function defineSplitEnv<S extends SplitEnvSchema>(
  schema: S,
  source?: object,
  serverContext?: boolean,
): Readonly<InferSplit<S>> {
  const serverSchema = schema.server ?? {};
  const clientSchema = schema.client ?? {};

  // (1) PUBLIC_ convention — list EVERY misnamed client key at once, same as the
  // validation pass lists every bad var, so one throw surfaces the whole set.
  const misnamed = Object.keys(clientSchema).filter((name) => !isPublicName(name));

  if (misnamed.length > 0) {
    const noun = misnamed.length === 1 ? "key" : "keys";

    throw new EnvError(
      "ENV_CLIENT_NOT_PUBLIC",
      `client env ${noun} ${misnamed.map((n) => `"${n}"`).join(", ")} must be named ` +
        `"${PUBLIC_PREFIX}*" — a client var is inlined into browser bundles, so its name ` +
        `must announce that it is public (the leak contract the island bundler keys off).`,
      { keys: misnamed },
    );
  }

  // (2) Validate each half independently (both throw ENV_VALIDATION_FAILED on a bad var).
  const serverValues = defineEnv(serverSchema, source) as Record<string, unknown>;
  const clientValues = defineEnv(clientSchema, source) as Record<string, unknown>;

  const serverKeys = new Set(Object.keys(serverSchema));
  const merged: Record<string, unknown> = { ...clientValues, ...serverValues };

  // (3) The leak guard. A server key read from the browser throws LOUD + EARLY.
  const guarded = new Proxy(Object.freeze(merged), {
    get(target, prop, receiver) {
      if (typeof prop === "string" && serverKeys.has(prop) && !isServerContext(serverContext)) {
        throw new EnvError(
          "ENV_SERVER_LEAK",
          `server env "${prop}" was read in a browser context — it is server-only and must ` +
            `never reach client code. Move it to the \`client\` half (named "${PUBLIC_PREFIX}*") ` +
            `if it is safe to ship, or pass the value down as a prop from a server page/loader.`,
          { key: prop },
        );
      }

      return Reflect.get(target, prop, receiver);
    },
  });

  return guarded as Readonly<InferSplit<S>>;
}
