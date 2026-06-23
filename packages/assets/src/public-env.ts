/**
 * The PUBLIC-env injection guard — the bundler boundary that lets ONLY public
 * (`PUBLIC_*`) config into island bundles, and refuses a server var that would leak.
 *
 * An island runs in the browser, where there is no `process.env`. To read public
 * config (an API base URL, an analytics key) it needs the framework to INLINE the
 * value at build time — a bundler `define`/replace. `@lesto/env`'s `clientDefineMap`
 * computes that map from a `PUBLIC_*`-only schema; this validates the map at the
 * bundler edge before it reaches `Bun.build`, so a server-only value can never be
 * baked into client code (the structural mirror of `@lesto/env`'s
 * `ENV_CLIENT_NOT_PUBLIC`, enforced again where the bytes are actually emitted).
 *
 * Pure (no Bun, no fs) so the guard + the accepted-key rule are unit-tested; `bun.ts`
 * merges the verified map into `Bun.build`'s `define`.
 */

import { AssetsError } from "./errors";

/** A bundler `define` map: a code expression → its literal replacement source. */
export type PublicEnvDefine = Record<string, string>;

/** The global the public bag is injected as — the one whole-object define key. */
const PUBLIC_ENV_GLOBAL = "__LESTO_PUBLIC_ENV__";

/**
 * The define keys this build will inline into island code. Two shapes are public by
 * construction and allowed:
 *   - the whole public bag global, `globalThis.__LESTO_PUBLIC_ENV__` (what
 *     `@lesto/env/client`'s reader reads); and
 *   - a per-var read of a `PUBLIC_*` name, `import.meta.env.PUBLIC_*` /
 *     `process.env.PUBLIC_*` (the textual-replace form).
 * Anything else names a non-public var — a server value that must NOT be inlined.
 */
function isPublicDefineKey(key: string): boolean {
  if (key === `globalThis.${PUBLIC_ENV_GLOBAL}`) return true;

  const perVar = /^(?:import\.meta\.env|process\.env)\.(.+)$/.exec(key);

  return perVar !== null && perVar[1] !== undefined && perVar[1].startsWith("PUBLIC_");
}

/**
 * Verify a public-env inject map, returning it unchanged — or refusing with a coded
 * {@link AssetsError} (`ASSETS_SERVER_ENV_LEAK`) naming EVERY non-public key at once.
 *
 * `undefined`/empty maps are the common case (an app with no public config) and pass
 * straight through as `{}`. A key that does not name the public bag global or a
 * `PUBLIC_*` per-var read is a server leak: it would inline a non-public value into the
 * browser, so the build refuses rather than ship it.
 */
export function verifyPublicEnvDefine(map: PublicEnvDefine | undefined): PublicEnvDefine {
  if (map === undefined) return {};

  const leaked = Object.keys(map).filter((key) => !isPublicDefineKey(key));

  if (leaked.length > 0) {
    const noun = leaked.length === 1 ? "key" : "keys";

    throw new AssetsError(
      "ASSETS_SERVER_ENV_LEAK",
      `the client-env inject map names non-public ${noun} ${leaked
        .map((k) => `"${k}"`)
        .join(", ")} — a server-only value would be inlined into island code. Only the ` +
        `public bag global and \`PUBLIC_*\` reads may be injected; move the var to a ` +
        `\`client\` env half (named "PUBLIC_*") or keep it server-side.`,
      { keys: leaked },
    );
  }

  return map;
}
