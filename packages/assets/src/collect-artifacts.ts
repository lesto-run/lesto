/**
 * Flatten Vite's in-memory build result into the {@link BundleArtifact}s the
 * orchestration (`build-client.ts`) writes — the PURE transform extracted out of the
 * coverage-excluded `vite-build.ts` bundler edge so it is unit-tested directly.
 *
 * `build({ write: false })` (see `vite-build.ts`) returns the Rollup output: an ARRAY
 * iff multiple outputs were configured, a single object otherwise — this normalizes
 * both. The synthesized entry's chunk is the one with `isEntry`; every OTHER chunk is a
 * lazy island's split (a `hydrate: "visible"` island reached through a dynamic
 * `import()`, the ADR-0009 per-island split). An emitted ASSET (an island's imported
 * CSS/binary) rides through as a non-entry artifact so it is written too — mapped to
 * `kind: "chunk"` (the orchestration's only non-entry kind) carrying its `source`. The
 * orchestration renames the entry to its configured `client.js` and writes the rest
 * under their content-hashed names.
 *
 * Importing the `Rollup` TYPE from `"vite"` is sound here: it is a TYPE-only import that
 * vanishes at runtime, so this module never RUNS Vite and stays covered — unlike
 * `vite-alias.ts` (on island-dev's covered import path, so kept Vite-free), this module
 * is `@lesto/assets`-internal and Vite's type already ships with the build edge.
 */

import type { Rollup } from "vite";

import type { BundleArtifact } from "./build-client";

/**
 * Normalize one-or-many Rollup outputs into the artifact list `buildClient` writes.
 *
 * - a `chunk` with `isEntry` → the `entry` artifact (the synthesized hydration entry);
 * - any other `chunk` → a `chunk` artifact (a lazy-island split), carrying its `code`;
 * - an `asset` → a `chunk` artifact (the orchestration's only non-entry kind), carrying
 *   its `source` (a `string` for text assets, a `Uint8Array` for binary).
 */
export function collectArtifacts(
  result: Rollup.RollupOutput | Rollup.RollupOutput[],
): readonly BundleArtifact[] {
  const outputs = Array.isArray(result) ? result : [result];

  return outputs.flatMap((output) =>
    output.output.map((item) =>
      item.type === "chunk"
        ? {
            kind: item.isEntry ? ("entry" as const) : ("chunk" as const),
            fileName: item.fileName,
            contents: item.code,
          }
        : { kind: "chunk" as const, fileName: item.fileName, contents: item.source },
    ),
  );
}
