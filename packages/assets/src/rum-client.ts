/**
 * The browser RUM wiring for the synthesized client entry (ARCHITECTURE.md §7).
 *
 * `@lesto/observability/rum`'s `startBrowserRum` is the browser half of the
 * UI→API→DB trace: it reads the SSR-injected `<meta name="lesto-traceparent">`,
 * adopts the server trace id, and POSTs navigation/resource/web-vital spans under
 * it. This module owns how that runtime is WIRED INTO the synthesized entry — the
 * import line and the call — so `synthesize.ts` stays a flat assembler and the
 * exact emitted snippet is pinned by a unit test.
 *
 * Unlike the client-error beacon (whose runtime is inlined byte-for-byte via
 * `.toString()` so the browser bundle carries no `@lesto/assets` import), the RUM
 * runtime is IMPORTED from `@lesto/observability/rum` — a node-free subpath (only
 * `rum.ts` + the pure `traceparent.ts`, no `node:crypto`), so the bundler resolves
 * it cleanly into the browser bundle. Importing rather than inlining is the right
 * call here: the runtime is a class plus several helpers that reference one
 * another, which `.toString()` cannot serialize as a coherent unit, and the
 * subpath keeps the byte cost tree-shaken to what the entry actually calls.
 */

import { AssetsError } from "./errors";

/** The module the synthesized entry imports the RUM runtime from (a node-free subpath). */
export const RUM_MODULE = "@lesto/observability/rum";

/** Build-time knobs the browser RUM runtime reads at startup. */
export interface RumConfig {
  /**
   * Fraction of sessions that emit browser spans, in `[0, 1]`. Defaults (when
   * omitted) to the runtime's conservative `DEFAULT_RUM_SAMPLE_RATE` — high enough
   * to sample the field, low enough that a page load never floods the receiver.
   */
  readonly sampleRate?: number;
}

/**
 * The import line the synthesized entry needs to reach `startBrowserRum`.
 *
 * Exported (rather than hardcoded in `synthesize.ts`) so the module specifier lives
 * in ONE place and the entry's import set is assembled from named pieces.
 */
export function rumImport(): string {
  return `import { startBrowserRum } from ${JSON.stringify(RUM_MODULE)};`;
}

/**
 * The call the synthesized entry makes to start RUM, carrying only the
 * author-set knobs (so the runtime falls back to its own defaults for anything
 * omitted — the same posture the beacon's option emission takes).
 *
 * `startBrowserRum` reads the `lesto-traceparent` meta itself (its default
 * environment), so the entry passes only the sample rate; no meta plumbing leaks
 * into the generated source.
 */
export function rumStartCall(config: RumConfig = {}): string {
  const options =
    config.sampleRate === undefined ? "" : `{ sampleRate: ${JSON.stringify(config.sampleRate)} }`;

  return `startBrowserRum(${options});`;
}

/**
 * The single `ASSETS_MISSING_RUM_DEPENDENCY` error, built in ONE place.
 *
 * Both guards that refuse a client entry whose UNCONDITIONAL `@lesto/observability/rum`
 * import can't resolve — `buildClient`'s (`lesto build`/`deploy` + the Bun dev fallback)
 * and `@lesto/island-dev`'s `createIslandDevServer` (the default `lesto dev` Vite path,
 * L-44ca7c57) — throw THIS, so a hand-written app sees one identical, actionable message
 * across build and dev. Restated prose would drift silently (only value equality is
 * CI-caught); a shared factory forecloses that.
 */
export function missingRumDependencyError(): AssetsError {
  return new AssetsError(
    "ASSETS_MISSING_RUM_DEPENDENCY",
    `the client entry imports "${RUM_MODULE}" — browser RUM (the UI→API→DB trace's browser half) ` +
      `is on by default — but "@lesto/observability" does not resolve from the app root. Add it to ` +
      `your dependencies (e.g. \`bun add @lesto/observability\`).`,
    { module: RUM_MODULE, dependency: "@lesto/observability" },
  );
}
