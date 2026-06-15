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

/**
 * Build the entry source for `islands`.
 *
 * Eager islands are static-imported and registered by their carried `.island`
 * def (component included, in the main bundle). Lazy islands are registered with
 * a `load` that dynamic-imports the module and resolves its component — so only
 * its bytes split, while its fallback (already server-painted) and its data bind
 * (carried by the mount script) need not be pulled eagerly.
 */
export function synthesizeEntry(islands: readonly IslandFile[]): string {
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

  return [
    ...imports,
    "",
    `const registry = new Registry()`,
    `${registrations.join("\n")};`,
    "",
    `hydrateDocumentIslands(registry);`,
    "",
  ].join("\n");
}
