/**
 * Synthesize the island hydration entry — the `client.tsx` an app no longer
 * writes by hand (ADR 0011).
 *
 * Given the islands an app declares under `app/islands/` (one `defineIsland`
 * default-export per file), this generates the browser entry that builds the
 * client registry and calls `hydrateDocumentIslands`. The split decision is made
 * HERE, from each island's declared hydration strategy — not by the author:
 *
 *   - an EAGER island is `import`ed statically, so its bytes live in the main
 *     `client.js` (always mounts → splitting would only add a request hop, the
 *     ADR 0009 lesson);
 *   - a `hydrate: "visible"` island is reached only through a dynamic
 *     `import()`, so the bundler emits it as its own chunk fetched at mount —
 *     true byte deferral for the conditionally-mounted case.
 *
 * The output is a string (the bundler compiles it); this function is pure so the
 * decision logic is tested without a bundler.
 */

import {
  BEACON_PATH,
  DEFAULT_SAMPLE_RATE,
  defaultOverlay,
  defaultSend,
  errorClass,
  hydrateEvent,
  reportClientErrors,
  shouldSample,
} from "./client-beacon";

/** One island module discovered under `app/islands/`, classified for splitting. */
export interface IslandFile {
  /** The island's registered name (matches the `name` in its mount script). */
  readonly name: string;

  /** The module specifier the synthesized entry imports it by. */
  readonly importPath: string;

  /** `true` for a `hydrate: "visible"` island — reached via a dynamic import (its own chunk). */
  readonly lazy: boolean;

  /**
   * `true` for an island the author asserted the server can render (`ssr: true`),
   * which therefore HYDRATES server markup rather than mounting fresh. Carried so
   * the build can refuse the broken matched pair (`ssr: true` under the `preact`
   * client dialect with the CLI's React server renderer — {@link buildClient}).
   */
  readonly ssr: boolean;
}

/** A safe JS identifier for the Nth statically-imported island. */
function eagerLocal(index: number): string {
  return `Island${index}`;
}

/** Build-time knobs the client error beacon (ADR 0011) reads at runtime. */
export interface BeaconConfig {
  /**
   * Fraction of sessions that POST a report, in `[0, 1]`. Defaults to the
   * conservative {@link DEFAULT_SAMPLE_RATE} — high enough to notice a bad
   * deploy, low enough that the error route never floods.
   */
  readonly sampleRate?: number;

  /**
   * `true` under `keel dev`: the synthesized entry paints the ADR-0011 overlay
   * instead of POSTing. Defaults to `false` (production beacon).
   */
  readonly dev?: boolean;
}

/**
 * The beacon runtime, inlined into the entry so the browser bundle carries no
 * `@keel/assets` import (a scaffolded app depends on `@keel/ui` alone).
 *
 * Each piece is serialized from its REAL `@keel/assets` source via `.toString()`,
 * so the code that ships is byte-for-byte the code this package's tests exercise —
 * there is no second, untested transcription to drift. The functions reference one
 * another (and the two constants) by name, so the IIFE declares them all in one
 * scope before `reportClientErrors` closes over them.
 */
function beaconRuntime(): string {
  return [
    `const BEACON_PATH = ${JSON.stringify(BEACON_PATH)};`,
    `const DEFAULT_SAMPLE_RATE = ${JSON.stringify(DEFAULT_SAMPLE_RATE)};`,
    `const errorClass = ${errorClass.toString()};`,
    `const hydrateEvent = ${hydrateEvent.toString()};`,
    `const shouldSample = ${shouldSample.toString()};`,
    `const defaultSend = ${defaultSend.toString()};`,
    `const defaultOverlay = ${defaultOverlay.toString()};`,
    `const reportClientErrors = ${reportClientErrors.toString()};`,
  ].join("\n");
}

/**
 * Build the entry source for `islands`.
 *
 * Eager islands are static-imported and registered by their carried `.island`
 * def (component included, in the main bundle). Lazy islands are registered with
 * a `load` that dynamic-imports the module and resolves its component — so only
 * its bytes split, while its fallback (already server-painted) and its data bind
 * (carried by the mount script) need not be pulled eagerly.
 *
 * The entry also wires the island hydration sinks to the inlined client error
 * beacon ({@link beaconRuntime}): `onMountError`/`onRecoverableError` and the
 * pass's `HydrationResult` feed a sampled, PII-free POST to {@link BEACON_PATH}
 * (or the ADR-0011 dev overlay under `beacon.dev`). The sinks are passed into
 * `hydrateDocumentIslands` so a deferred island that fails LATER still reports,
 * and the synchronous result drives the hydrate-summary.
 */
export function synthesizeEntry(islands: readonly IslandFile[], beacon: BeaconConfig = {}): string {
  const imports: string[] = [
    `import { Registry } from "@keel/ui";`,
    `import { hydrateDocumentIslands } from "@keel/ui/client";`,
  ];

  const registrations: string[] = [];

  islands.forEach((island, index) => {
    if (island.lazy) {
      registrations.push(
        `  .defineClient({ name: ${JSON.stringify(island.name)}, ` +
          `load: () => import(${JSON.stringify(island.importPath)})` +
          `.then((module) => module.default.island.component) })`,
      );

      return;
    }

    const local = eagerLocal(index);

    imports.push(`import ${local} from ${JSON.stringify(island.importPath)};`);
    registrations.push(`  .defineClient(${local}.island)`);
  });

  // The beacon's build-time knobs — only the author-set fields are emitted, so the
  // runtime falls back to its own conservative defaults for anything omitted.
  const beaconOptions: string[] = [];

  if (beacon.sampleRate !== undefined) {
    beaconOptions.push(`sampleRate: ${JSON.stringify(beacon.sampleRate)}`);
  }

  if (beacon.dev !== undefined) {
    beaconOptions.push(`dev: ${JSON.stringify(beacon.dev)}`);
  }

  return [
    ...imports,
    "",
    `const registry = new Registry()`,
    `${registrations.join("\n")};`,
    "",
    // The beacon runtime, inlined in an IIFE so its identifiers never leak into
    // the entry's scope; it returns the wired sinks the hydrate call consumes.
    `const beacon = (() => {`,
    beaconRuntime(),
    `  return reportClientErrors({ ${beaconOptions.join(", ")} });`,
    `})();`,
    "",
    `const result = hydrateDocumentIslands(registry, {`,
    `  onMountError: beacon.onMountError,`,
    `  onRecoverableError: beacon.onRecoverableError,`,
    `});`,
    "",
    `beacon.report(result);`,
    "",
  ].join("\n");
}
