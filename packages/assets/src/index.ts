/**
 * @keel/assets — the framework-owned client-asset pipeline (ADR 0011, Seam 2).
 *
 *   const deps = bunBuildClientDeps(projectRoot);
 *   await buildClient({ islandsDir, outDir, mode: "production", dialect: "preact" }, deps);
 *
 * Synthesizes the island hydration entry from an `app/islands/` convention (the
 * framework writes the `client.tsx` an app used to hand-author), bundles it with
 * `Bun.build` (splitting + the opt-in preact dialect), and sweeps stale chunks —
 * so an app ships an optimized `/client.js` with no bespoke build script.
 *
 * The orchestration (`buildClient`) and the decision logic (`synthesizeEntry`,
 * `isChunkFile`, the alias map) are pure; the real Bun + filesystem wiring is
 * `bunBuildClientDeps`.
 */

export { buildClient } from "./build-client";
export type {
  BuildClientDeps,
  BuildClientOptions,
  BuildClientResult,
  BuildMode,
  BundleArtifact,
  BundleRequest,
  Dialect,
} from "./build-client";

export { synthesizeEntry } from "./synthesize";
export type { IslandFile } from "./synthesize";

export { isChunkFile } from "./chunks";

export { PREACT_ALIAS } from "./preact-alias";

export { bunBuildClientDeps } from "./bun";

export { AssetsError, KeelError } from "./errors";
export type { AssetsErrorCode } from "./errors";
